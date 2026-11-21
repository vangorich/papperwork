// From source-work: node tests/pdfCompressionBenchmark.mjs [text|scan|mixed|photo|mask...]
// Uses the installed Chromium browser, package-lock dependencies, and loopback only. No project PDFs.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { offlineQpdf } from '../build/qpdf-engine.mjs'
const root = fileURLToPath(new URL('../', import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), 'pdf-compression-'))
const server = await createServer({ root, cacheDir, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { entries: ['tests/pdfCompressionFixture.js', 'src/lib/pdfCompression.worker.ts'], include: ['pdf-lib', 'pdfjs-dist', 'fflate', 'qpdf-run'] },
  worker: {plugins: () => [offlineQpdf()]}, plugins: [offlineQpdf(), { name: 'offline-bench', configureServer(s) { s.middlewares.use('/fixture', (_, res) => {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Offline compression benchmark</title>')
  }) } }] })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage(), origin = 'http://127.0.0.1:' + server.httpServer.address().port
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  page.on('pageerror', e => console.error(e.message))
  await page.goto(origin + '/fixture')
  console.log(`Chromium ${browser.version()}, PDF.js 4.10.38, RGB 216 DPI vs source. 'exact' = byte-identical rendered RGB.`)
  const kinds = process.argv.slice(2)
  for (const kind of kinds.length ? kinds : ['text', 'scan', 'mixed', 'photo', 'mask']) {
    const rows = await page.evaluate(async k => (await import('/tests/pdfCompressionFixture.js')).bench(k), kind)
    for (const row of rows) console.log(JSON.stringify(row))
  }
} finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }) }
