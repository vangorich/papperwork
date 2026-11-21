import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFPage } from 'pdf-lib'
import type { DocumentWatermark } from '../types/pdf'
import { watermarkTileBoxes } from './watermark'
import { centredPdfImage } from './objectTransform'
import { displayBoxToPdf } from './pdf'
import { visiblePdfBox } from './pdfOcrPersistence'

// v1 deliberately describes ONE document-wide watermark. No path, sidecar,
// producer-name guess, or matching by image pixels. Nonuniform/scoped print
// jobs and permanently flattened/cropped jobs can still use ordinary page art.
const N = PDFName.of
const infoKey = N('PaperworkWatermark'), layerKey = N('PaperworkWatermarkLayer'), configKey = N('PaperworkConfig')
const maxAsset = 16 * 1024 * 1024, maxFile = 128 * 1024 * 1024
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true})
const zero = '0'.repeat(64)
const prefix = (id:string) => `Paperwork-WM/1 ${id} `
const assetName = (id:string) => N(`PwIm${id}`), stateName = (id:string) => N(`PwGs${id}`)
const within = (v:unknown, min:number, max:number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

function configuration(value: unknown): value is DocumentWatermark & {imageData:string} {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const keys = ['kind','imageData','text','fontFamily','italic','bold','color','opacity','rotation','tiled','x','y','width','height','gapX','gapY']
  if (!Object.keys(v).every(k => keys.includes(k)) || !(v.kind === 'text' || v.kind === 'image') || typeof v.tiled !== 'boolean'
      || !within(v.opacity,0,1) || !within(v.rotation,-360,360) || !within(v.x,-4,4) || !within(v.y,-4,4)
      || !within(v.width,.00001,1) || !within(v.height,.00001,1)
      || ![v.gapX,v.gapY].every(n => n === undefined || within(n,0,2))
      || ![v.italic,v.bold].every(b => b === undefined || typeof b === 'boolean')
      || (v.text !== undefined && (typeof v.text !== 'string' || v.text.length>4096))
      || (v.fontFamily !== undefined && (typeof v.fontFamily !== 'string' || !/^[\p{L}\p{M}\p{N} ._-]{1,128}$/u.test(v.fontFamily)))
      || (v.color !== undefined && (typeof v.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.color)))) return false
  return typeof v.imageData === 'string' && v.imageData.length < 4*maxAsset/3+32
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.imageData)
}

// Dimensions are checked before handing an embedded data URL to the DOM.
function safeRaster(url:string) {
  const b = atob(url.slice(url.indexOf(',')+1)), u8 = (i:number)=>b.charCodeAt(i)
  const u16 = (i:number)=>u8(i)*256+u8(i+1), u32 = (i:number)=>u16(i)*65536+u16(i+2)
  const ok = (w:number,h:number)=>w>0 && h>0 && w<=16384 && h<=16384 && w*h<=16_777_216
  if (url.startsWith('data:image/png;')) return b.startsWith('\x89PNG\r\n\x1a\n') && b.slice(12,16)==='IHDR' && ok(u32(16),u32(20))
  if (u16(0)!==0xffd8) return false
  for (let i=2; i+9<b.length;) {
    if (u8(i++)!==255) return false
    while (u8(i)===255) i++
    const tag=u8(i++), length=u16(i)
    if (tag===0xda || !(length>=2) || i+length>b.length) return false
    if ([0xc0,0xc1,0xc2].includes(tag)) return ok(u16(i+5),u16(i+3))
    i+=length
  }
  return false
}

