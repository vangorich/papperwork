// Measure the shipped dialogs at the minimum supported window; local synthetic PDF only.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { chromium } = require('playwright-core')
const { PDFDocument } = require('pdf-lib')
const root = path.resolve(__dirname, '..')
async function fixture() {
  const doc = await PDFDocument.create()
  for (let i=0;i<3;i++) {
    const p = doc.addPage([420,550]);p.drawText('Reading proof '+(i+1),{x:35,y:510,size:19})
    for(let j=0;j<20;j++)p.drawText('Local specimen: the marked letters belong to this line.',{x:35,y:474-j*18,size:10})
  }
  return Buffer.from(await doc.save({useObjectStreams:false}))
}
const button=(root,name)=>root.getByRole('button',{name,exact:true})
async function hit(el){return el.evaluate(n=>{const b=n.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,t=document.elementFromPoint(x,y);return {x,y,top:b.top,bottom:b.bottom,ok:b.width>0&&b.height>0&&b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth&&(t===n||n.contains(t))}})}
async function run(){
  const dev=process.argv.includes('--dev'), evidence=process.argv.includes('--evidence');let server,browser
  const dest=path.join(root,'docs','verification','0.2.5','visual-final'), external=[],errors=[]
  try{
    if(!dev){const {preview}=await import('vite');server=await preview({root,logLevel:'error',preview:{host:'127.0.0.1',port:0}})}
    const origin=dev?'http://127.0.0.1:5207':'http://127.0.0.1:'+server.httpServer.address().port
    const bytes=await fixture();browser=await chromium.launch({channel:'msedge'})
    for(const [width,height,font,dark] of [[640,510,1,false],[640,510,1.3,true],[1460,940,1.3,false]]){
      const ctx=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',serviceWorkers:'block'})
      try{
        await ctx.addInitScript(({font,dark})=>{localStorage.setItem('paperwork-ui-font-scale',String(font));localStorage.setItem('paperwork-theme',dark?'dark':'light')},{font,dark})
        await ctx.route(/^https?:\/\//,route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(new URL(route.request().url()).origin);return route.abort()})
        const p=await ctx.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));await p.goto(origin)
        const file=p.waitForEvent('filechooser');await p.locator('.document-desk__actions button').first().click();await (await file).setFiles({name:'Reading-proof.pdf',mimeType:'application/pdf',buffer:bytes});const shell=p.locator('.app-shell:visible'),bar=shell.getByRole('toolbar',{name:'PDF 编辑工具栏'})
        await shell.locator('#pdf-stage .text-layer').getByText('Reading proof 1',{exact:true}).first().waitFor({state:'attached'});await button(bar,'压缩 PDF').click()
        const d=p.getByRole('dialog',{name:'压缩原文件并另存为'}),save=button(d,'压缩并另存为'),close=button(d,'关闭压缩设置'),cancel=button(d,'取消');assert(await d.locator('input[value="balanced"]').isChecked())
        const body=d.locator('.compression-dialog__body');await d.locator('.dialog__panel').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))))
        const before=await hit(save);assert(before.ok&&(await hit(close)).ok&&(await hit(cancel)).ok,JSON.stringify({width,height,before}));
        if(evidence&&width===640){await fs.mkdir(dest,{recursive:true});await p.screenshot({path:path.join(dest,dark?'compress-fixed-dark-large-text.png':'compress-fixed-640.png'),animations:'disabled'})}
        if(height===510){const b=await body.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+b.height/2);await p.mouse.wheel(0,800);await p.waitForFunction(()=>document.querySelector('.compression-dialog__body')?.scrollTop>0)}
        const after=await hit(save);assert(after.ok&&Math.abs(after.y-before.y)<1,'scroll moved the primary action');await save.click({trial:true});await cancel.click();await d.waitFor({state:'hidden'})
        await button(bar,'导出 Markdown…').click();const md=p.getByRole('dialog',{name:'导出 Markdown',exact:true});const scope=md.locator('.md-sheet__scope')
        const metrics=await scope.evaluate(l=>[...l.querySelectorAll('label')].map(n=>{const t=[...n.childNodes].find(c=>c.nodeType===Node.TEXT_NODE&&c.textContent.trim()),range=document.createRange();range.selectNodeContents(t);const b=n.querySelector('input').getBoundingClientRect();return{rows:range.getClientRects().length,w:b.width,h:b.height}}));assert.equal(metrics.length,3);assert(metrics.every(m=>m.rows===1&&m.w<=20&&m.h<=20),JSON.stringify(metrics))
        await button(md,'预览文字').click();const text=md.getByRole('textbox',{name:'本地预览文字'});await text.waitFor();const fontPx=await text.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),offset=await p.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-offset')));assert(Math.abs(fontPx-12-offset)<.1);if(font>1)assert(offset>0)
        const action=button(md,'下载 Markdown');await md.locator('.md-sheet__panel').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));const primary=await hit(action);assert(primary.ok,JSON.stringify({width,height,font,primary,hitAt:await p.evaluate(({x,y})=>document.elementFromPoint(x,y)?.outerHTML.slice(0,210),primary)}));if(evidence&&width===640&&!dark)await p.screenshot({path:path.join(dest,'markdown-fixed-640.png'),animations:'disabled'});await button(md,'取消').click()
        if(width>640){await button(bar,'文件操作').click();const menu=p.getByRole('menu',{name:'文件操作',exact:true});assert.equal(await menu.getByRole('menuitem',{name:'压缩 PDF',exact:true}).count(),0);await menu.getByRole('menuitem',{name:'导出与优化',exact:true}).click();const h=await p.getByRole('dialog').getByText(/^需要缩小文件/).innerText();assert(h.includes('顶部')&&h.includes('右键文件标签')&&!h.includes('“文件”菜单'))}
        console.log(`PASS ${width}×${height}, ${dark?'dark':'light'}, font ${font}: visible compression action y=${after.y.toFixed(1)} before/after scrolling; three inline Markdown choices, preview ${fontPx}px; footer reachable`)
      }finally{await ctx.close()}
    }assert.deepEqual(errors,[]);assert.deepEqual(external,[])
  }finally{await browser?.close();await server?.close()}
}
run().catch(e=>{console.error(e);process.exitCode=1})
