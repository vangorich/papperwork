import { OPS, Util, type PDFPageProxy } from 'pdfjs-dist'
import type { PDFOperatorList } from 'pdfjs-dist/types/src/display/api'

/** Classify the actual appearance, not the annotation's title, comment, /C or /CA.
 * A Highlight may contain an arbitrary opaque Form; unsupported paint stays a cover. */
export function markerInk(list: PDFOperatorList, begin: number): 'tint' | 'multiply' | undefined {
  let state = { alpha: 1, multiply: false, light: 0 }, fills = 0, allBrightMultiply = true, transmission = 1
  const stack: typeof state[] = []
  for (let i=begin+1; i<Math.min(list.fnArray.length,begin+8192); i++) {
    const op=list.fnArray[i], args=list.argsArray[i] ?? []
    switch (op) {
      case OPS.endAnnotation: return fills && !stack.length ? transmission>=.3 ? 'tint' : allBrightMultiply ? 'multiply' : undefined : undefined
      case OPS.save: case OPS.paintFormXObjectBegin: stack.push({...state}); break
      case OPS.restore: case OPS.paintFormXObjectEnd: {
        const previous=stack.pop(); if(!previous)return; state=previous; break
      }
      case OPS.setGState:
        for(const [key,value] of args[0] ?? []) {
          if(key==='ca') { if(!Number.isFinite(value)||value<0||value>1)return;state.alpha=value }
          else if(key==='BM') { if(value!=='multiply' && value!=='source-over')return; state.multiply=value==='multiply' }
          else if(!['CA','LW','LC','LJ','ML','D'].includes(key))return
        }
        break
      case OPS.setFillRGBColor: state.light=.2126*args[0]+.7152*args[1]+.0722*args[2]; break
      case OPS.fill: case OPS.eoFill:
        if(!state.alpha)return
        fills++; transmission*=1-state.alpha; allBrightMultiply &&= state.multiply && state.light>=128; break
      case OPS.dependency: case OPS.transform: case OPS.constructPath: case OPS.endPath: case OPS.clip: case OPS.eoClip: break
      default: return
    }
  }
}
// A custom appearance can paint somewhere other than its /QuadPoints. Recognize
// the common four straight edges or two outward-facing rounded caps. Unfamiliar
// shapes are still rendered by PDF.js, but grant no body text for excerpts.
export function matchesMarkerQuads(list: PDFOperatorList, begin: number, a: { hasAppearance?:boolean; quadPoints?: ArrayLike<number> }) {
  if(!a.hasAppearance)return true // PDF.js synthesizes this appearance from the quads themselves.
  const q=Array.from(a.quadPoints??[])
  if(!q.length || q.length%8 || q.length>8192)return false
  const declared:number[][]=[]
  for(let i=0;i<q.length;i+=8){const xs=[q[i],q[i+2],q[i+4],q[i+6]],ys=[q[i+1],q[i+3],q[i+5],q[i+7]];declared.push([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)])}
  const args=list.argsArray[begin], found=new Set<number>(), stack:number[][]=[]
  let m=Util.transform(args[2],args[3]), pending:number[]|undefined
  for(let i=begin+1;i<Math.min(list.fnArray.length,begin+8192);i++){
    const op=list.fnArray[i], v=list.argsArray[i]??[]
    if(op===OPS.endAnnotation)return found.size===declared.length && !pending
    if(op===OPS.clip || op===OPS.eoClip)return false
    if(op===OPS.save || op===OPS.paintFormXObjectBegin){stack.push(m);if(op===OPS.paintFormXObjectBegin){if(v[1])return false;if(v[0])m=Util.transform(m,v[0])}}
    else if(op===OPS.restore || op===OPS.paintFormXObjectEnd){if(!stack.length)return false;m=stack.pop()!}
    else if(op===OPS.transform)m=Util.transform(m,v)
    else if(op===OPS.constructPath){
      if(pending)return false
      const path:number[]=Array.from(v[0]), coords:number[]=Array.from(v[1]), edges:number[][]=[]
      if(path.at(-1)===OPS.closePath)path.pop()
      if(path.length===1 && path[0]===OPS.rectangle){
        const [x,y,w,h]=coords;edges.push([x,y],[x+w,y],[x+w,y+h],[x,y+h])
      }else{
        if(path.length!==4 || path[0]!==OPS.moveTo)return false
        let pos=0, start:number[]=[]
        for(const verb of path){
          if(verb!==OPS.moveTo && verb!==OPS.lineTo && verb!==OPS.curveTo)return false
          const pts=coords.slice(pos,pos+(verb===OPS.curveTo?6:2));pos+=pts.length
          const end=pts.slice(-2); if(end.length!==2)return false
          if(verb===OPS.curveTo){ // MuPDF-style cap: controls outside the chord, not a cut into the marked area.
            const right=v[2]?.[2], left=v[2]?.[0], near=(b:number,c:number)=>Math.abs(b-c)<.02
            if(!near(start[0],end[0]) || !(near(end[0],left)&&Math.max(pts[0],pts[2])<=left+.02 || near(end[0],right)&&Math.min(pts[0],pts[2])>=right-.02))return false
            if([pts[1],pts[3]].some(y=>y<Math.min(start[1],end[1])-.02 || y>Math.max(start[1],end[1])+.02))return false
          }
          edges.push(end);start=end
        }
      }
      const pts=edges.map(p=>Util.applyTransform(p,m)), xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]); const x=Math.min(...xs),r=Math.max(...xs),y=Math.min(...ys),t=Math.max(...ys)
      if(!(r>x&&t>y)||new Set(pts.map(p=>p.map(n=>n.toFixed(2)).join(':'))).size!==4||pts.some((p,k)=>Math.min(Math.abs(p[0]-x),Math.abs(p[0]-r))>.02||Math.min(Math.abs(p[1]-y),Math.abs(p[1]-t))>.02 || Math.min(Math.abs(p[0]-pts[(k+1)%4][0]),Math.abs(p[1]-pts[(k+1)%4][1]))>.02))return false
      pending=[x,y,r,t]
    }else if(op===OPS.fill || op===OPS.eoFill){
      const box=pending
      if(!box)return false
      // PDF.js exposes quads as Float32, but the appearance as decimal PDF coordinates.
      // A shared endpoint at e.g. 345.515 pt may round to opposite hundredths.
      const match=declared.findIndex(d=>d.every((v,k)=>Math.abs(v-box[k])<=.02))
      if(match<0)return false
      found.add(match);pending=undefined
    }else if(op===OPS.endPath)pending=undefined
  }
  return false
}

export const visibleHighlight = (a: Awaited<ReturnType<PDFPageProxy['getAnnotations']>>[number]) =>
  a.subtype === 'Highlight' && !a.hidden && !((a.annotationFlags ?? 0) & (1 | 2 | 32)) && a.opacity !== 0 && !!a.quadPoints?.length