function drawing(page:PDFPage, wm:DocumentWatermark, id:string) {
  const box = visiblePdfBox(page), rotation = page.getRotation().angle
  const ops = [`q`,`${stateName(id)} gs`]
  for (const tile of watermarkTileBoxes(wm)) {
    if (tile.x>=1 || tile.y>=1 || tile.x+tile.width<=0 || tile.y+tile.height<=0) continue
    const local = displayBoxToPdf(tile,box.width,box.height,rotation)
    const p = centredPdfImage({...local,x:local.x+box.x,y:local.y+box.y},wm.rotation)
    const a = p.rotation*Math.PI/180, c = Math.cos(a), s = Math.sin(a)
    const m = [p.width*c,p.width*s,-p.height*s,p.height*c,p.x,p.y].map(n=>PDFNumber.of(Number(n.toFixed(6))).toString())
    ops.push(`q ${m.join(' ')} cm ${assetName(id)} Do Q`)
  }
  return ops.join('\n')+'\nQ\n'
}

function info(doc:PDFDocument) { return doc.context.lookup(doc.context.trailerInfo.Info,PDFDict) }

export function watermarkInCrop(wm: DocumentWatermark, crop: { x:number; y:number; width:number; height:number }) {
  // A crop changes the coordinate system stored for the NEXT open. A single
  // fully-contained stamp has an exact equivalent. Do not clamp/repeat a
  // partially clipped tile into a different position just to make it editable.
  if (wm.tiled) return
  const b = watermarkTileBoxes(wm)[0]
  if (b.x < crop.x || b.y < crop.y || b.x+b.width > crop.x+crop.width || b.y+b.height > crop.y+crop.height) return
  return { ...wm, x:(b.x-crop.x)/crop.width, y:(b.y-crop.y)/crop.height, width:b.width/crop.width, height:b.height/crop.height }
}

export function beginOwnedWatermark(doc:PDFDocument, wm:DocumentWatermark, image:PDFRef) {
  if (!configuration(wm) || !safeRaster(wm.imageData)) return undefined
  const id = crypto.randomUUID().replace(/-/g,''), ctx = doc.context
  const state = ctx.register(ctx.obj({Type:'ExtGState',ca:wm.opacity,CA:wm.opacity}))
  const payload = encoder.encode(`${prefix(id)}${zero}\n${JSON.stringify(wm)}`)
  const config = ctx.register(ctx.stream(payload,{Type:'PaperworkWatermarkV1',Image:image,State:state}))
  info(doc).set(infoKey,PDFString.of(id))
  return {id, draw(page: PDFPage) {
    page.node.setXObject(assetName(id),image)
    page.node.setExtGState(stateName(id),state)
    const stream = ctx.register(ctx.stream(drawing(page,wm,id),{PaperworkConfig:config}))
    page.node.addContentStream(stream)
    page.node.set(layerKey,stream)
  }}
}

// An ordinary fixed-size field INSIDE an unfiltered PDF stream. Binding the
// edition to the whole file means outside edits/optimizers cannot make us
// restore stale raster bytes, delete someone else's resource alias, or detach
// an externally repurposed stream. This is integrity, NOT a digital signature.
function digestOffset(bytes:Uint8Array,id:string) {
  const key = encoder.encode(prefix(id))
  let offset = -1
  for (let i=bytes.indexOf(key[0]); i!==-1; i=bytes.indexOf(key[0],i+1)) {
    if (key.every((c,j)=>bytes[i+j]===c)) {
      if (offset>=0) return -1
      offset = i+key.length
    }
  }
  return offset>=0 && bytes[offset+64]===10 ? offset : -1
}
async function digest(bytes:Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')
}
export async function sealOwnedWatermark(bytes:Uint8Array, id:string) {
  // Never touch an input buffer: this function receives only output.save().
  if (bytes.length>maxFile) return
  const i = digestOffset(bytes,id)
  if (i>=0 && decoder.decode(bytes.subarray(i,i+64))===zero) bytes.set(encoder.encode(await digest(bytes)),i)
}

