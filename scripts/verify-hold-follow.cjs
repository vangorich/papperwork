// Real mouse and frame-by-frame release checks. No host IPC or user files.
const { chromium } = require('playwright-core')
const { PDFDocument } = require('pdf-lib')
const assert = require('node:assert/strict')
const path = require('node:path')

async function run() {
  const { preview } = await import('vite')
  const server = await preview({ root: path.resolve(__dirname, '..'), logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge' })
    const p = await browser.newPage({ viewport: { width: 1480, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    await p.route(/^https?:\/\//, r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort())
    p.setDefaultTimeout(6500)
    if (process.argv.includes('--motion-off')) await p.addInitScript(() => localStorage.setItem('paperwork-animations', 'off'))
    const errors = []; p.on('pageerror', e => errors.push(e.message)); await p.goto(origin)
    const shell = p.locator('.app-shell:visible'), stage = shell.locator('#pdf-stage'), bar = shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' })
    const doc = await PDFDocument.create(); doc.addPage([560, 720]).drawText('Synthetic gesture test')
    const open = shell.locator('.document-desk__actions button').first()
    await open.waitFor().catch(e => { throw new Error(errors.join('; ') || e.message) })
    const [pick] = await Promise.all([p.waitForEvent('filechooser'), open.click()])
    await pick.setFiles({ name: 'gesture.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
    const page = stage.locator('.stage-page[data-current] .pdf-page')
    await page.locator('canvas').waitFor(); await shell.getByRole('button', { name: '适合页面', exact: true }).click(); p.setDefaultTimeout(6500)
    const frames = () => p.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))))
    const xy = el => el.evaluate(e => [e.style.left, e.style.top]); const near = (a, b, message) => assert(Math.abs(a - b) <= 2, `${message}: ${a} vs ${b}`)
    // Start before pointerup: sampling just the eventual rectangle would miss a one-frame flash.
    async function observeRelease(label, selector) {
      await p.evaluate(({ label, selector }) => {
        window.addEventListener('pointerup', () => {
          window.dropFrames = new Promise(resolve => {
            const result = []; const sample = () => {
              const page = document.querySelector('#pdf-stage .stage-page[data-current] .pdf-page')
              const rail = page?.querySelector(`.object-tools[aria-label="${label}"]`), obj = page?.querySelector(selector)
              const a = obj?.getBoundingClientRect(), b = rail?.getBoundingClientRect()
              const activeCorners = obj && b ? [...obj.querySelectorAll('[data-rotate-zone]')].map(z => z.getBoundingClientRect()).filter(z => z.right > b.left - 3 && z.left < b.right + 3) : []
              const clearance = a ? Math.max(9, ...activeCorners.map(z => z.bottom + 4 - a.bottom)) : 0
              result.push(rail && a && b && getComputedStyle(rail).visibility === 'visible' ? [b.left + b.width / 2 - a.left - a.width / 2, b.top - a.bottom, clearance] : null)
              if (result.length === 8) resolve(result); else requestAnimationFrame(sample)
            }; requestAnimationFrame(sample)
          })
        }, { capture: true, once: true })
      }, { label, selector })
    }
    async function checkDrop(kind) {
      const data = await p.evaluate(() => window.dropFrames); assert.equal(data.length, 8)
      assert(data.every(Boolean), `${kind}: missing/hidden rail on a release frame ${JSON.stringify(data)}`)
      for (const [center, gap, clearance] of data) { near(center, 0, `${kind} rail not centered`); near(gap, clearance, `${kind}: rail not immediately below the box and its rotation handles`); near(gap, data[7][1], `${kind}: rail jumped after release`) }
    }
    async function move(box, rail, kind, { cancel = false, quick = false } = {}) {
      const media = ['image', 'signature', 'stamp'].includes(kind), selector = kind === 'draft' ? '.inline-draft' : `.annotation--${kind}[data-annotation-id]`, hit = media ? box : box.locator('textarea'), b = await hit.boundingBox(), sx = b.x + Math.min(32, b.width / 3), sy = b.y + Math.min(11, b.height / 2)
      const initial = await xy(box); await frames(); const original = await box.boundingBox(), startBar = await rail.boundingBox(); assert(startBar)
      await p.mouse.move(sx, sy); await p.mouse.down()
      try {
        if (!quick) await p.waitForFunction(sel => !!document.querySelector(sel + '[data-move-preview]'), selector)
        for (const [dx, dy] of [[18, 10], [49, 24]]) {
          await p.mouse.move(sx + dx, sy + dy, { steps: 4 }); await frames(); const a = await box.boundingBox()
          near(a.x - original.x, dx, 'preview x'); near(a.y - original.y, dy, 'preview y')
          if (!media) {
            assert(await rail.isHidden(), 'font rail should be hidden while moving text')
            assert(await hit.evaluate(e => +getComputedStyle(e).opacity === 0 || getComputedStyle(e).visibility === 'hidden'), 'text should be replaced by its outline during drag')
          } else {
            const t = await rail.boundingBox(); assert(t && await rail.evaluate(e => getComputedStyle(e).pointerEvents === 'none'))
            near(t.x - startBar.x, dx, 'media rail x'); near(t.y - startBar.y, dy, 'media rail y')
          }
        }
        if (cancel) await p.keyboard.press('Escape')
        await observeRelease(media ? '图片格式' : '文本格式', selector)
      } finally { await p.mouse.up() }
      await checkDrop(kind); const now = await xy(box)
      if (cancel) assert.deepEqual(now, initial); else assert.notDeepEqual(now, initial)
      assert(await rail.evaluate(e => getComputedStyle(e).pointerEvents !== 'none')); return initial
    }
    if (!process.argv.includes('--watermark-only')) {
      await frames(); const r = await page.boundingBox(), x = r.x + r.width * .36, y = r.y + r.height * .35
      const textCmd = bar.getByRole('button', { name: /文本框：/ }); if (await textCmd.count()) await textCmd.click(); else { await bar.getByRole('button', { name: '插入', exact: true }).click(); await p.getByRole('menuitem', { name: '文本框', exact: true }).click() }
      await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 175, y + 52, { steps: 8 }); await p.mouse.up()
      const draft = stage.locator('.inline-draft'), font = stage.getByRole('toolbar', { name: '文本格式', exact: true }); await draft.locator('textarea').waitFor(); await font.waitFor()
      await move(draft, font, 'draft', { cancel: true }); await draft.locator('textarea').fill('Measure this interesting line'); await move(draft, font, 'draft'); await draft.locator('textarea').press('Control+Enter')
      const box = stage.locator('.annotation--text[data-annotation-id]'), field = box.locator('textarea'); await field.waitFor(); assert.equal(await field.inputValue(), 'Measure this interesting line')
      await field.click({ position: { x: 18, y: 10 } }); await frames(); const f = await field.boundingBox(), saved = await xy(box)
      await p.mouse.move(f.x + 8, f.y + 9); await p.mouse.down(); await p.mouse.move(f.x + 85, f.y + 9, { steps: 5 }); await p.waitForTimeout(270); await p.mouse.up()
      assert(await field.evaluate(e => e.selectionEnd > e.selectionStart)); assert.deepEqual(await xy(box), saved)
      await move(box, font, 'text'); await p.keyboard.press('Control+z'); await p.waitForFunction(([x, y]) => {const e = document.querySelector('#pdf-stage .annotation--text[data-annotation-id]'); return e?.style.left === x && e.style.top === y}, saved)
      console.log('PASS empty/typed/committed text; quick character selection, outline-only move, first-frame rail below, Esc and undo')
      const corner = box.locator('[data-rotate-zone=ne]'); await corner.focus(); await corner.press('Shift+ArrowRight'); await corner.press('Shift+ArrowRight'); await frames()
      const rotated = await field.boundingBox(), sheet = await page.boundingBox(), pane = await stage.boundingBox(), cx = rotated.x + rotated.width/2, cy = rotated.y + rotated.height/2
      await p.mouse.move(cx,cy); await p.mouse.down()
      try { await box.locator('xpath=self::*[@data-move-preview]').waitFor(); await p.mouse.move(cx,Math.min(sheet.y+sheet.height,pane.y+pane.height)-4,{steps:10}) } finally { await p.mouse.up() }
      await frames(); const edge = await box.boundingBox(), below = await font.boundingBox(); assert(below && below.y >= pane.y && below.y+below.height <= edge.y+1, 'when there is no room below the rotated box the controls must fit above it'); await font.getByRole('button',{name:'粗体',exact:true}).click({trial:true})
      console.log('PASS rotated text at bottom of viewport: reachable toolbar above rather than off-screen')
      const file = p.waitForEvent('filechooser'); await bar.getByRole('button', { name: '插入', exact: true }).click(); await p.getByRole('menuitem', { name: '插入图片', exact: true }).click()
      const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 50; const g = c.getContext('2d'); g.fillStyle = 'brown'; g.fillRect(0, 0, 80, 50); return c.toDataURL().split(',')[1] })
      await (await file).setFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await stage.locator('.placement-sheet').press('Enter')
      const obj = stage.locator('.annotation--image'), media = stage.getByRole('toolbar', { name: '图片格式', exact: true }); await media.waitFor()
      await move(obj, media, 'image', { cancel: true }); await move(obj, media, 'image', { quick: true }); console.log('PASS image rail remains attached during drag, cancel and drop')
      // Only the seal inventory is mocked. Both objects still go through the
      // real insert command, object handles, page editor and release handling.
      for (const kind of ['signature', 'stamp']) {
        const cmd = kind === 'signature' ? '插入签名' : '插入电子章'
        await bar.getByRole('button', { name: '插入', exact: true }).click()
        if (kind === 'signature') {
          const chooser = p.waitForEvent('filechooser'); await p.getByRole('menuitem', { name: cmd, exact: true }).click()
          await (await chooser).setFiles({ name:'signature.png', mimeType:'image/png', buffer:Buffer.from(png, 'base64') })
        } else {
          await p.evaluate(base64 => {
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const asset = { id:'test-stamp', name:'Test seal', fileName:'stamp.png', mimeType:'image/png', width:80, height:50, byteLength:bytes.length, sha256:'synthetic', createdAt:new Date(0).toISOString(), bytes }
            window.desktop = { listElectronicSeals:async () => [asset], readElectronicSeal:async () => asset }
          }, png)
          await p.getByRole('menuitem', { name: cmd, exact: true }).click(); await p.getByRole('button', { name:'插入当前页', exact:true }).click()
          await p.evaluate(() => { delete window.desktop })
        }
        const selector = `.annotation--${kind}[data-primary]`, object = page.locator(selector); await object.waitFor(); await frames()
        const a = await object.boundingBox(), x = a.x + a.width / 2, y = a.y + a.height / 2
        await p.mouse.move(x,y); await p.mouse.down(); try { await p.mouse.move(x-58, y-75, {steps:8}); await frames(); assert(await media.isVisible()); await observeRelease('图片格式', selector) } finally { await p.mouse.up() }
        await checkDrop(kind)
      }
      console.log('PASS inserted signature and stamp: working media controls at the committed position')
    }
    await bar.getByRole('button', { name: '添加水印', exact: true }).click(); await p.getByRole('dialog', { name: '插入水印' }).getByRole('button', { name: '添加水印', exact: true }).click()
    const wr = page.getByRole('toolbar', { name: '水印设置' }), proxy = page.locator('.watermark-ui'), selected = page.locator('.watermark-tile[data-selected]'); await wr.waitFor()
    const tileToggle = wr.getByRole('button', { name: '每页平铺水印' })
    for (const tiled of [false, true]) {
      if ((await tileToggle.getAttribute('aria-pressed') === 'true') !== tiled) await tileToggle.click()
      for (const cancel of [true, false]) {
        await frames(); const a = await selected.boundingBox(), b = await wr.boundingBox(), x = a.x + a.width / 2, y = a.y + a.height / 2, initial = await xy(proxy)
        await wr.evaluate(e => { window.originalWatermarkRail = e }); await p.mouse.move(x, y); await p.mouse.down()
        try {
          await p.mouse.move(x + 35, y + 22, { steps: 5 }); await frames(); const t = await wr.boundingBox(); assert(t, 'watermark controls blinked out during the gesture')
          near(t.x - b.x, 35, 'watermark rail x'); near(t.y - b.y, 22, 'watermark rail y')
          if (cancel) await p.keyboard.press('Escape'); await observeRelease('水印设置', '.watermark-ui')
        } finally { await p.mouse.up() }
        await checkDrop('watermark'); assert(await wr.evaluate(e => e === window.originalWatermarkRail), 'watermark controls remounted on release')
        if (cancel) assert.deepEqual(await xy(proxy), initial); else assert.notDeepEqual(await xy(proxy), initial)
      }
    }
    console.log('PASS single/tiled watermark rail: visible, same toolbar node, no misplaced release frames on commit or Escape')
  } finally { try { await browser?.close() } finally { await server.close() } }
}
run().catch(e => { console.error(e); process.exitCode = 1 })
