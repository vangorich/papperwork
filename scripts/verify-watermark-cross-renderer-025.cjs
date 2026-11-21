// Node Canvas produces the original ink. Edge opens a renamed, independent copy
// in the real built editor and uses File > Save As without editing any setting.
// Compare the actual downloaded PDFs with two independent readers. No host IPC.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright-core')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
function run(exe, args, env = process.env) {
  const p = spawnSync(exe, args, { cwd: root, env, stdio: 'inherit', timeout: 120000 })
  if (p.error) throw p.error
  assert.equal(p.status, 0, `${path.basename(exe)} failed`)
}
const checkPdf = String.raw`
import sys, json, base64, hashlib
from pathlib import Path
import pymupdf as mu
import pypdfium2 as pdfium
p=Path(sys.argv[1]); dim=mu.Matrix(2,2)
def ink(doc):
    streams=[doc.xref_stream(i) for i in range(1,doc.xref_length()) if doc.xref_get_key(i,'Type')==('name','/PaperworkWatermarkV1')]
    assert len(streams)==1, 'expected one editable watermark record'
    data=streams[0]; meta=json.loads(data[data.index(b'\n{')+1:]); return meta, hashlib.sha256(base64.b64decode(meta['imageData'].split(',',1)[1],validate=True)).hexdigest()
for kind in ['text','image']:
    a=p/(kind+'-renamed.pdf'); b=p/(kind+'-from-edge.pdf')
    with mu.open(a) as before, mu.open(b) as after:
        prev,ha=ink(before); nxt,hb=ink(after);assert ha==hb, f'{kind}: embedded ink replaced on unmodified save'
        assert prev==nxt and len(before)==len(after)==2
        for x,y in zip(before,after): assert x.get_pixmap(matrix=dim,alpha=False).samples==y.get_pixmap(matrix=dim,alpha=False).samples, f'MuPDF: {kind} changed'
    with pdfium.PdfDocument(a) as before, pdfium.PdfDocument(b) as after:
        for i in range(len(before)):
            x=before[i];y=after[i];m=x.render(scale=2);n=y.render(scale=2)
            try: assert m.to_pil().convert('RGB').tobytes()==n.to_pil().convert('RGB').tobytes(), f'PDFium: {kind} changed'
            finally: m.close();n.close();x.close();y.close()
    print(f'PASS {kind}: original embedded image SHA-256 {ha} retained, both pages have zero changed 2x RGB pixels in MuPDF and PDFium')
`
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'paperwork-watermark-ui-'))
  let server, browser
  try {
    run(process.execPath, [path.join(root,'node_modules/vitest/vitest.mjs'), 'run','--silent','--fileParallelism=false','src/lib/pdfPersistence025.test.ts'], { ...process.env, PW_PERSISTENCE_PROOF_DIR: temp })
    const { preview } = await import('vite')
    server = await preview({ root, logLevel:'error', preview:{host:'127.0.0.1',port:0} })
    const origin = 'http://127.0.0.1:'+server.httpServer.address().port
    browser = await chromium.launch({ channel:'msedge' })
    for (const kind of ['text','image']) {
      const renamed=path.join(temp,kind+'-renamed.pdf'); await fs.copyFile(path.join(temp,kind+'-marked.pdf'),renamed)
      const context=await browser.newContext({viewport:{width:1460,height:940},serviceWorkers:'block',acceptDownloads:true})
      try {
        await context.route(/^https?:\/\//,route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
        const page=await context.newPage();page.setDefaultTimeout(12000);await page.goto(origin)
        const choose=page.waitForEvent('filechooser');await page.locator('.app-shell:visible .document-desk__actions button').first().click();await (await choose).setFiles(renamed)
        await page.getByRole('tab',{name:new RegExp(kind+'-renamed')}).waitFor()
        await page.locator('#pdf-stage .watermark-layer').first().waitFor({state:'attached'})
        await page.getByRole('button',{name:'文件操作',exact:true}).click()
        const ready=page.waitForEvent('download');await page.getByRole('menuitem',{name:'另存为',exact:true}).click();const output=await ready
        await output.saveAs(path.join(temp,kind+'-from-edge.pdf')); assert.equal(await output.failure(),null)
        assert((await fs.readFile(renamed)).equals(await fs.readFile(path.join(temp,kind+'-marked.pdf'))))
      } finally {await context.close()}
    }
    run(process.env.PYTHON||'python',['-I','-B','-X','utf8','-c',checkPdf,temp])
  } finally {try{await browser?.close()}finally{await server?.close();await fs.rm(temp,{recursive:true,force:true})}}
}
main().catch(e=>{console.error(e);process.exitCode=1})
