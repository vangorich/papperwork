export type Grip = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Point {
  x: number
  y: number
}
const radians = (degrees: number) => (degrees * Math.PI) / 180
export const signedAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180
/** Corners always show a native diagonal cursor (even near 45°); only side
 * grips offer the single-axis resize cursors. Swap diagonals at quarter turns. */
export function gripCursor(grip:Grip, angle:number){
  if(grip.length===2){const nwse=grip==='nw'||grip==='se',odd=Math.abs(Math.round(angle/90))%2===1;return nwse!==odd?'nwse-resize':'nesw-resize'}
  const base=grip==='e'||grip==='w'?0:90
  return ['ew-resize','nwse-resize','ns-resize','nesw-resize'][((Math.round((base+angle)/45)%4)+4)%4]
}

export function turnFrom(start: Point, point: Point, centre: Point, initial: number, snap: boolean) {
  if (Math.hypot(point.x - centre.x, point.y - centre.y) < 2) return initial
  const angle = (p: Point) => Math.atan2(p.y - centre.y, p.x - centre.x)
  const degrees = initial + ((angle(point) - angle(start)) * 180) / Math.PI
  return signedAngle(snap ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10)
}

/** Resize in physical display pixels, around the opposite edge midpoint/corner.
 * Apply limits along the drag trajectory, never by translating the fixed pin. */
export function resizeAtGrip(
  b: Box,
  grip: Grip,
  dx: number,
  dy: number,
  pageW: number,
  pageH: number,
  rotation: number,
  options: { aspect?: boolean; minW: number; minH: number; tiled?: boolean },
): Box {
  if (!(pageW > 0 && pageH > 0 && b.width > 0 && b.height > 0)) return b
  const sx = grip.includes('e') ? 1 : grip.includes('w') ? -1 : 0
  const sy = grip.includes('s') ? 1 : grip.includes('n') ? -1 : 0
  const cos = Math.cos(radians(rotation)),
    sin = Math.sin(radians(rotation))
  const lx = dx * cos + dy * sin,
    ly = -dx * sin + dy * cos
  const w = b.width * pageW,
    h = b.height * pageH
  const minW = Math.min(w, options.minW * pageW),
    minH = Math.min(h, options.minH * pageH)
  let dw = sx ? Math.max(minW, w + sx * lx) - w : 0
  let dh = sy ? Math.max(minH, h + sy * ly) - h : 0
  if (options.aspect && sx && sy) {
    const scale = Math.max(minW / w, minH / h, 1 + (sx * w * lx + sy * h * ly) / (w * w + h * h))
    dw = w * (scale - 1)
    dh = h * (scale - 1)
  }
  const dwf = dw / pageW,
    dhf = dh / pageH
  const tx = (sx * dw * cos - sy * dh * sin - dw) / (2 * pageW)
  const ty = (sx * dw * sin + sy * dh * cos - dh) / (2 * pageH)
  let t = 1
  const limit = (room: number, speed: number) => {
    if (speed > 1e-10) t = Math.min(t, Math.max(0, room) / speed)
  }
  limit(1 - b.width, dwf)
  limit(1 - b.height, dhf)
  if (!options.tiled) {
    limit(b.x, -tx)
    limit(b.y, -ty)
    limit(1 - b.x - b.width, tx + dwf)
    limit(1 - b.y - b.height, ty + dhf)
  }
  return { x: b.x + t * tx, y: b.y + t * ty, width: b.width + t * dwf, height: b.height + t * dhf }
}

/** Clockwise CSS rotation becomes counter-clockwise PDF rotation. A rotated
 * page has its own PDF axes. The image is drawn about its lower-left corner,
 * so recompute that corner from the fixed centre at the final orientation. */
export function centredPdfImage(
  box: {
    x: number
    y: number
    width: number
    height: number
    drawWidth: number
    drawHeight: number
    drawRotation: number
  },
  clockwise = 0,
) {
  const rotation = box.drawRotation - clockwise,
    a = radians(rotation),
    w = box.drawWidth,
    h = box.drawHeight
  return {
    x: box.x + box.width / 2 - (w * Math.cos(a) - h * Math.sin(a)) / 2,
    y: box.y + box.height / 2 - (w * Math.sin(a) + h * Math.cos(a)) / 2,
    width: w,
    height: h,
    rotation,
  }
}

/** During pointer capture Windows otherwise picks a cursor from whatever is
 * currently under the mouse. Restore the exact previous override on teardown. */
export function holdObjectCursor(cursor:string){
  const root=document.documentElement,prior=root.style.getPropertyValue('--captured-object-cursor'),flag=root.hasAttribute('data-object-capture')
  root.style.setProperty('--captured-object-cursor',cursor);root.setAttribute('data-object-capture','')
  return ()=>{if(prior)root.style.setProperty('--captured-object-cursor',prior);else root.style.removeProperty('--captured-object-cursor');if(!flag)root.removeAttribute('data-object-capture')}
}
