// Run from any directory: node scripts/verify-folio-025.cjs [built-web-directory]
// Without an argument, build the real App into TEMP. Route static files through Playwright's
// pipe: no HTTP server, installed app, existing profile or user documents are used.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright-core')
const { PDFDocument, rgb } = require('pdf-lib')
const root = path.resolve(__dirname, '..'), origin = 'https://folio.test'
const surface = '.folio-plate__surface'

async function main() {
  const qa = await fs.mkdtemp(path.join(os.tmpdir(), 'paperwork-folio-025-'))
  console.log('QA:', qa)
  const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(qa, 'web')
  if (!process.argv[2]) {
    process.chdir(root) // Tailwind resolves its config/content from the working directory.
    const { build } = await import('vite')
    const { offlineQpdf } = await import('../build/qpdf-engine.mjs')
    await build({ root, configFile: false, publicDir: false, base: './', logLevel: 'error',
      cacheDir: path.join(qa, 'cache'), plugins: [offlineQpdf()],
      worker: { format: 'es', plugins: () => [offlineQpdf()] }, build: { outDir: dist, reportCompressedSize: false } })
  }
  const browser = await chromium.launch({ channel: 'msedge' })
  const errors = []
  try {
    async function pageFor({ dark = false, fallback = false, width = 1360 } = {}) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
      await ctx.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) { errors.push(url.origin); return route.abort() }
        const rel = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
        if (rel.includes('..') || /[:\\]/.test(rel)) return route.abort()
        let file = path.join(dist, rel)
        try { await fs.access(file) } catch {
          file = rel.startsWith('pdfjs/') ? path.join(root, 'node_modules/pdfjs-dist', rel.slice(6)) : path.join(root, 'public', rel)
        }
        try { return await route.fulfill({ path: file }) } catch { return route.fulfill({ status: 404, body: '' }) }
      })
      await ctx.addInitScript(({ dark, fallback }) => {
        if (dark) localStorage.setItem('paperwork-theme', 'dark')
        const qa = window.folioQA = { attempts: 0, draws: 0, last: 0 }
        const context = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (name, ...options) {
          if (name === 'webgl2') { ++qa.attempts; if (fallback) return null }
          return context.call(this, name, ...options)
        }
        if (!window.WebGL2RenderingContext) return
        const proto = WebGL2RenderingContext.prototype, draw = proto.drawElements
        proto.drawElements = function (...args) {
          if (this.canvas.closest('.folio-plate')) { ++qa.draws; qa.last = performance.now() }
          return draw.apply(this, args)
        }
      }, { dark, fallback })
      const page = await ctx.newPage()
      page.on('pageerror', e => errors.push(e.message))
      page.on('console', m => { if (m.type() === 'error' && /shader|WebGLProgram/i.test(m.text())) errors.push(m.text()) })
      await page.goto(origin)
      await page.locator(`${surface} img`).evaluate(el => el.decode())
      await page.locator('.document-desk__sheet').evaluate(async sheet => {
        await document.fonts.ready
        await Promise.all(sheet.getAnimations({ subtree: true }).map(a => a.finished))
      })
      return page
    }
    const p = await pageFor(), art = p.locator(surface)
    const source = await art.locator('img').evaluate(async el => {
      const digest = await crypto.subtle.digest('SHA-256', await (await fetch(el.currentSrc)).arrayBuffer())
      return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
    })
    assert.equal(source, createHash('sha256').update(await fs.readFile(path.join(root, 'src/assets/folded-folios.webp'))).digest('hex'))
    async function aim(page, x, y = 0.5) {
      const box = await page.locator(surface).boundingBox()
      await page.mouse.move(box.x + x * box.width, box.y + y * box.height)
    }
    async function settled(page, x, y = .5) {
      await page.waitForFunction(({ surface, x, y }) => {
        const el = document.querySelector(surface)
        const near = (axis, target) => Math.abs(parseFloat(el.style.getPropertyValue('--folio-' + axis)) - (2 * target - 1)) < .008
        return near('x', x) && near('y', y) && (!el.dataset.folioLive || performance.now() - window.folioQA.last > 150)
      }, { surface, x, y })
    }
    // Measure the photographed red registration cross and two pieces of its front fold. Follow
    // the cross when sampling so translating a pre-lit photograph alone cannot pass the glint test.
    async function sample(name) {
      const png = await art.screenshot({ path: path.join(qa, name + '.png') })
      return p.evaluate(async png => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode()
        const c = document.createElement('canvas'); c.width = image.width; c.height = image.height
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0)
        const { data } = ctx.getImageData(0, 0, c.width, c.height)
        let count = 0, sum = 0
        for (let y = Math.floor(c.height * .39); y < c.height * .54; y++) for (let x = Math.floor(c.width * .46); x < c.width * .62; x++) {
          const i = (y * c.width + x) * 4
          if (data[i] - data[i + 1] > 65) { count++; sum += x + .5 }
        }
        if (!count) throw Error('red registration cross missing')
        const cross = sum / (count * c.width), dx = cross - 541 / 1008
        function light(x, y) {
          let luminance = 0, n = 0
          for (let j = Math.floor(c.height * (y - .006)); j <= c.height * (y + .006); j++) for (let k = Math.floor(c.width * (x - .013)); k <= c.width * (x + .013); k++) {
            const i = 4 * (j * c.width + k); luminance += .213 * data[i] + .715 * data[i + 1] + .072 * data[i + 2]; n++
          }
          return luminance / n
        }
        function bottomEdge(x) {
          const col = Math.round(c.width * x)
          for (let y = Math.floor(c.height * .72); y < c.height * .86; y++) {
            const i = 4 * (y * c.width + col), hi = data[i - 4 * c.width], lo = data[i]
            if (hi >= 120 && lo < 120) return y - 1 + (hi - 120) / (hi - lo)
          }
          throw Error('front leaf missing')
        }
        const bow = bottomEdge(.54 + dx) - (bottomEdge(.35 + dx) + bottomEdge(.73 + dx)) / 2
        return { cross, bow, l: light(.38 + dx, .594), r: light(.70 + dx, .594), face: light(.40 + dx, .45), bed: light(.15, .75) }
      }, png.toString('base64'))
    }
    assert.equal(await art.locator('canvas').count(), 0)
    await p.screenshot({ path: path.join(qa, 'light.png'), animations: 'disabled' })
    await aim(p, .08); await p.locator(`${surface}[data-folio-live]`).waitFor(); await settled(p, .08)
    const left = await sample('fold-left')
    await aim(p, .92); await settled(p, .92)
    const right = await sample('fold-right')
    const draws = await p.evaluate(() => window.folioQA.draws)
    await p.waitForTimeout(350)
    assert(draws > 0); assert.equal(await p.evaluate(() => window.folioQA.draws), draws, 'still drawing at idle')
    assert(right.cross - left.cross > .018, 'leaves did not shift relative to the bed')
    assert(left.l - right.l > 2 && right.r - left.r > 2, `fold illumination must reverse: ${JSON.stringify({ left, right })}`)
    assert(Math.abs(left.face - right.face) < 2 && Math.abs(left.bed - right.bed) < .3, 'light spilled off the fold')
    await aim(p, .5); await settled(p, .5); const rest = await sample('fold-neutral')
    await aim(p, .5, .97); await settled(p, .5, .97); const flex = await sample('fold-bend')
    const bendPx = flex.bow - rest.bow
    assert(bendPx > .55, `free edge did not bend relative to both corners: ${bendPx}px`)
    console.log('PASS WebGL relief, crease light reversal, edge bend and idle draws', { left, right, bendPx, idleDraws: 0 })
    await p.emulateMedia({ reducedMotion: 'reduce' }); await aim(p, .82); await settled(p, .82)
    for (const media of [{ forcedColors: 'active' }, { media: 'print' }]) {
      await p.emulateMedia(media); await p.waitForFunction(s => !document.querySelector(s + ' canvas'), surface)
      await aim(p, .14); assert.equal(await art.getAttribute('data-tracking'), null)
      await p.emulateMedia({ media: 'screen', forcedColors: 'none', reducedMotion: 'reduce' })
      await p.waitForFunction(() => document.documentElement.dataset.motion === 'on')
      await aim(p, .78); await p.locator(`${surface}[data-folio-live]`).waitFor()
    }
    // Turn off a live GPU relief from settings, not just a software fallback.
    await p.getByRole('button', { name: '打开常用设置' }).press('Enter')
    const toggle = p.getByRole('switch', { name: '界面动画' })
    await art.dispatchEvent('mousemove', {clientX: 840, clientY: 350})
    const live = await art.locator('canvas').elementHandle()
    await toggle.press('Space')
    assert(await live.evaluate(c => !c.isConnected && c.getContext('webgl2').isContextLost()))
    await live.dispose()
    await toggle.press('Space'); await p.keyboard.press('Escape')
    const pdf = await PDFDocument.create()
    for (const text of ['Folio first proof', 'Folio second proof']) {
      const page = pdf.addPage([360, 480]); page.drawText(text, { x: 45, y: 410, size: 18 })
      page.drawRectangle({ x: 50, y: 295, width: 120, height: 60, color: rgb(.7, .16, .1) })
    }
    const chooser = p.waitForEvent('filechooser')
    await p.locator('.document-desk__actions button').first().click()
    await (await chooser).setFiles({ name: 'Generated fold proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) })
    const sheet = p.locator('#pdf-stage .pdf-page').first(), line = sheet.locator('.text-layer').getByText('Folio first proof', { exact: true })
    await line.waitFor({ state: 'attached' }); assert.equal(await p.locator(surface).count(), 0)
    // Text and raster arrive independently; the unpainted canvas is still the default 300 × 150.
    await p.waitForFunction(() => { const c = document.querySelector('#pdf-stage .pdf-page canvas'); return c && c.height > c.width })
    const ink = await sheet.locator('canvas').first().evaluate(c => Array.from(c.getContext('2d').getImageData(c.width / 4, c.height / 3, 1, 1).data))
    assert(ink[0] > 150 && ink[1] < 65 && ink[2] < 50, `printed swatch changed: ${ink}`)
    const [start, end] = await line.evaluate(el => [6, 11].map(offset => {
      const r = document.createRange(); r.setStart(el.firstChild, offset); r.collapse(true)
      const b = r.getBoundingClientRect(); return [b.x + .1, b.y + b.height / 2]
    }))
    await p.mouse.move(...start); await p.mouse.down(); await p.mouse.move(...end, { steps: 10 }); await p.mouse.up()
    assert.equal(await p.evaluate(() => getSelection().toString().trim()), 'first')
    await p.locator('.thumbnail').nth(1).locator('.thumbnail__paper').click()
    await p.locator('#pdf-stage .stage-page[data-current] .text-layer').getByText('Folio second proof', { exact: true }).waitFor({ state: 'attached' })
    console.log('PASS reduced motion, print media, PDF swatch, real text drag and page navigation')
    const f = await pageFor({ dark: true, fallback: true, width: 660 }), fallback = f.locator(surface)
    assert(await f.locator('html').evaluate(e => e.classList.contains('dark')))
    const copyBox = await f.locator('.document-desk__copy').boundingBox(), plateBox = await fallback.boundingBox()
    assert(plateBox.y >= copyBox.y + copyBox.height - 1, 'narrow desk should stack')
    await aim(f, .1); await settled(f, .1)
    const a = await fallback.screenshot()
    await aim(f, .9); await settled(f, .9); assert(!a.equals(await fallback.screenshot()))
    assert.equal(await fallback.locator('canvas').count(), 0)
    await f.mouse.move(1, 1); await f.waitForFunction(s => !document.querySelector(s).dataset.tracking, surface)
    await aim(f, .85); await settled(f, .85); assert.equal(await f.evaluate(() => window.folioQA.attempts), 1)
    await f.emulateMedia({ reducedMotion: 'reduce' }); await aim(f, .12); await settled(f, .12)
    assert.notEqual(await fallback.locator('img').evaluate(el => getComputedStyle(el).transform), 'none')
    await f.screenshot({ path: path.join(qa, 'dark-narrow.png') })
    assert.deepEqual(errors, [])
    console.log('PASS dark narrow desk, refused WebGL -> CSS, no retry on re-entry, independent of OS motion')
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
