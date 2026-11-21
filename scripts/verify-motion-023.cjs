// Use a synthetic PDF for timing and screenshots. Real mouse events; quantities are CSS px.
const { chromium } = require('playwright-core'),
  { PDFDocument, rgb } = require('pdf-lib'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path')
async function run() {
  const origin = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert(origin.hostname === '127.0.0.1')
  const dir = process.argv[3]
  if (dir) await fs.mkdir(dir, { recursive: true })
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 6; i++) {
    const leaf = pdf.addPage([500, 670])
    leaf.drawText('Edition notes', { x: 37, y: 629, size: 22, color: rgb(0.13, 0.16, 0.24) })
    leaf.drawText(`PRINT STUDIES     /     ${String(i + 1).padStart(2, '0')}`, {
      x: 38,
      y: 603,
      size: 8,
      color: rgb(0.34, 0.39, 0.52),
    })
    leaf.drawLine({
      start: { x: 37, y: 586 },
      end: { x: 458, y: 586 },
      thickness: 0.5,
      color: rgb(0.67, 0.7, 0.8),
    })
    leaf.drawText('Free space for a proof mark.', {
      x: 38,
      y: 445,
      size: 12,
      color: rgb(0.22, 0.25, 0.34),
    })
    leaf.drawText('This synthetic sheet is used for pointer and registration checks.', {
      x: 38,
      y: 425,
      size: 9,
      color: rgb(0.39, 0.41, 0.48),
    })
  }
  const bytes = Array.from(await pdf.save())
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const p = await b.newPage({ viewport: { width: 1360, height: 875 } })
    p.setDefaultTimeout(7000)
    await p.goto(origin.href)
    const shell = p.locator('.app-shell:visible'),
      stage = shell.locator('#pdf-stage'),
      bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' })
    await shell.waitFor()
    if (dir) await p.screenshot({ path: path.join(dir, 'desk-light.png'), animations: 'disabled' })
    await p.evaluate((bytes) => {
      const d = new DataTransfer()
      d.items.add(new File([Uint8Array.from(bytes)], '排版校样.pdf', { type: 'application/pdf' }))
      document
        .querySelector('.app-shell')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: d }))
    }, bytes)
    const sheet = stage.locator('.stage-page[data-current] .pdf-page')
    await sheet.locator('canvas').waitFor()
    await bar.getByRole('button', { name: /^文本框：/ }).click()
    await sheet.click({ position: { x: 160, y: 135 } })
    const entry = stage.locator('[data-inline-draft]')
    await entry.fill('Proofing — 文字校样')
    await entry.press('Control+Enter')
    const obj = stage.locator('.annotation--text[data-annotation-id]'),
      field = obj.locator('textarea'),
      turn = obj.locator('[data-rotate-zone=ne]')
    await field.waitFor()
    const cursor = await turn.evaluate((e) => getComputedStyle(e).cursor)
    const f = await field.boundingBox(),
      start = { x: f.x + 18, y: f.y + 12 }
    await p.mouse.click(start.x, start.y)
    await p.evaluate(() => {
      window.hold = {}
      const obj = document.querySelector('#pdf-stage .annotation--text[data-annotation-id]')
      window.addEventListener(
        'pointerdown',
        () => {
          hold.start = performance.now()
        },
        { once: true, capture: true },
      )
      const obs = new MutationObserver(() => {
        if (obj.dataset.dragMode === 'move' && hold.armed === undefined) {
          hold.armed = performance.now() - hold.start
          obs.disconnect()
        }
      })
      obs.observe(obj, { attributes: true, attributeFilter: ['data-drag-mode'] })
    })
    await p.mouse.down()
    await p.waitForFunction(() => window.hold.armed !== undefined)
    const base = await obj.boundingBox(),
      initial = await obj.evaluate((e) => [e.style.left, e.style.top])
    let changedLayout = 0,
      maxError = 0
    for (let i = 1; i <= 12; i++) {
      const dx = i * 5,
        dy = i * 2
      await p.mouse.move(start.x + dx, start.y + dy)
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const rect = await obj.boundingBox()
      maxError = Math.max(maxError, Math.hypot(rect.x - base.x - dx, rect.y - base.y - dy))
      if (!(await obj.evaluate((e, a) => e.style.left === a[0] && e.style.top === a[1], initial)))
        changedLayout++
    }
    await p.mouse.up()
    const end = await obj.boundingBox()
    const result = {
      holdMs: Math.round(await p.evaluate(() => hold.armed)),
      moveSamples: 12,
      samplesChangingLayout: changedLayout,
      maxTrackingErrorPx: +maxError.toFixed(3),
      releaseDxPx: +(end.x - base.x).toFixed(3),
      rotationCursor:
        cursor,
      stageColor: await p.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--stage').trim(),
      ),
    }
    console.log(JSON.stringify(result))
    if (dir) {
      await fs.writeFile(path.join(dir, 'drag.json'), JSON.stringify(result, null, 2))
      await p.screenshot({ path: path.join(dir, 'reader-light.png'), animations: 'disabled' })
    }
    assert(result.rotationCursor === 'crosshair', 'rotation must use the system crosshair')
    assert.equal(changedLayout, 0, 'drag still relayouts the object on every move')
    assert(maxError < 2 && Math.abs(result.releaseDxPx - 60) < 2, 'pointer tracking/release jump')
    await p.keyboard.press('Control+z')
    await p
      .waitForFunction(
        (x) =>
          Math.abs(
            document.querySelector('#pdf-stage [data-annotation-id]').getBoundingClientRect().x - x,
          ) < 2,
        base.x,
        { timeout: 1600 },
      )
      .catch(async () => {
        throw Error(
          'one undo must restore position: ' +
            JSON.stringify(
              await obj.evaluate(
                (e, x) => ({
                  focus: document.activeElement.tagName,
                  left: e.style.left,
                  x: e.getBoundingClientRect().x,
                  wanted: x,
                }),
                base.x,
              ),
            ),
        )
      })
  } finally {
    await b.close()
  }
}
run().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
