import type { Box } from './objectTransform'

type Sample = Pick<PointerEvent, 'clientX' | 'clientY' | 'shiftKey'>
/** At high pointer polling rates paint only the newest sample. An up event
 * always supplies the final position, even before a queued frame executes. */
export function frameSampler<T>(paint: (v: T) => void) {
  let frame = 0,
    latest: T
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }
  return {
    push(value: T) {
      latest = value
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          paint(latest)
        })
    },
    cancel,
  }
}

/** Translation is independent of CSS rotate(). Move the compositor layer, not
 * React state or layout; write normalized geometry once on release. */
export function objectMovePreview(
  el: HTMLElement,
  initial: Box,
  page: { width: number; height: number },
  start: { x: number; y: number },
  positionRail?: () => void,
) {
  const host = el.closest<HTMLElement>('.split-pane__body,.stage'),
    sx = host?.scrollLeft ?? 0,
    sy = host?.scrollTop ?? 0
  let last = { x: start.x, y: start.y }
  const before = el.style.translate
  const position = () => ({
    ...initial,
    x: Math.max(
      0,
      Math.min(
        1 - initial.width,
        initial.x + (last.x - start.x + (host?.scrollLeft ?? 0) - sx) / page.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1 - initial.height,
        initial.y + (last.y - start.y + (host?.scrollTop ?? 0) - sy) / page.height,
      ),
    ),
  })
  const frame = frameSampler<void>(() => {
    const b = position()
    el.style.translate = `${(b.x - initial.x) * page.width}px ${(b.y - initial.y) * page.height}px`
    positionRail?.()
  })
  const refresh = () => frame.push()
  host?.addEventListener('scroll', refresh, { passive: true })
  el.dataset.movePreview = 'true'
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    frame.cancel()
    host?.removeEventListener('scroll', refresh)
    delete el.dataset.movePreview
    el.style.translate = before
    positionRail?.()
  }
  return {
    move(e: Sample) {
      last = { x: e.clientX, y: e.clientY }
      refresh()
    },
    finish(e: Sample) {
      last = { x: e.clientX, y: e.clientY }
      const current = position()
      const b =
        Math.hypot((current.x - initial.x) * page.width, (current.y - initial.y) * page.height) < 2
          ? initial
          : current
      el.style.left = `${b.x * 100}%`
      el.style.top = `${b.y * 100}%`
      dispose()
      return b
    },
    dispose,
  }
}
