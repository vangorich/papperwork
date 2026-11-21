// P03/P04 supplement to verify-object-corners-024.cjs. Headless Edge, synthetic inputs only.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright-core')
const { PDFDocument } = require('pdf-lib')

const centre = async (el) => {
  const r = await el.boundingBox()
  assert(r, 'expected a visible target')
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const cursorAt = (p, point) => p.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, point)
const shape = (o) => o.evaluate(e => ['left','top','width','height','transform'].map(k => e.style[k]))
const handles = {
  edge: { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' },
  grip: { nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' },
  'rotate-zone': { nw: 'crosshair', ne: 'crosshair', sw: 'crosshair', se: 'crosshair' },
}

async function checkCursors(p, o, kind, tab) {
  const far = await centre(tab), idle = await cursorAt(p, far)
  for (const [attr, directions] of Object.entries(handles)) {
    assert.equal(await o.locator(`[data-${attr}]`).count(), 4, `${kind} ${attr} count`)
    for (const [dir, expected] of Object.entries(directions)) {
      const label = `${kind} ${attr}=${dir}`, target = o.locator(`[data-${attr}=${dir}]`)
      const from = await centre(target), initial = await shape(o)
      await p.mouse.move(from.x, from.y)
      assert(await target.evaluate((e, pt) => e.contains(document.elementFromPoint(pt.x, pt.y)), from), `${label} covered`)
      assert.equal(await cursorAt(p, from), expected, `${label} hover`)
      await p.mouse.down()
      const cancel = ['n', 'w', 'nw', 'sw'].includes(dir)
      try {
        assert(await target.evaluate(e => e.hasPointerCapture(window.probePointerId)), `${label} pointer not captured`)
        await p.mouse.move(far.x, far.y, { steps: 3 }) // over a real, unrelated sidebar control
        assert(await tab.evaluate((e, pt) => e.contains(document.elementFromPoint(pt.x, pt.y)), far), `${label} probe missed sidebar`)
        assert.notEqual(idle, expected, `${label} sidebar must distinguish the captured cursor`)
        assert.equal(await cursorAt(p, far), expected, `${label} drag outside frame`)
        assert.equal(await target.evaluate(e => getComputedStyle(e).cursor), expected, `${label} captured target`)
        assert.equal(await p.locator('html[data-object-capture]').evaluate(e => getComputedStyle(e).cursor), expected, `${label} captured root`)
        if (cancel) {
          await p.keyboard.press('Escape')
          assert.equal(await cursorAt(p, far), idle, `${label} Escape before mouseup`)
        } else {
          await p.mouse.move(from.x, from.y, { steps: 3 })
        }
      } finally { await p.mouse.up() }
      assert.equal(await p.locator('html[data-object-capture]').count(), 0, `${label} retained capture override`)
      assert.equal(await target.evaluate(e => e.hasPointerCapture(window.probePointerId)), false, `${label} retained pointer`)
      assert.equal(await cursorAt(p, far), idle, `${label} cursor not restored`)
      assert.deepEqual(await shape(o), initial, `${label} ${cancel ? 'cancel' : 'drag back'} changed geometry`)
    }
  }
  console.log('PASS', kind, '4 edge / 4 diagonal / 4 outer crosshair; real capture over sidebar; release and Esc restore')
}

async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1')
  const out = process.argv[3]
  if (out) await fs.mkdir(out, { recursive: true })
  const pdf = await PDFDocument.create()
  for (let n = 1; n <= 3; n++) pdf.addPage([480, 590]).drawText(`Cursor proof - ${n}`, { x: 32, y: 534 })
  const bytes = Array.from(await pdf.save()), browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    console.log('Edge', browser.version())
    for (const kind of ['text', 'watermark', 'image', 'rectangle']) {
      const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      p.setDefaultTimeout(6500)
      try {
        await p.goto(url.href)
        const shell = p.locator('.app-shell:visible'), bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' })
        await shell.evaluate((el, data) => {
          window.addEventListener('pointerdown', e => { if (e.isTrusted) window.probePointerId = e.pointerId }, true)
          const dt = new DataTransfer()
          dt.items.add(new File([Uint8Array.from(data)], 'Cursor proof.pdf', { type: 'application/pdf' }))
          el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        }, bytes)
        const stage = shell.locator('#pdf-stage'), sheet = stage.locator('.stage-page[data-current] .pdf-page')
        const tab = shell.getByRole('tab', { name: '缩略图', exact: true })
        await sheet.locator('canvas').waitFor()
        if (kind === 'text') {
          const cards = shell.locator('.thumbnail-list--direct .thumbnail'), pager = shell.getByRole('spinbutton', { name: /^当前页码，共 3 页/ })
          assert.equal((await tab.innerText()).trim(), '缩略图')
          assert.equal(await cards.count(), 3)
          for (let i = 0; i < 3; i++) {
            const number = cards.nth(i).getByRole('button', { name: '拖动排序' }).locator('span')
            assert(await number.isVisible())
            assert.equal(await number.innerText(), String(i + 1))
            assert.match(await cards.nth(i).getAttribute('aria-label'), new RegExp(`^第 ${i + 1} 页，`))
          }
          await cards.nth(1).click()
          await p.waitForFunction(() => document.querySelector('input[aria-label^="当前页码"]')?.value === '2')
          assert.equal(await pager.inputValue(), '2')
          const total = shell.locator('output[aria-label="总页数 3"]')
          assert(await total.isVisible())
          assert.equal(await total.innerText(), '/3')
          if (out) await p.screenshot({ path: path.join(out, 'thumbnails-2-of-3.png') })
          console.log('PASS P04 exact tab=缩略图; visible page numbers=1,2,3; accessible names retained; pager=2/3')
        }
        await bar.getByRole('button', { name: /^显示与缩放/ }).click()
        await p.getByRole('menuitem', { name: '整页显示', exact: true }).click()
        const r = await sheet.boundingBox(), x = r.x + r.width * .32, y = r.y + r.height * .29
        const draw = async () => {
          await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 146, y + 60, { steps: 6 }); await p.mouse.up()
        }
        let o
        if (kind === 'text') {
          await bar.getByRole('button', { name: /^文本框：/ }).click(); await draw()
          const draft = stage.locator('.inline-draft'), field = draft.locator('textarea')
          assert.equal(await field.inputValue(), '')
          await stage.locator('[aria-label="文本格式"]').waitFor()
          await checkCursors(p, draft, 'empty text', tab)
          await field.fill('Synthetic text'); await field.press('Control+Enter')
          o = stage.locator('.annotation--text[data-annotation-id]')
        } else if (kind === 'watermark') {
          await bar.getByRole('button', { name: '添加水印', exact: true }).click()
          await p.getByRole('dialog', { name: '插入水印' }).getByRole('button', { name: '添加水印', exact: true }).click()
          o = stage.locator('.watermark-ui'); await o.locator('[data-rotate-zone=ne]').press('Home')
        } else if (kind === 'image') {
          const buffer = await sheet.locator('canvas').screenshot(), chooser = p.waitForEvent('filechooser')
          await bar.getByRole('button', { name: '插入', exact: true }).click()
          await p.getByRole('menuitem', { name: '插入图片', exact: true }).click()
          await (await chooser).setFiles({ name: 'proof.png', mimeType: 'image/png', buffer })
          await stage.locator('.placement-sheet').press('Enter'); o = stage.locator('.annotation--image')
        } else {
          await bar.getByRole('button', { name: '绘图工具', exact: true }).click()
          await p.getByRole('menuitem', { name: '矩形', exact: true }).click(); await draw()
          await p.keyboard.press('Escape'); o = stage.locator('.annotation--rectangle[data-annotation-id]')
          await o.click({ position: { x: 20, y: 12 } })
        }
        await o.locator('[data-grip=se]').waitFor()
        await checkCursors(p, o, kind, tab)
      } finally { await p.close() }
    }
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
