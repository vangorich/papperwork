// Checks distinct edge/corner/outside hit targets using REAL mouse drags.
const { chromium } = require('playwright-core'),
  { PDFDocument } = require('pdf-lib'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path')
async function run() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207'),
    out = process.argv[3]
  assert(url.hostname === '127.0.0.1')
  if (out) await fs.mkdir(out, { recursive: true })
  const doc = await PDFDocument.create()
  doc.addPage([480, 590]).drawText('Object geometry', { x: 28, y: 552, size: 12 })
  const bytes = Array.from(await doc.save())
  const b = await chromium.launch({ channel: 'msedge' })
  try {
    for (const kind of ['text', 'image', 'watermark', 'rectangle']) {
      const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
      p.setDefaultTimeout(5500)
      try {
        await p.goto(url.href)
        const shell = p.locator('.app-shell:visible'),
          stage = shell.locator('#pdf-stage'),
          bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' })
        await shell.waitFor()
        await p.evaluate((data) => {
          const t = new DataTransfer()
          t.items.add(new File([Uint8Array.from(data)], 'Grips.pdf', { type: 'application/pdf' }))
          document
            .querySelector('.app-shell')
            .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: t }))
        }, bytes)
        const sheet = stage.locator('.stage-page[data-current] .pdf-page')
        await sheet.locator('canvas').waitFor()
        await bar.getByRole('button', { name: /^显示与缩放/ }).click()
        await p.getByRole('menuitem', { name: '整页显示', exact: true }).click()
        const rect = await sheet.boundingBox(),
          xy = { x: rect.x + rect.width * 0.32, y: rect.y + rect.height * 0.29 }
        let o
        if (kind === 'text') {
          await bar.getByRole('button', { name: /^文本框：/ }).click()
          await p.mouse.move(xy.x, xy.y)
          await p.mouse.down()
          await p.mouse.move(xy.x + 146, xy.y + 50, { steps: 8 })
          await p.mouse.up()
          o = stage.locator('.inline-draft')
          await o.locator('textarea').waitFor()
          assert.equal(await o.locator('textarea').inputValue(), '')
        }
        if (kind === 'watermark') {
          await bar.getByRole('button', { name: '添加水印', exact: true }).click()
          await p
            .getByRole('dialog', { name: '插入水印' })
            .getByRole('button', { name: '添加水印', exact: true })
            .click()
          o = stage.locator('.watermark-ui')
          await o.waitFor()
          await o.locator('[data-rotate-zone=ne]').focus()
          await p.keyboard.press('Home')
        }
        if (kind === 'image') {
          const picker = p.waitForEvent('filechooser')
          await bar.getByRole('button', { name: '插入', exact: true }).click()
          await p.getByRole('menuitem', { name: '插入图片', exact: true }).click()
          const png = await p.evaluate(() => {
            const c = document.createElement('canvas')
            c.width = 100
            c.height = 55
            const x = c.getContext('2d')
            x.fillStyle = '#a55246'
            x.fillRect(0, 0, 100, 55)
            x.fillStyle = '#333'
            x.fillRect(5, 5, 15, 14)
            return c.toDataURL().split(',')[1]
          })
          await (
            await picker
          ).setFiles({ name: 'art.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
          await stage.locator('.placement-sheet').press('Enter')
          o = stage.locator('.annotation--image')
          await o.waitFor()
        }
        if (kind === 'rectangle') {
          await bar.getByRole('button', { name: '绘图工具', exact: true }).click()
          await p.getByRole('menuitem', { name: '矩形', exact: true }).click()
          await p.mouse.move(xy.x, xy.y)
          await p.mouse.down()
          await p.mouse.move(xy.x + 115, xy.y + 65, { steps: 8 })
          await p.mouse.up()
          await p.keyboard.press('Escape')
          o = stage.locator('.annotation--rectangle[data-annotation-id]')
          await o.click({ position: { x: 20, y: 12 } })
        }
        await o.locator('[data-grip=se]').waitFor()
        assert.equal(await stage.locator('.transform-turn').count(), 0)
        assert.equal(await o.locator('[data-rotate-zone]').count(), 4)
        assert.equal(await o.locator('[data-edge]').count(), 4)
        const centre = async (el) => {
          const e = await el.boundingBox()
          return { x: e.x + e.width / 2, y: e.y + e.height / 2 }
        }
        const read = () =>
          o.evaluate((e) => ({
            w: parseFloat(e.style.width),
            h: parseFloat(e.style.height),
            angle: parseFloat(e.style.transform.replace('rotate(', '')) || 0,
          }))
        const drag = async (el, dx, dy, ctrl = false) => {
          const pos = await centre(el)
          assert(
            await el.evaluate(
              (e, pos) =>
                e === document.elementFromPoint(pos.x, pos.y) ||
                e.contains(document.elementFromPoint(pos.x, pos.y)),
              pos,
            ),
            `${kind} covered target ${(await el.getAttribute('data-grip')) ?? (await el.getAttribute('data-edge')) ?? (await el.getAttribute('data-rotate-zone'))}`,
          )
          await p.mouse.move(pos.x, pos.y)
          if (ctrl) await p.keyboard.down('Control')
          await p.mouse.down()
          await p.mouse.move(pos.x + dx, pos.y + dy, { steps: 12 })
          await p.mouse.up()
          if (ctrl) await p.keyboard.up('Control')
          await p.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
        }
        const sz0 = await read(),
          fixed = await centre(o.locator('[data-grip=nw]'))
        await drag(o.locator('[data-grip=se]'), 38, 3)
        const sz1 = await read()
        assert(
          Math.abs(sz1.w / sz1.h - sz0.w / sz0.h) > 0.04,
          kind + ' free corner did not change aspect',
        )
        await drag(o.locator('[data-grip=se]'), 28, 16, true)
        const sz2 = await read()
        assert(Math.abs(sz2.w / sz2.h - sz1.w / sz1.h) < 0.003, kind + ' Ctrl corner changed aspect')
        const f2 = await centre(o.locator('[data-grip=nw]'))
        assert(Math.hypot(f2.x - fixed.x, f2.y - fixed.y) < 2, kind + ' fixed corner drift')
        await drag(o.locator('[data-edge=e]'), 19, 14)
        const sz3 = await read()
        assert(sz3.w > sz2.w && Math.abs(sz3.h - sz2.h) < 0.002, kind + ' edge changed two axes')
        const c = await centre(o),
          turn = o.locator('[data-rotate-zone=ne]'),
          pt = await centre(turn),
          a = (32 * Math.PI) / 180,
          dx = pt.x - c.x,
          dy = pt.y - c.y
        await drag(
          turn,
          dx * Math.cos(a) - dy * Math.sin(a) - dx,
          dx * Math.sin(a) + dy * Math.cos(a) - dy,
        )
        const sz4 = await read(),
          after = await centre(o)
        assert(
          Math.abs(sz4.angle - 32) < 1 &&
            Math.abs(sz4.w - sz3.w) < 0.002 &&
            Math.abs(sz4.h - sz3.h) < 0.002 &&
            Math.hypot(after.x - c.x, after.y - c.y) < 2,
          kind + ' rotation moved centre or resized',
        )
        for (const zone of ['nw', 'ne', 'sw', 'se']) {
          const z = o.locator(`[data-rotate-zone=${zone}]`),
            pt = await centre(z)
          assert(
            await z.evaluate((e, pos) => e === document.elementFromPoint(pos.x, pos.y), pt),
            kind + ' blocked outer ' + zone,
          )
        }
        assert(
          await o
            .locator('[data-grip]')
            .evaluateAll((es) =>
              es.every((e) => ['nesw-resize', 'nwse-resize'].includes(getComputedStyle(e).cursor)),
            ),
        )
        console.log(
          'PASS',
          kind,
          '4 outer hits, free corner / Ctrl ratio / opposite pin / single edge / centre rotation',
        )
        if (out && kind === 'image')
          await p.screenshot({ path: path.join(out, 'image-corners.png'), animations: 'disabled' })
      } finally {
        await p.close()
      }
    }
  } finally {
    await b.close()
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
