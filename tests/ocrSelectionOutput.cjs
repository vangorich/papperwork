// Run with node tests/ocrSelectionOutput.cjs (local Edge; no native OCR or network service required).
// Isolate capture → selected text output. The WinRT/Edge mouse E2E covers recognition itself.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require('playwright-core')

async function main() {
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-range-vite-'))
  const vite = await createServer({ configFile:false, root:fs.realpathSync.native(path.resolve(__dirname,'..')), cacheDir, logLevel:'error',
    server:{ host:'127.0.0.1', port:0, hmr:false, watch:null }, optimizeDeps:{ include:['pdfjs-dist','pdf-lib','fflate'] } })
  let browser
  try {
    await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    browser = await chromium.launch({ channel: 'msedge' })
    const tab = await browser.newPage()
    await tab.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort())
    await tab.route(`${origin}/_ocr_range`, r => r.fulfill({ contentType:'text/html', body:
      '<main><article class="stage-page" data-page-id="scan"><div class="text-layer" data-ocr="true"></div></article></main>' }))
    await tab.goto(`${origin}/_ocr_range`)
    const result = await tab.evaluate(async () => {
      const { captureMarkdownSelection, currentMarkdownFragments, registerMarkdownLayer, matchesCapturedOcr } = await import('/src/lib/captureMarkdownSelection.ts')
      const { makePdfMarkdown } = await import('/src/lib/pdfMarkdown.ts')
      // Axial bounding boxes overlap even though these runs lie on separate slanted baselines.
      const word = (text, x, y, width, height) => ({ text, x, y, width, height, confidence: .5, rotation: 9 })
      const words = [word('ClassificationClassification', .1,.10,.49,.17), word('TOKEN  007', .61,.23,.12,.05), word('OUTSIDE', .17,.15,.52,.17)]
      const ocr = { words, text: 'NOT THE SELECTION', revision: 1, mode:'printed', engine:'stored', createdAt:'' }
      const page = { id:'scan', sourceId:'blank', sourcePage:0, rotation:0, annotations:[], ocr }
      const stage = document.querySelector('main'), layer = stage.querySelector('.text-layer')
      const nodes = words.map((w,i) => {
        const el = document.createElement('span'); el.dataset.ocrIndex = String(i); el.textContent = w.text + (i === 0 ? ' ' : '\n'); layer.append(el); return el.firstChild
      })
      const boxes = [{x:.52,y:.235,width:.06,height:.03},{x:.61,y:.235,width:.065,height:.03}]
      registerMarkdownLayer(layer, r => ({ pageId:page.id, text:r.toString().trim(), boxes }))
      getSelection().setBaseAndExtent(nodes[1], 9, nodes[0], 22) // reverse partial drag, including a significant double space
      const snapshot = captureMarkdownSelection(stage,[page]), fragments = currentMarkdownFragments(snapshot,[page])
      const options = { scope:{ kind:'selection', fragments }, includeImages:false, assetDirectory:'images' }
      const output = async () => (await makePdfMarkdown([page], [], options)).markdown
      const rejected = async () => { try { await output(); return false } catch { return true } }
      if (matchesCapturedOcr(fragments[0],page,()=>true)!==true) throw Error('Missing exact glyph evidence')
      const text = await output()
      page.crop = { x:0, y:0, width:.62, height:1 }; const cropped = await rejected(); delete page.crop
      page.annotations.push({ id:'cover', type:'image', x:.61,y:.23,width:.12,height:.05 }); const covered = await rejected(); page.annotations.length = 0
      const otherTab = currentMarkdownFragments(snapshot,[{...page,id:'other'}]).length
      ocr.revision++; const stale = await rejected(), staleSnapshot = currentMarkdownFragments(snapshot,[page]).length
      return { text, cropped, covered, stale, staleSnapshot, otherTab }
    })
    assert.deepEqual(result, {text:'## 第 1 页\n\ncation TOKEN  00\n', cropped:true, covered:true, stale:true, staleSnapshot:0, otherTab:0})
    console.log('PASS exact OCR range, overlapping row, crop, cover, OCR revision and other tab')
  } finally { await browser?.close(); await vite.close(); fs.rmSync(cacheDir, {recursive:true,force:true}) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
