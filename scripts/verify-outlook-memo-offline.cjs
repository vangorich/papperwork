// No server, user profile, mail files, or temporary PDF. Build locally and inject
// scripts into a fresh offline about:blank. Independent readers get bytes via stdin.
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const compact = s => s.normalize('NFKC').replace(/\s/gu, '')
const probe = '春山明月'
const address = 'addr'.repeat(35) + '@example.invalid'
const mail = {
  from: '样张 <sender@example.invalid>', to: [address, '林川'], cc: ['复核'],
  subject: '本地备忘录 — proof', sentAt: '2026-04-05T07:08:09Z', attachments: ['样张.txt'], warnings: [],
  body: [probe, 'literal only: <img src="https://memo.invalid/never-fetch">',
    'Unicode: 𠮷 café', '', Array.from({length:270},(_,i)=>String.fromCodePoint(0x4e00+i)).join(''),
    ...Array.from({ length: 88 }, (_, i) => `条目 ${i + 1} 保留原文。`), '页末凭据 END.'].join('\r\n'),
}
const independent = String.raw`
import sys, json, base64, re, unicodedata
import pymupdf as mu
import pypdfium2 as pdfium
from PIL import Image
v=json.load(sys.stdin); data=base64.b64decode(v['pdf'],validate=True); counts={}
def compact(s): return ''.join(unicodedata.normalize('NFKC',s).split())
def check_img(im, first):
    mask=im.convert('L').point(lambda n: 255 if n<170 else 0); box=mask.getbbox(); s=2
    assert box and box[0]>=55*s and box[1]>=51*s and box[2]<=(595.28-55)*s and box[3]<=(841.89-38)*s, ('ink outside margins',box)
    if first:
        ink=mask.crop(tuple(round(n*s) for n in v['probeBox'])).histogram()[255]
        assert ink>180, ('missing visible Chinese glyphs',ink)
def check_text(name, pages):
    assert len(pages)==v['pages']; source=''
    for i,text in enumerate(pages):
        footer='第%d/%d页'%(i+1,len(pages)); page=compact(text)
        assert page.count(footer)==1, (name,'page number',i+1,repr(page[-32:]))
        source+=page.replace(footer,'')
    for item in v['required']:
        assert compact(item) in source, (name,'lost text',repr(item[:45]))
    counts[name]=len(pages)
with mu.open(stream=data,filetype='pdf') as doc:
    text=[]
    for i,p in enumerate(doc):
        assert abs(p.rect.width-595.28)<.02 and abs(p.rect.height-841.89)<.02 and p.rotation==0
        px=p.get_pixmap(matrix=mu.Matrix(2,2),colorspace=mu.csGRAY,alpha=False)
        check_img(Image.frombytes('L',(px.width,px.height),px.samples),i==0); text.append(p.get_text())
        assert p.get_links()==[], 'unexpected active mail link'
    check_text('MuPDF',text)
with pdfium.PdfDocument(data) as doc:
    text=[]
    for i in range(len(doc)):
        p=doc[i]; w,h=p.get_size(); assert abs(w-595.28)<.02 and abs(h-841.89)<.02
        t=p.get_textpage(); img=p.render(scale=2)
        try: text.append(t.get_text_bounded()); check_img(img.to_pil(),i==0)
        finally: t.close(); img.close(); p.close()
    check_text('PDFium',text)
print(json.dumps(counts))
`
async function main() {
  const js = await build({ stdin: { resolveDir: path.resolve(__dirname, '..'), contents: `
    import {renderOutlookMemo} from './src/lib/outlookMemo.ts';
    import {getDocument,TextLayer} from 'pdfjs-dist/build/pdf.mjs';
    import {WorkerMessageHandler} from 'pdfjs-dist/build/pdf.worker.mjs';
    Object.assign(globalThis,{renderOutlookMemo,getDocument,TextLayer,pdfjsWorker:{WorkerMessageHandler}});` },
    format: 'iife', bundle: true, target: 'es2022', write: false, logLevel: 'silent', minify: true })
  const browser = await chromium.launch({ channel: 'msedge', args: ['--disable-background-networking'] })
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' })
    const requests = []
    await context.route('**/*', r => { requests.push(r.request().resourceType()); return r.abort() })
    await context.routeWebSocket('**/*', ws => { requests.push('websocket'); ws.close() })
    const p = await context.newPage(); await p.addScriptTag({ content: js.outputFiles[0].text })
    await p.addStyleTag({ content: `body{margin:0}.memo-layer{position:absolute;inset:0;--scale-factor:1;line-height:1}
      .memo-layer :is(span,br){position:absolute;white-space:pre;color:transparent;transform-origin:0 0}` })
    const result = await p.evaluate(async ({ mail, probe }) => {
      const assert = (ok, why) => { if (!ok) throw Error(why) }
      const bytes = await renderOutlookMemo(mail)
      const task = getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, stopAtErrors: true })
      try {
        const doc = await task.promise, scale = 3
        let text = '', probeBox, overlap, drag
        assert(doc.numPages >= 3, 'synthetic message did not paginate')
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n), viewport = page.getViewport({ scale }), [,,w,h] = page.view
          assert(w === 595.28 && h === 841.89 && !page.rotate, 'not A4 portrait')
          const content = await page.getTextContent({ disableNormalization: true })
          const items = content.items.filter(i => i.str?.trim())
          assert(items.every(i => i.transform[4] >= 56.9 && i.transform[4]+i.width <= w-56.8), 'clipped text')
          const footer=items.filter(i=>i.transform[5] < 60).map(i=>i.str).join('').replace(/\s/g,'')
          assert(footer === `第${n}/${doc.numPages}页`, 'wrong page number')
          text += items.filter(i=>i.transform[5]>=60).map(i=>i.str).join('')
          if (n !== 1) continue
          const item = items.find(i => i.str === probe); assert(item, 'searchable native Chinese run missing')
          const size = item.transform[3], x = item.transform[4], y = h-item.transform[5]
          probeBox = [x-2,y-size-2,x+item.width+2,y+size*.4]
          const canvas = document.createElement('canvas'); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height)
          const ctx = canvas.getContext('2d',{willReadFrequently:true}); await page.render({canvasContext:ctx, viewport}).promise
          // Compare the glyph ink at its actual selectable text coordinates with
          // the local typeface, not just any dark pixels (rules/tofu are not proof).
          const [l,t,r,b] = probeBox.map(v=>Math.round(v*scale)), actual=ctx.getImageData(l,t,r-l,b-t).data
          const ref=document.createElement('canvas');ref.width=r-l;ref.height=b-t
          const rc=ref.getContext('2d');rc.fillStyle='white';rc.fillRect(0,0,ref.width,ref.height);rc.fillStyle='black'
          rc.font=`${size*scale}px "Microsoft YaHei", sans-serif`;rc.fillText(probe,x*scale-l,y*scale-t)
          const expected=rc.getImageData(0,0,ref.width,ref.height).data
          let both=0,either=0
          for(let i=0;i<actual.length;i+=4){const a=actual[i]<170,b=expected[i]<170;if(a&&b)both++;if(a||b)either++}
          overlap=both/either;assert(overlap>.53, 'Chinese ink does not match its text run: '+overlap)
          canvas.style.cssText=`width:${w}px;height:${h}px;display:block;user-select:none`;document.body.appendChild(canvas)
          const container=document.body.appendChild(document.createElement('div'));container.className='memo-layer'
          const layer=new TextLayer({textContentSource:content,container,viewport:page.getViewport({scale:1})});await layer.render()
          const span=layer.textDivs.find(e=>e.textContent===probe);assert(span,'no selectable text span')
          const rect=span.getBoundingClientRect()
          assert(Math.abs(rect.left-x)<1 && Math.abs(rect.width-item.width)<2, 'text layer is not aligned to ink')
          drag=[x+0.8,y-size/2,x+item.width-0.8]
        }
        return { pages:doc.numPages,text,probeBox,overlap,drag,bytes:Array.from(bytes) }
      } finally {await task.destroy()}
    }, {mail,probe})
    const [left,y,right]=result.drag
    await p.mouse.move(left,y);await p.mouse.down();await p.mouse.move(right,y,{steps:10});await p.mouse.up()
    const selected=await p.evaluate(()=>String(getSelection()));assert.equal(selected,probe,'mouse drag did not select visible text')
    const required=['备忘录','发件人','发送时间','收件人',address,'抄送','主题',mail.subject,'附件',mail.attachments[0],mail.body]
    for(const s of required)assert(compact(result.text).includes(compact(s)),`PDF.js: lost ${s.slice(0,48)}`)
    assert.deepEqual(requests,[])
    const data=Buffer.from(result.bytes)
    const py=spawnSync(process.env.PYTHON || 'python',['-I','-B','-X','utf8','-c',independent],{ encoding:'utf8',timeout:60000,
      input:JSON.stringify({pdf:data.toString('base64'),pages:result.pages,probeBox:result.probeBox,required}) })
    if(py.error)throw py.error
    assert.equal(py.status,0,py.stderr)
    console.log(JSON.stringify({pages:result.pages,bytes:data.length,selected,inkIoU:+result.overlap.toFixed(3),
      independent:JSON.parse(py.stdout),networkRequests:requests.length}))
  } finally {await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
