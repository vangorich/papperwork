// Run: node scripts/verify-source-identity-025.cjs [watermarks|compression]
// Real Edge, local Vite source and qpdf worker. Only the desktop file picker/writer
// is simulated, restricted to generated files in this run's private directory.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process')
const { chromium } = require('playwright-core'), { PDFDocument, rgb } = require('pdf-lib')
const root = path.resolve(__dirname, '..'), hash = data => createHash('sha256').update(data).digest('hex')
const shell = p => p.locator('.app-shell:visible').first(), stage = p => shell(p).locator('#pdf-stage .stage-page[data-current]')
const button = (el, name) => el.getByRole('button', {name, exact:true}), menu = (p, name) => p.getByRole('menuitem', {name, exact:true})
const rows = p => shell(p).locator('.thumbnail-list .thumbnail[data-page-id]')
let dir, origin
const file = name => path.join(dir, name)

async function specimen(name, pages, compressible = false) {
  const doc = await PDFDocument.create()
  for (let i=0; i<pages; i++) {
    const pg = doc.addPage([401,292]); pg.drawText(`${name} / ${i+1}`, {x:23,y:245,size:14})
    pg.drawRectangle({x:25+i*23,y:64,width:51,height:28,color:rgb(.16,.42,.54)})
    if (compressible) { // Raw, highly compressible bitmap keeps every lossless run measurable.
      const image = doc.context.register(doc.context.stream(Buffer.alloc(192*200*3,221), {Type:'XObject',Subtype:'Image',ColorSpace:'DeviceRGB',BitsPerComponent:8,Width:192,Height:200}))
      const ref = pg.node.newXObject('Tone',image)
      pg.node.addContentStream(doc.context.register(doc.context.stream(`q 130 0 0 110 85 50 cm ${ref} Do Q`)))
    }
  }
  await fs.writeFile(file(name), await doc.save({useObjectStreams:false}), {flag:'wx'})
}
// Independent renderer. The entire visible page is compared, not just the presence of a PDF object.
function inspect(name) {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-I','-c',
    'import pymupdf as m,json,hashlib,sys\nwith m.open(sys.argv[1]) as d:\n print(json.dumps([dict(angle=p.rotation,notes=len(list(p.annots() or [])),pixels=hashlib.sha256(p.get_pixmap(matrix=m.Matrix(2,2),alpha=False).samples).hexdigest()) for p in d]))',file(name)],{encoding:'utf8'}))
}
function compareRepaint(name, pageIndex, reference, refIndex) {
  // MuPDF can round a concatenated rotate/scale differently from the owned
  // layer's equivalent single matrix. Bound per-channel delta AND coverage.
  return execFileSync(process.env.PYTHON || 'python', ['-I','-c',
    'import pymupdf as m,sys\ndef frame(f,i):\n with m.open(f) as d: return d[int(i)].get_pixmap(matrix=m.Matrix(2,2),alpha=False).samples\na=frame(*sys.argv[1:3]);b=frame(*sys.argv[3:5]);assert len(a)==len(b);delta=[abs(i-j) for i,j in zip(a,b) if i!=j];mx=max(delta,default=0);print(len(delta),mx);assert mx<=2 and len(delta)<=len(a)//10000,(mx,len(delta),len(a))',file(name),String(pageIndex),file(reference),String(refIndex)],{encoding:'utf8'}).trim()
}
async function newPage(browser, init) {
  const ctx = await browser.newContext({viewport:{width:1880,height:1020},reducedMotion:'reduce',acceptDownloads:true,serviceWorkers:'block'})
  await ctx.route(/^https?:\/\//, r => {
    const u = new URL(r.request().url()); if(u.origin!==origin) return r.abort()
    if(/^\/pdfjs\/(cmaps|standard_fonts)\/[a-zA-Z0-9_.-]+$/.test(u.pathname)) return r.fulfill({path:path.join(root,'node_modules/pdfjs-dist',u.pathname.slice(7))})
    return r.continue()
  })
  const p = await ctx.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', e=>console.error('renderer:',e.message))
  if (init) await init(p)
  await p.goto(origin); await shell(p).locator('.document-desk__actions button').first().waitFor()
  return p
}
async function open(p,name) {
  const chooser=p.waitForEvent('filechooser'), first=shell(p).locator('.document-desk__actions button').first()
  await (await first.isVisible()?first:shell(p).locator('.editor-tabs__add')).click()
  await (await chooser).setFiles(file(name)); const tab=shell(p).getByRole('tab',{name:new RegExp(name.replace(/[.]/g,'\\.'))})
  await tab.click(); await stage(p).locator('.text-layer .endOfContent').first().waitFor({state:'attached'})
}
async function download(p, name, click) { const next=p.waitForEvent('download'); await click(); await (await next).saveAs(file(name)) }
const saveAs = (p,name) => download(p,name,()=>p.keyboard.press('Control+Shift+s'))
async function exportProject(p,name) {
  await button(shell(p),'页面整理').click(); await download(p,name,()=>menu(p,'合并导出').click())
}
async function mark(p, {edit=false, text, tiled=false, opacity=48, angle=0}={}) {
  await button(shell(p),edit?'编辑水印':'添加水印').click()
  const d=p.getByRole('dialog',{name:edit?'编辑文档水印':'插入水印'})
  if (text) { await d.locator('label.watermark-kind').filter({hasText:'文字水印'}).click(); await d.locator('[name=watermark-text]').fill(text) }
  else {
    await d.locator('label.watermark-kind').filter({hasText:'图片 / 电子章'}).click()
    const png=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=28;const g=c.getContext('2d');g.fillStyle='#a62a58';g.fillRect(0,0,64,16);g.fillStyle='#114598';g.fillRect(0,16,28,12);return c.toDataURL('image/png').split(',')[1]})
    await d.locator('input[type=file]').setInputFiles({name:'stamp.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
  }
  await d.locator('summary').click();await d.getByRole('spinbutton',{name:/不透明度/}).fill(String(opacity));await d.getByRole('spinbutton',{name:/旋转角度/}).fill(String(angle))
  await d.getByRole('checkbox',{name:/平铺到每一页/}).setChecked(tiled)
  await button(d,edit?'保存修改':'添加水印').click();await d.waitFor({state:'hidden'})
}
async function removeMark(p) {
  await button(shell(p),'编辑水印').click(); const d=p.getByRole('dialog',{name:'编辑文档水印'});await button(d,'移除水印').click();await d.waitFor({state:'hidden'})
}
async function transfer(p, count, {page, fresh=false}={}) {
  if(page) {
    const row=rows(p).nth(page-1);await row.click();await row.click({button:'right'});await menu(p,'将当前页加入工作区').click()
  } else {
    await shell(p).locator('.editor-tabs [role=tab][aria-selected=true]').click({button:'right'});await menu(p,'加入工作区').click()
  }
  const d=p.getByRole('dialog',{name:'加入哪个工作区？'}); if(fresh) await d.getByRole('radio',{name:/新建工作区/}).click()
  await button(d,`加入 ${count} 页`).click();await d.waitFor({state:'hidden'}); await stage(p).waitFor()
}
async function checkPreview(p, index, expected) {
  await rows(p).nth(index).press('Enter')
  const pg=stage(p).locator('.pdf-page'), layers=pg.locator('.watermark-layer')
  await pg.locator('.text-layer .endOfContent').first().waitFor({state:'attached'})
  await pg.evaluate(async el=>{await document.fonts.ready;await Promise.all([...el.querySelectorAll('.watermark-layer img')].map(im=>im.decode()))})
  assert.equal(await layers.count(),expected)
  const shot=async()=>hash(await pg.screenshot({animations:'disabled'})), visible=await shot()
  for(let i=0;i<expected;i++) {const layer=layers.nth(i);await layer.evaluate(e=>e.style.visibility='hidden');assert.notEqual(await shot(),visible,`layer ${i+1} paints no pixels`);await layer.evaluate(e=>e.style.removeProperty('visibility'))}
}
async function watermarkTest(browser) {
  await specimen('A.pdf',2);await specimen('B.pdf',1)
  let p=await newPage(browser);await open(p,'A.pdf');await mark(p,{tiled:true});await saveAs(p,'owned.pdf');await p.context().close()
  const files=['A.pdf','B.pdf','owned.pdf'], hashes=await Promise.all(files.map(async n=>hash(await fs.readFile(file(n)))))
  const a=inspect('A.pdf'),b=inspect('B.pdf'),owned=inspect('owned.pdf');assert.notDeepEqual(owned,a)
  p=await newPage(browser);await open(p,'owned.pdf');await button(shell(p),'编辑水印').waitFor()
  await transfer(p,2);await checkPreview(p,0,1);await exportProject(p,'whole.pdf');assert.deepEqual(inspect('whole.pdf'),owned)
  await button(shell(p),'浏览').click();await mark(p,{edit:true,text:'Revised',opacity:71,angle:26});await saveAs(p,'edited.pdf')
  const changed=inspect('edited.pdf');assert.notDeepEqual(changed,owned);assert.notDeepEqual(changed,a)
  await transfer(p,1,{page:2});await button(shell(p),'浏览').click();await removeMark(p);await transfer(p,1,{page:1})
  await button(shell(p),'浏览').click();await open(p,'B.pdf');await transfer(p,1)
  await checkPreview(p,2,1);await checkPreview(p,3,0);await checkPreview(p,4,0)
  await exportProject(p,'mixed.pdf');const expected=[...owned,changed[1],a[0],b[0]];assert.deepEqual(inspect('mixed.pdf'),expected)
  const global={text:'Project only',opacity:56,angle:-16};await mark(p,global);await checkPreview(p,0,2);await checkPreview(p,4,1)
  // Even a non-active source page in a multipage layout must display the project watermark.
  const layout=()=>shell(p).getByRole('button',{name:/^阅读布局：/});await layout().click();await p.getByRole('menuitemradio',{name:'连续滚动',exact:true}).click()
  const other=shell(p).locator('#pdf-stage .stage-page').first();await other.scrollIntoViewIfNeeded();await other.locator('.watermark-layer').nth(1).waitFor()
  await layout().click();await p.getByRole('menuitemradio',{name:'单页',exact:true}).click()
  await exportProject(p,'both.pdf');const stacked=inspect('both.pdf');stacked.forEach((pg,i)=>assert.notEqual(pg.pixels,expected[i].pixels))
  // Same project: copying the first page must not turn its existing global overlay into a second layer.
  await transfer(p,1,{page:1});await exportProject(p,'local-copy.pdf');assert.deepEqual(inspect('local-copy.pdf'),[...stacked,stacked[0]])
  // Another project: both marks follow only the selected page, as read-only artwork.
  await transfer(p,1,{page:1,fresh:true});await checkPreview(p,0,2);await exportProject(p,'remote-copy.pdf');assert.equal(inspect('remote-copy.pdf').length,1);console.log('repainted global layer: changed channels, max delta',compareRepaint('remote-copy.pdf',0,'both.pdf',0))
  await p.context().close()
  // Independent control for the entire two-layer output: apply the same global mark
  // to the already-resolved, mixed PDF in a fresh editor, then remove it on reopen.
  p=await newPage(browser);await open(p,'mixed.pdf');await mark(p,global);await saveAs(p,'global-control.pdf');assert.deepEqual(inspect('global-control.pdf'),stacked);await p.context().close()
  p=await newPage(browser);await open(p,'both.pdf');await removeMark(p);await saveAs(p,'remove-global.pdf');assert.deepEqual(inspect('remove-global.pdf'),expected);await p.context().close()
  assert.deepEqual(await Promise.all(files.map(async n=>hash(await fs.readFile(file(n))))),hashes)
  console.log('H02 PASS: full/selected transfers, changed/deleted marks and plain input, two independent project layers, same/new destination, remove-on-reopen; source hashes and 2x RGB pages verified.')
}
async function compressionTest(browser) {
  const name='rotate.pdf', source=file(name), grant='only-this-open';await specimen(name,1,true)
  const initial=await fs.readFile(source), before=inspect(name);assert.equal(before[0].angle,0)
  let disposition='ok', copyName, cancelCopy=false, entered, resume
  const p=await newPage(browser,async p=>{
    await p.exposeFunction('readSpecimen',async()=>({name,path:source,type:'pdf',desktopGrant:grant,b64:(await fs.readFile(source)).toString('base64')}))
    await p.exposeFunction('writeSpecimen',async(kind,b64,destination,token)=>{
      const bytes=Buffer.from(b64,'base64')
      if(kind==='overwrite') {
        assert.equal(destination,source);assert.equal(token,grant)
        if(disposition==='cancel') return null
        if(disposition==='fail') {await fs.writeFile(source,bytes,{flag:'wx'});throw Error('expected EEXIST')}
        if(disposition==='held') {entered();await new Promise(ok=>{resume=ok})}
        await fs.writeFile(source,bytes);return source
      }
      assert(['saveAs','compress'].includes(kind));if(kind==='compress'&&cancelCopy)return null
      assert(copyName && path.basename(copyName)===copyName);const dest=file(copyName);await fs.writeFile(dest,bytes,{flag:'wx'});return dest
    })
    await p.addInitScript(()=>{
      const encode=arr=>new Promise((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(r.result.split(',')[1]);r.onerror=fail;r.readAsDataURL(new Blob([arr]))}), off=()=>()=>{}, noop=()=>{}
      window.desktop={onOpenFileRequested:off,notifyRendererReady:noop,onCloseRequest:off,onSessionReset:off,setWorkspaceDirty:noop,getOcrStatus:async()=>({}),getOcrCapabilities:async()=>({}),
        openFiles:async()=>{const d=await window.readSpecimen();return [{...d,bytes:Uint8Array.from(atob(d.b64),c=>c.charCodeAt(0))}]},
        overwritePdf:async(bytes,path,grant)=>window.writeSpecimen('overwrite',await encode(bytes),path,grant),savePdf:async bytes=>window.writeSpecimen('saveAs',await encode(bytes)),savePdfCopy:async bytes=>window.writeSpecimen('compress',await encode(bytes))}
      window.workerInputs=[];window.Worker=class extends Worker {
        constructor(url,options){super(url,options);this.qpdf=String(url).includes('pdfCompression.worker')}
        postMessage(data,...rest){if(this.qpdf && data.bytes)window.workerInputs.push(crypto.subtle.digest('SHA-256',data.bytes).then(b=>Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('')));super.postMessage(data,...rest)}
      }
    })
  })
  await shell(p).locator('.document-desk__actions button').first().click();await stage(p).locator('.text-layer .endOfContent').first().waitFor({state:'attached'})
  const turn=async angle=>{await button(shell(p),'向右旋转当前页').click();await stage(p).locator(`.text-layer[data-main-rotation="${angle}"] .endOfContent`).first().waitFor({state:'attached'})}
  const state=()=>p.evaluate(()=>Promise.all(window.workerInputs)), dlg=p.locator('.compression-dialog__panel')
  const openComp=async from=>{if(from==='tab'){await shell(p).locator('.editor-tabs [role=tab]').click({button:'right'});await menu(p,'压缩 PDF').click()}else await button(shell(p),'压缩 PDF').click();await dlg.locator('input[value=lossless]').check()}
  const run=async(name,reference)=>{copyName=name;const inputs=(await state()).length;await button(dlg,'压缩并另存为').click();await dlg.waitFor({state:'hidden',timeout:35000});const seen=await state();assert.equal(seen.length,inputs+1);assert.equal(seen.at(-1),hash(await fs.readFile(reference)));assert.deepEqual(inspect(name),inspect(path.basename(reference)))}
  const compress=async(from,name,ref=source)=>{await openComp(from);await run(name,ref)}
  await turn(90);await rows(p).first().click({button:'right'});await menu(p,'插入备注').click()
  await compress('top','unsaved.pdf');assert.deepEqual(inspect('unsaved.pdf'),before)
  const idle=()=>shell(p).locator('.statusbar__state:not([data-working])').waitFor()
  for(const kind of ['cancel','fail']) {
    disposition=kind;await p.keyboard.press('Control+s');if(kind==='fail')await shell(p).locator('.toast').filter({hasText:'EEXIST'}).waitFor();await idle();await compress('tab',kind+'.pdf');assert.deepEqual(await fs.readFile(source),initial)
  }
  copyName='separate.pdf';await p.keyboard.press('Control+Shift+s');await shell(p).locator('.toast').filter({hasText:'PDF 副本已另存到本地'}).waitFor();assert.equal(inspect(copyName)[0].angle,90);assert.equal(inspect(copyName)[0].notes,1);await compress('top','after-copy.pdf');assert.deepEqual(await fs.readFile(source),initial)
  await turn(180);disposition='held';const holding=new Promise(ok=>{entered=ok});await p.keyboard.press('Control+s');await holding
  try {
    await openComp('tab');cancelCopy=true;await button(dlg,'压缩并另存为').click();await button(dlg,'重选保存位置').waitFor();assert.equal((await state()).at(-1),hash(initial))
  } finally {resume();disposition='ok';cancelCopy=false}
  await button(dlg,'压缩并另存为').waitFor();assert.equal(await button(dlg,'重选保存位置').count(),0)
  const saved=inspect(name);assert.equal(saved[0].angle,180);assert.equal(saved[0].notes,1);await run('saved-tab.pdf',source);await compress('top','saved-top.pdf')
  await turn(270);await compress('tab','dirty-after-save.pdf');assert.deepEqual(inspect('dirty-after-save.pdf'),saved)
  await p.keyboard.press('Control+s');await shell(p).locator('.toast').filter({hasText:'已保存当前文档'}).waitFor();await compress('top','next-save.pdf');const next=inspect(name);assert.equal(next[0].angle,270);assert.equal(next[0].notes,1)
  console.log(`P01 PASS: ${(await state()).length} real qpdf inputs, both launchers, disk bytes/2x RGB/rotation/note count, cancelled + failed overwrite, Save As, same-tab dirty and repeated saves, cached retry invalidation.`);await p.context().close()
}
;(async()=>{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'paperwork-source-identity-'));let server,browser
  try {
    const {createServer}=await import('vite'), {default:react}=await import('@vitejs/plugin-react'), {offlineQpdf}=await import('../build/qpdf-engine.mjs')
    // No bundling or release plugins: even closing this server cannot write dist/release assets.
    server=await createServer({root,configFile:false,cacheDir:file('vite'),logLevel:'error',plugins:[react(),offlineQpdf()],server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,file('vite')]}},optimizeDeps:{include:['react','react-dom','react-dom/client','@tanstack/react-virtual','@dnd-kit/core','@dnd-kit/sortable','pdf-lib','pdfjs-dist','qpdf-run','lucide-react','@headlessui/react','three','fflate']}})
    await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({channel:'msedge',headless:true});console.log('Edge',browser.version())
    const which=process.argv[2];assert(!which||['watermarks','compression'].includes(which));if(!which||which==='watermarks')await watermarkTest(browser);if(!which||which==='compression')await compressionTest(browser)
  } finally {await browser?.close();await server?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:3})}
})().catch(e=>{console.error(e);process.exitCode=1})
