// Runtime regression bench, no private files. From the repository root:
// PLAYWRIGHT_MODULE=/path/to/playwright node scripts/bench-pdf-reader.mjs
// Optional: BROWSER_CHANNEL=msedge, BENCH_PAGES=160. Times are diagnostic;
// assertions use actual PDF.js requests/raster calls, not timing thresholds.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const pages = Number(process.env.BENCH_PAGES || 160)
assert(Number.isSafeInteger(pages) && pages >= 12 && pages <= 1000)
const root = fileURLToPath(new URL('../', import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'pdf-reader-bench-'))
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const tile = new Uint8Array(192 * 192 * 3)
for (let i = 0; i < pages; i++) {
  const p = doc.addPage([612, 792])
  for (let j = 0; j < tile.length; j++) tile[j] = (i * 19 + j * 83 + (j >> 3)) & 255
  const stream = doc.context.stream(tile.slice(), { Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceRGB', Width: 192, Height: 192, BitsPerComponent: 8 })
  const name = p.node.newXObject('Tile', doc.context.register(stream))
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 500, 50, 110), drawObject(name), popGraphicsState())
  p.drawText(`Reader benchmark page ${i + 1}`, { x: 30, y: 730, size: 22, font })
}
const bytes = Buffer.from(await doc.save())
const tiny = await PDFDocument.create()
tiny.addPage()
const probe = Buffer.from(await tiny.save())
let server, browser
try {
  process.chdir(root)
  // The shipping entry only installs IPC inside Tauri. Use it unmodified so
  // the benchmark measures the same fonts, grid and hit targets as the app.
  server = await createServer({ root, mode: 'reader-bench', cacheDir: join(tmp, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } })
  await server.listen()
  const channel = process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
  browser = await chromium.launch({ channel, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1.25 })
  page.on('pageerror', (error) => console.error('browser error:', error.message))
  await page.route('**/__bench_file.pdf', route => route.fulfill({ contentType: 'application/pdf', body: bytes }))
  await page.goto(server.resolvedUrls.local[0])
  await page.locator('.app-shell:not([hidden])').waitFor()
  // Isolate the stage and its resource pipeline from thumbnail-list changes.
  const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
  if (await collapse.count() && await collapse.isVisible()) await collapse.click()
  await page.evaluate(async (calibration) => {
    const { inspectPdf, getPdfDocument, getPdfPage, releasePdfDocument } = await import('/src/lib/pdf.ts')
    const source = await inspectPdf(new Uint8Array(calibration), 'probe.pdf', undefined, false)
    const d = await getPdfDocument(source), p = await getPdfPage(source, 0)
    const pageProto = Object.getPrototypeOf(p), docProto = Object.getPrototypeOf(d)
    const render = pageProto.render, getPage = docProto.getPage
    releasePdfDocument(source)
    const renders = [], requested = new Set(), paints = []
    let loads = 0, inputBytes = 0
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg?.action === 'GetDocRequest') { loads++; inputBytes += msg.data?.data?.byteLength ?? 0 }
      // Full/GetRange reader stream chunks are transferred renderer → worker.
      if (msg?.stream && msg.chunk instanceof Uint8Array) inputBytes += msg.chunk.byteLength
      return post.call(this, msg, ...rest)
    }
    docProto.getPage = function (n) { requested.add(n); return getPage.call(this, n) }
    pageProto.render = function (params) {
      renders.push({ page: this.pageNumber, width: Math.ceil(params.viewport.width) })
      return render.call(this, params)
    }
    const draw = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = draw.apply(this, args)
      const host = this.canvas.closest('#pdf-stage .stage-page')
      if (host && this.canvas.matches('.pdf-page > canvas')) {
        paints.push({ page: Number(host.querySelector('.stage-page__number')?.textContent), at: performance.now(), lookups: requested.size, inputBytes })
      }
      return result
    }
    const file = new File([await (await fetch('/__bench_file.pdf')).arrayBuffer()], 'synthetic.pdf', { type: 'application/pdf' })
    const drop = name => {
      const transfer = new DataTransfer(); transfer.items.add(new File([file], name, { type: file.type }))
      document.querySelector('.app-shell:not([hidden])').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
    }
    window.readerBench = { renders, paints, loads: () => loads, requested: () => requested.size, drop, start: performance.now() }
    drop('synthetic.pdf')
  }, [...probe])
  const waitPaint = (n, after) => page.waitForFunction(([number, t]) => window.readerBench.paints.some(p => p.page === number && p.at >= t), [n, after], { timeout: 45000 })
  await waitPaint(1, 0)
  const first = await page.evaluate(() => {
    const b = window.readerBench
    return { ms: Math.round(b.paints[0].at - b.start), distinctPagesRequested: b.paints[0].lookups, workerInputBytes: b.paints[0].inputBytes }
  })
  const jump = async n => {
    const input = page.locator('.app-shell:not([hidden]) input[aria-label*="输入页码"]')
    await input.fill(String(n))
    const start = await page.evaluate(() => performance.now())
    await input.press('Enter')
    await waitPaint(n, start)
    return page.evaluate(([num, t]) => Math.round(window.readerBench.paints.find(p => p.page === num && p.at >= t).at - t), [n, start])
  }
  const rasterCount = n => page.evaluate(num => window.readerBench.renders.filter(r => r.page === num && r.width > 300).length, n)
  const measure = async n => {
    const before = await rasterCount(n), ms = await jump(n)
    return { ms, stageRasters: (await rasterCount(n)) - before }
  }
  // Non-neighbours cannot be prewarmed by this sequence. The page components
  // are unmounted/remounted by the single-page reader on every jump.
  const cold = await measure(7)
  await measure(12)
  const revisit = await measure(7)
  // Two actual raster resolutions (at 205%, DPI exceeds the sharp tier's
  // minimum). A second width must not destroy the useful original frame.
  const width = () => page.locator('#pdf-stage .pdf-page').evaluate(el => el.clientWidth)
  const originalWidth = await width()
  const zoomAt = await page.evaluate(() => performance.now())
  await page.locator('.zoom-control > input[type=range]').fill('2.05')
  await waitPaint(7, zoomAt)
  assert.notEqual(await width(), originalWidth)
  await measure(12)
  const fit = page.getByRole('button', { name: '适合宽度', exact: true })
  await fit.click()
  await page.waitForFunction(w => document.querySelector('#pdf-stage .pdf-page')?.clientWidth === w, originalWidth)
  const revisitOriginalZoom = await measure(7)
  const text = page.locator('#pdf-stage .text-layer')
  await text.filter({ hasText: 'Reader benchmark page 7' }).waitFor()
  const state = await page.evaluate(() => ({ loads: window.readerBench.loads(), requested: window.readerBench.requested() }))
  // Append leaves the current tab selected. Activating the newly inspected
  // document must not parse/transfer the same bytes a second time.
  await page.evaluate(() => window.readerBench.drop('second.pdf'))
  const tab = page.getByRole('tab', { name: /second\.pdf/ })
  await tab.waitFor()
  const afterAppend = await page.evaluate(() => window.readerBench.loads())
  const activate = await page.evaluate(() => performance.now())
  await tab.click()
  await waitPaint(1, activate)
  const activateCalls = (await page.evaluate(() => window.readerBench.loads())) - afterAppend
  console.log(JSON.stringify({ browser: browser.version(), pages, fileMiB: +(bytes.length / 2**20).toFixed(2), dpr: 1.25, sidebar: (await page.locator('aside.sidebar:visible').count()) ? 'open' : 'closed', first, cold, revisit, revisitOriginalZoom, ...state, afterAppend, activateCalls }, null, 2))
  assert.equal(afterAppend, 2, 'Two added sources should be parsed once each')
  assert.equal(activateCalls, 0, 'Switching to a just-imported tab should reuse its already-inspected worker')
  assert.equal(state.loads, 1, 'A single import should open one document worker')
  assert.ok(first.distinctPagesRequested < 10 && state.requested < 16, 'Single-page reading should not traverse the whole PDF')
  assert.equal(cold.stageRasters, 1, 'The cold jump should raster only once')
  assert.equal(revisit.stageRasters, 0, 'Warm return must not issue page.render()')
  assert.equal(revisitOriginalZoom.stageRasters, 0, 'Another zoom must not evict a recently used, affordable raster')
} finally {
  await browser?.close()
  await server?.close()
  await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
