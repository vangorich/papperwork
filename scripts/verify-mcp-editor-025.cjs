// Offline: real React reader, PDF.js and compositor; the desktop boundary stores copies in memory.
// Run: node scripts/verify-mcp-editor-025.cjs (Edge / playwright-core, no installer or user profile).
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { chromium } = require('playwright-core')
const { PDFDocument, degrees } = require('pdf-lib')
const root = path.resolve(__dirname, '..')

function mockDesktop() {
  const noop = () => {}, replies = new Map(), t = window.qa = { saved: [], wrongWrites: 0 }
  t.call = (name, args) => new Promise(resolve => {
    const id = crypto.randomUUID(); replies.set(id, resolve); t.receive({id,name,args})
  })
  const forbiddenWrite = () => { t.wrongWrites++; throw Error('Not a guarded copy') }
  window.desktop = {
    pdfMcp: { listen(fn) { t.receive = fn; return () => { delete t.receive } },
      async live() { if (!t.hold) return true; t.hold = false; return new Promise(resolve => { t.resume = resolve }) },
      async reply(id, ok, value) { replies.get(id)({ok,value}); replies.delete(id) } },
    async saveGuardedPdfCopy(bytes, _name, valid) {
      if (!valid()) return null
      if (t.denySave) throw Error('synthetic/private/location.pdf')
      t.saved.push(bytes.slice()); return 'memory-only-copy'
    },
    saveExport: forbiddenWrite, savePdf: forbiddenWrite, overwritePdf: forbiddenWrite,
    savePdfCopy: forbiddenWrite, setWorkspaceDirty: noop, onOpenFileRequested: () => noop,
    onCloseRequest: () => noop, onSessionReset: () => noop, onVirtualPrintJob: () => noop,
    notifyRendererReady: noop, takeVirtualPrintJobs: async () => [],
    getVirtualPrinterStatus: async () => ({ installed:false,supported:false }), getOcrStatus: async () => ({}), getOcrCapabilities: async () => ({}),
  }
}

