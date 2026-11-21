import { describe, expect, it } from 'vitest'
import { createPreviewLoader, placeOnSheet, selectSheetPages, sheetGrid, sheetSize, validCopies, type SheetPage } from './printSheet'

const pages = [5, 2, 0, 3, 1, 4].map((sourceIndex): SheetPage => ({
  key: `doc:${sourceIndex}`, itemId: 'doc', pageIndex: sourceIndex, sourceIndex,
}))

describe('physical sheet preview', () => {
  it('uses original page numbers for range, odd/even and exclusion, then queue order and reverse', () => {
    const selected = selectSheetPages(pages, '2-6', 'even', new Set(['doc:3']), true)
    expect(selected.pages.map(p => p.sourceIndex + 1)).toEqual([2, 6])
    expect(selected.range).toBe('2-3,5-6') // submit parity and reverse separately, exactly once
    expect(selected.issue).toBeUndefined()
    expect(selectSheetPages(pages, '', 'all', new Set(), false).pages).toEqual(pages)
  })

  it('gives an actionable empty state without treating an empty range intersection as print-all', () => {
    expect(selectSheetPages([], '', 'all', new Set(), false).issue?.field).toBe('print-add-files')
    expect(selectSheetPages(pages, '7', 'all', new Set(), false).issue?.field).toBe('print-range')
    expect(selectSheetPages(pages, '1', 'even', new Set(), false).issue?.field).toBe('print-subset')
    const excluded = selectSheetPages(pages, '2', 'all', new Set(['doc:1']), false)
    expect(excluded.pages).toEqual([])
    expect(excluded.issue?.field).toBe('print-restore')
    for (const value of ['', '0', '100', '1.5', '-2']) expect(validCopies(value)).toBe(false)
    for (const value of ['1', '99']) expect(validCopies(value)).toBe(true)
  })

  it('uses explicit physical paper sizes, including ISO B5 and portrait/landscape 2- and 6-up', () => {
    for (const [paper, w, h] of [['a4', 210, 297], ['a5', 148, 210], ['b5', 176, 250]] as const) {
      expect(sheetSize(paper, false)?.widthPt).toBeCloseTo(w * 72 / 25.4)
      expect(sheetSize(paper, true)?.widthPt).toBeCloseTo(h * 72 / 25.4)
    }
    expect(sheetSize('letter', false)).toEqual({ widthPt: 612, heightPt: 792 })
    expect(sheetSize('legal', true)).toEqual({ widthPt: 1008, heightPt: 612 })
    expect(sheetSize('auto', false)).toBeUndefined()
    const wide = { widthPt: 480, heightPt: 270 }
    expect(sheetSize('auto', false, wide)).toEqual(wide)
    expect(sheetSize('auto', true, { widthPt: 270, heightPt: 480 })).toEqual(wide)
    expect(sheetGrid(2, false)).toEqual({ cols: 1, rows: 2 })
    expect(sheetGrid(6, true)).toEqual({ cols: 3, rows: 2 })
    for (const n of [1, 2, 4, 6, 9, 16]) for (const landscape of [true, false]) {
      const { rows, cols } = sheetGrid(n, landscape)
      expect(rows * cols).toBe(n)
    }
  })

  it('fits the bitmap without stretching; actual 72 pt occupies one inch regardless of cell size', () => {
    const cell = { widthPt: 200, heightPt: 100 }
    expect(placeOnSheet(cell, true, 1, 100)).toEqual({ inset: 12, width: 176, height: 76, contentWidth: 76, cropped: false })
    expect(placeOnSheet(cell, true, 1, 150)?.cropped).toBe(true)
    expect(placeOnSheet(cell, false, 2, 100)?.contentWidth).toBe(200)
    expect(placeOnSheet(cell, true, 3, 100, 72)?.contentWidth).toBe(72)
    expect(placeOnSheet(cell, true, 3, 50, 72)?.contentWidth).toBe(36)
    expect(placeOnSheet(cell, true, 1, 100, 100)?.cropped).toBe(true)
    expect(placeOnSheet({ widthPt: 20, heightPt: 40 }, true, 1, 100)).toBeUndefined()
  })

  it('shares one bounded, serial loader: skips stale requests and reuses higher resolution without size I/O in fit', async () => {
    let busy = 0, peak = 0, measured = 0
    const renders: number[] = []
    const load = createPreviewLoader(async (_, idx, width) => {
      renders.push(idx); peak = Math.max(peak, ++busy)
      await Promise.resolve(); busy--
      return `${idx}@${width}`
    }, async () => { measured++; return { widthPt: 123, heightPt: 456 } })
    const active = () => true
    const [one, skip, two] = await Promise.all([load(pages[0], 320, false, active), load(pages[1], 320, true, () => false), load(pages[2], 144, false, active)])
    expect([one?.url, skip, two?.url]).toEqual(['5@320', undefined, '0@144'])
    expect([peak, measured]).toEqual([1, 0])
    expect((await load(pages[0], 144, true, active))?.size?.widthPt).toBe(123)
    await load(pages[0], 144, true, active)
    expect([renders, measured]).toEqual([[5, 0], 1])
    for (let i = 10; i < 44; i++) await load({ key: String(i), itemId: 'doc', pageIndex: i }, 144, false, active)
    await load(pages[0], 144, false, active)
    expect(renders.at(-1)).toBe(5) // evicted, not all pages retained after a long scroll
  })
})
