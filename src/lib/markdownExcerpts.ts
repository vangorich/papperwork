import type { PDFPageProxy } from 'pdfjs-dist'
import type { OcrWord, WorkspacePage } from '../types/pdf'
import type { MarkdownFragment, MarkdownRegion as Box } from './markdownScopeTypes'
import { inside, intersection, glyphKey } from './pdfMarkdownFigures'

const controls = /[\u0000-\u0008\u000b-\u001f\u007f]/gu
function escapeLiteral(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_\[\]|~#])/g, '\\$1').replace(/^([=+\-])/, '\\$1').replace(/^(\d+)([.)])(?=\s)/, '$1\\$2')
}
export function literalMarkdown(value: string) {
  return escapeLiteral(value.replace(controls, '').replace(/\s+/gu, ' ').trim())
}
function excerptMarkdown(text: string, tsv = false, exactOcr = false) {
  if (tsv) {
    // Tabs and newlines encode selected cells, including trailing empty columns/rows.
    const rows = text.split(/\r?\n/).map(s => s.split('\t').map(literalMarkdown))
    const n = rows.reduce((max,r)=>Math.max(max,r.length),0)
    if (n>=1 && n<=64 && rows.length<=2048) {
      const row=(a:string[])=>'| '+Array.from({length:n},(_,i)=>a[i]??'').join(' | ')+' |'
      return [row(rows[0]),row(Array(n).fill('---')),...rows.slice(1).map(row)].join('\n')
    }
  }
  return text.trim().split(/\r?\n/).map(exactOcr ? line => escapeLiteral(line.replace(controls, '')) : literalMarkdown).join('  \n')
}
function validBox(b:Box){return [b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0}

/** PDF highlight comments are not quotations. Only the actual displayed quads may grant a region. */
export async function pageHighlightFragments(item:WorkspacePage,page:PDFPageProxy|undefined,turn:number):Promise<MarkdownFragment[]> {
  const byGroup=new Map<string,MarkdownFragment>()
  for(const a of item.annotations){
    if(a.type!=='highlight'||(a.opacity??1)<=0||!validBox(a))continue
    const key=a.highlightGroupId??a.id, group=byGroup.get(key)??{pageId:item.id,boxes:[]}
    group.boxes.push({x:a.x,y:a.y,width:a.width,height:a.height})
    if(a.highlightGroupId && a.text && !group.text)group.text=a.text
    byGroup.set(key,group)
  }
  const result=[...byGroup.values()]
  if(!page)return result
  const v=page.getViewport({scale:1,rotation:turn})
  const annotations=await page.getAnnotations({intent:'display'})
  if(annotations.length>8192)throw Error('单页批注过多，请缩小导出范围。')
  const seen=new Set<string>()
  for(const a of annotations){
    if(a.subtype!=='Highlight'||a.hidden||((a.annotationFlags??0)&(1|2|32))||a.opacity===0)continue
    const q=a.quadPoints, raw:number[]=q instanceof Float32Array?Array.from(q):Array.isArray(q)?q.flat(2).flatMap((p:unknown)=>typeof p==='number'?[p]:p && typeof p==='object'&&'x' in p&&'y' in p?[Number(p.x),Number(p.y)]:[]):[]
    if(!raw.length||raw.length%8||raw.length>8*4096)continue
    const boxes:Box[]=[]
    for(let i=0;i<raw.length;i+=8){
      const pts=Array.from({length:4},(_,k)=>v.convertToViewportPoint(raw[i+2*k],raw[i+2*k+1]))
      const xs=pts.map(p=>p[0]/v.width),ys=pts.map(p=>p[1]/v.height)
      const x=Math.min(...xs),y=Math.min(...ys),b={x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y}
      if(!validBox(b))continue
      // Don't use an AABB that sweeps in unrelated text on a diagonal quad.
      if(pts.some((p,k)=> Math.min(Math.abs(xs[k]-x),Math.abs(xs[k]-x-b.width))>0.002 || Math.min(Math.abs(ys[k]-y),Math.abs(ys[k]-y-b.height))>0.002))continue
      const key=a.id+':'+[b.x,b.y,b.width,b.height].map(n=>n.toFixed(5)).join(':');if(!seen.has(key)){seen.add(key);boxes.push(b)}
    }
    if(boxes.length)result.push({pageId:item.id,boxes,nativeHighlightId:a.id})
  }
  return result
}

export type GlyphSlices = WeakMap<OcrWord, readonly (Box & { text: string })[]>

/** Quotations are checked against visible glyphs at the chosen location. For a
 * geometry-only mark never output a whole text run merely because its edge touches the mark. */
export function scopedExcerpts(fragments:readonly MarkdownFragment[], words:readonly OcrWord[], crop:Box, rotateToSource:(b:Box)=>Box, verifyCaptured?: (f: MarkdownFragment) => boolean | undefined, glyphs?: GlyphSlices) {
  const blocks:string[]=[], regions:Box[]=[], painted=new Set<OcrWord>(),quoted=new Set<string>()
  const emittedGlyphs=new Set<Box>()
  const count=fragments.reduce((a,f)=>a+f.boxes.length,0)
  if(count>4096 || count*Math.max(words.length,1)>8_000_000)throw Error('选区太大或过密，请分段导出。')
  for(const f of fragments){
    const raw=f.boxes.filter(validBox).map(rotateToSource)
    const boxes=raw.map(b=>intersection(b,crop)).filter((b):b is Box=>!!b)
    if(!boxes.length)continue
    const exact = verifyCaptured?.(f)
    if (exact === false) throw Error('选中文字已改变或被遮挡，请重新拉选；没有扩大导出范围。')
    // A text drag grants characters, not images caught in the corners of its bounds.
    if (!f.text || f.table) regions.push(...boxes)
    if(f.text?.trim()){
      // Never infer an OCR drag from overlapping line AABBs. Verify its captured glyphs and visibility instead.
      const evidence:OcrWord[]=[], used=new Set<OcrWord>()
      if (exact === undefined) for(const box of boxes){
        const row=words.filter(w=>{const o=intersection(w,box);return o && o.height>=.25*Math.min(w.height,box.height) && o.width>=Math.min(w.width,box.width)*.06}).sort((a,b)=>Math.abs(a.y-b.y)<Math.min(a.height,b.height)*.5?a.x-b.x:a.y-b.y)
        for(const w of row)if(!used.has(w)){evidence.push(w);used.add(w)}
      }
      const key=glyphKey(f.text), seenAt=boxes.map(b=>[b.x,b.y,b.width,b.height].map(n=>n.toFixed(5)).join(',')).join(';')+'\0'+key
      if(key && raw.every(b=>inside(b,crop)) && (exact === true || glyphKey(evidence.map(w=>w.text).join('')).includes(key)) && !quoted.has(seenAt)){
        blocks.push(excerptMarkdown(f.text,f.table,exact === true));quoted.add(seenAt);evidence.forEach(w=>painted.add(w))
      }
      // A partial-quote mismatch is never a reason to broaden it to the rest of the line or page.
      continue
    }
    for(const box of boxes){
      const row=words.filter(w=>!painted.has(w)&&intersection(w,box)).sort((a,b)=>Math.abs(a.y-b.y)<Math.min(a.height,b.height)*.5?a.x-b.x:a.y-b.y)
      const parts:string[]=[]
      for(const w of row){
        const letters=glyphs?.get(w)
        if(letters){
          // QuadPoints are Float32 in PDF.js, glyph advances use doubles. Allow
          // rounding at a shared endpoint only (never relax crop/cover checks).
          const excerpt=letters.filter(g=>{
            const e=Math.min(1e-6,Math.min(g.width,g.height)*1e-4)
            return inside(g,{x:box.x-e,y:box.y-e,width:box.width+2*e,height:box.height+2*e}) && !emittedGlyphs.has(g)
          })
          if(excerpt.length){parts.push(excerpt.map(g=>g.text).join(''));excerpt.forEach(g=>emittedGlyphs.add(g))}
        }else if(inside(w,box)){parts.push(w.text);painted.add(w)}
      }
      if(parts.some(p=>p.trim()))blocks.push(literalMarkdown(parts.join(' ')))
    }
  }
  return {text:blocks.join('\n\n'),regions}
}
