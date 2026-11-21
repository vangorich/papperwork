import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useWorkspace } from '../hooks/useWorkspace'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees, rgb } from 'pdf-lib'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import type { DocumentWatermark, OcrPageLayer, OcrWord, PdfSource } from '../types/pdf'
import { activatePersistedWatermark, composePdf, compositionNeedsNewFile, getPdfPage, getPdfSourceEditableBytes, getPdfTextContent, inspectPdf, pagesForSource, releasePdfDocument } from './pdf'

beforeAll(()=>{
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).href
  Object.assign(globalThis,{DOMMatrix,ImageData,Path2D})
})
const opened: PdfSource[] = []
afterEach(async()=>{ await Promise.all(opened.splice(0).map(releasePdfDocument)) })
async function reopen(bytes:Uint8Array, path:string) {
  const src = await inspectPdf(new Uint8Array(bytes),path.split('/').at(-1)!,path,false)
  opened.push(src); return src
}
const saveProof = async(name:string,bytes:Uint8Array) => {
  if(process.env.PW_PERSISTENCE_PROOF_DIR) await writeFile(join(process.env.PW_PERSISTENCE_PROOF_DIR,name+'.pdf'),bytes)
}
const word = (text:string,x:number,y:number,width:number,height:number):OcrWord => ({text,x,y,width,height,confidence:.9})
const layer = (words:OcrWord[]):OcrPageLayer=>({words,engine:'synthetic',mode:'printed',createdAt:'2026-01-01',revision:1,text:words.map(w=>w.text).join(' ')})
const mixed = '合同 A9 café 𠀀'
const words = [word(mixed,.15,.4,.55,.1),word('NAT1VE',.1,.065,.21,.095),word('invalid',NaN,.3,.1,.1),word('outside',.99,.3,.1,.1)]
async function withCanvas<T>(run:()=>Promise<T>) {
  const old=Object.getOwnPropertyDescriptor(globalThis,'document')
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>{
    const canvas=createCanvas(1,1)
    return Object.assign(canvas,{toBlob:(cb:(b:Blob)=>void)=>cb(new Blob([canvas.toBuffer('image/png')],{type:'image/png'}))})
  }}})
  try { return await run() } finally {
    if(old) Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document')
  }
}
function raster(text=false) {
  const canvas=createCanvas(80,32), ctx=canvas.getContext('2d')
  ctx.fillStyle=text?'#041fc0':'#de1826'
  if(text) {ctx.font='bold 20px sans-serif';ctx.fillText('TEST',1,22)}
  else {ctx.fillRect(0,0,62,21);ctx.fillStyle='#0acf61';ctx.fillRect(13,21,24,11)}
  return canvas.toDataURL('image/png')
}
async function original(count=1) {
  const doc=await PDFDocument.create(), font=await doc.embedFont(StandardFonts.Helvetica)
  const logo=await doc.embedPng(raster())
  for(let i=0;i<count;i++) {
    const p=doc.addPage([320,240]);p.setCropBox(32,40,240,160);p.setRotation(degrees(90))
    p.drawRectangle({x:46,y:69,width:200,height:80,color:rgb(.9,.8,.6)})
    // Third-party native words, bitmap (identical to the image watermark),
    // and vector art: none is ours to delete, even if the images match.
    p.drawText('NATIVE',{x:56,y:177,size:12,font}); p.drawImage(logo,{x:60,y:102,width:25,height:14})
  }
  return doc.save()
}
async function text(s:PdfSource,i=0) {
  return (await getPdfTextContent(s,i)).items.flatMap(item=>'str'in item?[item.str]:[]).join('')
}
async function pixels(s:PdfSource,i=0) {
  const p=await getPdfPage(s,i), viewport=p.getViewport({scale:1.5}), canvas=createCanvas(viewport.width,viewport.height)
  const ctx=canvas.getContext('2d')
  await p.render({viewport,canvasContext:ctx as unknown as CanvasRenderingContext2D}).promise
  return Buffer.from(ctx.getImageData(0,0,canvas.width,canvas.height).data)
}

