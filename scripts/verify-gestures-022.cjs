// Real mouse/keyboard regression against the local app only. No personal PDFs.
const { chromium } = require('playwright-core'),
  { PDFDocument } = require('pdf-lib'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path')
async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert(['localhost', '127.0.0.1'].includes(url.hostname))
  const out = process.argv[3]
  if (out) await fs.mkdir(out, { recursive: true })
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 100; i++)
    pdf.addPage([560, 720]).drawText('Proof ' + (i + 1), { x: 24, y: 670, size: 18 })
  const data = Array.from(await pdf.save())
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  let failed = 0
  const tests = {
    async ribbon({ p, bar }) {
      for (const w of [1440, 1024, 820, 640, 450, 320, 1280]) {
        await p.setViewportSize({ width: w, height: 760 })
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        const a = await bar.evaluate((e) => {
          const r = e.getBoundingClientRect()
          return [...e.querySelectorAll('button')]
            .filter(
              (b) =>
                b.getBoundingClientRect().width &&
                b.getBoundingClientRect().height &&
                !b.closest('[inert]'),
            )
            .map((b) => {
              const v = b.getBoundingClientRect()
              return { mid: (v.top + v.bottom) / 2, right: v.right, left: v.left, width: r.width }
            })
        })
        assert(
          a.length && a.every((q) => Math.abs(a[0].mid - q.mid) < 3 && q.left >= 0 && q.right <= w + 1),
          'command displaced at ' + w,
        )
        if (w === 640) {
          const more = bar.getByRole('button', { name: '更多工具', exact: true })
          await more.click()
          await p.getByRole('menu', { name: '更多工具' }).waitFor()
          if (out) await p.screenshot({ animations:'disabled', path:path.join(out,'ribbon-overflow.png') })
          const docGroup=p.getByRole('menuitem',{name:'文档操作',exact:true})
          if(await docGroup.count())await docGroup.click()
          await p.getByRole('menuitem',{name:'专项工具',exact:true}).click()
          await p.getByRole('menuitem',{name:'发票',exact:true}).click()
          assert.equal(await p.getByRole('menuitem',{name:/^发票/}).count(),3)
          await p.keyboard.press('ArrowLeft')
          await p.getByRole('menuitem',{name:'表单',exact:true}).waitFor()
          await p.keyboard.press('Escape')
          assert(await more.evaluate((b) => b === document.activeElement))
        }
      }
      const css = await p.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--stage').trim(),
      )
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css)
      assert(
        match &&
          Math.min(...match.slice(1).map(v=>parseInt(v,16)))>=210 &&
          Math.max(...match.slice(1).map(v=>parseInt(v,16)))-Math.min(...match.slice(1).map(v=>parseInt(v,16)))<=16 && parseInt(match[1],16)>parseInt(match[3],16) && parseInt(match[1],16)>=parseInt(match[2],16),
        'light desk must be a low-chroma warm paper neutral, not purple or saturated yellow',
      )
      if (out) await p.screenshot({ path: path.join(out, 'light-workspace.png') })
    },
    async text({ p, bar, stage }) {
      const pick = async () => {
        const quick = bar.getByRole('button', { name: /文本框：/ })
        if (await quick.count()) await quick.click()
        else {
          await bar.getByRole('button', { name: '插入', exact: true }).click()
          await p.getByRole('menuitem', { name: '文本框', exact: true }).click()
        }
      }
      const page = stage.locator('.stage-page[data-current] .pdf-page')
      const r = await page.boundingBox()
      const x = r.x + r.width * 0.29,
        y = r.y + 135
      await pick()
      await p.mouse.click(x, y)
      assert.equal(await p.getByRole('dialog').count(), 0, 'text placement must stay on page')
      const input = stage.locator('textarea[aria-label="文本内容"]:focus')
      await input.fill('弃稿')
      await p.keyboard.press('Escape')
      assert.equal(await stage.locator('[data-annotation-id]').count(), 0)
      await pick()
      await p.mouse.move(x, y)
      await p.mouse.down()
      await p.mouse.move(x + 230, y + 60, { steps: 8 })
      await p.mouse.up()
      await input.fill('Measure this line')
      const draft = stage.locator('.inline-draft'), prior=await draft.evaluate(e=>e.style.left)
      const editBox=await input.boundingBox(), qx=editBox.x+30,qy=editBox.y+12
      await p.mouse.move(qx,qy);await p.mouse.down();await p.waitForFunction(()=>document.querySelector('.inline-draft')?.dataset.dragMode==='move');await p.mouse.move(qx+24,qy+16,{steps:7});await p.mouse.up()
      const held=await draft.evaluate(e=>e.style.left);assert.notEqual(held,prior);assert.equal(await stage.locator('[data-annotation-id]').count(),0)
      await p.keyboard.press('Control+Enter')
      const box = stage.locator('.annotation--text[data-annotation-id]'),
        field = box.locator('textarea')
      assert.equal(await box.count(), 1)
      const style = () =>
        box.evaluate((e) => [
          e.style.left,
          e.style.top,
          e.style.width,
          e.style.height,
          e.style.transform,
        ])
      const initial = await style()
      const f = await field.boundingBox(),
        mx = f.x + 22,
        my = f.y + 9
      await p.mouse.click(mx, my)
      await p.mouse.move(mx, my)
      await p.mouse.down()
      await p.mouse.move(mx + 45, my, { steps: 4 })
      await p.mouse.up()
      assert.deepEqual((await style()).slice(0, 2), initial.slice(0, 2))
      assert(
        await field.evaluate((e) => e.selectionEnd > e.selectionStart),
        'quick drag selects characters',
      )
      await p.mouse.move(mx, my)
      await p.mouse.down()
      await p.waitForFunction(
        () => !!document.querySelector('#pdf-stage .annotation[data-drag-mode=move]'),
      )
      await p.mouse.move(mx + 55, my + 34, { steps: 8 })
      await p.mouse.up()
      assert.notEqual((await style())[0], initial[0])
      const h = box.locator('[data-rotate-zone=ne]')
      await h.focus()
      await p.keyboard.press('Shift+ArrowRight')
      assert.match((await style())[4], /15deg/)
      const pin = box.locator('[data-grip=nw]'),
        end = box.locator('[data-grip=se]')
      const midpoint = async (e) => {
        const b = await e.boundingBox()
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }
      const before = await midpoint(pin),
        pt = await midpoint(end)
      await p.mouse.move(pt.x, pt.y)
      await p.mouse.down()
      await p.mouse.move(pt.x + 48, pt.y + 31, { steps: 9 })
      await p.mouse.up()
      const after = await midpoint(pin)
      assert(Math.hypot(before.x - after.x, before.y - after.y) < 2, 'opposite rotated grip moved')
      assert.notEqual((await style())[2], initial[2])
      if (out) await p.screenshot({ path: path.join(out, 'inline-text.png') })
      const geom = await style(),
        rt = await midpoint(h),
        b = await box.boundingBox(),
        cx = b.x + b.width / 2,
        cy = b.y + b.height / 2
      await p.mouse.move(rt.x, rt.y)
      await p.mouse.down()
      await p.mouse.move(cx + 100, cy, { steps: 7 })
      await p.keyboard.press('Escape')
      await p.mouse.up()
      assert.deepEqual(await style(), geom, 'cancelling rotation changed geometry')
    },
    async wheel({ p, stage }) {
      const list = p.locator('.thumbnail-list--direct'),
        first = list.locator('.thumbnail').first(),
        id = await first.getAttribute('data-page-id'),
        grip = await first.getByRole('button', { name: '拖动排序' }).boundingBox(),
        b = await list.boundingBox()
      const x = b.x + b.width * 0.6,
        y = b.y + b.height * 0.5
      await p.mouse.move(grip.x + 10, grip.y + 10)
      await p.mouse.down()
      try {
        await p.mouse.move(x, y, { steps: 12 })
        await list.locator('[data-dragging]').waitFor()
        const stageY = await stage.evaluate((e) => e.scrollTop),
          initial = await list.evaluate((e) => e.scrollTop)
        await p.mouse.wheel(0, 1050)
        await p.waitForFunction(
          (v) => document.querySelector('.thumbnail-list--direct').scrollTop > v + 650,
          initial,
        )
        await p.waitForFunction(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('.thumbnail')?.hasAttribute('data-insertion'),
          { x, y },
        )
        const t = await list
          .locator('[data-insertion]')
          .evaluate((e) => ({
            i: e.parentElement.hasAttribute('data-index') ? +e.parentElement.dataset.index : [...e.closest('.thumbnail-list--direct').querySelectorAll('.thumbnail')].indexOf(e),
            after: e.dataset.insertion === 'after',
          }))
        assert(t.i > 1)
        assert.equal(await stage.evaluate((e) => e.scrollTop), stageY)
        await p.mouse.up()
        await p.waitForFunction(
          ({ id, i }) => {
            const row=document.querySelector(`.thumbnail[data-page-id="${id}"]`)
            return row && (row.parentElement.hasAttribute('data-index')?+row.parentElement.dataset.index:[...row.closest('.thumbnail-list--direct').querySelectorAll('.thumbnail')].indexOf(row))===i
          },
          { id, i: t.i + Number(t.after) - 1 },
        )
      } finally {
        await p.mouse.up()
      }
    },
    async phrase({ p }) {
      await p.getByRole('tab', { name: /常用语/ }).click()
      const row = p.locator('.common-phrase-card').first(),
        b = await row.boundingBox(),
        toggle = row.getByRole('button', { name: /管理常用语/ })
      await toggle.click()
      const menu = p.getByRole('toolbar', { name: '常用语操作' })
      await menu.waitFor()
      const rr = await row.boundingBox(),
        m = await menu.boundingBox()
      assert(
        Math.abs(b.height - rr.height) < 1 && m.height <= 48,
        'phrase menu changed card height or wrapped',
      )
      assert(m.x >= 0 && m.x + m.width <= 1441)
      console.log(`Phrase actions ${Math.round(m.width)}×${Math.round(m.height)} px; card ${Math.round(rr.height)} px before/after`)
      if(out)await p.screenshot({path:path.join(out,'phrase-actions.png')})
      await p.keyboard.press('Escape')
      assert(await toggle.evaluate((e) => e === document.activeElement))
    },
    async seal({ p, bar, stage }) {
      await bar.getByRole('button', { name: '添加水印', exact: true }).click()
      const d = p.getByRole('dialog', { name: '插入水印' })
      await d.getByRole('button', { name: '添加水印', exact: true }).click()
      const ui = stage.locator('.watermark-ui'),
        rot = ui.locator('[data-rotate-zone=ne]')
      await rot.waitFor()
      assert.equal(await ui.locator('[data-rotate-zone]').count(),4);assert.equal(await stage.locator('.transform-turn').count(),0)
      const strip = stage.getByRole('toolbar', { name: '水印设置' })
      const b = await strip.boundingBox()
      assert(b.width <= 385 && b.height <= 44 && await strip.getByRole('combobox',{name:'字体'}).count()===1, 'watermark should share the single-line text format rail: '+JSON.stringify(b)+' type controls='+await strip.getByRole('combobox',{name:'字体'}).count())
      console.log(`Watermark strip ${Math.round(b.width)}×${Math.round(b.height)} px`)
      const at=async el=>{const r=await el.boundingBox();return {x:r.x+r.width/2,y:r.y+r.height/2}}
      await rot.focus();await p.keyboard.press('Home');const centre=await at(ui),start=await at(rot),angle=37*Math.PI/180,dx=start.x-centre.x,dy=start.y-centre.y
      await p.mouse.move(start.x,start.y);await p.keyboard.down('Shift');await p.mouse.down();await p.mouse.move(centre.x+dx*Math.cos(angle)-dy*Math.sin(angle),centre.y+dx*Math.sin(angle)+dy*Math.cos(angle),{steps:12});await p.mouse.up();await p.keyboard.up('Shift')
      assert.match(await ui.evaluate(e=>e.style.transform),/30deg/)
      const pin=ui.locator('[data-grip=nw]'),moving=ui.locator('[data-grip=se]'),beforePin=await at(pin),g=await at(moving);const initialWidth=await ui.evaluate(e=>e.style.width)
      await p.mouse.move(g.x,g.y);await p.mouse.down();await p.mouse.move(g.x+46,g.y+26,{steps:10});await p.mouse.up();const afterPin=await at(pin);assert.notEqual(await ui.evaluate(e=>e.style.width),initialWidth);assert(Math.hypot(beforePin.x-afterPin.x,beforePin.y-afterPin.y)<2)
      await p.keyboard.press('Control+z');await p.waitForFunction(w=>document.querySelector('#pdf-stage .watermark-ui')?.style.width===w,initialWidth,{timeout:1800});assert.equal(await ui.evaluate(e=>e.style.width),initialWidth)
      await rot.dblclick();assert(['','rotate(0deg)'].includes(await ui.evaluate(e=>e.style.transform)))
      const before = await ui.evaluate((e) => e.style.transform)
      await rot.focus()
      await p.keyboard.press('Shift+ArrowRight')
      assert.notEqual(await ui.evaluate((e) => e.style.transform), before)
      await strip.getByRole('button', { name: '水印样式' }).click()
      await p.getByRole('slider', { name: '不透明度' }).focus()
      await p.keyboard.press('ArrowRight')
      await p.keyboard.press('Escape')
      if (out) await p.screenshot({ path: path.join(out, 'watermark-tools.png') })
    },
  }
  const shortPDF=await PDFDocument.create();for(let i=0;i<12;i++)shortPDF.addPage([560,720]).drawText(`Short ${i+1}`)
  const shortData=Array.from(await shortPDF.save());tests.wheelShort=tests.wheel
  try {
    for (const [name, fn] of Object.entries(tests)) {
      const p = await browser.newPage({ viewport: { width: 1440, height: 920 } })
      if (process.env.CASE && !process.env.CASE.split(',').includes(name)) {
        await p.close()
        continue
      }
      if (process.env.DIAG) {
        await p.addInitScript(() => {
          window.events = []
          for (const type of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'pointercancel',
            'lostpointercapture',
            'gotpointercapture',
            'dragstart',
            'wheel',
            'scroll',
            'blur',
          ])
            window.addEventListener(
              type,
              (e) => {
                const t = e.target
                window.events.push([
                  type,
                  t.className ?? t.nodeName,
                  e.buttons,
                  e.clientX,
                  e.clientY,
                  document.querySelector('.thumbnail-list--direct')?.scrollTop,
                  document.querySelector('.thumbnail[data-insertion]')?.getAttribute('aria-label'),
                  document.querySelector('#pdf-stage .annotation--text[data-annotation-id]')?.style.left,
                ])
                if (window.events.length > 35) window.events.shift()
              },
              true,
            )
        })
      }
      p.setDefaultTimeout(4500)
      try {
        await p.goto(url.href)
        const shell = p.locator('.app-shell:visible'),
          bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' }),
          stage = shell.locator('#pdf-stage')
        await shell.waitFor()
        await p.evaluate((b) => {
          const t = new DataTransfer()
          t.items.add(new File([Uint8Array.from(b)], '排版校样.pdf', { type: 'application/pdf' }))
          document
            .querySelector('.app-shell')
            .dispatchEvent(new DragEvent('drop', { dataTransfer: t, bubbles: true }))
        }, name==='wheelShort'?shortData:data)
        await stage.locator('.stage-page canvas').first().waitFor()
        await fn({ p, bar, stage })
        console.log('PASS', name)
      } catch (e) {
        failed++
        console.error('FAIL', name, e.stack)
        if (process.env.DIAG)
          console.error(
            await p.evaluate(() => ({
              events: window.events,
              hit: document.querySelector('.thumbnail[data-insertion]')?.dataset,
              pager: document.querySelector('input[aria-label^="当前页码"]')?.value,
            })),
          )
      } finally {
        await p.close()
      }
    }
  } finally {
    await browser.close()
  }
  if (failed) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
