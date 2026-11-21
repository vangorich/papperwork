// After building the web app: node scripts/verify-folio-pointer.cjs [built-web-directory]
// Real homepage + isolated Edge profiles; native mouse/pen/touch and explicitly simulated VM events.
// Nothing is served on the network or read from the user's documents.
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const dist = path.resolve(process.argv[2] || path.join(__dirname, '../dist-tauri'))
const origin = 'https://folio.test', surface = '.folio-plate__surface'

async function openDesk(browser, hasTouch, options = {}) {
  const context = await browser.newContext({ hasTouch, viewport: { width: 1360, height: 900 }, reducedMotion: options.reducedMotion || 'no-preference', forcedColors: options.forcedColors || 'none', serviceWorkers: 'block' })
  if (options.legacyMedia) await context.addInitScript(() => {
    const match = window.matchMedia.bind(window)
    // Unsupported media features match neither value; don't accidentally simulate an actual opt-out.
    window.matchMedia = query => match(query.replace(/forced-colors:/g, 'unavailable-colors:'))
  })
  if (options.slowFrames) await context.addInitScript(() => {
    window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 125)
    window.cancelAnimationFrame = clearTimeout
  })
  if (options.rejectShader) await context.addInitScript(() => {
    const native = WebGL2RenderingContext.prototype.shaderSource
    WebGL2RenderingContext.prototype.shaderSource = function(shader, source) {
      if (source.includes('attribute vec3 paper;')) { window.folioShaderRejected = true; source += '\n#error QA_folio_shader_refused' }
      return native.call(this, shader, source)
    }
  })
  await context.route('**/*', route => {
    const url = new URL(route.request().url()), file = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
    if (url.origin !== origin || /\.\.|[:\\]/.test(file)) return route.abort()
    const local = [path.join(dist, file), path.join(__dirname, '../public', file)].find(existsSync)
    return route.fulfill(local ? { path: local } : { status: 404, body: '' })
  })
  if (hasTouch) await context.addInitScript(() => localStorage.setItem('paperwork-theme', 'dark'))
  const page = await context.newPage()
  await page.goto(origin)
  const plate = page.locator(surface)
  await plate.locator('img').evaluate(img => img.decode())
  await page.locator('.document-desk__sheet').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)))
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), hasTouch)
  if (hasTouch) assert.equal(await page.evaluate(() => matchMedia('(any-hover: hover) and (any-pointer: fine)').matches), false, 'fixture no longer emulates touch-only capability reporting')
  assert.equal(await page.locator('html').evaluate(el => el.classList.contains('dark')), hasTouch)
  await plate.evaluate(el => {
    const qa = window.folioPointerQA = { mouse: 0, touch: 0, pen: 0, tracking: 0, writes: 0, firstY: null }
    el.closest('.document-desk').addEventListener('pointermove', e => { if (e.isTrusted && e.isPrimary) qa[e.pointerType]++ })
    new MutationObserver(records => {
      records.forEach(r => qa[r.attributeName === 'style' ? 'writes' : 'tracking']++)
      const y = el.style.getPropertyValue('--folio-y')
      if (qa.firstY === null && y !== '') qa.firstY = Number(y)
    }).observe(el, { attributes: true, attributeFilter: ['style', 'data-tracking'] })
  })
  return { context, page, plate }
}

// Measure the printed registration mark AND the lower edge of the paper, in painted pixels.
async function marks(plate) {
  const png = await plate.screenshot()
  return plate.evaluate(async (_, data) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
    const { data: rgba } = ctx.getImageData(0, 0, c.width, c.height)
    let n = 0, sumX = 0, sumY = 0
    for (let y = Math.floor(c.height * .36); y < c.height * .56; ++y) {
      for (let x = Math.floor(c.width * .43); x < c.width * .64; ++x) {
        const i = 4 * (y * c.width + x)
        if (rgba[i] - rgba[i + 1] > 65) { ++n; sumX += x; sumY += y }
      }
    }
    if (!n) throw Error('Registration cross not visible')
    const col = Math.round(c.width * .54)
    for (let y = Math.floor(c.height * .68); y < c.height * .90; y++) {
      const i = (y * c.width + col) * 4, hi = rgba[i - 4 * c.width], lo = rgba[i]
      if (hi >= 120 && lo < 120) return [sumX / n, sumY / n, y - 1 + (hi - 120) / (hi - lo)]
    }
    throw Error('Front leaf edge not visible')
  }, png.toString('base64'))
}