async function verify(p) {
  const src = await PDFDocument.create(); src.addPage([340,220]).drawText('First fixture', {x:20,y:40,size:12})
  const leaf = src.addPage([420,270]); leaf.setRotation(degrees(90)); leaf.drawText('Second fixture', {x:15,y:24,size:12})
  const original = Array.from(await src.save())
  await p.locator('.app-shell:visible').waitFor()
  await p.evaluate(bytes => {
    qa.original=Uint8Array.from(bytes); document.querySelector('.app-shell').dispatchEvent(new CustomEvent('paperwork-native-drop', {
      bubbles:true,cancelable:true,detail:[{type:'pdf',name:'Synthetic MCP.pdf',bytes:qa.original.slice()}],
    }))
  }, original)
  await p.getByRole('tab', {name:/Synthetic MCP/}).waitFor()
  const dialog = p.getByRole('dialog', {name:'AI 文档授权'}), field = p.locator('.app-shell:visible #pdf-stage textarea[aria-label="文本内容"]:visible').first()
  const permissions = async () => { await p.getByRole('button',{name:'文件操作',exact:true}).click(); await p.getByRole('menuitem',{name:'AI 文档授权'}).click() }
  const close = () => dialog.getByRole('button',{name:'关闭授权设置'}).click()
  const raw = (name,args={}) => p.evaluate(([name,args]) => qa.call(name,args),[name,args])
  const call = async (name,args={}) => {const r=await raw(name,args);assert.equal(r.ok,true,String(r.value));return r.value}
  assert.deepEqual(await call('list_documents'),{documents:[]})
  await permissions(); await dialog.getByRole('button',{name:'允许直接编辑'}).click(); await close()
  const [{documentId}] = (await call('list_documents')).documents
  const read = () => call('read_page',{documentId,page:2})
  const search = query => call('search',{documentId,query})
  const edit = async op => call('edit_document',{documentId,revision:(await read()).revision,operation:{page:2,...op}})
  assert.match((await read()).text,/Second fixture/); assert.deepEqual((await search('第 1 页')).matches,[])
  const pageNo = p.locator('.app-shell:visible input[aria-label^="当前页码"]').first()
  await pageNo.fill('2'); await pageNo.press('Enter')
  const box={x:.16,y:.24,width:.63,height:.22}, initial='第 1 页 中文校样', changed='重新排版的字形'
  await edit({kind:'add_object',objectType:'text',box,text:initial,fontSize:19})
  const added=await read(), [object]=added.objects
  assert.match(added.text,/第 1 页 中文校样/); assert.equal('text' in object,false); assert.equal(object.type,'text')
  assert.deepEqual((await search('第 1 页')).matches.map(m=>m.page),[2])
  const patch = changes => edit({kind:'update_object',objectId:object.id,patch:changes})
  const save = async (fail=false,page=2) => {
    const {requestId}=await call('request_export',{documentId,pages:[page],format:'pdf'})
    await dialog.getByRole('button',{name:'选择位置并导出'}).click()
    await dialog.locator('.ai-book-export').waitFor({state:'detached'});const status=await call('export_status',{documentId,requestId})
    assert.equal(status.state,fail?'failed':'saved',await p.locator('.app-shell:visible .toast').allTextContents().then(v=>v.join(' · ')))
    if(fail)assert.match(await p.locator('.app-shell:visible .toast').innerText(),/synthetic\/private\/location\.pdf/)
    await close();return status
  }
  const checkPdf = async (text,box,style={},blankSize) => {
    await save(false,blankSize?3:2)
    const result=await p.evaluate(async ({text,box,style,blankSize})=>{
      const {inspectPdf,composePdf,getPdfPage,releasePdfDocument}=await import('/src/lib/pdf.ts')
      const {rasterizeText}=await import('/src/lib/text.ts')
      // Independent expected layout: the original leaf is 420 x 270pt with /Rotate 90.
      const size=blankSize??{width:270,height:420}
      const gui={id:'gui-ref',type:'text',...box,text,color:'#18324a',fontSize:19,fontFamily:'Microsoft YaHei',pageHeight:size.height,pageAspectRatio:size.width/size.height,...style}
      const base=await inspectPdf(qa.original.slice(),'reference.pdf',undefined,false)
      async function pixels(bytes) {
        const s=await inspectPdf(bytes.slice(),'render.pdf',undefined,false)
        try { const page=await getPdfPage(s,0), vp=page.getViewport({scale:2}), c=document.createElement('canvas');c.width=vp.width;c.height=vp.height
          const ctx=c.getContext('2d');await page.render({canvasContext:ctx,viewport:vp}).promise
          const data=ctx.getImageData(0,0,c.width,c.height).data, hash=await crypto.subtle.digest('SHA-256',data)
          return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')
        } finally {await releasePdfDocument(s)}
      }
      try { const page={id:'p',sourceId:blankSize?'blank':base.id,sourcePage:blankSize?0:1,pageSize:blankSize,rotation:0,annotations:[]}
        const ref=await composePdf([{...page,annotations:[{...gui,imageData:rasterizeText(gui)}]}],[base])
        const empty=await composePdf([page],[base])
        return {actual:await pixels(qa.saved.at(-1)),gui:await pixels(ref),empty:await pixels(empty)}
      } finally {await releasePdfDocument(base)}
    },{text,box,style,blankSize})
    assert.notEqual(result.gui,result.empty,'the reference must actually paint glyphs');assert.equal(result.actual,result.gui,'exported pixels differ from GUI glyph layout');return result.actual
  }
  const initialHash=await checkPdf(initial,box)
  const newBox={...box,x:.21,width:.51,height:.29},style={fontSize:23,bold:true,color:'#443355',italic:true}
  await patch({text:changed, box:newBox,...style});const changedHash=await checkPdf(changed,newBox,style);assert.notEqual(changedHash,initialHash)
  // Closing the native-copy dialog can restore focus to the page-number input.
  // Explicitly invoke document undo/redo, not the input's native text history.
  await p.getByRole('button',{name:'撤销 Ctrl+Z',exact:true}).click();await p.waitForFunction(s=>[...document.querySelectorAll('#pdf-stage textarea')].some(e=>e.value===s),initial)
  assert.equal(await checkPdf(initial,box),initialHash,'one GUI undo restores the prior snapshot and layout')
  await p.getByRole('button',{name:'重做 Ctrl+Y',exact:true}).click();await field.waitFor();assert.equal(await checkPdf(changed,newBox,style),changedHash)
  await field.fill('临时 GUI 编辑');await field.press('Control+Enter');await field.fill(changed);await field.press('Control+Enter')
  assert.equal(await checkPdf(changed,newBox,style),changedHash,'the same text actually committed by the textarea must render identically')
  console.log('PASS CJK create/update, UI undo/redo and a GUI text commit give matching 2x PDF pixels on a non-A4 rotated leaf')

  const args={documentId,revision:(await read()).revision,operation:{kind:'update_object',page:2,objectId:object.id,patch:{bold:false}}}
  await field.focus();await field.dispatchEvent('compositionstart',{data:''})
  let denied=await raw('edit_document',args);assert.equal(denied.ok,false);assert.match(denied.value,/重新读取/)
  assert(await field.evaluate(e=>document.activeElement===e && e.hasAttribute('data-composing')))
  await field.dispatchEvent('compositionend',{data:''})
  await p.evaluate(args=>{qa.hold=true;qa.inFlight=qa.call('edit_document',args)},args)
  await p.waitForFunction(()=>typeof qa.resume==='function');await field.fill('未提交的本地输入')
  denied=await p.evaluate(()=>{qa.resume(true);delete qa.resume;return qa.inFlight})
  assert.equal(denied.ok,false);assert.match(denied.value,/重新读取/);assert.equal(await field.inputValue(),'未提交的本地输入')
  assert(await field.evaluate(e=>document.activeElement===e));const still=await read();assert.equal(still.revision,args.revision);assert(!JSON.stringify(still).includes('未提交'))
  // Same-page sibling creation does not replace this annotation. Its draft must survive.
  await edit({kind:'add_object',objectType:'rectangle',box:{x:.02,y:.8,width:.1,height:.05}})
  assert.equal(await field.inputValue(),'未提交的本地输入');await field.press('Control+Enter');assert.match((await read()).text,/未提交的本地输入/)
  await field.fill(changed);await field.press('Control+Enter');assert.equal(await field.inputValue(),changed)
  // A clean, focused field may accept a remote edit. Escape then cancels only
  // subsequent typing, never resurrecting the stale text from focus time.
  await field.focus();await patch({text:'已提交的远端文字'});await field.fill('取消这次输入');await field.press('Escape')
  assert.equal(await field.inputValue(),'已提交的远端文字');await patch({text:changed})
  console.log('PASS IME and asynchronous drafts retain focus, text and revision; Escape restores the latest committed text')

  await edit({kind:'add_object',objectType:'text',text:'可见上层',box:newBox})
  const covered=await read();assert.match(covered.text,/可见上层/);assert.equal(covered.objects.length,3);assert(!JSON.stringify(covered).includes(changed));assert.deepEqual((await search(changed)).matches,[])
  console.log('PASS read/search omit export headings and covered text, including object metadata; genuine page-number text remains searchable')
  const blankSize={width:460,height:250}, blankText='自定义空白纸张'
  await call('edit_document',{documentId,revision:(await read()).revision,operation:{kind:'insert_blank',after:2}})
  await edit({kind:'resize_page',page:3,widthPt:blankSize.width,heightPt:blankSize.height})
  assert.equal((await call('read_page',{documentId,page:3})).text,'')
  await pageNo.fill('3');await pageNo.press('Enter')
  await p.waitForFunction(({width,height})=>{
    const card=document.querySelector('.app-shell:not([hidden]) #pdf-stage .stage-page[data-current] .pdf-page')
    const r=card?.getBoundingClientRect();return card?.querySelector('.blank-label') && r.height>0 && Math.abs(r.width/r.height-width/height)<.01
  },blankSize)
  await edit({kind:'add_object',page:3,objectType:'text',box,text:blankText,fontSize:19})
  await checkPdf(blankText,box,{},blankSize)
  console.log('PASS 460 x 250pt blank sheet uses its actual stage ratio and exports matching CJK glyph pixels')
  await p.evaluate(()=>{qa.denySave=true});const status=await save(true)
  assert.equal(status.error,'未能另存副本，请在工作台查看详情。');assert.equal(await p.evaluate(()=>qa.wrongWrites),0)
  console.log('PASS guarded PDF save failure exposes no local detail or overwrite fallback')

  const final=await read();await p.evaluate(args=>{qa.hold=true;qa.inFlight=qa.call('edit_document',args)},{...args,revision:final.revision})
  await p.waitForFunction(()=>typeof qa.resume==='function');await permissions();await dialog.getByRole('button',{name:'撤销授权'}).click();await close()
  denied=await p.evaluate(()=>{qa.resume(true);return qa.inFlight});assert.equal(denied.ok,false);assert.match(denied.value,/撤销/);assert.deepEqual(await call('list_documents'),{documents:[]})
  console.log('PASS revocation aborts an already-prepared text edit before commit')
}

