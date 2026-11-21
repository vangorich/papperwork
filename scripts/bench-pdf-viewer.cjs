// Run with Node, Playwright (or PLAYWRIGHT_MODULE) and an installed Chromium.
// BROWSER_CHANNEL=msedge selects local Edge; leave unset for Playwright Chromium.
// The app and a fresh generated PDF are served only on loopback. No native files.
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { PDFDocument } = require('pdf-lib')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')

async function fixture(count, attachmentBytes = 0) {
  const doc = await PDFDocument.create()
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Synthetic page ${i}`, { x: 48, y: 720, size: 24 })
    for (let j = 0; j < 80; j++) page.drawLine({ start: { x: 48, y: 40 + j * 8 }, end: { x: 460 - j, y: 41 + j * 8 } })
  }
  if (attachmentBytes) {
    const data = new Uint8Array(attachmentBytes)
    let word = 1
    for (let i = 0; i < data.length; i++) {
      word ^= word << 13; word ^= word >>> 17; word ^= word << 5
      data[i] = word & 255
    }
    await doc.attach(data, 'synthetic.bin')
  }
  return Buffer.from(await doc.save())
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const count = Number(process.env.PDF_BENCH_PAGES || 240)
  assert(count >= 30)
  const [pdf, probe, { createServer }] = await Promise.all([fixture(count, 12 * 1024 ** 2), fixture(1), import('vite')])
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'paperwork-bench-vite-'))
  let browser, server
  try {
    // A browser has no native IPC bridge. Keep the real entry and its CSS.
    server = await createServer({ root, mode: 'bench', cacheDir, logLevel: 'error', server: {
      host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, cacheDir] },
    } })
    await server.listen()
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined })
    const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, deviceScaleFactor: 1 })
    await page.route('**/__fixture.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
    await page.route('**/__probe.pdf', route => route.fulfill({ contentType: 'application/pdf', body: probe }))
    page.on('pageerror', error => console.error(error.message))
    const quality = process.env.PDF_BENCH_QUALITY === 'smooth' ? 'smooth' : 'sharp'
    await page.addInitScript(q => localStorage.setItem('paperwork-render-quality', q), quality)
    await page.goto(server.resolvedUrls.local[0])
    const shell = page.locator('.app-shell:not([hidden])')
    await shell.waitFor()
    await page.evaluate(async () => {
      // Instrument the real PDF.js proxies (not the viewer queue, which counts
      // a cache hit as a job too). Warm JS/worker code on a separate document.
      const lib = await import('/src/lib/pdf.ts')
      const sample = await lib.inspectPdf(new Uint8Array(await (await fetch('/__probe.pdf')).arrayBuffer()), 'probe.pdf', undefined, false)
      const doc = await lib.getPdfDocument(sample)
      const proxy = await doc.getPage(1)
      const perf = window.__pdfBench = { pageRequests: new Set(), renders: [], paints: [], starts: 0, workerBytes: 0 }
      const docProto = Object.getPrototypeOf(doc), pageProto = Object.getPrototypeOf(proxy)
      const getPage = docProto.getPage, render = pageProto.render
      docProto.getPage = function (n) { perf.pageRequests.add(n); return getPage.call(this, n) }
      pageProto.render = function (params) {
        if (params.viewport.width > 400) perf.renders.push(this.pageNumber)
        return render.call(this, params)
      }
      const post = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (...args) {
        const msg = args[0]
        if (msg?.action === 'GetDocRequest') { perf.starts++; perf.workerBytes += msg.data?.data?.byteLength || 0 }
        else if (msg?.stream && msg.chunk instanceof Uint8Array) perf.workerBytes += msg.chunk.byteLength
        return post.apply(this, args)
      }
      const draw = CanvasRenderingContext2D.prototype.drawImage
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = draw.apply(this, args)
        const stage = this.canvas.closest('.stage-page')
        if (stage) perf.paints.push({ page: Number(stage.querySelector('.stage-page__number')?.textContent), t: performance.now(), width: this.canvas.width, before: perf.pageRequests.size, workerBytes: perf.workerBytes })
        return result
      }
      lib.releasePdfDocument(sample)
      const file = new File([await (await fetch('/__fixture.pdf')).blob()], 'synthetic.pdf', { type: 'application/pdf' })
      const transfer = new DataTransfer(); transfer.items.add(file)
      perf.open = performance.now()
      document.querySelector('.app-shell:not([hidden])').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
    })
    const waitPaint = (n, since = 0) => page.waitForFunction(({ n, since }) => window.__pdfBench.paints.some(p => p.page === n && p.t >= since), { n, since })
    await waitPaint(1)
    await page.waitForTimeout(600) // let the import fit, neighbor prewarm and any eager scan settle
    const cold = await page.evaluate(() => {
      const b = window.__pdfBench, first = b.paints[0]
      return { coldMs: Math.round(first.t - b.open), requestedAtFirstPaint: first.before, workerBytesAtFirstPaint: first.workerBytes, requestedWhileIdle: b.pageRequests.size, docLoads: b.starts }
    })
    const jump = async n => {
      const input = shell.getByRole('spinbutton', { name: /输入页码/ })
      await input.fill(String(n))
      const t = await page.evaluate(() => performance.now())
      await input.press('Enter'); await waitPaint(n, t)
      return page.evaluate(([n, t]) => Math.round(window.__pdfBench.paints.find(p => p.page === n && p.t >= t).t - t), [n, t])
    }
    const pageOneRenders = () => page.evaluate(() => window.__pdfBench.renders.filter(n => n === 1).length)
    await jump(24)
    const before = await pageOneRenders()
    const returnMs = await jump(1)
    const returnRasters = await pageOneRenders() - before
    await shell.locator('#pdf-stage .text-layer span').filter({ hasText: 'Synthetic page 1' }).first().waitFor()
    // Start at an exact zoom independent of the import-fit and sidebar width.
    const actualSize = shell.getByRole('button', { name: '100%', exact: true })
    await actualSize.click()
    const initialWidth = quality === 'sharp' ? 1632 : 816 // 612 pt at 96 CSS DPI
    await page.waitForFunction(w => document.querySelector('#pdf-stage canvas')?.width === w, initialWidth)
    const slider = shell.locator('.zoom-control input[type=range]')
    await slider.focus(); await slider.press('End')
    await page.waitForFunction(w => document.querySelector('#pdf-stage canvas')?.width > w, initialWidth)
    const afterZoom = await pageOneRenders()
    await actualSize.click()
    await page.waitForFunction(w => document.querySelector('#pdf-stage canvas')?.width === w, initialWidth)
    const zoomBackRasters = await pageOneRenders() - afterZoom
    const result = { browser: browser.version(), pages: count, bytes: pdf.length, dpr: 1, quality, initialWidth, ...cold, returnMs, returnRasters, zoomBackRasters }
    console.log(JSON.stringify(result))
    assert.equal(cold.docLoads, 1, 'opening one document must start only one PDF.js load')
    assert(cold.workerBytesAtFirstPaint > 0 && cold.workerBytesAtFirstPaint < pdf.length / 2, 'do not copy/send the entire large file to the PDF worker before first paint')
    assert(cold.requestedWhileIdle < 25, 'single-page mode must not read dimensions for the entire document')
    assert.equal(returnRasters, 0, 'revisiting a recently painted page must not rasterize again')
    assert.equal(zoomBackRasters, 0, 'returning to a retained resolution must reuse its frame')
  } finally {
    try { await browser?.close() } finally { await server?.close(); rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 }) }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
