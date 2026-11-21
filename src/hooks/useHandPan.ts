import { useEffect, type RefObject } from 'react'

import {frameSampler} from '../lib/gesturePreview'

/** The hand tool moves only the document scroller. Native touch scrolling and
 * interactive controls retain their gestures; switching tools ends any drag. */
export function useHandPan(ref: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const stage = ref.current
    if (!stage || !enabled) return
    let start: { id: number; x: number; y: number; left: number; top: number; scroller: HTMLElement } | undefined
    const sample=frameSampler<{x:number;y:number}>(({x,y})=>{if(start)start.scroller.scrollTo({left:start.left+start.x-x,top:start.top+start.y-y,behavior:'instant'})})
    const end = () => {
      sample.cancel()
      const id = start?.id; start = undefined
      delete stage.dataset.panning
      if (id !== undefined && stage.hasPointerCapture(id)) stage.releasePointerCapture(id)
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || !e.isPrimary || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (!(e.target instanceof Element) || e.target.closest('button, input, textarea, select, a, [contenteditable=true], [role=button], .annotation, .watermark-ui-layer, .search-popover')) return
      if (!e.target.closest('.stage-page') && e.target !== stage) return
      const scroller = e.target.closest<HTMLElement>('.split-pane__body') ?? stage
      start = {id:e.pointerId, x:e.clientX, y:e.clientY, left:scroller.scrollLeft, top:scroller.scrollTop, scroller}
      e.preventDefault(); e.stopPropagation(); stage.setPointerCapture(e.pointerId);stage.dataset.panning = 'true'
    }
    const move = (e: PointerEvent) => {
      if (!start || start.id !== e.pointerId) return
      if (!(e.buttons & 1)) { end(); return }
      sample.push({x:e.clientX,y:e.clientY})
    }
    const up = (e: PointerEvent) => { if (start && e.pointerId===start.id){if(e.type==='pointerup')start.scroller.scrollTo({left:start.left+start.x-e.clientX,top:start.top+start.y-e.clientY,behavior:'instant'});end()} }
    stage.addEventListener('pointerdown',down,true); stage.addEventListener('pointermove',move)
    for (const event of ['pointerup','pointercancel','lostpointercapture'] as const) stage.addEventListener(event,up)
    window.addEventListener('blur',end)
    return () => {
      stage.removeEventListener('pointerdown',down,true); stage.removeEventListener('pointermove',move)
      for (const event of ['pointerup','pointercancel','lostpointercapture'] as const) stage.removeEventListener(event,up)
      window.removeEventListener('blur',end);end()
    }
  }, [ref,enabled])
}
