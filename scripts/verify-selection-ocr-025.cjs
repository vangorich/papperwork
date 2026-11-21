// Fresh local Edge. Only OCR IPC and the clipboard sink are bridged; words, boxes, DOM ranges and mouse drags are real.
// Prerequisite: built x64 native-support debug rlib, Rust/MSVC, installed Windows OCR language, local Vite on 5207.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFileSync } = require('node:child_process'), { inflateSync } = require('node:zlib')
const { chromium } = require('playwright-core'), { PDFDocument } = require('pdf-lib')
const root = path.resolve(__dirname, '..'), url = 'http://127.0.0.1:5207/'

// Call the same native_support::binary("ocr") as the Tauri host, on the renderer's actual RGBA.
// Link a temp-only stdin adapter; do not launch an installed app or read its database/clipboard.
function nativeOcr(dir) {
  const target = 'x86_64-pc-windows-msvc', deps = path.join(root, 'src-tauri', 'target', target, 'debug', 'deps')
  const libs = fs.readdirSync(deps).filter(f=>/^libnative_support-.*\.rlib$/.test(f)).map(f=>path.join(deps,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)
  assert(libs.length, 'build the native-support x64 debug library first')
  const src = path.join(dir,'ocr_probe.rs'), exe = path.join(dir,'ocr_probe.exe')
  fs.writeFileSync(src, `use std::{env,io::{self,Read,Write},path::Path};
fn main(){ let mut bytes=Vec::new(); io::stdin().read_to_end(&mut bytes).unwrap();
let json=native_support::binary(Path::new("."),0,"ocr",&env::args().nth(1).unwrap(),&bytes).unwrap(); io::stdout().write_all(&json).unwrap(); }`)
  const host = path.join(root,'src-tauri','target','debug','deps')
  const build=path.resolve(deps,'../build'), winLibs=fs.readdirSync(build).filter(f=>f.startsWith('windows_x86_64_msvc-')).flatMap(f=>{
    const out=path.join(build,f,'output'); if(!fs.existsSync(out)) return []; return [...fs.readFileSync(out,'utf8').matchAll(/^cargo:rustc-link-search=(native=.+)$/gm)].flatMap(m=>['-L',m[1].trim()])
  })
  const args = [src,'--edition=2021','--target',target,'--extern',`native_support=${libs[0]}`,'-L',`dependency=${deps}`,'-L',`dependency=${host}`,...winLibs,'-o',exe]
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','& $env:VERIFY_VC_ENV -Program rustc.exe -CommandArgs ($env:VERIFY_RUST_ARGS | ConvertFrom-Json)'], {
    cwd:dir, env:{...process.env, VERIFY_VC_ENV:path.join(root,'scripts','with-x64-env.ps1'), VERIFY_RUST_ARGS:JSON.stringify(args)}, stdio:['ignore','inherit','inherit'], timeout:90000,
  })
  return (width,height,data) => JSON.parse(execFileSync(exe,[JSON.stringify({width,height,mode:'printed'})],{cwd:dir,input:inflateSync(Buffer.from(data,'base64')),timeout:90000,maxBuffer:8*1024*1024}).toString('utf8'))
}
async function scanPdf(page) {
  const png = await page.evaluate(() => {
    const c=document.createElement('canvas'); c.width=1200; c.height=840
    const g=c.getContext('2d'); g.fillStyle='white'; g.fillRect(0,0,c.width,c.height); g.fillStyle='black'; g.font='38px Arial, "Microsoft YaHei", sans-serif'
    g.fillText('Proof line terminal',92,110); g.fillText('Sentinel',92,189); g.fillText('复核  BETA  123',92,266)
    const table=[['Item','Code','Qty'],['Binder Box','Delta','12'],['Marker','Gamma','34']]
    table.forEach((row,i)=>row.forEach((word,j)=>g.fillText(word,[92,496,922][j],475+i*56)))
    return c.toDataURL('image/png').split(',')[1]
  })
  const doc=await PDFDocument.create(), pg=doc.addPage([450,315]); pg.drawImage(await doc.embedPng(Buffer.from(png,'base64')),{x:0,y:0,width:450,height:315})
  return Buffer.from(await doc.save())
}

