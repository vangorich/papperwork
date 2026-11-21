import { PDFHexString, PDFName, type PDFDocument, type PDFRef } from 'pdf-lib'
import { ofdError } from './ofdArchive'
import type { GlyphShape } from './ofdOutlineFont'

const EM = 128
const hex = (n: number) => n.toString(16).padStart(2, '0')
const unit = (n: number) => Math.round(n * 1000 / EM)
type Glyph = { ref: PDFRef; font: PDFName; code: PDFHexString; advance: number }
type Subset = { ref: PDFRef; name: PDFName; chars: string[]; widths: number[]; shapes: Map<string, PDFRef>; bounds: number[] }

// Embed only used glyphs. Explicit GIDs use font outlines; for ordinary
// Unicode text without a GID map the OS shapes each glyph via its
// font rasterizer; a 128-sample/em stencil keeps copies portable without a
// system font dependency or shipping an entire CJK font in the installer.
// Every subset carries ToUnicode, so copy/search survive PDF export.
export function createOfdFonts(pdf: PDFDocument) {
  const { context } = pdf
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) ?? ofdError('无法初始化文字渲染器')
  const styles = new Map<string, { glyphs: Map<string, Glyph>; subset?: Subset }>()
  const subsets: Subset[] = []
  let count = 0
  let shapeBytes=0
  function register(style:string,char:string,keyId:string,build:()=>GlyphShape):Glyph {
    let set = styles.get(style)
    if (!set) styles.set(style, set = { glyphs: new Map() })
    const cached = set.glyphs.get(keyId)
    if (cached) return cached
    if (++count > 6000) ofdError('文档使用的不同字形超过 6000 个')
    let sub = set.subset
    if (!sub || sub.chars.length >= 255) {
      sub = { ref: context.nextRef(), name: PDFName.of(`OFD${subsets.length}`), chars: [], widths: [], shapes: new Map(), bounds: [0, 0, 0, 0] }
      subsets.push(sub); set.subset = sub
    }
    const {shape,bounds,width,advance}=build()
    if ((shapeBytes+=shape.length)>40*1024*1024) ofdError('字形绘制内容超过上限')
    const code = sub.chars.push(char), key = `g${code}`
    sub.widths.push(width); sub.shapes.set(key, context.register(context.flateStream(shape)))
    sub.bounds = bounds.map((v, i) => i < 2 ? Math.min(v, sub!.bounds[i]) : Math.max(v, sub!.bounds[i]))
    const result = { ref: sub.ref, font: sub.name, code: PDFHexString.of(hex(code)), advance }
    set.glyphs.set(keyId, result)
    return result
  }
  function glyph(style:string,char:string) {return register(style,char,char,()=>{
    ctx.font = style
    const metrics = ctx.measureText(char)
    const left = Math.floor(-metrics.actualBoundingBoxLeft) - 1, top = Math.ceil(metrics.actualBoundingBoxAscent) + 1
    const w = Math.max(1, Math.ceil(metrics.actualBoundingBoxRight) - left + 1), h = Math.max(1, top + Math.ceil(metrics.actualBoundingBoxDescent) + 1)
    if (!Number.isFinite(w + h) || w > EM * 4 || h > EM * 4) ofdError('字形边界无效')
    const advance = metrics.width / EM, width = unit(metrics.width)
    const bounds = [unit(left), unit(top - h), unit(left + w), unit(top)]
    let shape = `${width} 0 ${bounds.join(' ')} d1\n`
    if (char.trim()) {
      if (canvas.width < w || canvas.height < h) { canvas.width = Math.max(canvas.width, w); canvas.height = Math.max(canvas.height, h) }
      ctx.clearRect(0, 0, w, h); ctx.font = style; ctx.fillText(char, -left, top)
      const alpha = ctx.getImageData(0, 0, w, h).data, stride = Math.ceil(w / 8)
      const mask = new Uint8Array(stride * h).fill(255)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (alpha[(y * w + x) * 4 + 3] >= 96) mask[y * stride + (x >> 3)] &= ~(128 >> (x & 7))
      }
      // Inline stencil, encoded as hex so binary glyph data cannot contain EI.
      shape += `q ${unit(w)} 0 0 ${unit(h)} ${bounds[0]} ${bounds[1]} cm\nBI /W ${w} /H ${h} /IM true /BPC 1 /F /AHx ID\n${Array.from(mask, hex).join('')}>\nEI Q\n`
    }
    return {shape,bounds,width,advance}
  })}
  function mapped(fontKey:string,char:string,gid:number,outline:(gid:number)=>GlyphShape){return register(`mapped:${fontKey}`,char,`${gid}:${char}`,()=>outline(gid))}
  function finish() {
    for (const sub of subsets) {
      let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (OFD) /Ordering (Unicode) /Supplement 0 >> def\n/CMapName /OFDUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n'
      for (let i = 0; i < sub.chars.length; i += 100) {
        const batch = sub.chars.slice(i, i + 100)
        cmap += `${batch.length} beginbfchar\n` + batch.map((c, n) => `<${hex(i + n + 1)}> <${c.split('').map(s => s.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`).join('\n') + '\nendbfchar\n'
      }
      cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend end'
      context.assign(sub.ref, context.obj({ Type: 'Font', Subtype: 'Type3', Name: sub.name, FontBBox: sub.bounds,
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: context.obj(Object.fromEntries(sub.shapes)),
        Encoding: context.obj({ Type: 'Encoding', Differences: [1, ...sub.shapes.keys()] }),
        FirstChar: 1, LastChar: sub.chars.length, Widths: sub.widths, Resources: context.obj({}), ToUnicode: context.register(context.flateStream(cmap)),
      }))
    }
    canvas.width = canvas.height = 0
  }
  return { glyph, mapped, finish }
}

export function ofdFontStyle(family: string, bold: boolean, italic: boolean, serif: boolean) {
  const safeFamily = family.replace(/[^\p{L}\p{M}\p{N} _.-]/gu, '').slice(0, 128) || 'Arial'
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${EM}px "${safeFamily}", ${serif ? 'serif' : 'sans-serif'}`
}
