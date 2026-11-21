// Usage: OCR_E2E_EXECUTABLE=<unpacked exe> OCR_E2E_PDF=<single-page fixture>
// PLAYWRIGHT_MODULE=<absolute path to playwright> node build/verify-ocr-line-endings.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

;(async () => {
  assert(process.env.OCR_E2E_EXECUTABLE, 'Set OCR_E2E_EXECUTABLE to an unpacked Electron app')
  assert(process.env.OCR_E2E_PDF, 'Set OCR_E2E_PDF to a single-page local PDF fixture')
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-line-endings-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await electron.launch({
      executablePath: process.env.OCR_E2E_EXECUTABLE,
      args: [`--user-data-dir=${userDataDir}`, process.env.OCR_E2E_PDF],
      env,
      timeout: 60000,
    })
    const page = await app.firstWindow()
    await page.locator('#pdf-stage .stage-page[data-current] canvas').waitFor({ state: 'visible', timeout: 60000 })
    await page.getByRole('button', { name: 'OCR 文字识别', exact: true }).click()
    await page.getByRole('menuitem', { name: /仅识别当前页/ }).click()
    const layer = page.locator('#pdf-stage .stage-page[data-current] .text-layer[data-ocr="true"]')
    await layer.waitFor({ state: 'visible', timeout: 180000 })
    // Fit the whole page in the viewport: at fit-width a tall page pushes the
    // lower OCR lines under the statusbar / below the fold, where drags can't
    // reach them. Then wait for any completion toast to leave the page area.
    await page.getByRole('button', { name: '适合页面', exact: true }).click()
    await page.waitForTimeout(600)
    await page.waitForFunction(() => ![...document.querySelectorAll('.toast')].some((t) => {
      const r = t.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(t).visibility !== 'hidden'
    }), undefined, { timeout: 15000 }).catch(() => undefined)

    const coverage = await layer.evaluate((element) => (
      [...element.querySelectorAll('span[data-ocr-index]')].slice(0, 3).map((span) => {
        const bounds = span.getBoundingClientRect()
        const node = span.firstChild
        const full = node.textContent.trimEnd()
        let visible = ''
        for (let index = 0; index < full.length; index++) {
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + 1)
          if (range.getBoundingClientRect().right <= bounds.right + 1) visible += full[index]
        }
        return { full, visible }
      })
    ))
    assert.equal(coverage.length, 3)
    for (const row of coverage) assert.equal(row.visible, row.full, 'OCR suffix is clipped by its layout box')

    for (let index = 0; index < 3; index++) {
      const geometry = await layer.locator('span[data-ocr-index]').nth(index).evaluate((span) => {
        const bounds = span.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y + bounds.height / 2, right: bounds.right, text: span.textContent.trimEnd() }
      })
      for (const reverse of [false, true]) {
        await page.evaluate(() => window.getSelection()?.removeAllRanges())
        await page.mouse.move(reverse ? geometry.right - 1 : geometry.x + 2, geometry.y)
        await page.mouse.down()
        await page.mouse.move(reverse ? geometry.x + 2 : geometry.right - 1, geometry.y, { steps: 20 })
        await page.mouse.up()
        const selected = await page.evaluate(() => window.getSelection()?.toString().trim())
        assert.equal(selected, geometry.text, `Incomplete ${reverse ? 'reverse' : 'forward'} line selection`)
      }
    }
    console.log('PASS: first three OCR lines fit without clipping and select completely in both directions')
  } finally {
    if (app) {
      const pid = app.process().pid
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
