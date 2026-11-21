/* Browser or real Windows host smoke test. Only synthetic fixtures; no external URLs.
 * node scripts/verify-workbench.cjs --web http://127.0.0.1:5173
 * node scripts/verify-workbench.cjs --exe path/to/paperwork-studio.exe [--pages 180] [--ofd fixture.ofd]
 * For the previous packaged app: use --electron path/to/legacy.exe (diagnostic, not a keyboard assertion).
 */
const { chromium } = require('playwright-core')
const { PDFDocument, PDFName, PDFHexString, StandardFonts, rgb } = require('pdf-lib')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined

async function fixture(filename, count) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  let seed = 1729
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([560, 900]); page.drawText(`Paperwork test • ${i + 1}`, { x: 45, y: 830, font, size: 25, color: rgb(.08,.23,.3) })
    // A unique high-contrast strip lets the native-window probe detect a genuinely painted page.
    page.drawRectangle({x:40,y:765,width:485,height:28,color:i%2 ? rgb(.07,.60,.31) : rgb(.46,.13,.72)})
    // Unique gray image per page, incompressible enough to exercise real byte transfer.
    const size = count > 12 ? 480 : 96, pixels = Buffer.alloc(size * size)
    for (let j = 0; j < pixels.length; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[j] = (seed >>> 24) }
    const image = doc.context.register(doc.context.stream(pixels, { Type:'XObject', Subtype:'Image', Width:size, Height:size, BitsPerComponent:8, ColorSpace:'DeviceGray' }))
    const name = page.node.newXObject('Print', image)
    page.node.addContentStream(doc.context.register(doc.context.stream(`q 430 0 0 540 65 200 cm ${name} Do Q\n`)))
  }
  const outline = doc.context.nextRef(), bookmark = doc.context.nextRef()
  doc.context.assign(bookmark, doc.context.obj({ Title: PDFHexString.fromText('Opening leaf'), Parent:outline, Dest:[doc.getPage(0).ref, PDFName.of('Fit')] }))
  doc.context.assign(outline, doc.context.obj({ Type:'Outlines', First:bookmark, Last:bookmark, Count:1 }))
  doc.catalog.set(PDFName.of('Outlines'), outline); await fs.writeFile(filename, await doc.save())
}
async function freePort() {
  const server = net.createServer(); await new Promise((ok,fail) => server.once('error',fail).listen(0,'127.0.0.1',ok)); const port=server.address().port; await new Promise(ok=>server.close(ok));return port
}
async function waitPaint(page) {
  await page.waitForFunction(() => {
    const canvas=document.querySelector('.stage .stage-page canvas[aria-label="PDF 页面画布"]'); if (!canvas || canvas.width <= 4 || canvas.height <= 4) return false
    const ctx=canvas.getContext('2d'); const data=ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),4,4).data
    return data.some((value,i)=>i%4===0 && value<245 && data[i+3]>0)
  },null,{timeout:90000,polling:32})
}
async function main() {
  const web = arg('--web'), legacy = arg('--electron'), exe = arg('--exe') || legacy
  if (!!web === !!exe) throw Error('Choose --web, --exe or --electron')
  const pages=Number(arg('--pages') ?? 6);assert(Number.isInteger(pages) && pages>=3 && pages<=1000)
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paperwork-smoke-')), pdf=path.join(dir,'Synthetic leaves.pdf')
  let proc, browser, page
  const ofd = arg('--ofd') && path.resolve(arg('--ofd')); const origin=web && new URL(web); if(web) assert(['localhost','127.0.0.1','[::1]'].includes(origin.hostname))
  const results={host:web?'web':legacy?'electron':'tauri',pages}
  try {
    await fixture(pdf,pages);results.bytes=(await fs.stat(pdf)).size
    if (exe && (!legacy || args.includes('--pixels')) && !args.includes('--cdp')) {
      // Production WebView2 may disable remote debugging. Observe the actual window,
      // not a modified development executable; the browser test covers focus events.
      const driver = spawnSync('python',['-I','-X','utf8',path.join(__dirname,'verify-native-reader.py'),'--exe',path.resolve(exe),'--pdf',pdf,...(legacy?['--electron']:[]),...(ofd?['--ofd',ofd]:[]),...(arg('--screenshot')?['--screenshot',path.resolve(arg('--screenshot'))]:[])],{stdio:'inherit',timeout:155000})
      if (driver.error || driver.status !== 0) throw driver.error || new Error(`Windows pixel test failed: ${driver.status}`)
      return
    }
    if(web) {
      browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:940}});await page.goto(web)
    } else {
      const port=await freePort(), debug=`http://127.0.0.1:${port}`, profile=path.join(dir,'webview')
      const env={...process.env,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`};delete env.ELECTRON_RUN_AS_NODE
      const nativeArgs=legacy?[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`]:[]
      proc=spawn(path.resolve(exe),nativeArgs,{env,stdio:'ignore'});const start=performance.now();
      while(performance.now()-start<65000){if(proc.exitCode!=null)throw Error('Test host exited. Close any other instance of this test product first.');try{if((await fetch(debug+'/json/version',{signal:AbortSignal.timeout(650)})).ok)break}catch{} await delay(150)}
      browser=await chromium.connectOverCDP(debug,{timeout:6000}); const context=browser.contexts()[0];page=context.pages()[0]||await context.waitForEvent('page',{timeout:15000});results.startupCdpMs=Math.round(performance.now()-start)
      results.environment=await page.evaluate(()=>navigator.userAgent)
    }
    page.on('pageerror', error => console.error('Renderer error:',error.message));page.setDefaultTimeout(25000);await page.locator('.app-shell:visible').first().waitFor();
    const open=async file=>{
      if(web){const picker=page.waitForEvent('filechooser');const shell=page.locator('.app-shell:visible').first();const btn=shell.locator('.document-desk__actions button, .empty-state button').first(); if(await btn.isVisible())await btn.click();else await shell.getByRole('button',{name:/打开文件|添加文件/}).first().click();await(await picker).setFiles(file)}
      else {const nativeArgs=legacy?[`--user-data-dir=${path.join(dir,'webview')}`,file]:[file];const env={...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(dir,'webview')};delete env.ELECTRON_RUN_AS_NODE;spawn(path.resolve(exe),nativeArgs,{env,stdio:'ignore'}).unref()}
    }
    const start=performance.now();await open(pdf); await waitPaint(page);results.firstCanvasMs=Math.round(performance.now()-start)
    const shell=page.locator('.app-shell:visible').first(),num=shell.getByRole('textbox',{name:/当前页码/}).or(shell.locator('input[aria-label^="当前页码"]')).first();await num.waitFor()
    if(!legacy && pages>64){
      const list=shell.locator('.thumbnail-list--direct'),rows=list.locator('.thumbnail');await list.locator('[data-thumbnail-window]').waitFor();await rows.first().waitFor();const firstCount=await rows.count();assert(firstCount>0 && firstCount<30,`Unexpected initial rows: ${firstCount}`)
      const far=pages-6; await num.fill(String(far));await num.press('Enter');const selected=list.locator('.thumbnail[data-active]');await page.waitForFunction(n=>document.querySelector('.thumbnail[data-active]')?.getAttribute('aria-label')?.startsWith(`第 ${n} 页`),far)
      await selected.focus();await selected.press('ArrowDown');await page.waitForFunction(n=>document.activeElement?.getAttribute('aria-label')?.startsWith(`第 ${n} 页`),far+1)
      const reordered=list.locator('.thumbnail[data-active]');const id=await reordered.getAttribute('data-page-id');const from=await reordered.locator('..').getAttribute('data-index');const handle=reordered.getByRole('button',{name:'拖动排序'});await handle.focus();await handle.press('Space');await list.locator('.thumbnail[data-move-target]').waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.keyboard.press('ArrowDown');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.keyboard.press('Space');await list.locator('.thumbnail[data-move-target]').waitFor({state:'detached',timeout:5500});await page.waitForFunction(({id,from})=>{const n=document.querySelector(`.thumbnail[data-page-id="${id}"]`)?.parentElement?.dataset.index;return n!=null && +n===+from+1},{id,from},{timeout:5500});results.sidebar={total:pages,mountedInitially:firstCount,mountedAtFarPage:await rows.count(),farJump:far,keyboardReordered:true}
    }
    if(!legacy && pages>64){
      const list=shell.locator('.thumbnail-list--direct');await num.fill('5');await num.press('Enter');
      const moving=list.locator('[data-index="4"] .thumbnail[data-active]');await moving.waitFor();const id=await moving.getAttribute('data-page-id');
      const grip=moving.getByRole('button',{name:'拖动排序'});await grip.scrollIntoViewIfNeeded();await grip.hover();
      const start=await grip.boundingBox();assert(start);let x=start.x+start.width/2,y=start.y+start.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y+2,{steps:3});await list.locator('.thumbnail[data-dragging]').waitFor();
      const other=await list.locator('[data-index="5"] .thumbnail').boundingBox();const own=await moving.boundingBox();assert(own && other);await page.mouse.move(other.x+other.width*.5,other.y+other.height*.76,{steps:14});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.mouse.up();
      await page.waitForFunction(id=>document.querySelector(`.thumbnail[data-page-id="${id}"]`)?.parentElement?.dataset.index==='5',id,{timeout:5000});results.sidebar.pointerReordered=true
      await delay(100) // dnd-kit keeps a capture-phase click shield for 50ms after a pointer drag.
    }
    const outline=shell.getByRole('tab',{name:'目录'});await outline.click();
    // dnd-kit intentionally suppresses the trailing pointer click for 50 ms after a drop.
    // If that swallowed our synthetic click, use the accessible tab action instead.
    if(await outline.getAttribute('aria-selected')!=='true')await outline.press('Enter');const row=shell.getByRole('button',{name:/Opening leaf/});await row.click();
    await page.waitForFunction(()=>document.querySelector('.app-shell:not([hidden]) input[aria-label^="当前页码"]').value==='1');await row.press('ArrowDown');
    if(!legacy) {
      const waitNum=async n=>page.waitForFunction(n=>Number(document.querySelector('.app-shell:not([hidden]) input[aria-label^="当前页码"]').value)===n,n)
      await waitNum(2);await row.press('ArrowDown');await waitNum(3);await row.press('ArrowUp');await waitNum(2);await row.press('ArrowUp');await waitNum(1);await row.press('ArrowUp');assert.equal(await num.inputValue(),'1');assert(await row.evaluate(e=>e===document.activeElement))
      const chooseLayout=async name=>{await shell.getByRole('button',{name:/^阅读布局/}).click();await page.getByRole('menuitemradio',{name,exact:true}).click()};await chooseLayout('连续滚动');await row.focus();const consumed=await row.evaluate(e=>!e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));assert.equal(consumed,false);await chooseLayout('单页');results.outline='single page 1→2→3→2→1, boundary and focus retained; continuous key not consumed'
      await page.keyboard.press('h');const stage=shell.locator('#pdf-stage');await page.waitForFunction(()=>document.querySelector('#pdf-stage')?.hasAttribute('data-hand'));await stage.evaluate(e=>e.scrollTo({top:0,behavior:'instant'}));const sb=await stage.boundingBox();assert(sb);const px=sb.x+sb.width*.58,py=sb.y+sb.height*.61;await page.mouse.move(px,py);await page.mouse.down();await page.mouse.move(px,py-75,{steps:6});await page.mouse.up();assert(await stage.evaluate(e=>e.scrollTop>30),'hand tool did not move the document');await page.keyboard.press('v');await page.waitForFunction(()=>!document.querySelector('#pdf-stage')?.hasAttribute('data-hand'));results.handTool='H drags the document; V restores selection'
      if(!web)results.nativeOcr=await page.evaluate(async()=>{const c=await window.desktop.getOcrCapabilities();return {engine:c.engine,local:c.local,languages:c.languages}})
    } else {results.legacyOutlineDown=await num.inputValue()}
    if(ofd && !web && !legacy){await open(ofd); const base=path.basename(ofd,path.extname(ofd));await shell.getByText(new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).first().waitFor();results.openedOfd=base}
    if(arg('--screenshot'))await page.screenshot({path:path.resolve(arg('--screenshot'))})
    process.stdout.write(JSON.stringify(results,null,2)+'\n')
  } catch (error) {
    if (page && !page.isClosed()) console.error('Smoke state:',await page.evaluate(()=>({url:location.origin,root:document.body.innerText.slice(-1000),canvases:[...document.querySelectorAll('.stage canvas')].slice(0,2).map(c=>[c.width,c.height])})).catch(()=>null)); throw error
  } finally {
    if(browser && web) await browser.close().catch(()=>{});
    if(proc && proc.exitCode===null){const done=new Promise(ok=>proc.once('exit',ok));proc.kill();await Promise.race([done,delay(2500)])}
    if(browser && !web) await browser.close().catch(()=>{});
    await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:250}).catch(()=>console.warn('Temporary WebView profile may still be closing:',dir))
  }
}
if (arg('--make-pdf')) {
  fixture(path.resolve(arg('--make-pdf')),Number(arg('--pages') || 180)).catch(e=>{console.error(e);process.exitCode=1})
} else main().catch(e=>{console.error(e);process.exitCode=1})
