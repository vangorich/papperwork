const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { _electron: electron, chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mode-switch-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const errors = []
  let app, browser, launcher
  try {
    let page
    if (process.env.OCR_E2E_PORTABLE === '1') {
      const port = Number(process.env.OCR_E2E_PORT || 19383)
      launcher = spawn(process.env.OCR_E2E_EXECUTABLE, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, process.env.OCR_E2E_PDF], { env, stdio: 'ignore' })
      const deadline = Date.now() + 120000
      let endpoint
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`)
          if (response.ok) { endpoint = `http://127.0.0.1:${port}`; break }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert(endpoint, 'Portable did not expose its debug endpoint')
      browser = await chromium.connectOverCDP(endpoint)
      page = browser.contexts()[0].pages()[0]
    } else {
      app = await electron.launch({
        executablePath: process.env.OCR_E2E_EXECUTABLE,
        args: [`--user-data-dir=${dir}`, process.env.OCR_E2E_PDF],
        env, timeout: 60000,
      })
      page = await app.firstWindow()
    }
    page.on('pageerror', error => errors.push(error.message))
    const active = () => page.locator('.app-shell:not([hidden])')
    await page.locator('#pdf-stage .stage-page[data-current] canvas').waitFor({ state: 'visible', timeout: 60000 })
    await active().getByRole('button', { name: 'OCR 文字识别', exact: true }).click()
    await page.getByRole('menuitem', { name: /仅识别当前页/ }).click()
    await active().getByRole('progressbar', { name: 'OCR 后台识别进度' }).waitFor({ timeout: 15000 })
    await active().getByRole('button', { name: /打印清单/ }).click()
    if (process.env.OCR_EXPECT_CRASH === '1') {
      await page.waitForTimeout(1500)
      console.log(JSON.stringify({ errors }))
      assert(errors.some(error => /#300|#310|hooks|Hooks/i.test(error)), 'Expected the original Hook-order crash')
      return
    }
    await active().getByRole('button', { name: '浏览', exact: true }).waitFor({ timeout: 5000 })
    for (const mode of ['浏览', '工作区', '打印清单', '浏览']) {
      await active().getByRole('button', { name: new RegExp(`^${mode}`) }).click()
      await active().getByRole('toolbar', { name: 'PDF 编辑工具栏' }).waitFor({ timeout: 5000 })
    }
    const layer = page.locator('#pdf-stage .stage-page[data-current] .text-layer[data-ocr="true"]')
    await layer.waitFor({ state: 'visible', timeout: 180000 })
    const text = await layer.textContent()
    assert(text && text.trim().length > 5, 'Original file did not receive OCR results')
    if (process.env.OCR_E2E_CANCEL === '1') {
      await active().getByRole('progressbar', { name: 'OCR 后台识别进度' }).waitFor({ state: 'detached' })
      await active().getByRole('button', { name: 'OCR 文字识别', exact: true }).click()
      await page.getByRole('menuitem', { name: /仅识别当前页/ }).click()
      await active().getByRole('progressbar', { name: 'OCR 后台识别进度' }).waitFor()
      await active().getByRole('button', { name: 'OCR 文字识别', exact: true }).click()
      await page.getByRole('menuitem', { name: /仅识别当前页/ }).click()
      await page.getByText('当前工作区已有 OCR 任务，请等待完成或先取消', { exact: true }).waitFor()
      await active().getByRole('button', { name: '取消', exact: true }).click()
      await active().getByRole('progressbar', { name: 'OCR 后台识别进度' }).waitFor({ state: 'detached', timeout: 180000 })
      assert((await layer.textContent())?.trim(), 'Cancellation discarded completed OCR')
    }
    assert.deepEqual(errors, [], 'Mode switching crashed the renderer')
    console.log(JSON.stringify({ ok: true, pageErrors: errors, text }))
  } finally {
    if (browser) await browser.close().catch(() => {})
    const pid = app?.process().pid ?? launcher?.pid
    if (pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
