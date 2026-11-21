// node scripts/verify-reader-motion.cjs http://127.0.0.1:PORT (local Vite). Fresh Edge context per case; generated PDF and private clipboard only.
const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
const W = 320, H = 560, x = 75, y = 284, size = 16, text = 'Motion proof'
let browser, bytes
before(async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier)
  pdf.addPage([W, H]).drawText(text, { x, y, size, font })
  bytes = Buffer.from(await pdf.save())
  browser = await chromium.launch({ channel: 'msedge' })
})
after(() => browser?.close())

async function desk(t, { motion = 'on', pdf = true, reducedMotion = 'reduce' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion, serviceWorkers: 'block' })
  t.after(() => page.close())
  page.setDefaultTimeout(7000)
  await page.route(/^https?:\/\//, r => new URL(r.request().url()).origin === url.origin ? r.continue() : r.abort())
  await page.addInitScript(on => {
    localStorage.setItem('paperwork-animations', on)
    localStorage.setItem('paperwork-render-quality', 'smooth')
    window.__painted = key => { if (key.startsWith('page:')) window.readerPaint = key }
  }, motion)
  await page.goto(url.origin)
  const sheet = page.locator('#pdf-stage .pdf-page').first()
  if (pdf) {
    const file = page.waitForEvent('filechooser')
    await page.locator('.document-desk__actions button').first().click()
    await (await file).setFiles({ name: 'Motion proof.pdf', mimeType: 'application/pdf', buffer: bytes })
    await sheet.locator('.text-layer > .endOfContent').waitFor({ state: 'attached' })
  }
  return { page, sheet, turn: page.getByRole('button', { name: '向右旋转当前页', exact: true }),
    settings: page.getByRole('button', { name: '打开常用设置' }), toggle: page.getByRole('switch', { name: '界面动画' }) }
}

for (const motion of ['on', 'off']) test(`90° printed glyphs remain selectable with motion ${motion}`, async t => {
  const { page, sheet, turn } = await desk(t, { motion })
  await turn.click()
  await sheet.locator('.text-layer[data-main-rotation="90"] > .endOfContent').waitFor({ state: 'attached' })
  await page.waitForFunction(() => {
    const paper = document.querySelector('#pdf-stage .pdf-page')
    return window.readerPaint?.endsWith(':0:90') && !paper.style.transition && getComputedStyle(paper).transform === 'none'
  })
  await page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))))
  // No fit/zoom or resize after rotation: that would repair a stale text layer and mask the bug.
  const layer = sheet.locator('.text-layer'), box = await sheet.locator('canvas').boundingBox(), l = await layer.boundingBox()
  const px = box.x + box.width * (y + size * .32) / H
  const py = n => box.y + box.height * (x + n * size * .6 + .2) / W
  await page.mouse.move(px, py(1)); await page.mouse.down()
  try { await page.mouse.move(px, py(6), { steps: 8 }) } finally { await page.mouse.up() }
  const copied = await layer.evaluate(el => {
    const d = new DataTransfer(), ev = new ClipboardEvent('copy', { clipboardData: d, bubbles: true, cancelable: true })
    ;(getSelection().anchorNode?.parentElement || el).dispatchEvent(ev)
    return d.getData('text/plain')
  })
  t.diagnostic(`paper ${box.width.toFixed(2)}×${box.height.toFixed(2)}, layer ${l.width.toFixed(2)}×${l.height.toFixed(2)}, copy ${JSON.stringify(copied)}`)
  assert.equal(copied, text.slice(1, 6))
  for (const k of ['x', 'y', 'width', 'height']) assert(Math.abs(box[k] - l[k]) < 2, `layer ${k} differs from printed page`)
})

