import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from '@napi-rs/canvas'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import { PDFDocument, rgb } from 'pdf-lib'
import type { DocumentWatermark } from '../types/pdf'
import { inspectPdf, pagesForSource, releasePdfDocument } from './pdf'
import { makePrintProof } from './printProof'

beforeAll(()=>{
  GlobalWorkerOptions.workerSrc=new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).href
  vi.stubGlobal('DOMMatrix',DOMMatrix);vi.stubGlobal('ImageData',ImageData);vi.stubGlobal('Path2D',Path2D)
  vi.stubGlobal('document',{createElement:()=>createCanvas(1,1)})
})
afterAll(()=>vi.unstubAllGlobals())

async function raster(url:string){
  const img=await loadImage(url), canvas=createCanvas(img.width,img.height), ctx=canvas.getContext('2d')
  ctx.drawImage(img,0,0)
  return Buffer.from(ctx.getImageData(0,0,img.width,img.height).data)
}

it('prints the watermark inherited by a single workspace page, not the clean source shortcut',async()=>{
  const doc=await PDFDocument.create();const pdfPage=doc.addPage([200,160]);pdfPage.drawRectangle({x:5,y:10,width:15,height:8,color:rgb(.15,.7,.4)})
  const source=await inspectPdf(await doc.save(),'print-proof.pdf',undefined,false)
  try {
    const [page]=pagesForSource(source), tile=createCanvas(24,14),ctx=tile.getContext('2d');ctx.fillStyle='#dd182c';ctx.fillRect(0,0,24,14)
    const w:DocumentWatermark={kind:'image',imageData:tile.toDataURL('image/png'),x:.2,y:.3,width:.35,height:.2,rotation:0,opacity:.9,tiled:false}
    const plain=await raster((await makePrintProof(page,[source],undefined,300)).url)
    const control=await raster((await makePrintProof(page,[source],w,300)).url)
    const inherited=await raster((await makePrintProof({...page,inheritedWatermarks:[w]},[source],undefined,300)).url)
    expect(plain.equals(control)).toBe(false)
    expect(inherited.equals(control)).toBe(true)
    // The other occurrence of the same source must stay untouched.
    expect((await raster((await makePrintProof({...page,id:'other'},[source],undefined,300)).url)).equals(plain)).toBe(true)
  }finally{await releasePdfDocument(source)}
})