describe('PDF edition persistence (new byte buffer and source identity on each open)',()=>{
  it('writes positioned Unicode only on missing regions and keeps reopened/re-recognized pages single-layered',async()=>{
    const bytes=await original(), src=await reopen(bytes,'/old/original.pdf'), [p]=pagesForSource(src)
    const out=await composePdf([{...p,ocr:layer(words)}],[src]);await saveProof('base',bytes);await saveProof('ocr',out)
    const s=await reopen(out,'/moved/scan.pdf'), txt=await text(s)
    expect(txt).toContain(mixed);expect(txt.match(/NATIVE/g)).toHaveLength(1);expect(txt).not.toMatch(/NAT1VE|invalid|outside/)
    expect((await pixels(s)).equals(await pixels(src))).toBe(true)
    const runs=(await getPdfTextContent(s,0)).items.flatMap(t=>'str'in t && t.str.includes('合同')?[t]:[])
    expect(runs[0].transform[4]).toBeCloseTo(68);expect(runs[0].transform[5]).toBeCloseTo(123.2)
    const again=await composePdf([{...pagesForSource(s)[0],ocr:layer(words)}],[s]);await saveProof('ocr-again',again)
    const final=await reopen(again,'/other/again.pdf');expect((await text(final)).split(mixed)).toHaveLength(2)
    expect((await pixels(final)).equals(await pixels(src))).toBe(true)
  })
  it('keeps both skewed OCR axes and the crop origin when the page itself turns',async()=>{
    const src=await reopen(await original(),'/skew.pdf'), [p]=pagesForSource(src)
    const w=word('斜印',.18,.42,.37,.14)
    w.points=[{x:.18,y:.42},{x:.51,y:.46},{x:.55,y:.56},{x:.22,y:.52}]
    const bytes=await composePdf([{...p,rotation:180,ocr:layer([w])}],[src]);const reloaded=await reopen(bytes,'/skew-and-turn.pdf')
    const t=(await getPdfTextContent(reloaded,0)).items.flatMap(t=>'str'in t && t.str.includes('斜印')?[t]:[])[0]
    // Two 1-em CJK glyphs; p0->p1 and p3->p0 in the unrotated 240 x 160 CropBox.
    const expected=[39.6,-3.2,-9.6,16,32+.18*240+7.68,200-.42*160-12.8]
    expected.forEach((v,i)=>expect(t.transform[i]).toBeCloseTo(v,3));expect((await getPdfPage(reloaded,0)).rotate).toBe(270)
  })
  it('fits resized paper, honors crop clipping, and uses more than 255 distinct Unicode glyphs',async()=>{
    const src=await reopen(await original(),'/in.pdf'),[p]=pagesForSource(src)
    const chars=Array.from({length:280},(_,i)=>String.fromCodePoint(0x4e00+i)).join('')
    const rows=Array.from({length:7},(_,i)=>word(chars.slice(40*i,40*(i+1)),.1,.24+i*.09,.8,.055))
    const out=await composePdf([{...p,pageSize:{width:640,height:640},ocr:layer(rows)}],[src])
    const resized=await reopen(out,'/sized.pdf');expect((await text(resized)).replace(/\s/g,'')).toContain(chars)
    const first=(await getPdfTextContent(resized,0)).items.flatMap(t=>'str'in t && t.str.includes(chars[0])?[t]:[])[0]
    expect(first.transform[4]).toBeCloseTo(112);expect(first.transform[5]).toBeCloseTo(80+2*(200-.24*160-.8*.055*160))
    const cropped=await composePdf([{...p,rotation:270,crop:{x:0,y:0,width:1,height:.58},ocr:layer([word('KEPT',.3,.35,.2,.1),word('CLIPPED',.1,.8,.3,.13)])}],[src])
    const selection=await reopen(cropped,'/selected.pdf');expect(await text(selection)).toContain('KEPT');expect(await text(selection)).not.toContain('CLIPPED')
  })
  it.each(['text','image'] as const)('moves, edits and removes a %s watermark without disturbing original bytes, third-party art or another open',async kind=>{
    const input=await original(2), src=await reopen(input,'/a/original.pdf')
    const wm:DocumentWatermark={kind,text:kind==='text'?'审阅 TEST':undefined,imageData:kind==='image'?raster():undefined,fontFamily:'Microsoft YaHei',bold:true,italic:false,color:'#263d4d',rotation:-24,tiled:true,opacity:.53,x:.12,y:.17,width:.29,height:.1,gapX:.16,gapY:.12}
    const first=await withCanvas(()=>composePdf(pagesForSource(src),[src],{watermark:wm}));await saveProof(kind+'-marked',first)
    const saved=await reopen(first,'/else/renamed.pdf'), other=await reopen(first,'/another/renamed.pdf')
    const originalPixels=await pixels(src), markedPixels=await pixels(other)
    expect(markedPixels.equals(originalPixels)).toBe(false)
    saved.originalPath='/else/renamed.pdf';saved.desktopGrant='test-read-revision'
    const restored=activatePersistedWatermark(saved)
    expect(restored).toEqual(kind === 'text' ? {...wm,imageData:undefined} : wm);expect((await pixels(saved)).equals(originalPixels)).toBe(true)
    expect((await pixels(other)).equals(markedPixels)).toBe(true)
    expect(await getPdfSourceEditableBytes(saved)).toBe(saved.bytes);expect(saved.bytes).toEqual(first)
    expect(saved).toMatchObject({path:'/else/renamed.pdf',originalPath:'/else/renamed.pdf',desktopGrant:'test-read-revision'})
    expect(await compositionNeedsNewFile(saved)).toBe(false)
    const pages=pagesForSource(saved), same=await composePdf(pages,[saved],{watermark:restored})
    const round=await reopen(same,'/same-style.pdf');expect((await pixels(round)).equals(markedPixels)).toBe(true)
    await saveProof(kind+'-round',same)
    const changed={...restored!,text:kind==='text'?'核准 Approved':undefined,color:'#bd2035',imageData:kind==='image'?raster(true):undefined,rotation:37,tiled:false,x:.48,opacity:.87}
    const edited=await withCanvas(()=>composePdf(pages,[saved],{watermark:changed}));await saveProof(kind+'-edit',edited)
    const editedSrc=await reopen(edited,'/copy/edit.pdf');expect((await pixels(editedSrc)).equals(markedPixels)).toBe(false)
    expect(activatePersistedWatermark(editedSrc)).toEqual(kind === 'text' ? {...changed,imageData:undefined} : changed)
    const clean=await composePdf(pagesForSource(editedSrc),[editedSrc]);await saveProof(kind+'-removed',clean)
    const final=await reopen(clean,'/copy/no-mark.pdf');expect(activatePersistedWatermark(final)).toBeUndefined()
    for(const i of [0,1]) expect((await pixels(final,i)).equals(await pixels(src,i))).toBe(true)
    const obj=await PDFDocument.load(clean)
    expect(obj.context.enumerateIndirectObjects().filter(([,v])=>v instanceof PDFRawStream && v.dict.get(PDFName.Type)===PDFName.of('PaperworkWatermarkV1'))).toHaveLength(0)
    expect(saved.bytes).toEqual(first);expect(src.bytes).toEqual(input)
  })
  it('hydrates only editor groups and carries the right maps through open, remove, undo and redo',async()=>{
    const src=await reopen(await original(),'/base.pdf'), rows=pagesForSource(src)
    const wm:DocumentWatermark={kind:'image',imageData:raster(),rotation:16,opacity:.35,tiled:false,x:.2,y:.3,width:.26,height:.11}
    const bytes=await composePdf(rows,[src],{watermark:wm})
    const a=await reopen(bytes,'/first/A.pdf'), b=await reopen(bytes,'/another/B.pdf'), collector=await reopen(bytes,'/merged/raw.pdf')
    // Render-phase updates exercise the real hook state machine with React's
    // server renderer; no browser, network, synthetic DOM, or mocked hooks.
    let step=0
    function Probe() {
      const w=useWorkspace()
      switch(step++) {
        case 0: w.load([a],false,true); break
        case 1: expect(w.watermarks.get(a.id)).toEqual(wm);expect(w.dirtyGroupIds.size).toBe(0);w.load([b],true,true);break
        case 2: expect(w.watermarks.size).toBe(2);expect(w.dirtyGroupIds.size).toBe(0);w.setWatermark(undefined,b.id);break
        case 3: expect([...w.watermarks.keys()]).toEqual([a.id]);expect([...w.dirtyGroupIds]).toEqual([b.id]);w.undo();break
        case 4: expect(w.watermarks.get(b.id)).toEqual(wm);w.undo();break
        case 5: expect([...w.watermarks.keys()]).toEqual([a.id]);w.redo();break
        case 6: expect(w.watermarks.size).toBe(2);w.load([collector],false,false);break
        case 7: expect(w.watermarks.size).toBe(0);break
      }
      return null
    }
    renderToStaticMarkup(createElement(Probe));expect(step).toBe(8)
    expect((await pixels(a)).equals(await pixels(src))).toBe(true);expect((await pixels(collector)).equals(await pixels(src))).toBe(false)
  })
  it('rebases a contained watermark on a newly cropped rotated page; clipping is never guessed',async()=>{
    const src=await reopen(await original(),'/input.pdf'), [p]=pagesForSource(src)
    const wm:DocumentWatermark={kind:'image',imageData:raster(),rotation:28,opacity:.6,tiled:false,x:.27,y:.31,width:.22,height:.12}
    const crop={x:.1,y:.2,width:.7,height:.6};const saved=await composePdf([{...p,crop}],[src],{watermark:wm})
    const open=await reopen(saved,'/cropped.pdf'), baked=await pixels(open), hydrated=activatePersistedWatermark(open)
    expect(hydrated?.x).toBeCloseTo((wm.x-crop.x)/crop.width)
    const again=await reopen(await composePdf(pagesForSource(open),[open],{watermark:hydrated}),'/again.pdf')
    expect((await pixels(again)).equals(baked)).toBe(true)
    const clipped=await reopen(await composePdf([{...p,crop}],[src],{watermark:{...wm,x:0}}),'/clipped.pdf')
    expect(activatePersistedWatermark(clipped)).toBeUndefined()
  })
  it('adds only the invisible OCR after an intentional full-page raster bake',async()=>{
    const src=await reopen(await original(),'/in.pdf'), [p]=pagesForSource(src)
    const mark:DocumentWatermark={kind:'image',imageData:raster(),opacity:.6,rotation:17,tiled:false,x:.2,y:.24,width:.19,height:.08}
    const page={...p,annotations:[{id:'flat',type:'image' as const,imageData:raster(true),imageExportMode:'flatten-page' as const,x:.4,y:.5,width:.24,height:.12}]}
    const clean=await withCanvas(()=>composePdf([page],[src],{watermark:mark}))
    const searchable=await withCanvas(()=>composePdf([{...page,ocr:layer(words)}],[src],{watermark:mark}))
    const base=await reopen(clean,'/flat.pdf'), after=await reopen(searchable,'/flat-ocr.pdf')
    expect(activatePersistedWatermark(after)).toBeUndefined();expect(await text(after)).toContain(mixed)
    expect((await pixels(base)).equals(await pixels(after))).toBe(true)
    await saveProof('flat',clean);await saveProof('flat-ocr',searchable)
  })
  it('reads identical saved bytes from two actual local paths and never writes either input', async()=>{
    const src=await reopen(await original(),'/synthetic.pdf'), folder=await mkdtemp(join(tmpdir(),'pw-moved-'))
    try {
      const wm:DocumentWatermark={kind:'image',imageData:raster(),rotation:11,opacity:.65,tiled:false,x:.2,y:.1,width:.27,height:.12}
      const saved=await composePdf(pagesForSource(src),[src],{watermark:wm})
      const a=join(folder,'first.pdf'), b=join(folder,'moved-and-renamed.pdf')
      await writeFile(a,saved);await copyFile(a,b)
      const first=await reopen(await readFile(a),a), moved=await reopen(await readFile(b),b)
      expect(activatePersistedWatermark(moved)).toEqual(wm);expect((await pixels(moved)).equals(await pixels(src))).toBe(true)
      expect((await pixels(first)).equals(await pixels(src))).toBe(false)
      const removed=await composePdf(pagesForSource(moved),[moved]);expect(removed).not.toEqual(saved)
      for (const path of [a,b]) expect((await readFile(path)).equals(saved)).toBe(true)
    } finally { await rm(folder,{recursive:true,force:true}) }
  })
  it('refuses an internally inconsistent ownership claim even with a recomputed integrity digest',async()=>{
    const src=await reopen(await original(),'/start.pdf'), wm:DocumentWatermark={kind:'image',imageData:raster(),x:.2,y:.2,width:.2,height:.1,tiled:false,opacity:.4,rotation:0}
    const bytes=await composePdf(pagesForSource(src),[src],{watermark:wm}), d=await PDFDocument.load(bytes,{updateMetadata:false})
    // Point the private marker at a foreign drawing. Metadata must not turn
    // that drawing into authority to remove a Content stream.
    const page=d.getPage(0), contents=page.node.lookup(PDFName.Contents,PDFArray)
    page.node.set(PDFName.of('PaperworkWatermarkLayer'),contents.get(0))
    const forged=Buffer.from(await d.save()), match=/Paperwork-WM\/1 [\da-f]{32} ([\da-f]{64})\n/.exec(forged.toString('latin1'))!
    const off=match.index+match[0].indexOf(match[1]);forged.fill(48,off,off+64)
    forged.write(createHash('sha256').update(forged).digest('hex'),off,64,'ascii')
    const candidate=await reopen(forged,'/foreign.pdf');expect(activatePersistedWatermark(candidate)).toBeUndefined()
    const pristine=await reopen(bytes,'/pristine.pdf');expect((await pixels(candidate)).equals(await pixels(pristine))).toBe(true)
  })
  it('fails closed on stale metadata, externally rewritten bytes, partial-page jobs and signatures',async()=>{
    const src=await reopen(await original(2),'/input.pdf'), pages=pagesForSource(src)
    const watermark:DocumentWatermark={kind:'image',imageData:raster(),rotation:0,opacity:1,tiled:false,x:.2,y:.2,width:.2,height:.1}
    const full=await composePdf(pages,[src],{watermark}), partial=await composePdf(pages,[src],{watermark,watermarkPageIds:new Set([pages[0].id])})
    const mutated=await PDFDocument.load(full);mutated.getPage(0).drawText('THIRD PARTY',{x:70,y:108,size:10})
    const changed=await reopen(await mutated.save(),'/changed.pdf');expect(activatePersistedWatermark(changed)).toBeUndefined();expect(await text(changed)).toContain('THIRD PARTY')
    const subset=await reopen(partial,'/partial.pdf');expect(activatePersistedWatermark(subset)).toBeUndefined()
    expect((await pixels(subset,1)).equals(await pixels(src,1))).toBe(true)
    mutated.context.register(mutated.context.obj({Type:'Sig',ByteRange:[0,10,20,30]}))
    const signed=await reopen(await mutated.save(),'/signed.pdf');expect(activatePersistedWatermark(signed)).toBeUndefined();expect(await compositionNeedsNewFile(signed)).toBe(true)
  })
})
