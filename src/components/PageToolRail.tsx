import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** The object rotates, its controls do not. Keep controls inside the visible
 * sheet/pane (including a split pane) and hide them when their object leaves. */
export function PageToolRail({
  anchor,
  geometry, owner, followMove,
  label,
  className,
  children,
}: {
  anchor: RefObject<HTMLDivElement>
  geometry: string
  owner?: string
  /** Called immediately after this anchor's compositor translation is painted. */
  followMove?: { current: (() => void) | undefined }
  label: string
  className: string
  children: ReactNode
}) {
  const [page, setPage] = useState<HTMLElement | null>(null),
    bar = useRef<HTMLDivElement>(null)
  const reposition = useRef<() => void>()
  useLayoutEffect(() => {
    const bind=()=>setPage(anchor.current?.closest<HTMLElement>('.pdf-page') ?? null)
    if(anchor.current){bind();return}
    const frame=requestAnimationFrame(bind);return()=>cancelAnimationFrame(frame)
  }, [anchor])
  useLayoutEffect(() => {
    const object = anchor.current,
      el = bar.current,
      pane = page?.closest('.split-pane__body') ?? page?.closest('.stage')
    if (!page || !object || !el || !pane) return
    const place = () => {
      const measured = object.getBoundingClientRect(), p = page.getBoundingClientRect(), v = pane.getBoundingClientRect()
      // WebView2 can report the previous composited rectangle on drop or Esc.
      // The layout centre plus the live displacement is authoritative for both
      // annotations and the watermark proxy; rotation changes only the extents.
      let dx=0, dy=0
      const layer=object.offsetParent
      if(layer instanceof HTMLElement && layer.matches('.annotation-layer,.watermark-ui-layer')) {
        const translate = layer.classList.contains('watermark-ui-layer') ? page.style.getPropertyValue('--wm-offset') : object.style.translate
        const parent=layer.getBoundingClientRect(), [tx,ty]=translate.split(' ').map(parseFloat)
        dx=parent.left+object.offsetLeft+object.offsetWidth/2+(tx||0)-(measured.left+measured.width/2)
        dy=parent.top+object.offsetTop+object.offsetHeight/2+(ty||0)-(measured.top+measured.height/2)
      }
      const a=new DOMRect(measured.left+dx,measured.top+dy,measured.width,measured.height)
      const room=Math.max(1,Math.min(innerWidth,v.width)-8)+'px'
      if(el.style.maxWidth!==room)el.style.maxWidth=room
      const w=el.offsetWidth, h=el.offsetHeight
      const l = Math.max(3, v.left + 4),
        r = Math.min(innerWidth - 3, v.right - 4),
        top = Math.max(3, v.top + 4),
        bottom = Math.min(innerHeight - 3, v.bottom - 4)
      if (a.bottom < top || a.top > bottom || a.right < l || a.left > r) { el.style.visibility = 'hidden'; return }
      const left=Math.max(l,Math.min(r-w,a.left+(a.width-w)/2))
      // A toolbar below a narrow or rotated box can otherwise cover its outer
      // rotation targets. Reserve the real hit rectangles at the chosen x.
      const zones=[...object.querySelectorAll('[data-rotate-zone]')].map(z=>z.getBoundingClientRect()).filter(z=>z.right+dx>left-3&&z.left+dx<left+w+3)
      const below=Math.max(a.bottom+9,...zones.map(z=>z.bottom+dy+4)), above=Math.min(a.top-9,...zones.map(z=>z.top+dy-4))-h
      const y=below+h<=bottom?below:above>=top?above:Math.max(top,Math.min(bottom-h,below))
      el.style.left=`${left-p.left-page.clientLeft}px`;el.style.top=`${y-p.top-page.clientTop}px`
      el.style.visibility = 'visible'
    }
    reposition.current = place
    if (followMove) followMove.current = place
    place()
    let frame = 0
    const queue = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          place()
        })
    }
    const ro = new ResizeObserver(queue)
    ;[el, object, page, pane].forEach((n) => ro.observe(n))
    window.addEventListener('scroll', queue, true)
    window.addEventListener('resize', queue)
    return () => {
      reposition.current = undefined
      if (followMove?.current === place) followMove.current = undefined
      ro.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', queue, true)
      window.removeEventListener('resize', queue)
    }
  }, [anchor, page, followMove])
  useLayoutEffect(() => {
    reposition.current?.()
    if (!followMove || anchor.current?.hasAttribute('data-move-preview')) return
    // Chromium can report the last composited translation during the React
    // commit that removes it (notably on Esc). Re-anchor once after that paint.
    const frame=requestAnimationFrame(()=>reposition.current?.())
    return ()=>cancelAnimationFrame(frame)
  }, [geometry, page, anchor, followMove])
  return page
    ? createPortal(
        <div
          ref={bar} data-editor-owner={owner} style={{ visibility: 'hidden' }}
          role="toolbar"
          aria-label={label}
          className={`object-tools ${className}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        page,
      )
    : null
}
