import type { PointerEvent as ReactPointerEvent } from 'react'

/** Quick travel on text belongs to the browser. On an image it can start a direct drag. */
export const OBJECT_HOLD_MS = 205
const HOLD_SLOP = 4 // CSS px, independent of PDF zoom / display DPR
export function armObjectHold(e: ReactPointerEvent, activate: (point: { x: number; y: number }) => void,
  directDrag?: (firstMove: PointerEvent) => void) {
  if (e.pointerType !== 'mouse' || !e.isPrimary || e.button !== 0 || e.detail > 1 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return () => {}
  const {pointerId, clientX, clientY} = e, target=e.target as Element
  const field=target.closest('textarea'), owner=target.closest<HTMLElement>('.annotation')
  if (!owner || field?.hasAttribute('data-composing')) return () => {}
  const initialStart=field?.selectionStart, initialEnd=field?.selectionEnd
  owner.dataset.holdPending='true'
  let x=clientX, y=clientY
  const stop=()=>{
    delete owner.dataset.holdPending;clearTimeout(timer)
    window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',end,true)
    window.removeEventListener('pointercancel',end,true);window.removeEventListener('blur',stop)
    window.removeEventListener('keydown',key,true);owner.removeEventListener('dragstart',stop);owner.removeEventListener('compositionstart',stop)
  }
  const move=(v:PointerEvent)=>{
    if(v.pointerId!==pointerId)return
    x=v.clientX;y=v.clientY
    if(!(v.buttons&1)||v.ctrlKey||v.shiftKey||v.altKey||v.metaKey){stop();return}
    if(Math.hypot(x-clientX,y-clientY)>HOLD_SLOP){stop();directDrag?.(v)}
  }
  const end=(v:PointerEvent)=>{if(v.pointerId===pointerId)stop()}
  const key=(v:KeyboardEvent)=>{if(['Escape','Shift','Control','Alt','Meta'].includes(v.key))stop()}
  const timer=window.setTimeout(()=>{
    stop()
    // A slow drag over a narrow glyph (or double click) can select characters
    // before crossing the movement tolerance. Never turn that selection into a move.
    if(!owner.isConnected || field?.hasAttribute('data-composing') ||
      (field && field.selectionStart!==field.selectionEnd && (field.selectionStart!==initialStart || field.selectionEnd!==initialEnd)))return
    activate({x,y})
  },OBJECT_HOLD_MS)
  window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',end,true)
  window.addEventListener('pointercancel',end,true);window.addEventListener('blur',stop);window.addEventListener('keydown',key,true)
  owner.addEventListener('dragstart',stop);owner.addEventListener('compositionstart',stop)
  return stop
}
