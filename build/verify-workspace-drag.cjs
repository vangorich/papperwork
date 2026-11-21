const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { execFileSync, spawn } = require('node:child_process')
const { _electron: electron, chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
;(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-drag-'))
 const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE
 let app,browser,launcher
 try{
  let page
  if(process.env.OCR_E2E_PORTABLE==='1'){
   const port=19385
   launcher=spawn(process.env.OCR_E2E_EXECUTABLE,[`--user-data-dir=${dir}`,`--remote-debugging-port=${port}`],{env,stdio:'ignore'})
   const deadline=Date.now()+120000;let endpoint
   while(Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){endpoint=`http://127.0.0.1:${port}`;break}}catch{};await new Promise(r=>setTimeout(r,500))}
   assert(endpoint,'Portable did not start');browser=await chromium.connectOverCDP(endpoint);page=browser.contexts()[0].pages()[0]
  }else{
   app=await electron.launch({executablePath:process.env.OCR_E2E_EXECUTABLE,args:[`--user-data-dir=${dir}`],env,timeout:60000})
   page=await app.firstWindow()
  }
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  const active=()=>page.locator('.app-shell:not([hidden])')
  await active().getByRole('button',{name:'工作区',exact:true}).click()
  if(app){
   await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},process.env.OCR_E2E_PDF)
   await active().getByRole('button',{name:'打开',exact:true}).click()
  }else{
   await active().evaluate((shell,{bytes,name})=>{
    const data=Uint8Array.from(atob(bytes),c=>c.charCodeAt(0));const transfer=new DataTransfer()
    transfer.items.add(new File([data],name,{type:'application/pdf'}))
    shell.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))
   },{bytes:fs.readFileSync(process.env.OCR_E2E_PDF).toString('base64'),name:path.basename(process.env.OCR_E2E_PDF)})
  }
  await active().locator('.sidebar .thumbnail').nth(2).waitFor({timeout:60000})
  const measure=()=>page.evaluate(()=>{
   const app=document.querySelector('.app-shell:not([hidden])')
   const rect=s=>{const e=app.querySelector(s);const b=e?.getBoundingClientRect();return b?{x:b.x,y:b.y,w:b.width,h:b.height}:null}
   return {windowY:scrollY,htmlY:document.documentElement.scrollTop,bodyY:document.body.scrollTop,rootY:document.getElementById('root').scrollTop,appY:app.scrollTop,title:rect('.titlebar'),toolbar:rect('.toolbar'),tabs:rect('.project-bar'),sidebar:rect('.sidebar'),scrolling:[...app.querySelectorAll('*')].filter(e=>e.scrollTop!==0).slice(0,12).map(e=>({cls:e.className,y:e.scrollTop}))}
  })
  const before=await measure();const samples=[before]
  const order=()=>active().locator('.sidebar .thumbnail').evaluateAll(es=>es.map(e=>e.dataset.pageId))
  const originalOrder=await order()
  const first=active().locator('.sidebar .thumbnail').first()
  const selector='button[title*="拖"], button[aria-label*="拖"], .thumbnail__drag'
  const handle=first.locator(selector).first()
  if(!await handle.count())throw Error('Drag handle missing '+JSON.stringify(await first.locator('button').evaluateAll(bs=>bs.map(b=>({title:b.title,aria:b.getAttribute('aria-label'),cls:b.className})))))
  const b=await handle.boundingBox();const side=await active().locator('.sidebar').boundingBox()
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down()
  await page.mouse.move(b.x+b.width/2+15,b.y+b.height/2+15,{steps:5});await page.waitForTimeout(250);samples.push(await measure())
  await page.mouse.move(side.x+side.width*.5,side.y+side.height-8,{steps:20});await page.waitForTimeout(1800);samples.push(await measure())
  if(process.env.DEBUG_SCREENSHOTS)await page.screenshot({path:path.join(process.env.DEBUG_SCREENSHOTS,'workspace-drag-during.png')})
  await page.mouse.up();await page.waitForTimeout(400);samples.push(await measure())
  const afterDropOrder=await order()
  assert.notDeepEqual(afterDropOrder,originalOrder,'Pointer dragging did not reorder pages')
  assert.deepEqual([...afterDropOrder].sort(),[...originalOrder].sort(),'Drag changed page membership')
  assert(samples[2].scrolling.some(e=>e.cls.includes('thumbnail-list')&&e.y>0),'Sidebar edge autoscroll stopped working')
  const second=active().locator('.sidebar .thumbnail').nth(1)
  await second.locator(selector).first().focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowDown');await page.keyboard.press('Space');await page.waitForTimeout(300);samples.push(await measure())
  await page.waitForTimeout(1500)
  if(process.env.DEBUG_SCREENSHOTS)await page.screenshot({path:path.join(process.env.DEBUG_SCREENSHOTS,'workspace-drag-after.png')})
  console.log(JSON.stringify({errors,samples},null,2))
  assert.deepEqual(errors,[])
  for(const sample of samples){assert(Math.abs(sample.title.y-before.title.y)<1,'Titlebar moved off-screen');assert(Math.abs(sample.toolbar.y-before.toolbar.y)<1,'Toolbar moved off-screen');assert.equal(sample.rootY,0,'Root scrolled');assert.equal(sample.bodyY,0,'Body scrolled');assert.equal(sample.appY,0,'Shell scrolled');assert.equal(sample.windowY,0,'Document scrolled')}
 }finally{if(browser)await browser.close().catch(()=>{});const pid=app?.process().pid??launcher?.pid;if(pid)try{execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{stdio:'ignore'})}catch{};try{fs.rmSync(dir,{recursive:true,force:true})}catch{}}
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
