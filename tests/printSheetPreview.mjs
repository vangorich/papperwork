// node tests/printSheetPreview.mjs — local Chromium/Edge, no actual print calls.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const cacheDir = await mkdtemp(join(tmpdir(), 'paperwork-sheet-test-'))
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
import '/src/styles.css'; import { PrintDialog } from '/src/components/Dialogs.tsx';
const params = new URLSearchParams(location.search), count = Number(params.get('count') || 6);
if (!params.has('web')) window.desktop = { getPrinters: async () => [{ name: '测试打印机', isDefault:true }], printPages: () => { throw new Error('no device calls allowed') } };
if (params.has('tauri')) window.__TAURI_INTERNALS__ = {};
window.seen = []; window.sent = [];
const render = async (_, i, width) => { window.seen.push([i,width]);
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/><text x="30" y="55">page '+(i+1)+'</text></svg>'); };
const size = async () => params.has('unknown') ? undefined : ({ widthPt:144, heightPt:72 });
createRoot(document.getElementById('fixture')).render(React.createElement(PrintDialog,{open:true, pageCount:count, items:count ? [{id:'doc',name:'fixture.pdf',pageCount:count,origin:'file'}] : [], onClose:()=>{},onAddFiles:async()=>{},onAddFolder:async()=>{},onRemoveItem:()=>{},onClear:()=>{},onRenderPreview:render,onGetPreviewPageSize:size,printProgress:'测试：正在准备页面',onPrint:o=>{window.sent.push(o); return new Promise((resolve,reject)=>{window.cancelMock=()=>resolve('explained');window.failMock=()=>reject(new Error('驱动测试错误'))})}}));`
const server = await createServer({ root, cacheDir, configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['src/components/Dialogs.tsx'], include: ['react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{ name: 'local-print-fixture',
    resolveId(id) { if (id === '/__sheet-test.js') return '\0sheet-test.js' },
    load(id) { if (id === '\0sheet-test.js') return fixture },
    configureServer(s) { s.middlewares.use('/fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="fixture"></div><script type="module" src="/__sheet-test.js"></script>') }) },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const p = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  const url = `http://127.0.0.1:${server.httpServer.address().port}/fixture?`
  const button = name => p.getByRole('button', { name, exact: true })
  const open = async params => { await p.goto(url + params); await p.getByRole('dialog', { name: '批量打印中心' }).waitFor({ state: 'attached' }); await p.locator('.dialog__panel--print').waitFor() }
  const choose = async (name, value) => { await p.getByRole('button', { name: new RegExp('^' + name) }).click(); await p.getByRole('option', { name: value, exact: true }).click() }
  const image = p.locator('.print-sheet__cell img').first()
  const ratio = async locator => { const r = await locator.boundingBox(); return r.width / r.height }
  await open('tauri')
  assert(await p.getByRole('radio', { name: '适合纸张' }).isChecked())
  await p.locator('#print-page-1 img').waitFor()
  assert.equal(await p.locator('.print-sheet').count(), 0)
  assert.deepEqual(await p.evaluate(() => [...new Set(window.seen.map(row => row[1]))]), [144])
  // Keyboard reorder remains functional after virtualizing the exclusion rail.
  const second = p.getByRole('button', { name: /^调整第 2 页打印顺序/ })
  await second.focus(); await p.keyboard.press('Space'); await p.locator('[data-page-key="doc:1"][data-dragging]').waitFor()
  await p.waitForFunction(() => document.querySelector('[id^="DndLiveRegion"]')?.textContent.includes('over'), { }, {timeout:4000})
  await p.keyboard.press('ArrowRight'); await p.waitForFunction(() => document.querySelector('[id^="DndLiveRegion"]')?.textContent.includes('doc:2'), {}, {timeout:4000}); await p.keyboard.press('Space')
  await p.waitForFunction(() => document.querySelector('#print-page-2').getAttribute('aria-label').includes('顺序 3'))
  await button('排除第 4 页打印').click()
  await p.locator('#print-range').fill('1-5'); await choose('页面子集', '仅奇数页'); await p.locator('[name=reverse]').check()
  await choose('纸张大小', 'Letter'); await choose('每张页数', '2 页'); await p.locator('#print-page-5').click(); await button('纸张预览').click()
  await p.getByText('本面原页：5、3', { exact: true }).waitFor(); await image.waitFor({ state: 'visible' })
  const paper = p.locator('.print-sheet__paper')
  assert(Math.abs(await ratio(paper) - 612 / 792) < .01)
  assert(Math.abs(await ratio(image) - 2) < .01)
  const fitWidth = (await image.boundingBox()).width
  await p.getByLabel('实际大小', { exact: true }).check()
  await p.waitForFunction(() => { const i = document.querySelector('.print-sheet__cell img'), s = document.querySelector('.print-sheet__paper'); return i?.clientWidth && Math.abs(i.getBoundingClientRect().width / s.clientWidth - 144 / 612) < .01 })
  assert((await image.boundingBox()).width < fitWidth)
  await p.locator('[name=color]').uncheck(); await p.locator('[name=pageBorder]').check()
  assert.equal(await image.evaluate(el => getComputedStyle(el).filter), 'grayscale(1)')
  assert.equal(await image.evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
  await p.locator('[name=landscape]').check(); assert(Math.abs(await ratio(paper) - 792 / 612) < .01)
  await button('下一张').click(); await p.getByText('本面原页：1', { exact: true }).waitFor()
  await choose('双面', '双面 · 长边'); await p.getByText('第 1 / 1 张 · 背面', { exact: true }).waitFor(); await button('上一面').click(); await p.getByText('第 1 / 1 张 · 正面', { exact: true }).waitFor(); await button('下一面').click()
  await button('定位原第 1 页，返回页序 / 排除').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-page-1')
  await p.locator('#print-copies').fill('0'); await button('开始打印').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-copies')
  await p.locator('#print-copies').fill('2'); await p.locator('#print-range').fill('99'); await button('开始打印').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-range')
  await p.locator('#print-range').fill('2'); await button('纸张预览').click(); await p.getByText('没有可预览的纸张').waitFor()
  await button('调整页面子集').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-subset')
  assert.equal(await p.evaluate(() => window.sent.length), 0)
  await p.locator('#print-range').fill('1-5'); await button('开始打印').click(); await p.waitForFunction(() => window.sent.length === 1)
  await p.getByText('测试：正在准备页面', { exact: true }).waitFor(); assert(await button('取消').isDisabled()); await p.evaluate(() => window.cancelMock()); await button('开始打印').waitFor(); assert.equal(await p.locator('#print-submit-error').count(), 0)
  await button('开始打印').click(); await p.waitForFunction(() => window.sent.length === 2); await p.evaluate(() => window.failMock()); await p.waitForFunction(() => document.activeElement?.id === 'print-submit-error'); await p.getByText('驱动测试错误', { exact: true }).waitFor()
  const sent = await p.evaluate(() => window.sent[0]); assert.deepEqual([sent.sizing, sent.range, sent.pageOrder, sent.reverse, sent.copies], ['actual', '1-3,5', [0,2,1,3,4,5], true, 2])
  await open('tauri&count=2000'); assert(await p.getByLabel('实际大小', { exact: true }).isChecked()); await p.locator('#print-page-1 img').waitFor()
  const rail = p.locator('.print-preview__rail'); await rail.evaluate(el => { el.scrollLeft = el.scrollWidth }); await p.locator('#print-page-2000 img').waitFor(); assert(await p.locator('.print-preview__thumb').count() < 25)
  await button('纸张预览').click(); assert(await p.locator('.print-sheet__cell').count() <= 2)
  await open('tauri&count=0'); await button('纸张预览').click(); await button('前往添加文件').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-add-files')
  await open('tauri&unknown'); await choose('纸张大小', '随 PDF 页面'); await button('纸张预览').click(); await button('选择固定纸张').click(); await p.waitForFunction(() => document.activeElement?.id === 'print-paper')
  await p.setViewportSize({ width: 390, height: 700 }); await open('tauri'); await button('纸张预览').click(); await image.waitFor({ state: 'visible' })
  const narrow = await paper.boundingBox(); assert(narrow.width > 50 && narrow.height > 50 && narrow.x >= 0 && narrow.x + narrow.width <= 390)
  await open(''); assert.equal(await p.getByLabel('实际大小', { exact: true }).count(), 0)
  await open('web'); await button('生成待打印 PDF').waitFor(); assert.equal(await button('纸张预览').count(), 0); assert.equal(await p.locator('[name=pagesPerSheet]').count(), 0); assert(await p.locator('[name=reverse]').isVisible()); assert.deepEqual(errors, [])
  console.log('Print dialog: bounded rendering, order, physical geometry, focus, fallback, and sizing persistence passed (mock submission only).')
} finally {
  await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 })
}
