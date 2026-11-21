import { PDFName, PDFNumber, type PDFPage } from 'pdf-lib'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import type { OcrWord } from '../types/pdf'
import { newOcrTag } from './ocrEditionReceipt'
import { ocrWordSpanPlacement, sortOcrWordsReadingOrder, type OcrBoundingBox } from './ocr'

// All coordinates here are unrotated PDF user units. /Rotate applies to the
// original ink AND the new text; applying it to the text matrix again is wrong.
type Box = OcrBoundingBox
export function visiblePdfBox(page: PDFPage): Box {
  const m = page.getMediaBox(), c = page.getCropBox()
  const x = Math.max(m.x, c.x), y = Math.max(m.y, c.y)
  const width = Math.min(m.x + m.width, c.x + c.width) - x
  const height = Math.min(m.y + m.height, c.y + c.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : m
}

function validWord(w: OcrWord) {
  const unit = (n: number) => Number.isFinite(n) && n >= -1e-6 && n <= 1.000001
  if (!w || ![w.x, w.y, w.width, w.height, w.x + w.width, w.y + w.height].every(unit)
      || w.width <= 0 || w.height <= 0 || !Number.isFinite(w.rotation ?? 0)) return false
  if (w.points) {
    const q = w.points
    if (q.length !== 4 || !q.every(p => p && unit(p.x) && unit(p.y))) return false
    // TL, TR, BR, BL in top-left-origin space: reject collapsed or folded quads.
    if (!q.every((a,i) => {
      const b=q[(i+1)%4], c=q[(i+2)%4]
      return (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x) > 0
    })) return false
  }
  return typeof w.text === 'string' && w.text.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(w.text)
}

// PDF.js gives the text baseline + local axes, not a top-left rectangle.
// Suppress overlaps even if the OCR spelling disagrees. A native page number
// must not suppress a whole scanned body elsewhere on the same page.
function nativeBoxes(content: TextContent): Box[] {
  return content.items.flatMap(item => {
    if (!('str' in item) || !item.str.trim()) return []
    const [a,b,c,d,x,y] = item.transform as number[]
    const w = Math.hypot(a,b), h = Math.hypot(c,d)
    if (!w || !h) return []
    const style = content.styles[item.fontName]
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : .8
    const descent = Number.isFinite(style?.descent) ? style.descent : -.2
    const dx = a/w*item.width, dy = b/w*item.width
    const xs = [x+c*ascent,x+c*descent,x+dx+c*ascent,x+dx+c*descent]
    const ys = [y+d*ascent,y+d*descent,y+dy+d*ascent,y+dy+d*descent]
    const l = Math.min(...xs), bottom = Math.min(...ys)
    return [{ x:l, y:bottom, width:Math.max(...xs)-l, height:Math.max(...ys)-bottom }]
  })
}

const num = (n: number) => PDFNumber.of(n).toString()
const hexByte = (n: number) => n.toString(16).padStart(2,'0')
const advance = (char: string) => char.codePointAt(0)! < 256 ? 550 : 1000

// A real embedded font, without shipping (or substituting) a CJK typeface.
// All CharProcs have advance metrics but NO paint operators. ToUnicode maps
// each code to a Unicode scalar (including a UTF-16 surrogate pair). Type 3
// fonts have one-byte codes, so continue in a fresh subset after 255 glyphs.
function pageAlphabet(page: PDFPage, chars: string[]) {
  const ctx = page.doc.context, codes = new Map<string,{font: PDFName; code:string}>()
  const procs = new Map<number, ReturnType<typeof ctx.register>>()
  for (let i=0;i<chars.length;i+=255) {
    const subset = chars.slice(i,i+255), names = subset.map((_,i)=>`g${i+1}`)
    const shapes = subset.map((char,i) => {
      const width = advance(char)
      if (!procs.has(width)) procs.set(width,ctx.register(ctx.stream(`${width} 0 0 -200 ${width} 800 d1\n`)))
      return [names[i],procs.get(width)!] as const
    })
    const cmap = ['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /PaperworkOCR def','/CMapType 2 def','1 begincodespacerange','<01> <FF>','endcodespacerange']
    for (let j=0;j<subset.length;j+=100) {
      const batch = subset.slice(j,j+100)
      cmap.push(`${batch.length} beginbfchar`,...batch.map((c,n)=>`<${hexByte(j+n+1)}> <${c.split('').map(u=>u.charCodeAt(0).toString(16).padStart(4,'0')).join('')}>`),'endbfchar')
    }
    cmap.push('endcmap','CMapName currentdict /CMap defineresource pop','end end')
    const font = page.node.newFontDictionary('PaperworkOCR', ctx.register(ctx.obj({
      Type:'Font', Subtype:'Type3', FontBBox:[0,-200,1000,800], FontMatrix:[.001,0,0,.001,0,0],
      FirstChar:1, LastChar:subset.length, Widths:subset.map(advance), CharProcs:Object.fromEntries(shapes),
      Encoding:{ Type:'Encoding', Differences:[1,...names] }, Resources:{},
      ToUnicode:ctx.register(ctx.flateStream(cmap.join('\n'))),
    })))
    subset.forEach((char,n)=>codes.set(char,{font,code:hexByte(n+1)}))
  }
  return codes
}

export interface OcrPlacement {
  sourceBox: Box
  /** Mapping used by embedPage for resized paper (identity for copied leaves). */
  scale: number
  dx: number
  dy: number
}

export function writeSearchableOcr(page: PDFPage, words: OcrWord[], placement: OcrPlacement, native?: TextContent) {
  const {sourceBox:box,scale,dx,dy} = placement, clip = visiblePdfBox(page)
  const existing = native ? nativeBoxes(native) : []
  const lines = sortOcrWordsReadingOrder(words.filter(validWord), box.height/box.width).flatMap(word=>{
    const p = ocrWordSpanPlacement(word,0,box.height/box.width), b = p.box
    const x = box.x+b.x*box.width, y = box.y+(1-b.y-b.height)*box.height
    const w = b.width*box.width, h = b.height*box.height
    // Never add hidden text for geometry discarded by an explicit crop.
    if (x*scale+dx < clip.x-.01 || y*scale+dy < clip.y-.01 || (x+w)*scale+dx > clip.x+clip.width+.01 || (y+h)*scale+dy > clip.y+clip.height+.01) return []
    if (existing.some(n=>{
      const overlapW = Math.min(x+w,n.x+n.width)-Math.max(x,n.x)
      const overlapH = Math.min(y+h,n.y+n.height)-Math.max(y,n.y)
      return overlapW>0 && overlapH>0 && overlapW*overlapH >= .38*Math.min(w*h,n.width*n.height)
    })) return []
    const text = [...word.text], width = p.width*box.width*scale, height = p.height*box.height*scale
    const theta = -p.angle*Math.PI/180, cos = Math.cos(theta), sin = Math.sin(theta)
    const units = text.reduce((n,c)=>n+advance(c)/1000,0)
    const quad = word.points
    // Use the actual two non-orthogonal edges on deskewed scans; a PDF text
    // matrix supports shear, so there is no need to force a rectangle here.
    const rightX = quad ? (quad[1].x-quad[0].x)*box.width*scale : width*cos
    const rightY = quad ? (quad[0].y-quad[1].y)*box.height*scale : width*sin
    const upX = quad ? (quad[0].x-quad[3].x)*box.width*scale : -sin*height
    const upY = quad ? (quad[3].y-quad[0].y)*box.height*scale : cos*height
    const matrix = [rightX/units, rightY/units, upX, upY, (box.x+p.x*box.width)*scale+dx-.8*upX, (box.y+(1-p.y)*box.height)*scale+dy-.8*upY]
    return matrix.every(Number.isFinite) && width>0 && height>0 ? [{text,matrix}] : []
  })
  if (!lines.length) return
  const chars = new Set<string>()
  for (const {text} of lines) for (const c of text) chars.add(c)
  const tag = newOcrTag()
  const codes = pageAlphabet(page,[...chars]), ops = ['q', `/${tag} BMC`, 'BT','3 Tr','0 Tc','0 Tw','100 Tz','0 Ts']
  for (const {text,matrix} of lines) {
    ops.push(`${matrix.map(num).join(' ')} Tm`)
    let font: PDFName | undefined, run = ''
    for (const char of text) {
      const glyph = codes.get(char)!
      if (font !== glyph.font) {
        if (run) ops.push(`<${run}> Tj`)
        font = glyph.font; run = ''; ops.push(`${font} 1 Tf`)
      }
      run += glyph.code
    }
    ops.push(`<${run}> Tj`)
  }
  const ctx = page.doc.context
  page.node.addContentStream(ctx.register(ctx.flateStream([...ops,'ET','EMC','Q',''].join('\n'))))
  return tag
}