test('rotating paper excludes edit targets until settled or switched off', async t => {
  const { page, sheet, turn } = await desk(t)
  await page.getByRole('button', { name: '适合页面', exact: true }).click()
  const box = await sheet.boundingBox()
  await page.getByRole('button', { name: /^文本框：/ }).click()
  await sheet.click({ position: { x: box.width * .36, y: box.height * .46 } })
  const draft = sheet.locator('[data-inline-draft]'); await draft.fill('Edit target'); await draft.press('Control+Enter')
  await sheet.locator('[data-annotation-id] textarea').waitFor()
  await page.getByRole('button', { name: '添加水印', exact: true }).click()
  await page.getByRole('dialog', { name: '插入水印' }).getByRole('button', { name: '添加水印', exact: true }).click()
  await sheet.getByRole('toolbar', { name: '水印设置' }).waitFor()
  const turns = await turn.evaluate(async button => {
    const paper = document.querySelector('#pdf-stage .pdf-page'), tile = paper.querySelector('.watermark-tile')
    const ink = () => [getComputedStyle(tile).transform, getComputedStyle(tile.querySelector('.watermark-tile__text')).opacity]
    const frame = () => new Promise(requestAnimationFrame)
    // Actual hit-test stacks at the editor, watermark, outer grip and portaled rail,
    // including what's under the settings overlay when switching off mid-turn.
    function hits() {
      const tags = new Set()
      for (const probe of paper.querySelectorAll('.annotation textarea, .watermark-tile, [data-rotate-zone="ne"], .object-tools button:first-of-type')) {
        const r = probe.getBoundingClientRect()
        for (const el of document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)) if (paper.contains(el)) tags.add(el.tagName)
      }
      return [...tags]
    }
    const result = []
    for (const interrupt of [false, true]) {
      const ready = hits(), before = ink(), live = []
      button.click(); await Promise.resolve()
      while (paper.getAnimations().some(a => a.transitionProperty === 'transform') && live.length < 60) {
        live.push(hits())
        if (interrupt && live.length === 2) {
          document.querySelector('[aria-label="打开常用设置"]').click(); await Promise.resolve()
          document.querySelector('.settings-panel__motion input').click(); await Promise.resolve()
          break
        }
        await frame()
      }
      result.push({ ready, live, restored: hits(), transform: getComputedStyle(paper).transform, before, after: ink() })
    }
    return result
  })
  for (const { ready, live, restored, transform, before, after } of turns) {
    assert(ready.includes('TEXTAREA') && ready.includes('BUTTON') && live.length > 0, 'need real editor and handle hits and a running turn')
    const leaks = live.filter(list => list.length)
    assert.equal(leaks.length, 0, `${leaks.length}/${live.length} frames hit page descendants: ${leaks[0]}`)
    assert(restored.includes('TEXTAREA') && restored.includes('BUTTON'), `editor/handle not immediately hittable after turn: ${restored}`)
    assert.equal(transform, 'none')
    assert(before[0] !== 'none' && Number(before[1]) > 0 && Number(before[1]) < 1, 'use genuinely rotated, translucent document ink')
    assert.deepEqual(after, before, 'turning the page must preserve watermark rotation and opacity')
    t.diagnostic(`0/${live.length} frames hit the page; editor and handles restored; watermark opacity ${after[1]}`)
  }
})

test('turning motion off lands on the intended note before the next frame', async t => {
  const { page, settings, toggle } = await desk(t, { motion: 'off', reducedMotion: 'no-preference' })
  await page.getByRole('tab', { name: /^备注/ }).click()
  const write = page.getByRole('button', { name: '本页备注' })
  for (let i = 0; i < 12; ++i) await write.evaluate(b => b.click())
  await page.waitForFunction(() => document.querySelectorAll('.note-thread-card').length === 12 && document.activeElement === document.querySelector('.note-thread-card:last-child textarea'))
  // Calibrate the destination with motion OFF: the note editor itself has a 2px ink entrance.
  const intended = await page.locator('.notes-drawer__list').evaluate(list => {
    list.scrollTo({ top: 0, behavior: 'instant' })
    list.querySelector('.note-thread-card:last-child textarea').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    return list.scrollTop
  })
  await settings.click(); await toggle.click(); await page.keyboard.press('Escape')
  const result = await page.evaluate(async () => {
    const frame = () => new Promise(requestAnimationFrame), list = document.querySelector('.notes-drawer__list')
    list.scrollTo({ top: 0, behavior: 'instant' })
    document.querySelector('#pdf-stage .annotation--note:last-child [id^="note-pin-"]').click()
    for (let i = 0; i < 60 && list.scrollTop === 0; ++i) await frame()
    const during = list.scrollTop
    document.querySelector('[aria-label="打开常用设置"]').click(); await Promise.resolve()
    document.querySelector('.settings-panel__motion input').click(); await Promise.resolve()
    const offsets = [list.scrollTop]
    for (let i = 0; i < 8; ++i) { await frame(); offsets.push(list.scrollTop) }
    return { during, offsets }
  })
  t.diagnostic(JSON.stringify({ intended, ...result }))
  assert(result.during > 0 && result.during < intended, 'must interrupt an actual smooth jump')
  assert.deepEqual(result.offsets, Array(9).fill(intended))
})

test('only opening settings plays the panel and backdrop entrances', async t => {
  const { page, settings, toggle } = await desk(t, { pdf: false, motion: 'off' })
  for (const openedWithMotion of [false, true]) {
    await settings.click()
    const panel = page.locator('.settings-panel__panel')
    const entrance = await panel.evaluate(el => ({ panel: getComputedStyle(el).animationName,
      backdrop: getComputedStyle(el.parentElement).animationName, opaque: matchMedia('(prefers-reduced-transparency: reduce)').matches }))
    assert.equal(entrance.panel, openedWithMotion ? 'settings-panel-in' : 'none')
    assert.equal(entrance.backdrop, openedWithMotion && !entrance.opaque ? 'fade-in' : 'none')
    if (openedWithMotion) await toggle.click() // also check off/on within one opening
    const frames = await toggle.evaluate(async input => {
      const layer = input.closest('.settings-panel__backdrop'), panel = layer.querySelector('.settings-panel__panel')
      const read = () => [getComputedStyle(layer).opacity, getComputedStyle(panel).transform, ...[...layer.getAnimations(), ...panel.getAnimations()].map(a => a.animationName)]
      input.click(); await Promise.resolve(); const frames = [read()]
      for (let i = 0; i < 4; ++i) { await new Promise(requestAnimationFrame); frames.push(read()) }
      return frames
    })
    assert.deepEqual(frames, Array(5).fill(['1', 'none']))
    await page.keyboard.press('Escape')
  }
})
