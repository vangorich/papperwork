import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { WorkspacePage } from '../types/pdf'

const useMeasuredEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** PDF pages vary in aspect and rotate. Measure actual rows, including the paste
 * hint; estimates affect the scrollbar before measurement, never card layout. */
export function ThumbnailWindow({ pages, activeId, dragId, container, children }: {
  pages: WorkspacePage[]; activeId?: string; dragId?: string; container: RefObject<HTMLDivElement>
  children: (page: WorkspacePage) => ReactNode
}) {
  const enabled = pages.length > 64
  const [focused, setFocused] = useState<string>()
  const positions = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages])
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range)
    // An input/drag handle must not unmount while keyboard focus or a pointer
    // drag belongs to it, even if the user scrolls to a distant drop target.
    for (const id of [focused, dragId]) {
      const i = id && positions.get(id)
      if (typeof i === 'number' && !indexes.includes(i)) indexes.push(i)
    }
    return indexes.sort((a, b) => a - b)
  }, [positions, focused, dragId])
  const key = useCallback((i: number) => pages[i].id, [pages])
  const v = useVirtualizer({ count: pages.length, getScrollElement: () => container.current,
    estimateSize: () => 246, overscan: 3, getItemKey: key, rangeExtractor, enabled,
    initialRect: { width: 240, height: 720 }, useAnimationFrameWithResizeObserver: true })
  const active = activeId ? positions.get(activeId) : undefined
  // Follow a page change, not a sidebar scroll or render. Wheel, touch and
  // scrollbar users can inspect other thumbnails without a snap-back.
  const pauseUntil = useRef(0)
  const wasDragging = useRef(false)
  useMeasuredEffect(() => {
    const list = container.current
    if (!list) return
    const pause = () => { pauseUntil.current = performance.now() + 450 }
    list.addEventListener('wheel', pause, { passive: true }); list.addEventListener('touchmove', pause, { passive: true })
    return () => { list.removeEventListener('wheel', pause); list.removeEventListener('touchmove', pause) }
  }, [container])
  useMeasuredEffect(() => {
    const list = container.current
    if(dragId){wasDragging.current=true;return}
    if(wasDragging.current){wasDragging.current=false;return}
    if (!list || active == null || !activeId || performance.now() < pauseUntil.current) return
    let frame = 0, stopped = false
    const align = () => {
      if (stopped || performance.now() < pauseUntil.current) return
      const row = list.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(activeId)}"]`)
      if (!row) { if (enabled) v.scrollToIndex(active, { align: 'auto' }); return }
      const box = row.getBoundingClientRect(), view = list.getBoundingClientRect()
      const delta = box.top < view.top || box.height > list.clientHeight ? box.top - view.top : Math.max(0, box.bottom - view.bottom)
      if (Math.abs(delta) > 1) list.scrollBy({ top: delta, behavior: 'instant' })
    }
    // Placeholder ratios change as PDFs paint. Only correct the current jump's
    // measured rows; the first direct interaction ends the follow permanently.
    const settle = () => { cancelAnimationFrame(frame);frame=requestAnimationFrame(align) }
    const observer = new ResizeObserver(settle)
    observer.observe(list); for (const r of list.querySelectorAll('.thumbnail')) observer.observe(r)
    const stop = () => { stopped=true; observer.disconnect(); cancelAnimationFrame(frame) }
    for (const type of ['pointerdown','wheel','touchmove']) list.addEventListener(type,stop,{passive:true})
    align(); settle(); const timer=window.setTimeout(stop,850)
    return () => {stop();clearTimeout(timer);for(const type of ['pointerdown','wheel','touchmove'])list.removeEventListener(type,stop)}
  }, [active, activeId, container, dragId, enabled, v])
  if (!enabled) return <>{pages.map(p => <Fragment key={p.id}>{children(p)}</Fragment>)}</>
  return <div data-thumbnail-window style={{ position: 'relative', height: v.getTotalSize(), overflowAnchor: 'none' }}
    onFocusCapture={e => setFocused((e.target as HTMLElement).closest<HTMLElement>('[data-page-id]')?.dataset.pageId)}
    onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(undefined) }}>
    {v.getVirtualItems().map(row => <div key={pages[row.index].id} data-index={row.index} ref={v.measureElement}
      style={{ position: 'absolute', insetInline: 0, top: 0, display: 'flow-root', transform: `translateY(${row.start}px)` }}>
      {children(pages[row.index])}
    </div>)}
  </div>
}
