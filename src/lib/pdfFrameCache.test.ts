import { describe, expect, it } from 'vitest'
import { pageFrames, pdfFrameOwner, PdfFrameCache, releasePdfFrames, thumbnailFrames } from './pdfFrameCache'
import type { PdfSource } from '../types/pdf'

// Cache only needs a backing-store width/height. Counters prove the owned
// surface was released, which checking Map membership alone wouldn't detect.
const canvas = (width: number, height: number) => ({ width, height }) as HTMLCanvasElement
const source = (): PdfSource => ({ id: crypto.randomUUID(), name: 'fixture.pdf', bytes: new Uint8Array(), pageCount: 1, pageSizes: [], pageText: [], textIndexed: false })

describe('completed PDF frame cache', () => {
  it('keeps multiple resolutions, promotes reads, and evicts by allocated bytes', () => {
    const cache = new PdfFrameCache(500, 10), owner = { live: true }
    const fit = canvas(10, 10), small = canvas(5, 5), other = canvas(5, 5)
    cache.put(owner, 'p1-fit', fit); cache.put(owner, 'p1-small', small)
    expect(cache.get(owner, 'p1-fit')).toBe(fit)
    cache.put(owner, 'p2', other)
    expect(cache.get(owner, 'p1-small')).toBeUndefined()
    expect(small.width).toBe(0)
    expect(cache.get(owner, 'p1-fit')).toBe(fit)
  })

  it('protects recently seen frames from prewarm but never exceeds byte or count limits', () => {
    const cache = new PdfFrameCache(800, 2), owner = { live: true }
    const a = canvas(10, 10), b = canvas(10, 10), warm = canvas(2, 2)
    cache.put(owner, 'a', a, true); cache.put(owner, 'b', b, true); cache.put(owner, 'warm', warm)
    expect(warm.width).toBe(0)
    cache.put(owner, 'a', canvas(12, 12), true)
    expect(b.width).toBe(0) // even protected entries yield to the hard budget
    expect(a.width).toBe(0) // overwritten bytes also released
    const huge = canvas(20, 20); cache.put(owner, 'poster', huge, true)
    expect(huge.width).toBe(0); expect(cache.get(owner, 'a')?.width).toBe(12)
  })

  it('closing one source frees both pools and rejects late writes, including after undo', () => {
    const first = source(), other = source(), old = pdfFrameOwner(first), live = pdfFrameOwner(other)
    const page = canvas(2, 3), thumb = canvas(2, 1), retained = canvas(3, 3)
    pageFrames.put(old, 'first', page, true); thumbnailFrames.put(old, 'small', thumb)
    pageFrames.put(live, 'other', retained)
    releasePdfFrames(first)
    expect([page.width, thumb.width]).toEqual([0, 0]); expect(pageFrames.get(live, 'other')).toBe(retained)
    const fresh = pdfFrameOwner(first), replacement = canvas(2, 3)
    pageFrames.put(fresh, 'first', replacement)
    const stale = canvas(5, 3); pageFrames.put(old, 'first', stale)
    expect(stale.width).toBe(0); expect(pageFrames.get(fresh, 'first')).toBe(replacement)
    releasePdfFrames(first); releasePdfFrames(other)
  })
})