async function sweep(page, plate, label, move = (x, y) => page.mouse.move(x, y), stationary = false) {
  const box = await plate.boundingBox(), positions = []
  for (const t of [.13, .87, .13]) {
    await move(box.x + box.width * t, box.y + box.height * t)
    // Sample the same 0.4 second interval at 30, 60 or 144 Hz, including when input was ignored.
    await page.waitForTimeout(400)
    positions.push(await marks(plate))
  }
  const delta = (a, b) => b.map((v, i) => +(v - a[i]).toFixed(2))
  const [forward, back] = [delta(positions[0], positions[1]), delta(positions[1], positions[2])]
  console.log(label, 'Δpx [cross X, cross Y, paper edge Y]:', forward, back)
  if (stationary) assert.deepEqual([forward, back], [[0, 0, 0], [0, 0, 0]])
  else {
    assert(forward.every(n => n > 1) && back.every(n => n < -1), 'printed mark and paper edge must move with the pointer in both directions')
    assert(forward[2] > 5 && back[2] < -5, 'paper edge motion must be visible, not just a one-pixel wobble')
  }
}

async function checkTouchAndPen({ context, page, plate }) {
  const cdp = await context.newCDPSession(page)
  // Headless Playwright otherwise keeps each tab focused even when another is in front.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const other = await context.newPage(); await other.bringToFront()
  await page.waitForFunction(s => !document.hasFocus() && !document.querySelector(s).dataset.tracking, surface)
  assert.equal(await plate.locator('img').evaluate(el => getComputedStyle(el).transform), 'none')
  await other.close(); await page.bringToFront()
  await page.mouse.move(1, 1)
  await page.setViewportSize({ width: 660, height: 510 })
  await plate.scrollIntoViewIfNeeded()
  const stage = page.locator('#pdf-stage'), top = await stage.evaluate(el => el.scrollTop)
  const box = await plate.boundingBox(), x = box.x + box.width / 2, y = box.y + 75
  const changes = () => page.evaluate(() => window.folioPointerQA.tracking)
  const before = await changes()
  for (const dy of [0, 10, 30, 60, 95]) await cdp.send('Input.dispatchTouchEvent', { type: dy ? 'touchMove' : 'touchStart', touchPoints: [{ x, y: y + dy }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const scroll = top - await stage.evaluate(el => el.scrollTop)
  assert(scroll > 15, `native finger pan did not scroll the desk: ${scroll}px`)
  assert(await page.evaluate(() => window.folioPointerQA.touch > 0))
  assert.equal(await changes(), before, 'touch pan activated the folio')
  await page.setViewportSize({ width: 1360, height: 900 })
  const r = await plate.boundingBox(), px = r.x + r.width / 2, py = r.y + r.height / 2
  // A tap (unlike a pan) can also generate a mousemove; neither labelled nor unlabelled contact is hover.
  await page.touchscreen.tap(px, py)
  await plate.dispatchEvent('mousemove', { clientX: px, clientY: py, buttons: 0 })
  await plate.dispatchEvent('pointermove', { pointerType: '', width: 13, height: 14, pressure: .4, clientX: px, clientY: py })
  assert.equal(await changes(), before, 'touch compatibility mouse or unclassified contact activated tracking')
  const pen = (type, x, y, buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button: type === 'mouseMoved' ? 'none' : 'left', buttons })
  await pen('mousePressed', px, py, 1); await pen('mouseMoved', px + 25, py, 1); await pen('mouseReleased', px + 25, py)
  assert(await page.evaluate(() => window.folioPointerQA.pen > 0), 'no primary pen input reached the desk')
  assert.equal(await changes(), before, 'pen contact activated the folio')
  await sweep(page, plate, 'hovering pen', (x, y) => pen('mouseMoved', x, y))
  assert(await page.evaluate(() => window.folioPointerQA.pen >= 3))
  console.log('finger pan:', scroll, 'px; touch and pen contact did not activate tracking')
}

async function checkMotionSettings(browser) {
  const { context, page, plate } = await openDesk(browser, false, { reducedMotion: 'reduce' })
  const open = () => page.getByRole('button', { name: '打开常用设置' }).press('Enter')
  const toggle = page.getByRole('switch', { name: '界面动画' })
  const motion = () => page.locator('html').getAttribute('data-motion')
  assert.equal(await motion(), 'on')
  assert.equal(await plate.locator('..').getByRole('button').count(), 0, 'no separate cover controls')
  await sweep(page, plate, 'default ON with OS animations disabled')
  await open()
  assert(await toggle.isChecked())
  assert.equal(await page.locator('.settings-panel__panel').evaluate(el => getComputedStyle(el).animationName), 'settings-panel-in')

  // Queue a real folio update, then operate the real switch in the SAME task, before paint.
  // Only count requests made by this pointer event, not focus, PDF painting or Playwright.
  const stopped = await toggle.evaluate(async input => {
    const host = document.querySelector('.folio-plate__surface'), desk = host.closest('.document-desk')
    const box = host.getBoundingClientRect(), event = () => desk.dispatchEvent(new MouseEvent('mousemove', { clientX: box.right - 7, clientY: box.bottom - 6 }))
    desk.dispatchEvent(new PointerEvent('pointerleave'))
    const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame, pending = new Set()
    window.requestAnimationFrame = cb => { const id = raf.call(window, cb); pending.add(id); return id }
    window.cancelAnimationFrame = id => { pending.delete(id); caf.call(window, id) }
    try {
      event()
      const queued = pending.size
      window.requestAnimationFrame = raf
      input.click(); await Promise.resolve()
      event()
      return { queued, pending: pending.size, state: document.documentElement.dataset.motion, tracking: !!host.dataset.tracking,
        pose: host.style.getPropertyValue('--folio-x'), canvas: !!host.querySelector('canvas'), animations: document.getAnimations().length }
    } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf }
  })
  assert.deepEqual(stopped, { queued: 1, pending: 0, state: 'off', tracking: false, pose: '', canvas: false, animations: 0 })
  await page.keyboard.press('Escape')
  assert(await page.getByRole('button', {name: '打开常用设置'}).evaluate(el => el === document.activeElement))
  await sweep(page, plate, 'OFF under reduce', undefined, true)
  await page.reload(); await plate.locator('img').evaluate(img => img.decode())
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.equal(await motion(), 'off')
  await sweep(page, plate, 'persisted OFF after reload with OS animations enabled', undefined, true)
  await open(); assert.equal(await toggle.isChecked(), false)
  assert.equal(await page.locator('.settings-panel__panel').evaluate(el => getComputedStyle(el).animationName), 'none')
  await toggle.press('Space'); await page.keyboard.press('Escape')
  await page.reload(); await plate.locator('img').evaluate(img => img.decode())
  assert.equal(await motion(), 'on')
  await sweep(page, plate, 'keyboard ON persisted after reload')
  await page.emulateMedia({ forcedColors: 'active' })
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'off')
  await sweep(page, plate, 'forced colors retain static, high-contrast UI', undefined, true)
  await open(); assert(await toggle.isChecked(), 'forced colors must not overwrite the stored choice')
  await page.keyboard.press('Escape'); await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' })
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'on')
  await page.keyboard.press('Control+p')
  await page.waitForFunction(() => document.querySelector('.print-center') && !document.querySelector('.document-desk[data-animated]'))
  await plate.dispatchEvent('mousemove', {clientX: 40, clientY: 60})
  assert.equal(await plate.getAttribute('data-tracking'), null, 'folio tracking behind print center')
  await page.keyboard.press('Escape')
  await open(); await toggle.press('Space')
  await page.getByRole('button', { name: '恢复默认设置' }).press('Enter')
  assert(await toggle.isChecked(), 'restore defaults must restore motion')
  await page.keyboard.press('Escape')

  const img = await plate.locator('img').elementHandle()
  const { PDFDocument } = require('pdf-lib'), pdf = await PDFDocument.create()
  pdf.addPage([220, 330])
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.document-desk__actions button').first().press('Enter')
  await (await chooser).setFiles({ name: 'folio-motion-proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) })
  await page.locator('#pdf-stage .pdf-page canvas').first().waitFor()
  assert.equal(await page.locator(surface).count(), 0)
  assert.equal(await img.evaluate(el => el.isConnected || el.getAnimations().length > 0), false)
  await img.dispose()

  // A page rotating under Windows' reduced-motion preference must also release its
  // temporary pointer lock when the app switch is flipped mid-turn, before another frame.
  const turn = page.getByRole('button', { name: '顺时针旋转 90 度', exact: true }).first()
  await turn.waitFor(); await open()
  const rotation = await turn.evaluate(async button => {
    const sheet = document.querySelector('#pdf-stage .pdf-page')
    const state = () => [getComputedStyle(sheet).pointerEvents === 'none', sheet.style.transition.includes('transform')]
    button.click(); await Promise.resolve(); const running = state()
    document.querySelector('.settings-panel__motion input').click(); await Promise.resolve(); const stopped = state()
    button.click(); await Promise.resolve()
    return [running, stopped, state()]
  })
  assert.deepEqual(rotation, [[true, true], [false, false], [false, false]])
  await context.close()
  console.log('PASS same-frame cancellation, keyboard switch, stored ON/OFF, system overrides, print, document teardown and page rotation')
}

async function checkOldWebView(browser) {
  const { context, page, plate } = await openDesk(browser, false, { slowFrames: true, legacyMedia: true })
  // Model unsupported declarations in the actual loaded stylesheets, not a fake CSS.supports() result.
  await page.evaluate(() => {
    const strip = rules => {
      for (const rule of rules) {
        if (rule.cssRules) strip(rule.cssRules)
        if (rule.style) for (const prop of Array.from(rule.style)) {
          if (['translate','rotate','scale'].includes(prop) || /perspective\(|rotate[XYZ]\(|color-mix\(|\d(?:cqi|cqw)\b/i.test(rule.style.getPropertyValue(prop))) rule.style.removeProperty(prop)
        }
      }
    }
    for (const sheet of document.styleSheets) strip(sheet.cssRules)
  })
  assert.equal(await page.evaluate(() => matchMedia('(forced-colors: none)').matches || matchMedia('(forced-colors: active)').matches), false)
  const box = await plate.boundingBox(), rest = await marks(plate)
  await plate.dispatchEvent('mousemove', { clientX: box.x + box.width * .95, clientY: box.y + box.height * .95, buttons: 0 })
  // The observer records the very first 125ms tick. A fixed per-frame lerp only travels 36%.
  const pose = await (await page.waitForFunction(() => window.folioPointerQA.firstY, null, { polling: 10 })).jsonValue()
  assert(pose > .70, `slow first frame hardly moved: ${pose}`)
  const edge = (await marks(plate))[2] - rest[2]
  assert(edge > 4, `software page did not move at simulated 8 Hz: ${edge}`)
  console.log('simulated 8 Hz, 2D CSS, unknown contrast media: first pose =', pose, 'paper edge Δpx =', edge.toFixed(2))
  await context.close()
}

async function main() {
  for (const noGL of [true, false]) {
    const browser = await chromium.launch({ channel: 'msedge', args: noGL ? ['--disable-gpu', '--disable-webgl'] : [] })
    try {
      for (const hasTouch of noGL ? [false, true] : [true]) {
        const desk = await openDesk(browser, hasTouch), { context, page, plate } = desk
        const buttons = page.locator('.document-desk__actions button')
        await buttons.first().focus(); await page.keyboard.press('Tab')
        if (!noGL) {
          await plate.hover()
          await page.locator(`${surface}[data-folio-live] canvas`).waitFor()
        }
        await sweep(page, plate, `${hasTouch ? 'primary coarse + mouse' : 'desktop mouse'}, ${noGL ? 'WebGL disabled' : 'WebGL'}`)
        assert(await page.evaluate(() => window.folioPointerQA.mouse >= 3))
        assert(await buttons.nth(1).evaluate(el => el.matches(':focus-visible')), 'hover stole keyboard focus')
        const writes = await page.evaluate(() => window.folioPointerQA.writes)
        await page.waitForTimeout(200)
        assert.equal(await page.evaluate(() => window.folioPointerQA.writes), writes, 'idle folio still updating its pose')
        const canvas = plate.locator('canvas')
        if (!noGL) {
          await canvas.evaluate(c => c.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext())
          await canvas.waitFor({ state: 'detached' })
          await page.mouse.move(1, 1)
          await sweep(page, plate, 'after real WebGL context loss and pointer re-entry')
        }
        assert.equal(await canvas.count(), 0)
        if (hasTouch && noGL) {
          for (const [label, type, init] of [
            ['compatibility mousemove only', 'mousemove', {}],
            ['unclassified hover, no primary flag', 'pointermove', { pointerType: '', isPrimary: false, pressure: 0, width: 1, height: 1 }],
            ['virtual mouse, no primary flag', 'pointermove', { pointerType: 'mouse', isPrimary: false }],
          ]) {
            await sweep(page, plate, label, (x, y) => plate.dispatchEvent(type, { ...init, clientX: x, clientY: y, buttons: 0 }))
          }
          await checkTouchAndPen(desk)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await sweep(page, plate, 'pointer with OS animations disabled')
        }
        await page.mouse.move(1, 1)
        assert.equal(await plate.getAttribute('data-tracking'), null)
        await context.close()
      }
      if (noGL) {
        await checkMotionSettings(browser)
        await checkOldWebView(browser)
      } else {
        const { context, page, plate } = await openDesk(browser, false, { rejectShader: true })
        await plate.hover()
        await page.waitForFunction(() => window.folioShaderRejected)
        await plate.locator('canvas').waitFor({ state: 'detached', timeout: 2500 })
        await sweep(page, plate, 'rejected relief shader')
        await context.close()
      }
    } finally { await browser.close() }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