export async function readOwnedWatermark(bytes:Uint8Array, id:string, permitted:(doc:PDFDocument)=>Promise<boolean>) {
  if (!/^[a-f0-9]{32}$/.test(id) || bytes.length>maxFile) return
  try {
    const i = digestOffset(bytes,id)
    if (i<0) return
    const expected = decoder.decode(bytes.subarray(i,i+64))
    if (!/^[a-f0-9]{64}$/.test(expected) || expected===zero) return
    const copy = new Uint8Array(bytes)
    copy.fill(48,i,i+64)
    if (await digest(copy)!==expected) return
    const doc = await PDFDocument.load(copy,{updateMetadata:false,throwOnInvalidObject:true})
    if (!await permitted(doc) || info(doc).lookup(infoKey,PDFString).asString()!==id) return
    const pages = doc.getPages()
    const first = pages[0]?.node.lookup(layerKey)
    if (!(first instanceof PDFRawStream)) return
    const ref = first.dict.get(configKey)
    if (!(ref instanceof PDFRef)) return
    const config = doc.context.lookup(ref)
    if (!(config instanceof PDFRawStream) || config.dict.get(PDFName.Type)!==N('PaperworkWatermarkV1') || config.dict.has(N('Filter'))
        || config.getContentsSize()>4*maxAsset/3+32768) return
    const payload = decoder.decode(config.contents), header = `${prefix(id)}${zero}\n`
    if (!payload.startsWith(header)) return
    const wm:unknown = JSON.parse(payload.slice(header.length))
    if (!configuration(wm) || !safeRaster(wm.imageData)) return
    const im = config.dict.get(N('Image')), gs = config.dict.get(N('State'))
    const image = doc.context.lookup(im)
    if (!(im instanceof PDFRef) || !(gs instanceof PDFRef) || !(image instanceof PDFRawStream) || image.dict.get(N('Subtype'))!==N('Image')) return
    const state = doc.context.lookup(gs,PDFDict)
    if (state.keys().length!==3 || state.get(PDFName.Type)!==N('ExtGState') || [N('ca'),N('CA')].some(k=>state.lookup(k,PDFNumber).asNumber()!==wm.opacity)) return
    const removedLayers = new Set<PDFRef>()
    for (const page of pages) {
      const layer = page.node.get(layerKey), contents = page.node.lookup(PDFName.Contents,PDFArray)
      if (!(layer instanceof PDFRef) || contents.get(contents.size()-1)!==layer || contents.asArray().filter(r=>r===layer).length!==1) return
      const stream = doc.context.lookup(layer), resources = page.node.Resources()!
      if (!(stream instanceof PDFRawStream) || stream.dict.get(configKey)!==ref || stream.dict.has(N('Filter')) || stream.getContentsSize()>65536
          || decoder.decode(stream.contents)!==drawing(page,wm,id) || resources.lookup(PDFName.XObject,PDFDict).get(assetName(id))!==im
          || resources.lookup(PDFName.ExtGState,PDFDict).get(stateName(id))!==gs) return
      // Detach only our final, byte-verified paint operation. Cloning the
      // containers preserves shared dictionaries/arrays on every other leaf.
      const rest = contents.clone(); rest.remove(rest.size()-1); page.node.set(PDFName.Contents,rest)
      const kept = resources.clone()
      for (const [key,name] of [[PDFName.XObject,assetName(id)],[PDFName.ExtGState,stateName(id)]]) {
        const dict = kept.lookup(key,PDFDict).clone(); dict.delete(name); kept.set(key,dict)
      }
      page.node.set(PDFName.Resources,kept); page.node.delete(layerKey)
      removedLayers.add(layer)
    }
    for (const layer of removedLayers) doc.context.delete(layer)
    info(doc).delete(infoKey)
    // pdf-lib saves all indirect objects, even unreachable ones. Do not
    // delete shared bitmap objects globally: composePdf copies only the
    // reachable page graph when the user subsequently saves the edited file.
    doc.context.delete(ref)
    return {watermark:wm,bytes:await doc.save({useObjectStreams:true,updateFieldAppearances:false})}
  } catch { return undefined } // Invalid/private extensions never prevent normal, baked viewing.
}
