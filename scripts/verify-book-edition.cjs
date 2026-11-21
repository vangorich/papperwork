// Local, deterministic application tests. Only generated PDFs and UI assets.
const { chromium } = require('playwright-core'),
  { PDFDocument } = require('pdf-lib'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto')
async function run() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert(url.hostname === '127.0.0.1')
  const out = process.argv[3]
  if (out) await fs.mkdir(out, { recursive: true })
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 6; i++)
    pdf.addPage([480, 655]).drawText(`Editorial proof / ${i + 1}`, { x: 40, y: 570, size: 16 })
  const bytes = Array.from(await pdf.save())
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const p = await browser.newPage({ viewport: { width: 1320, height: 860 } })
  p.setDefaultTimeout(6500)
  const shell = p.locator('.app-shell:visible'),
    stage = shell.locator('#pdf-stage'),
    bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' })
  const proof = (name) =>
    out
      ? p.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' })
      : Promise.resolve()
  const pt = async (el) => {
    const b = await el.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const sheet = stage.locator('.stage-page[data-current] .pdf-page')
  const pick = async () => {
    await bar.getByRole('button', { name: /^文本框：/ }).click()
    await sheet.click({ position: { x: 158, y: 140 } })
  }
  try {
    await p.goto(url.href)
    await shell.waitFor()
    const art = shell.locator('.folio-plate__surface'),
      image = art.locator('img')
    const hash = await image.evaluate(async (e) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest('SHA-256', await (await fetch(e.currentSrc)).arrayBuffer()),
        ),
      ]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join(''),
    )
    assert.equal(
      hash,
      crypto
        .createHash('sha256')
        .update(await fs.readFile(path.join(__dirname, '../src/assets/folded-folios.webp')))
        .digest('hex'),
    )
    await proof('paper-home')
    const a = await art.boundingBox()
    await p.mouse.move(a.x + a.width * 0.12, a.y + a.height * 0.24)
    await p.waitForFunction(
      () =>
        parseFloat(
          document.querySelector('.folio-plate__surface')?.style.getPropertyValue('--folio-x'),
        ) < -0.58,
    )
    const l = await art.screenshot()
    await p.mouse.move(a.x + a.width * 0.91, a.y + a.height * 0.73, { steps: 8 })
    await p.waitForFunction(
      () =>
        parseFloat(document.querySelector('.folio-plate__surface').style.getPropertyValue('--folio-x')) >
        0.7,
    )
    assert(!l.equals(await art.screenshot()), 'image must actually respond to pointer')
    console.log(
      'PASS original overhead artwork, cursor-following image:',
      await art.evaluate((e) => (e.hasAttribute('data-folio-live') ? 'WebGL' : 'CSS fallback')),
    )
    await p.emulateMedia({ reducedMotion: 'reduce' })
    await p.mouse.move(a.x + a.width * .2, a.y + a.height * .3)
    await p.waitForFunction(() => Number(document.querySelector('.folio-plate__surface').style.getPropertyValue('--folio-x')) < -.5)
    await p.getByRole('button', {name: '打开常用设置'}).press('Enter')
    await p.getByRole('switch', {name: '界面动画'}).press('Space')
    await p.keyboard.press('Escape')
    await p.waitForFunction(() => document.documentElement.dataset.motion === 'off' && !document.querySelector('.folio-plate__surface[data-tracking],.folio-plate canvas'))
    await p.emulateMedia({ reducedMotion: 'no-preference' })
    await p.evaluate((data) => {
      const dt = new DataTransfer()
      dt.items.add(new File([Uint8Array.from(data)], '书页校样.pdf', { type: 'application/pdf' }))
      document
        .querySelector('.app-shell')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    }, bytes)
    await sheet.locator('canvas').waitFor()
    assert.equal(await shell.locator('.folio-plate').count(), 0)
    const row = shell.locator('.thumbnail').first(),
      preview = await row.locator('.thumbnail__paper').boundingBox(),
      strip = await row.locator('.thumb-strip').boundingBox(),
      card = await row.boundingBox()
    assert(strip.y >= preview.y + preview.height - 1, 'commands overlap preview or still flank it')
    assert(Math.abs(preview.x + preview.width / 2 - card.x - card.width / 2) < 2)
    const more = row.getByRole('button', { name: /更多操作/ })
    await more.focus()
    await more.press('ArrowDown')
    const rm = p.getByRole('menu', { name: '第 1 页操作' })
    await rm.getByRole('menuitem', { name: '删除页面', exact: true }).waitFor()
    await proof('thumbnail-tools')
    await p.keyboard.press('Escape')
    assert(await more.evaluate((el) => el === document.activeElement))
    await row.getByRole('button', { name: '顺时针旋转 90 度' }).click()
    await row.locator('.thumb-strip__degrees').getByText('90°').waitFor()
    await p.keyboard.press('Control+z')
    console.log(
      `PASS zero left control column; preview ${Math.round(preview.width)} px, footer ${Math.round(strip.height)} px`,
    )
    await pick()
    const d = stage.locator('.inline-draft'),
      field = d.getByRole('textbox', { name: '文本内容' }),
      rail = stage.getByRole('toolbar', { name: '文本格式' })
    await field.waitFor()
    assert.equal(await field.inputValue(), '')
    await rail.getByRole('combobox', { name: '字体' }).selectOption('KaiTi')
    const size = rail.getByRole('spinbutton', { name: '字号' })
    await size.fill('23')
    await size.press('Enter')
    await rail.getByRole('button', { name: '粗体', exact: true }).click()
    assert.equal(await field.inputValue(), '')
    const before = await d.boundingBox(),
      f = await pt(field)
    await p.mouse.move(f.x, f.y)
    await p.mouse.down()
    await p.waitForFunction(() => document.querySelector('.inline-draft')?.dataset.dragMode === 'move')
    await p.mouse.move(f.x + 42, f.y + 21, { steps: 8 })
    await p.mouse.up()
    const after = await d.boundingBox()
    assert(Math.abs(after.x - before.x - 42) < 2 && Math.abs(after.y - before.y - 21) < 2)
    const knob = d.locator('[data-rotate-zone=ne]')
    await knob.focus()
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowRight')
    assert.match(await d.evaluate((e) => e.style.transform), /45deg/)
    assert(
      await d
        .locator('[data-grip]')
        .evaluateAll(
          (es) =>
            es.length === 4 &&
            es.every((e) => ['nesw-resize', 'nwse-resize'].includes(getComputedStyle(e).cursor)),
        ),
    )
    await proof('empty-text-tools')
    await field.fill('正文校样')
    await field.press('Control+Enter')
    const saved = stage.locator('.annotation--text[data-annotation-id]').first()
    await saved.waitFor()
    assert.equal(await saved.locator('textarea').inputValue(), '正文校样')
    assert.match(await saved.evaluate((e) => e.style.fontFamily), /KaiTi/)
    assert.equal(await saved.evaluate((e) => e.style.fontWeight), '700')
    assert.match(await saved.evaluate((e) => e.style.transform), /45deg/)
    console.log('PASS editable and movable BEFORE first character, style and angle retained at commit')
    await shell.getByRole('tab', { name: /常用语/ }).click()
    const ph = shell.getByRole('tabpanel', { name: '常用语' })
    const first = ph.locator('.common-phrase-card').first(),
      beforeP = await p.evaluate(
        () => JSON.parse(localStorage.getItem('paperwork-common-phrases-v2')).items,
      )
    await first.getByRole('button', { name: /管理常用语/ }).click()
    await p
      .getByRole('toolbar', { name: '常用语操作' })
      .getByRole('button', { name: /编辑常用语/ })
      .click()
    await ph.locator('.phrase-form textarea').fill('请复核附件')
    await ph.getByRole('combobox', { name: '字体' }).selectOption('SimSun')
    const sz = ph.getByRole('spinbutton', { name: '字号' })
    await sz.fill('25')
    await sz.press('Enter')
    await ph.getByRole('button', { name: '斜体', exact: true }).click()
    await ph.getByRole('button', { name: '保存修改' }).click()
    await p.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('paperwork-common-phrases-v2')).items[0].text === '请复核附件',
    )
    const afterP = await p.evaluate(
      () => JSON.parse(localStorage.getItem('paperwork-common-phrases-v2')).items,
    )
    assert.deepEqual(
      beforeP.map((s) => s.id),
      afterP.map((s) => s.id),
    )
    assert.equal(afterP[0].fontFamily, 'SimSun')
    assert.equal(afterP[0].fontSize, 25)
    assert.equal(afterP[0].italic, true)
    await first.getByRole('button', { name: /管理常用语/ }).click()
    await p.getByRole('button', { name: /编辑常用语/ }).click()
    await ph.locator('.phrase-form textarea').fill('不得保存')
    await ph.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await first.locator('strong').innerText(), '请复核附件')
    console.log('PASS phrase menu edits in place; id/order, typography, persistence and cancel')
    await shell.getByRole('tab', { name: /^备注/ }).click()
    const notes = shell.locator('#notes-panel')
    await p.evaluate(() => {
      const scroll = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (options) {
        if (this.id.startsWith('note-body-')) window.noteScroll = options?.behavior
        return scroll.call(this, options)
      }
    })
    await notes.getByRole('button', { name: '本页备注' }).click()
    await p.waitForFunction(() => window.noteScroll === 'instant')
    const body = notes.getByRole('textbox', { name: '备注内容' })
    await body.fill('书签位置已校对，待复核图版。')
    await body.press('Control+Enter')
    const byline = notes.getByRole('textbox', { name: '备注作者' })
    await byline.fill('校样员')
    await byline.press('Enter')
    const reply = notes.getByRole('textbox', { name: '回复此备注' })
    await reply.fill('已核对第 1 页。')
    await reply.press('Control+Enter')
    await notes.locator('.note-reply').getByText('已核对第 1 页。').waitFor()
    await proof('margin-notes')
    await shell.getByRole('tab', { name: /^备注/ }).click()
    console.log('PASS note composer, byline, body, reply thread')
    await bar.getByRole('button', { name: '添加水印', exact: true }).click()
    const dia = p.getByRole('dialog', { name: '插入水印' })
    await dia.getByRole('button', { name: '添加水印', exact: true }).click()
    const wr = stage.getByRole('toolbar', { name: '水印设置' }),
      ui = stage.locator('.watermark-ui')
    await wr.getByRole('combobox', { name: '字体' }).selectOption('Georgia')
    await wr.getByRole('button', { name: '斜体', exact: true }).click()
    await wr.getByRole('button', { name: '每页平铺水印' }).click()
    await p.waitForFunction(() => document.querySelectorAll('#pdf-stage .watermark-tile').length > 1)
    assert.equal(
      await stage
        .locator('.watermark-tile__text')
        .first()
        .evaluate((e) => getComputedStyle(e).fontStyle),
      'italic',
    )
    assert.match(
      await stage
        .locator('.watermark-tile__text')
        .first()
        .evaluate((e) => getComputedStyle(e).fontFamily),
      /Georgia/,
    )
    await wr.getByRole('button', { name: '水印样式' }).click()
    const opts = p.getByRole('dialog', { name: '水印样式' })
    await opts.getByRole('slider').fill('35')
    await opts.getByRole('slider').press('ArrowRight')
    await p.keyboard.press('Escape')
    const rc = ui.locator('[data-rotate-zone=ne]')
    await rc.focus()
    await rc.press('Home')
    for (let i = 0; i < 3; i++) await rc.press('Shift+ArrowRight')
    assert(
      await ui
        .locator('[data-grip]')
        .evaluateAll(
          (es) =>
            es.length === 4 &&
            es.every((e) => ['nesw-resize', 'nwse-resize'].includes(getComputedStyle(e).cursor)),
        ),
    )
    await proof('watermark-format')
    console.log('PASS shared watermark typography + opacity + tiling + native corner cursors')
  } finally {
    await browser.close()
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
