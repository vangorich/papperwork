// End-to-end consent check. Two synthetic PDFs and a loopback-only mock provider.
// Never accepts a document, address, actual key, or an external URL from the command line.
const { PDFDocument } = require('pdf-lib')
const { chromium } = require('playwright-core')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const FIRST = 'Inside LEFT ABCDEFG RIGHT outside', OUTSIDE = 'UNSELECTED PAGE SENTINEL', NEIGHBOR = 'OTHER TAB SENTINEL'
async function fixture(lines) {
  const pdf=await PDFDocument.create()
  for(const line of lines)pdf.addPage([380,460]).drawText(line,{x:20,y:345,size:12})
  return Buffer.from(await pdf.save())
}
async function main(){
  const requests=[], externals=[], answer='## Formatted\n\nOnly the approved excerpt.\n',approved='### OK\n\nCDE\n'
  let preview,browser,origin,mode='ok',held,received
  const service=createServer((req,res)=>{
    if(!origin || req.headers.origin!==origin || req.url!=='/v1/chat/completions'){res.writeHead(403);res.end();return}
    const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type, authorization','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}
    if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return}
    if(req.method!=='POST'){res.writeHead(405,headers);res.end();return}
    let data='';req.on('data',chunk=>{data+=chunk;if(data.length>32000)req.destroy()})
    req.on('end',()=>{
      requests.push({data,auth:req.headers.authorization})
      const reply=()=>{if(!res.destroyed){res.writeHead(200,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:answer}}]}))}}
      if(mode==='error'){res.writeHead(503,headers);res.end('Synthetic unavailable');return}
      if(mode==='hold'){held=reply;received?.();return}
      reply()
    })
  })
  await new Promise((yes,no)=>service.once('error',no).listen(0,'127.0.0.1',yes))
  const api='http://127.0.0.1:'+service.address().port
  try{
    if(process.argv.includes('--dev')) origin='http://127.0.0.1:5207'
    else {const {preview:serve}=await import('vite');preview=await serve({root,logLevel:'error',preview:{port:0,host:'127.0.0.1'}});origin='http://127.0.0.1:'+preview.httpServer.address().port}
    browser=await chromium.launch({channel:'msedge'});const p=await browser.newPage({viewport:{width:1480,height:960},serviceWorkers:'block'});p.setDefaultTimeout(9500)
    await p.route(/^https?:\/\//,route=>{const target=new URL(route.request().url()).origin;if([origin,api].includes(target))return route.continue();externals.push(target);return route.abort()})
    await p.goto(origin)
    const choose=p.waitForEvent('filechooser');await p.locator('.document-desk__actions button').first().click();await(await choose).setFiles({name:'proof.pdf',mimeType:'application/pdf',buffer:await fixture([FIRST,OUTSIDE])})
    const s=p.locator('.app-shell:visible'), stage=s.locator('#pdf-stage'),button=s.getByRole('toolbar',{name:'PDF 编辑工具栏'}).getByRole('button',{name:'导出 Markdown…',exact:true}),dlg=p.getByRole('dialog',{name:'导出 Markdown',exact:true})
    const first=stage.locator('.text-layer span').getByText(FIRST,{exact:true}).or(stage.locator('.text-layer').getByText(FIRST,{exact:true})).first();await first.waitFor({state:'attached'})
    const input=dlg.getByRole('textbox',{name:'本地预览文字'}), suggest=dlg.getByRole('textbox',{name:'API 建议',exact:true})
    const b=(name)=>dlg.getByRole('button',{name,exact:true}), txt=async()=>{await b('预览文字').click();await input.waitFor();return input.inputValue()}
    async function selectToken(span=first){
      const pts=await span.evaluate(async el=>{
        const n=el.firstChild,k=n.data.indexOf('ABCDEFG')+2,r=document.createRange(),points=()=>[k,k+3].map(i=>{r.setStart(n,i);r.collapse(true);const b=r.getBoundingClientRect();return{x:b.x+.12,y:b.y+b.height*.5}})
        // Jumping 2,500 leaves can replace placeholder geometry after text first appears.
        // Start a physical drag only when both printed carets are steady and hittable.
        await document.fonts.ready;let prev=points(),steady=0
        for(let i=0;i<100;i++){await new Promise(ok=>requestAnimationFrame(ok));const next=points();const ready=next.every((v,j)=>{const h=document.caretRangeFromPoint(v.x,v.y);return h?.startContainer===n && h.startOffset===[k,k+3][j] && Math.hypot(v.x-prev[j].x,v.y-prev[j].y)<.05});steady=ready?steady+1:0;prev=next;if(steady>=4)return next}
        throw Error('Both character endpoints were not stable or hittable on the rendered text layer: '+JSON.stringify(prev))
      })
      const widthError=await span.evaluate(el=>Math.abs(el.closest('.pdf-page').getBoundingClientRect().width-el.closest('.text-layer').getBoundingClientRect().width))
      assert(widthError<1,'selectable glyphs still use the old raster width: '+widthError+' CSS px')
      await p.mouse.move(pts[0].x,pts[0].y);await p.mouse.down();await p.mouse.move(pts[1].x,pts[1].y,{steps:9});await p.mouse.up()
      assert.equal(await p.evaluate(()=>getSelection().toString()),'CDE')
    }
    async function takeDownload(){const done=p.waitForEvent('download');await b('下载 Markdown').click();const d=await done,a=[];for await(const c of await d.createReadStream())a.push(c);return Buffer.concat(a).toString('utf8')}
    await button.click();assert(await dlg.getByRole('radio',{name:'全文',exact:true}).isChecked());assert(await dlg.getByRole('radio',{name:'当前选区',exact:true}).isDisabled());let full=await txt();assert(full.includes(FIRST)&&full.includes(OUTSIDE));await dlg.getByRole('radio',{name:'已有高亮',exact:true}).check();await b('预览文字').click();await dlg.getByRole('alert').waitFor();assert.equal(await input.count(),0);await b('关闭 Markdown 导出').click();assert.equal(requests.length,0)
    await selectToken();await button.click();assert(await dlg.getByRole('radio',{name:'当前选区',exact:true}).isChecked());let scoped=await txt();assert.equal(scoped.trim(),'## 第 1 页\n\nCDE');await dlg.getByRole('checkbox',{name:/API 辅助整理/}).check();await dlg.getByLabel('API 地址',{exact:true}).fill(api);await dlg.getByLabel('模型',{exact:true}).fill('fixture-model');await dlg.getByLabel('API Key（可选）',{exact:true}).fill('test-key');await input.fill(approved);assert.equal(requests.length,0,'opening, configuring and previewing must send nothing');await b('确认发送预览文字').click();await suggest.waitFor();assert.equal(await suggest.inputValue(),answer);assert.equal(requests.length,1);const wire=JSON.parse(requests[0].data);assert.deepEqual(wire.messages.filter(m=>m.role==='user'),[{role:'user',content:approved}]);assert.deepEqual(Object.keys(wire).sort(),['messages','model']);assert.equal(requests[0].auth,'Bearer test-key');for(const banned of [OUTSIDE,NEIGHBOR,'proof.pdf','RIGHT','LEFT','application/pdf','data:image'])assert(!requests[0].data.includes(banned));await b('放弃建议').click();assert.equal(await takeDownload(),approved);assert.equal(requests.length,1)
    await selectToken();await button.click();await txt();await dlg.getByRole('checkbox',{name:/API 辅助整理/}).check();await dlg.getByLabel('API 地址',{exact:true}).fill(api);await dlg.getByLabel('模型',{exact:true}).fill('fixture-model');assert.equal(await dlg.getByLabel('API Key（可选）',{exact:true}).inputValue(),'');await b('确认发送预览文字').click();await b('采用 API 结果').click();assert.equal(await takeDownload(),answer);assert.equal(requests.length,2)
    await selectToken();await stage.locator('.text-selection-action').click();await button.click();await dlg.getByRole('radio',{name:'已有高亮',exact:true}).check();scoped=await txt();assert.equal(scoped.trim(),'## 第 1 页\n\nCDE');assert.equal(await takeDownload(),scoped)
    const other=p.waitForEvent('filechooser');await s.locator('.editor-tabs__add').click();await(await other).setFiles({name:'other.pdf',mimeType:'application/pdf',buffer:await fixture([NEIGHBOR])});await s.getByRole('tab',{name:/other\.pdf/}).click();await p.setViewportSize({width:640,height:650});await button.waitFor();await button.click();assert(await dlg.getByRole('radio',{name:'当前选区',exact:true}).isDisabled());full=await txt();assert(full.includes(NEIGHBOR)&&!full.includes(OUTSIDE)&&!full.includes('CDE'));assert.equal(requests.length,2);assert.deepEqual(externals,[])
    let unsolicitedDownloads=0;p.on('download',()=>unsolicitedDownloads++)
    await dlg.getByRole('checkbox',{name:/API 辅助整理/}).check();await dlg.getByLabel('API 地址',{exact:true}).fill(api);await dlg.getByLabel('模型',{exact:true}).fill('fixture-model');await input.fill(approved)
    mode='hold'
    const arrived=new Promise((resolve,reject)=>{received=resolve;AbortSignal.timeout(9500).addEventListener('abort',()=>reject(Error('No request at the loopback receiver')),{once:true})})
    await b('确认发送预览文字').click();await arrived;await b('停止本次操作').click();held();assert.equal(requests.length,3)
    mode='error';await b('确认发送预览文字').click();await dlg.getByRole('alert').filter({hasText:'API 请求未成功'}).waitFor();assert.equal(await input.inputValue(),approved);assert.equal(await suggest.count(),0);assert.equal(requests.length,4)
    mode='ok';await b('确认发送预览文字').click();await suggest.waitFor();await b('采用 API 结果').click();await dlg.getByRole('radio',{name:'已有高亮',exact:true}).check();assert.equal(await suggest.count(),0);assert.equal(await input.count(),0);assert(await b('确认发送预览文字').isDisabled());assert.equal(requests.length,5);assert.equal(unsolicitedDownloads,0);assert.deepEqual(externals,[])
    if(process.argv.includes('--long-selection')) {
      await b('关闭 Markdown 导出').click();await p.setViewportSize({width:1480,height:960})
      const long=await PDFDocument.create();long.addPage([380,460]).drawText('Do not export the first page',{x:20,y:345,size:12})
      for(let i=1;i<2500;i++)long.addPage([380,460]);long.addPage([380,460]).drawText('Final ABCDEFG line',{x:20,y:345,size:12})
      const pick=p.waitForEvent('filechooser');await s.locator('.editor-tabs__add').click();await(await pick).setFiles({name:'long-proof.pdf',mimeType:'application/pdf',buffer:Buffer.from(await long.save())});await s.getByRole('tab',{name:/long-proof\.pdf/}).click()
      const num=s.locator('input[aria-label^="当前页码"]:visible').first();await num.fill('2501');await num.press('Enter')
      const finalSpan=stage.locator('.text-layer').getByText('Final ABCDEFG line',{exact:true}).first();await finalSpan.waitFor({state:'visible',timeout:20000});await finalSpan.scrollIntoViewIfNeeded();await selectToken(finalSpan);await button.click()
      assert(await dlg.getByRole('radio',{name:'当前选区',exact:true}).isChecked());const final=await txt();assert.equal(final,'## 第 2501 页\n\nCDE\n');assert.equal(await takeDownload(),final);assert.equal(requests.length,5);assert.deepEqual(externals,[])
      console.log('PASS 2501-page document: the selected three letters on the last page alone were previewed and saved, with the original page number; zero additional API calls')
    }
    console.log('PASS dedicated Markdown at 1480/640px; full, partial, saved highlight and empty-highlight/no fallback; no old-tab text. Exact preview-only POST on confirmation, discard/adopt saved exactly, cancellation, failed request and scope change never saved or adopted a stale reply. Synthetic loopback only.')
  }finally{held?.();await browser?.close();await preview?.close();service.closeAllConnections();await new Promise(done=>service.close(done))}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
