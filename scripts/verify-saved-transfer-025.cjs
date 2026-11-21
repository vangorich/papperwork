// Reproducers H02/P01: live source renderer + real Edge/qpdf. All files and grants
// are synthetic, all writes are confined to a fresh directory, no native app needed.
// Run: node scripts/verify-saved-transfer-025.cjs [H02|P01]
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright-core')
const { PDFDocument, rgb } = require('pdf-lib')
const root = path.resolve(__dirname, '..')
const shell = p => p.locator('.app-shell:visible').first()
const stage = p => shell(p).locator('#pdf-stage .stage-page[data-current]')
const button = (root, name) => root.getByRole('button', {name, exact:true})
const menu = (p, name) => p.getByRole('menuitem', {name, exact:true})
const tab = (p, name) => shell(p).locator('.editor-tabs [role="tab"]').filter({hasText:name})

async function fixture(labels, rawImage = false) {
  const d = await PDFDocument.create()
  for (const [i, label] of labels.entries()) {
    const pg = d.addPage([400,300]); pg.drawText(label,{x:28, y:248, size:16})
    pg.drawRectangle({x:42+i*20, y:54, width:64, height:100, color:rgb(.83,.76,.58)})
    if (rawImage) { // A meaningful referenced stream that remains compressible even after Ctrl+S.
      const im = d.context.register(d.context.stream(Buffer.alloc(192*200*3,221),{Type:'XObject',Subtype:'Image',ColorSpace:'DeviceRGB',BitsPerComponent:8,Width:192,Height:200}))
      const name = pg.node.newXObject('Tone', im)
      pg.node.addContentStream(d.context.register(d.context.stream(`q 130 0 0 110 85 50 cm ${name} Do Q`)))
    }
  }
  return Buffer.from(await d.save({useObjectStreams:false}))
}
async function app(browser, origin, setup) {
  const ctx=await browser.newContext({viewport:{width:1720,height:990},reducedMotion:'reduce',acceptDownloads:true,serviceWorkers:'block'})
  const p=await ctx.newPage(); p.setDefaultTimeout(12000)
  await ctx.route(/^https?:\/\//, r=>new URL(r.request().url()).origin===origin?r.continue():r.abort())
  p.on('pageerror',e=>console.error('renderer:',e.message))
  if (setup) await setup(p)
  await p.goto(origin); await shell(p).locator('.document-desk__actions').waitFor()
  return p
}
async function drop(p, name, bytes) {
  await shell(p).evaluate((el,[name,b64])=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],name,{type:'application/pdf'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}))},[name,bytes.toString('base64')])
  await tab(p,name).click(); await stage(p).locator('.text-layer .endOfContent').waitFor({state:'attached'})
}
async function transfer(p, name, count, part = false) {
  if (part) await stage(p).locator('.pdf-page').click({button:'right',position:{x:12,y:12}})
  else await tab(p,name).click({button:'right'})
  await menu(p,'加入工作区').click()
  const d=p.getByRole('dialog',{name:'加入哪个工作区？'})
  await button(d,`加入 ${count} 页`).click(); await d.waitFor({state:'hidden'})
  await button(shell(p),'页面整理').waitFor()
}
async function exportMerge(p, dest) {
  await button(shell(p),'页面整理').click()
  const dl=p.waitForEvent('download'); await menu(p,'合并导出').click(); await (await dl).saveAs(dest)
}
async function saveAs(p, dest) {
  const dl=p.waitForEvent('download'); await p.keyboard.press('Control+Shift+s'); await (await dl).saveAs(dest)
}
async function markDialog(p, isEdit) {
  await button(shell(p),isEdit?'编辑水印':'添加水印').click()
  return p.getByRole('dialog',{name:isEdit?'编辑文档水印':'插入水印'})
}
async function h02(browser,origin,dir) {
  const file=n=>path.join(dir,n+'.pdf'), base=await fixture(['Marked page ONE','Marked page TWO']), plain=await fixture(['Other document'])
  const p=await app(browser,origin)
  try {
    await fs.writeFile(file('base'),base); await fs.writeFile(file('other'),plain)
    // Create an owned, nonopaque mark with the actual UI, then reopen the saved file.
    await drop(p,'base.pdf',base);let d=await markDialog(p,false)
    await d.locator('[name=watermark-text]').fill('FIRST INK'); await d.getByRole('checkbox',{name:/平铺到每一页/}).check()
    await button(d,'添加水印').click();await saveAs(p,file('owned'))
    const original=await fs.readFile(file('owned'));await drop(p,'owned.pdf',original)
    await stage(p).locator('.watermark-tile').first().waitFor();await transfer(p,'owned.pdf',2)
    await stage(p).locator('.watermark-tile').first().waitFor();await exportMerge(p,file('first-merge'))
    await button(shell(p),'浏览').click();await tab(p,'owned.pdf').click()
    d=await markDialog(p,true);await d.locator('[name=watermark-text]').fill('SECOND INK');await d.getByRole('checkbox',{name:/平铺到每一页/}).uncheck()
    await d.locator('summary').click();await d.getByRole('spinbutton',{name:/不透明度/}).fill('62');await button(d,'保存修改').click()
    await saveAs(p,file('edited'));await button(shell(p),'下一页（Page Down）').click()
    await stage(p).locator('.text-layer span').filter({hasText:'Marked page TWO'}).first().waitFor({state:'attached'})
    await transfer(p,'owned.pdf',1,true)
    await button(shell(p),'浏览').click();await tab(p,'owned.pdf').click();d=await markDialog(p,true);await button(d,'移除水印').click()
    await stage(p).locator('.watermark-tile').first().waitFor({state:'detached'});await transfer(p,'owned.pdf',2)
    await button(shell(p),'浏览').click();await drop(p,'other.pdf',plain);await transfer(p,'other.pdf',1)
    await exportMerge(p,file('mixed'));assert((await fs.readFile(file('owned'))).equals(original))
    // The project's global layer can coexist with the source layers. Removing it
    // must restore exactly the same six rendered pages, not strip the imported art.
    d=await markDialog(p,false);await d.locator('[name=watermark-text]').fill('PROJECT');await button(d,'添加水印').click();await exportMerge(p,file('global'))
    await transfer(p,null,1,true);await exportMerge(p,file('same-project'))
    d=await markDialog(p,true);await button(d,'移除水印').click();await exportMerge(p,file('global-removed'))
    await button(shell(p),'浏览').click();await drop(p,'global.pdf',await fs.readFile(file('global')))
    d=await markDialog(p,true);await button(d,'移除水印').click();await saveAs(p,file('reopened-global-removed'))
    // Independent image-watermark reproduction (a nonuniform colored PNG, no user asset).
    await drop(p,'stamp-base.pdf',base);d=await markDialog(p,false);await d.getByText('图片 / 电子章',{exact:true}).click()
    const png=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=32;const g=c.getContext('2d');g.fillStyle='#b83c23';g.fillRect(0,0,40,20);g.fillStyle='#186f55';g.fillRect(22,10,42,22);return c.toDataURL().split(',')[1]})
    await d.locator('input[type=file]').setInputFiles({name:'stamp.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await button(d,'添加水印').click();await saveAs(p,file('stamp'))
    const stamp=await fs.readFile(file('stamp'));await drop(p,'stamp.pdf',stamp);await stage(p).locator('.watermark-tile img').first().waitFor();await transfer(p,'stamp.pdf',2)
    await exportMerge(p,file('with-stamp'));assert((await fs.readFile(file('stamp'))).equals(stamp))
    const check=spawnSync(process.env.PYTHON||'python',['-I','-B','-X','utf8','-c',String.raw`
from pathlib import Path
import sys, pymupdf as mu
p=Path(sys.argv[1]); scale=mu.Matrix(2,2)
def frames(name):
    with mu.open(p/(name+'.pdf')) as d: return [pg.get_pixmap(matrix=scale,alpha=False).samples for pg in d]
b=frames('base'); a=frames('owned'); c=frames('edited'); o=frames('other'); first=frames('first-merge'); m=frames('mixed'); g=frames('global'); r=frames('global-removed')
assert len(b)==len(a)==len(c)==2 and len(o)==1
assert all(x!=y and y!=z and x!=z for x,y,z in zip(b,a,c)), 'independent versions must have distinct pixels'
# MuPDF rounds concatenated translate/rotate/scale operators slightly differently
# from an equivalent single cm. Bound both magnitude and coverage; absent/doubled
# semi-transparent ink changes thousands of pixels by much more than one level.
changed=[]
def same_ink(x,y):
    if x==y: changed.append(0); return True
    if len(x)!=len(y): return False
    diffs=[abs(u-v) for u,v in zip(x,y) if u!=v]; changed.append(len(diffs))
    return max(diffs)<=1 and len(diffs)<=len(x)//1000
assert len(first)==2 and all(same_ink(x,y) for x,y in zip(first,a)), 'original transfer lost or doubled its ink'
expected=[*a,c[1],*b,*o]
assert len(m)==len(expected) and all(same_ink(x,y) for x,y in zip(m[:3],expected[:3])) and m[3:]==expected[3:], 'source spill, lost or doubled ink'
s=frames('same-project'); assert s==[*g,g[-1]], 'transferring inside the same project duplicated its global watermark'
assert len(g)==len(m) and all(x!=y for x,y in zip(m,g)) and r==[*m,m[-1]], 'destination mark damaged inherited pages'
assert frames('reopened-global-removed')==m, 'removing only the global layer from the reopened PDF damaged underlying inherited ink'
stamp=frames('stamp'); with_stamp=frames('with-stamp'); assert len(stamp)==2 and all(x!=y for x,y in zip(stamp,b))
assert with_stamp[:-2]==r and all(same_ink(x,y) for x,y in zip(with_stamp[-2:],stamp)), 'two-page image stamp did not survive transfer'
print('H02 PASS: text and image, whole, edited partial and deleted-source transfers; marked page comparisons <=1/255 at 2x (%s changed channels), unmarked pages pixel-exact; project layer did not stack on same-project copy or remove underlying ink on reopen.' % changed)
`,dir],{stdio:'inherit',cwd:root});if(check.error)throw check.error;assert.equal(check.status,0)
  } finally { await p.context().close() }
}
async function p01(browser,origin,dir) {
  const src=path.join(dir,'rotation-original.pdf'),input=await fixture(['Rotation and save specimen'],true)
  await fs.writeFile(src,input,{flag:'wx'})
  let overwrite='ok', copyKind='ok', copyNo=0, saveNo=0, calls=0, releaseWrite
  const pendingWrite=new Promise(r=>releaseWrite=r)
  const writes=[]
  const p=await app(browser,origin,async p=>{
    await p.exposeFunction('readSynthetic',async()=>({bytes:(await fs.readFile(src)).toString('base64'),name:path.basename(src),path:src,desktopGrant:'open-fixture-grant'}))
    await p.exposeFunction('writeSynthetic',async(kind,b64,pathOrName,grant)=>{
      const bytes=Buffer.from(b64,'base64');let out
      if(kind==='original') {
        assert.equal(pathOrName,src);assert.equal(grant,'open-fixture-grant');calls++
        if(overwrite==='cancel')return null
        if(overwrite==='fail')await fs.writeFile(src,bytes,{flag:'wx'}) // genuine EEXIST, never clobber
        if(overwrite==='hold')await pendingWrite
        out=src
      } else if(kind==='saveAs'){out=path.join(dir,`saveAs-${++saveNo}.pdf`)}
      else {assert.equal(kind,'compressed');if(copyKind==='cancel')return null;out=path.join(dir,`compressed-${++copyNo}.pdf`)}
      await fs.writeFile(out,bytes,kind==='original'?{}:{flag:'wx'});writes.push(out);return out
    })
    await p.addInitScript(()=>{
      const base64=bytes=>new Promise((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(r.result.split(',')[1]);r.onerror=fail;r.readAsDataURL(new Blob([bytes]))}),off=()=>()=>{},noop=()=>{}
      window.proofWrites={started:0,settled:0}
      window.desktop={onOpenFileRequested:off,notifyRendererReady:noop,onCloseRequest:off,onSessionReset:off,setWorkspaceDirty:noop,getOcrStatus:async()=>({}),getOcrCapabilities:async()=>({}),
        openFiles:async()=>{const v=await window.readSynthetic();return [{...v,type:'pdf',bytes:Uint8Array.from(atob(v.bytes),c=>c.charCodeAt(0))}]},
        overwritePdf:async(b,path,grant)=>{const bytes=await base64(b);window.proofWrites.started++;try{return await window.writeSynthetic('original',bytes,path,grant)}finally{window.proofWrites.settled++}},
        savePdf:async(b,name)=>window.writeSynthetic('saveAs',await base64(b),name),savePdfCopy:async(b,name)=>window.writeSynthetic('compressed',await base64(b),name)}
    })
  })
  const angle=async f=>(await PDFDocument.load(await fs.readFile(f))).getPage(0).getRotation().angle
  const status=re=>shell(p).getByRole('status').filter({hasText:re}).first().waitFor()
  const current=()=>stage(p).locator('.text-layer')
  async function turn(n){await button(shell(p),'向右旋转当前页').click();await p.waitForFunction(n=>{const t=document.querySelector('.app-shell:not([hidden]) #pdf-stage .stage-page[data-current] .text-layer');return t&&Number(t.getAttribute('data-main-rotation')||0)===n},n)}
  async function compress(from){if(from==='tab'){await tab(p,path.basename(src)).click({button:'right'});await menu(p,'压缩 PDF').click()}else await button(shell(p),'压缩 PDF').click();const d=p.locator('.compression-dialog__panel');await d.locator('input[value="lossless"]').check();return d}
  async function copy(from,expected){const before=copyNo,d=await compress(from);await button(d,'压缩并另存为').click();await d.waitFor({state:'hidden',timeout:35000});assert.equal(copyNo,before+1);assert.equal(await angle(writes.at(-1)),expected,from+' compressed wrong revision');return writes.at(-1)}
  try {
    await shell(p).locator('.document-desk__actions button').first().click();await current().locator('.endOfContent').waitFor({state:'attached'})
    await turn(90);const pristine=await copy('top',0);assert((await fs.readFile(src)).equals(input))
    // A cancelled result for the old input is live while an already-pending original
    // write completes. Retrying inside that same dialog must run qpdf on new bytes.
    overwrite='hold';await p.keyboard.press('Control+s');await p.waitForFunction(()=>window.proofWrites.started===1)
    copyKind='cancel';const d=await compress('tab');await button(d,'压缩并另存为').click();await button(d,'重选保存位置').waitFor({timeout:35000})
    releaseWrite();overwrite='ok';copyKind='ok';await status(/已保存当前文档/);assert.equal(await angle(src),90)
    await button(d,'压缩并另存为').click();await d.waitFor({state:'hidden',timeout:35000})
    const saved=writes.at(-1);assert.equal(await angle(saved),90);const savedBytes=await fs.readFile(src)
    const viaTop=await copy('top',90);await turn(180);await p.keyboard.press('Control+Shift+s');await status(/PDF 副本已另存/);assert.equal(await angle(writes.at(-1)),180)
    await copy('tab',90);await turn(270);overwrite='cancel';await p.keyboard.press('Control+s');await p.waitForFunction(()=>window.proofWrites.settled===2);await copy('top',90)
    overwrite='fail';await p.keyboard.press('Control+s');await status(/EEXIST/);await copy('tab',90);assert((await fs.readFile(src)).equals(savedBytes));assert.equal(calls,3)
    overwrite='ok';await p.keyboard.press('Control+s');await status(/已保存当前文档/);assert.equal(await angle(src),270);const last=await copy('top',270)
    // Read actual source/copy bytes back using an independent PDF renderer, not the test bridge.
    const savedFile=path.join(dir,'first-save.pdf'),baseFile=path.join(dir,'initial.pdf');await fs.writeFile(savedFile,savedBytes);await fs.writeFile(baseFile,input)
    const check=spawnSync(process.env.PYTHON||'python',['-I','-B','-c',String.raw`
import sys,pymupdf as mu
def page(path):
    with mu.open(path) as d:
        p=d[0]; bm=p.get_pixmap(matrix=mu.Matrix(2,2),alpha=False); return p.rotation,bm.width,bm.height,bm.samples
for a,b in zip(sys.argv[1::2],sys.argv[2::2]): assert page(a)==page(b), (a,b)
`,baseFile,pristine,savedFile,saved,savedFile,viaTop,src,last],{stdio:'inherit',cwd:root});if(check.error)throw check.error;assert.equal(check.status,0)
    console.log('P01 PASS: original 0°, unsaved 90° excluded; pending overwrite invalidated cached retry -> 90°; tab/top preserved 90° across Save As, cancellation and failed write; next overwrite 270°, not double-rotated. Four disk/copy pixel pairs exact at 2x.')
  } finally {releaseWrite?.();await p.context().close()}
}
async function main(){
  const target=process.argv[2];assert(!target||['H02','P01'].includes(target))
  const dir=await fs.mkdtemp(path.join(tmpdir(),'paperwork-saved-transfer-'));let server,browser
  try {
    const [{createServer},{default:react},{offlineQpdf}]=await Promise.all([import('vite'),import('@vitejs/plugin-react'),import('../build/qpdf-engine.mjs')])
    // No production config/closeBundle hooks: closing this server must not write dist.
    server=await createServer({root,configFile:false,cacheDir:path.join(dir,'cache'),logLevel:'error',plugins:[react(),offlineQpdf(),{name:'qa-fonts',configureServer(s){s.middlewares.use((req,_res,next)=>{if(/^\/pdfjs\/(?:cmaps|standard_fonts)\/[\w.-]+$/.test(req.url))req.url='/node_modules/pdfjs-dist/'+req.url.slice(7);next()})}}],worker:{format:'es',plugins:()=>[offlineQpdf()]},optimizeDeps:{include:['@tanstack/react-virtual','@dnd-kit/core','@dnd-kit/sortable','pdf-lib','pdf-lib/es/api/svgPath']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,dir]}}})
    await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;browser=await chromium.launch({channel:'msedge',headless:true});console.log('Edge',browser.version())
    if(!target||target==='H02')await h02(browser,origin,dir);if(!target||target==='P01')await p01(browser,origin,dir)
  } finally {try{await browser?.close()}finally{await server?.close();if(process.env.PW_KEEP_SYNTHETIC_PDFS)console.log('Synthetic evidence:',dir);else await fs.rm(dir,{recursive:true,force:true})}}
}
main().catch(e=>{console.error(e);process.exitCode=1})
