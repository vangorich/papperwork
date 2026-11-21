// Paint is downstream of the DOM Range. These functions do not edit the Range,
// infer characters, change OCR text, or touch the clipboard.
export interface OcrRunFrame {
  line: number
  cell: number | null
  angle: number // physical CSS degrees, including the page turn
  x: number; y: number; width: number; height: number // normalized span *before* rotation
  length: number // UTF-16 length of displayed text, excluding its structural separator
}
const frames = new WeakMap<HTMLElement, OcrRunFrame>()
export const setOcrRunFrame = (span: HTMLElement, frame: OcrRunFrame) => { frames.set(span, frame) }
export const getOcrRunFrame = (span: HTMLElement) => frames.get(span)
export type Point = { x: number; y: number }
export interface SelectedInk { start: Point; end: Point; height: number; angle: number; line: number; cell: number | null }
const axis = (angle: number) => {const a=angle*Math.PI/180; return {x:Math.cos(a),y:Math.sin(a)}}
const dot = (p:Point,u:Point) => p.x*u.x+p.y*u.y
const perpendicular = (u:Point):Point => ({x:-u.y,y:u.x})
const midpoint=(p:SelectedInk):Point=>({x:(p.start.x+p.end.x)/2,y:(p.start.y+p.end.y)/2})
const pointsOf=(run:SelectedInk):Point[]=>{
  const n=perpendicular(axis(run.angle)),d=run.height/2
  return [run.start,run.end].flatMap(p=>[{x:p.x-n.x*d,y:p.y-n.y*d},{x:p.x+n.x*d,y:p.y+n.y*d}])
}
/** Return a closed baseline-aligned strip per consecutive selected part of a line.
 * Normal inter-word whitespace joins. A different cell, column gutter, row or
 * implausible OCR angle/vertical offset starts a separate strip. */
export function ocrSelectionBands(runs: readonly SelectedInk[]): Point[][] {
  const result:Point[][]=[];let group:SelectedInk[]=[]
  const flush=()=>{
    if(!group.length)return
    let vx=0,vy=0
    for(const r of group){const u=axis(r.angle),len=Math.max(1,Math.hypot(r.end.x-r.start.x,r.end.y-r.start.y));vx+=u.x*len;vy+=u.y*len}
    const norm=Math.hypot(vx,vy),u=norm?{x:vx/norm,y:vy/norm}:axis(group[0].angle),n=perpendicular(u)
    let lo=Infinity,hi=-Infinity,top=Infinity,bottom=-Infinity
    for(const r of group)for(const p of pointsOf(r)){const a=dot(p,u),b=dot(p,n);lo=Math.min(lo,a);hi=Math.max(hi,a);top=Math.min(top,b);bottom=Math.max(bottom,b)}
    const point=(a:number,b:number)=>({x:u.x*a+n.x*b,y:u.y*a+n.y*b})
    result.push([point(lo,top),point(hi,top),point(hi,bottom),point(lo,bottom)]);group=[]
  }
  for(const r of runs){
    if(!(r.height>0) || ![r.angle,r.start.x,r.start.y,r.end.x,r.end.y,r.height].every(Number.isFinite)) {flush();continue}
    const p=group.at(-1)
    if(p){const u=axis(p.angle), n=perpendicular(u), gap=dot(r.start,u)-dot(p.end,u)
      const dh=Math.abs(dot(midpoint(r),n)-dot(midpoint(p),n)),em=Math.max(1,p.height,r.height)
      if(p.line!==r.line||p.cell!==r.cell||dot(u,axis(r.angle))<.9945||gap>1.35*em||gap < -.45*em||dh>.61*em)flush()
    }
    group.push(r)
  }
  flush();return result
}
/** Actual caret centres give the partial offsets' advances—including kerning,
 * uneven Latin/CJK widths and composed characters—without uniform-char estimates. */
export function selectedOcrInk(span:HTMLElement, node:Text, lo:number, hi:number, bounds:DOMRect, range:Range):SelectedInk|undefined {
  const f=frames.get(span);if(!f||hi<=lo)return
  const centre=(k:number)=>{range.setStart(node,k);range.collapse(true);const b=range.getBoundingClientRect();return {p:{x:b.x+b.width/2-bounds.left,y:b.y+b.height/2-bounds.top},b}}
  const a=centre(lo),b=centre(hi),u=axis(f.angle),n=perpendicular(u)
  // A collapsed, rotated Chromium caret is a thin segment along the normal.
  const height=(Math.abs(n.x)*(a.b.width+b.b.width)+Math.abs(n.y)*(a.b.height+b.b.height))/2
  if(!(height>.25)||Math.hypot(a.p.x-b.p.x,a.p.y-b.p.y)<.1)return
  return {start:a.p,end:b.p,height,angle:f.angle,line:f.line,cell:f.cell}
}
export function bandPath(quads:readonly Point[][]) {
  return quads.map(p=>p.map((v,i)=>`${i?'L':'M'}${v.x.toFixed(2)} ${v.y.toFixed(2)}`).join('')+'Z').join('')
}
/** If the cursor is in whitespace after/before a slanted word, project onto the
 * original word axes. No paint expansion/bridged gap ever becomes a copy hit. */
export function ocrGapDistance(f:OcrRunFrame,p:Point,w:number,h:number){
  const u=axis(f.angle),n=perpendicular(u),rel={x:p.x-f.x*w,y:p.y-f.y*h},advance=dot(rel,u),normal=dot(rel,n),len=f.width*w,em=f.height*h
  if(!(len>0&&em>0)||normal < -1 || normal>em+1)return
  return {before:advance<len/2,score:Math.max(-advance,0,advance-len)+Math.abs(normal-em/2)*.12}
}
