/**
 * Module-level shared observers: one IntersectionObserver per rootMargin
 * config and one ResizeObserver total, dispatching entries through element
 * maps. Per-page observer construction scaled to ~2400 live instances on a
 * 500-page document; registration is now a Map insert per page.
 */
type IntersectionCallback = (entry: IntersectionObserverEntry) => void

const intersectionPools = new Map<string, {
  observer: IntersectionObserver
  callbacks: Map<Element, IntersectionCallback>
}>()

/** Observe viewport intersection with a shared observer. Returns the unsubscribe. */
export function observeSharedIntersection(
  element: Element,
  callback: IntersectionCallback,
  rootMargin = '',
): () => void {
  let pool = intersectionPools.get(rootMargin)
  if (!pool) {
    const callbacks = new Map<Element, IntersectionCallback>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry)
    }, { rootMargin })
    pool = { observer, callbacks }
    intersectionPools.set(rootMargin, pool)
  }
  pool.callbacks.set(element, callback)
  pool.observer.observe(element)
  return () => {
    pool.callbacks.delete(element)
    pool.observer.unobserve(element)
  }
}

type ResizeCallback = (entry: ResizeObserverEntry) => void

const resizeCallbacks = new Map<Element, ResizeCallback>()
let sharedResizeObserver: ResizeObserver | undefined

/** Observe element resizes with the shared ResizeObserver. Returns the unsubscribe. */
export function observeSharedResize(element: Element, callback: ResizeCallback): () => void {
  sharedResizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) resizeCallbacks.get(entry.target)?.(entry)
  })
  resizeCallbacks.set(element, callback)
  sharedResizeObserver.observe(element)
  return () => {
    resizeCallbacks.delete(element)
    sharedResizeObserver!.unobserve(element)
  }
}
