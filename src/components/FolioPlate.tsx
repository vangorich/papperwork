import { useLayoutEffect, useRef } from 'react'
import folioPrint from '../assets/folded-folios.webp'
import type { FolioRelief } from './folioRelief'

type HoverEvent = MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null }

export function FolioPlate({ enabled }: { enabled: boolean }) {
  const surface = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null)

  useLayoutEffect(() => {
    const host = surface.current, print = image.current, desk = host?.closest<HTMLElement>('.document-desk')
    if (!enabled || !host || !print || !desk) return
    const canMove = () => !document.hidden
    let tryWebGL = Boolean(window.WebGL2RenderingContext)
    let generation = 0, frame = 0, lastPaint = 0, lastTouch = -Infinity
    let clientX = NaN, clientY = NaN, x = 0, y = 0, nx = 0, ny = 0, scene: FolioRelief | undefined

    const reset = () => {
      ++generation
      cancelAnimationFrame(frame)
      frame = 0
      scene?.dispose()
      scene = undefined
      clientX = clientY = NaN
      x = y = nx = ny = 0
      host.style.removeProperty('--folio-x')
      host.style.removeProperty('--folio-y')
      delete host.dataset.tracking
    }
    const paint = (now: number) => {
      frame = 0
      // Ease by elapsed time: at 8 Hz a single update should travel, not inch along for 20 frames.
      const blend = 1 - Math.exp(-Math.max(1, now - lastPaint) / 36)
      lastPaint = now
      x += (nx - x) * blend
      y += (ny - y) * blend
      if (Math.abs(nx - x) + Math.abs(ny - y) < 0.002) { x = nx; y = ny }
      host.style.setProperty('--folio-x', x.toFixed(4))
      host.style.setProperty('--folio-y', y.toFixed(4))
      scene?.tilt(x, y)
      if (x !== nx || y !== ny) frame = requestAnimationFrame(paint)
    }
    const move = (e: HoverEvent) => {
      if (e.buttons || e.sourceCapabilities?.firesTouchEvents || !canMove()) return
      // Chromium usually sends both pointermove and mousemove for the same physical move.
      if (e.clientX === clientX && e.clientY === clientY) return
      const r = host.getBoundingClientRect()
      if (!r.width || !r.height) return
      clientX = e.clientX; clientY = e.clientY
      nx = Math.max(-1, Math.min(1, (2 * (clientX - r.left)) / r.width - 1))
      ny = Math.max(-1, Math.min(1, (2 * (clientY - r.top)) / r.height - 1))
      if (!host.dataset.tracking) {
        host.dataset.tracking = 'true'
        const ticket = ++generation
        if (tryWebGL) void Promise.all([import('./folioRelief'), print.decode()])
          .then(([{ mountFolioRelief }]) => {
            if (ticket !== generation || !canMove()) return
            scene = mountFolioRelief(host, print, () => { tryWebGL = false; scene = undefined })
            tryWebGL = Boolean(scene)
            scene?.tilt(x, y)
          })
          .catch(() => { if (ticket === generation) tryWebGL = false })
      }
      if (!frame && (nx !== x || ny !== y)) {
        lastPaint = performance.now()
        frame = requestAnimationFrame(paint)
      }
    }
    const pointer = (e: PointerEvent) => {
      // isPrimary is per device type, not a hover capability. Some virtual mice have no type.
      const pointing = e.pointerType === 'mouse' || e.pointerType === 'pen'
      const unclassifiedHover = !e.pointerType && (e.width ?? 1) <= 1 && (e.height ?? 1) <= 1
      if (!e.pressure && (pointing || unclassifiedHover)) move(e)
    }
    const touch = () => { lastTouch = performance.now() }
    const mouse = (e: HoverEvent) => {
      if (!e.sourceCapabilities && performance.now() - lastTouch < 800) return // unlabelled compatibility event after a tap
      move(e)
    }
    const reconsider = () => { if (!canMove()) reset() }
    const listeners = new AbortController(), options = { passive: true, signal: listeners.signal }
    desk.addEventListener('pointermove', pointer, options)
    desk.addEventListener('mousemove', mouse, options)
    desk.addEventListener('touchstart', touch, options)
    desk.addEventListener('touchend', touch, options)
    desk.addEventListener('pointerleave', reset, options)
    desk.addEventListener('mouseleave', reset, options)
    desk.addEventListener('pointercancel', reset, options)
    window.addEventListener('blur', reset, options)
    window.addEventListener('beforeprint', reset, options)
    document.addEventListener('visibilitychange', reconsider, options)
    return () => { listeners.abort(); reset() }
  }, [enabled])

  return (
    <figure className="folio-plate">
      <div className="folio-plate__surface" ref={surface} aria-hidden="true">
        <img ref={image} src={folioPrint} alt="" width="1008" height="672" draggable={false} />
        <span className="folio-plate__corners" />
      </div>
      <figcaption>纸样 · 折页<span className="folio-plate__inks" aria-hidden="true"><i /><i /><i /></span></figcaption>
    </figure>
  )
}