async function main() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paperwork-025-selection-')); let browser
  try {
    const recognize=nativeOcr(dir)
    browser=await chromium.launch({channel:'msedge'}); const page=await browser.newPage({viewport:{width:1500,height:960},reducedMotion:'reduce'}); const failures=[]
    page.setDefaultTimeout(10000); page.on('pageerror',e=>{failures.push('renderer: '+e.message);console.error(failures.at(-1))})
    // Do not let unrelated edits on the shared dev server remount this one test page mid-gesture.
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:5207\/\?token=/, ws=>ws.send('{"type":"connected"}'))
    await page.goto(url); assert.equal(await page.title(),'Paperwork PDF Studio')
    const source=await scanPdf(page), choose=page.waitForEvent('filechooser'); await page.locator('.document-desk__actions button').first().click(); await (await choose).setFiles({name:'Synthetic scan.pdf',mimeType:'application/pdf',buffer:source})
    const stage=page.locator('#pdf-stage'), layer=stage.locator('.text-layer').first()
    await stage.locator('canvas').first().waitFor(); await page.getByRole('tab',{name:/Synthetic scan/}).waitFor()
    assert.equal(await layer.locator('span').count(),0,'source must have no underlying PDF text')
    let calls=0
    await page.exposeFunction('recognizeProofPixels',(w,h,b64)=>{ calls++; const r=recognize(w,h,b64); console.log('OCR:',r.model,JSON.stringify(r.text)); return r })
    await page.evaluate(()=>{
      window.desktop={setWorkspaceDirty(){},recognizeOcrPage:async ({width,height,data})=>{
        const zipped=await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
        const base64=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result.split(',')[1]);r.onerror=no;r.readAsDataURL(zipped)})
        return window.recognizeProofPixels(width,height,base64)
      }}
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
        write:async ([item])=>{const pairs=await Promise.all(item.types.map(async t=>[t,await (await item.getType(t)).text()]));window.__proofClip=Object.fromEntries(pairs)},
        writeText:async text=>{window.__proofClip={'text/plain':text}},
      }})
    })
    await page.getByRole('button',{name:'OCR 文字识别',exact:true}).click(); await page.getByRole('menuitem',{name:/仅识别当前页/}).click()
    await stage.locator('.text-layer[data-ocr="true"] span[data-ocr-index]').first().waitFor({timeout:90000}); assert.equal(calls,1)
    await page.getByRole('button',{name:'适合页面',exact:true}).click()
    await page.waitForFunction(()=>![...document.querySelectorAll('.toast')].some(t=>t.offsetWidth&&t.offsetHeight),undefined,{timeout:15000})
    async function stable() {
      await page.waitForFunction(()=>{const l=document.querySelector('#pdf-stage .text-layer[data-ocr]'),p=l?.closest('.pdf-page');return p && Math.abs(l.getBoundingClientRect().width-p.getBoundingClientRect().width)<1})
      await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))))
    }
    const span = text => layer.locator('span[data-ocr-index]').filter({hasText:new RegExp('^'+text+'\\s*$','i')})
    async function point(word,offset,outside=0) {
      const el=span(word); assert.equal(await el.count(),1,'expected one OCR word: '+word)
      return el.evaluate((el,[k,extra])=>{
        const n=el.firstChild,range=document.createRange(),pt=i=>{range.setStart(n,i);range.collapse(true);const b=range.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}}
        const a=pt(0),end=pt(n.textContent.trimEnd().length),len=Math.hypot(end.x-a.x,end.y-a.y); const p=pt(k)
        const shift=extra || (k===n.textContent.trimEnd().length ? -.45 : .45)
        return {x:p.x+shift*(end.x-a.x)/len,y:p.y+shift*(end.y-a.y)/len}
      },[offset,outside])
    }
    async function drag(a,b) {await page.mouse.move(a.x,a.y);await page.mouse.down();try {await page.mouse.move(b.x,b.y,{steps:14})} finally{await page.mouse.up()}}
    // A fresh ClipboardEvent invokes the actual React onCopy handler without touching the system clipboard.
    async function copyText(expected) {
      const snap=await layer.evaluate(l=>{
        const s=getSelection(),r=s.rangeCount?s.getRangeAt(0):null,dt=new DataTransfer(),e=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:dt});(s.anchorNode?.parentElement||l).dispatchEvent(e)
        return {anchor:[s.anchorNode?.textContent?.trim().slice(0,25),s.anchorOffset],focus:[s.focusNode?.textContent?.trim().slice(0,25),s.focusOffset],plain:dt.getData('text/plain'),html:dt.getData('text/html'),native:s.toString(),handled:e.defaultPrevented,rangeInLayer:!!r&&l.contains(r.startContainer)&&l.contains(r.endContainer),cells:l.querySelectorAll('[data-selected]').length}
      }); assert.equal(snap.plain,expected,JSON.stringify(snap));assert(snap.handled&&snap.rangeInLayer);assert.equal(snap.cells,0);assert.equal(snap.html,'')
      // The ink wash should cover only the selected glyph boxes, not the entire word, cell or page.
      await page.waitForFunction(()=>document.querySelector('#pdf-stage .text-layer[data-selection-wash] + .page-selection-wash path[d]'))
      const coverage=await layer.evaluate(async l=>{
        const sel=getSelection(), original=sel.getRangeAt(0).cloneRange()
        // A path[d] can belong to the preceding selection. Sample the next paint,
        // but reject any change of endpoints; don't poll away a geometry error.
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))
        const now=sel.getRangeAt(0)
        if(now.startContainer!==original.startContainer||now.startOffset!==original.startOffset||now.endContainer!==original.endContainer||now.endOffset!==original.endOffset)throw Error('Selection endpoints moved before paint')
        const b=l.nextElementSibling.querySelector('path').getBoundingClientRect(), r=now.getBoundingClientRect()
        return Math.max(...['left','right','top','bottom'].map(k=>Math.abs(r[k]-b[k])))
      })
      assert(coverage<2,'paint differs from selected range by '+coverage+' CSS pixels')
    }
    async function check(name,work){try{await work();console.log('PASS',name)}catch(e){failures.push(name+': '+e.message);console.error('FAIL',failures.at(-1))}}
    const partial=async (label,word,k,otherOffset,outside,expected)=>check(label,async()=>{await drag(await point(word,k),await point(word,otherOffset,outside));await copyText(expected)})
    await partial('line-end forward overshoot','terminal',3,8,14,'minal')
    if(process.env.OCR_SELECTION_SCREENSHOT) await stage.screenshot({path:process.env.OCR_SELECTION_SCREENSHOT})
    await partial('line-start reverse overshoot','Sentinel',5,0,-15,'Senti')
    await check('mixed-script multi-word copy',async()=>{await drag(await point('复',0),await point('123',3));await copyText('复核 BETA 123')})
    const scale=()=>layer.evaluate(l=>Number(l.style.getPropertyValue('--ocr-scale'))), before=await scale()
    await page.getByRole('button',{name:/^放大 Ctrl/}).click(); await page.waitForFunction(s=>Number(document.querySelector('#pdf-stage .text-layer').style.getPropertyValue('--ocr-scale'))>s,before)
    await stable(); await partial('zoomed partial forward','terminal',2,6,0,'rmin'); await partial('zoomed partial reverse','terminal',6,2,0,'rmin')
    await check('multi-line clipped at both ends',async()=>{await drag(await point('terminal',3),await point('Sentinel',3));await copyText('minal\nSen')})
    await check('table glyph partial (not whole cell)',async()=>{
      await drag(await point('Binder',1),await point('Binder',4));await copyText('ind')
      const p=await point('Binder',2);await page.evaluate(()=>{window.__proofClip=null});await page.mouse.click(p.x,p.y,{button:'right'})
      await page.getByRole('menuitem',{name:/复制所选内容/}).click();await page.waitForFunction(()=>window.__proofClip);assert.deepEqual(await page.evaluate(()=>window.__proofClip),{'text/plain':'ind'})
    })
    await partial('whole word within a multi-word cell','Binder',0,6,0,'Binder')
    await check('explicit 2x2 rectangle Ctrl+C',async()=>{
      const cell=(row,col)=>layer.locator(`[data-table-row="${row}"][data-table-column="${col}"]`), corner=async el=>el.evaluate(c=>{const b=c.getBoundingClientRect();return{x:b.right-4,y:b.top+b.height/2}})
      await drag(await corner(cell(1,0)),await point('Gamma',2)); assert.equal(await layer.locator('[data-table-cell][data-selected]').count(),4)
      assert(await page.evaluate(()=>getSelection().isCollapsed)); await page.evaluate(()=>{window.__proofClip=null});await page.keyboard.press('Control+c');await page.waitForFunction(()=>window.__proofClip)
      const result=await page.evaluate(()=>{const c=window.__proofClip;return {plain:c['text/plain'],rows:[...new DOMParser().parseFromString(c['text/html'],'text/html').querySelectorAll('tr')].map(r=>[...r.cells].map(c=>c.textContent))}})
      assert.deepEqual(result,{plain:'Binder Box\tDelta\nMarker\tGamma',rows:[['Binder Box','Delta'],['Marker','Gamma']]})
      if(process.env.OCR_VERIFY_MARKDOWN_GRID==='1'){
        await page.getByRole('toolbar',{name:'PDF 编辑工具栏'}).getByRole('button',{name:'导出 Markdown…',exact:true}).click()
        const dialog=page.getByRole('dialog',{name:'导出 Markdown',exact:true})
        assert(await dialog.getByRole('radio',{name:'当前选区',exact:true}).isChecked())
        await dialog.getByRole('button',{name:'预览文字',exact:true}).click()
        const preview=dialog.getByRole('textbox',{name:'本地预览文字',exact:true});await preview.waitFor()
        const expected='## 第 1 页\n\n| Binder Box | Delta |\n| --- | --- |\n| Marker | Gamma |\n'
        assert.equal(await preview.inputValue(),expected)
        const done=page.waitForEvent('download');await dialog.getByRole('button',{name:'下载 Markdown',exact:true}).click()
        const bytes=[];for await(const chunk of await (await done).createReadStream())bytes.push(chunk)
        assert.equal(Buffer.concat(bytes).toString('utf8'),expected);console.log('PASS 2x2 selected Markdown preview and saved UTF-8; no neighboring cell')
        // Closing a toolbar dialog returns focus to its invoker. Reenter the grid
        // before exercising its cell-local Escape shortcut, as in the no-dialog path.
        await dialog.waitFor({state:'hidden'});await layer.locator('[data-table-cell][data-selected]').first().focus()
      }
      await page.keyboard.press('Escape');assert.equal(await layer.locator('[data-selected]').count(),0)
    })
    for (const quarter of [90,180,270]) {
      await page.getByRole('button',{name:'向右旋转当前页',exact:true}).click()
      await page.waitForFunction(deg=>{const el=[...document.querySelectorAll('#pdf-stage [data-ocr-index]')].find(n=>n.textContent.trim()==='terminal');if(!el)return false;const m=new DOMMatrix(getComputedStyle(el).transform);return Math.round(Math.atan2(m.b,m.a)*2/Math.PI+4)%4===deg/90},quarter)
      await page.getByRole('button',{name:'适合页面',exact:true}).click(); await stable()
      await partial(`${quarter}° inside word reverse`,'terminal',6,2,0,'rmin')
      await partial(`${quarter}° line-end forward overshoot`,'terminal',3,8,14,'minal')
      await partial(`${quarter}° line-start reverse overshoot`,'Sentinel',5,0,-15,'Senti')
      await check(`${quarter}° partial across three words`,async()=>{await drag(await point('Proof',2),await point('terminal',4));await copyText('oof line term')})
    }
    assert.equal(calls,1,'zooming and turning must not rerun OCR');assert.deepEqual(failures,[])
  } finally {await browser?.close(); fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