async function main() {
  const cache=await fs.mkdtemp(path.join(os.tmpdir(),'paperwork-mcp-vite-'));let server,browser
  try {
    const {offlineQpdf}=await import('../build/qpdf-engine.mjs'), react=(await import('@vitejs/plugin-react')).default
    // No project build plugins: their closeBundle hooks copy production assets even on dev shutdown.
    server=await (await import('vite')).createServer({root,configFile:false,cacheDir:cache,plugins:[react(),offlineQpdf(),{
      name:'test-pdfjs-assets',configureServer(v){v.middlewares.use((req,_res,next)=>{if(/^\/pdfjs\/(cmaps|standard_fonts)\/[\w.-]+$/.test(req.url||''))req.url='/node_modules/pdfjs-dist'+req.url.slice(6);next()})},
    }],optimizeDeps:{include:['react','react-dom','react-dom/client','@headlessui/react','lucide-react','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','@tanstack/react-virtual','pdfjs-dist','pdf-lib','three']},logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,cache]}}})
    await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
    const ctx=await browser.newContext({viewport:{width:1580,height:990},serviceWorkers:'block'})
    await ctx.route(/^https?:\/\//,r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await ctx.addInitScript(mockDesktop)
    const page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>console.error('Page error:',e.message))
    await page.goto(origin);await verify(page)
  } finally {try{await browser?.close()}finally{await server?.close();await fs.rm(cache,{recursive:true,force:true})}}
}
main().catch(e=>{console.error(e);process.exitCode=1})
