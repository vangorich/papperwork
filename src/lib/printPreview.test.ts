import { describe, expect, it } from 'vitest'
import { arrayMove } from '@dnd-kit/sortable'
import { PDFDocument } from 'pdf-lib'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import { composePdf, excludeFromPageRange, parsePageRanges } from './pdf'
import { orderPrintPageIndices, reconcilePrintPageOrder } from './printPreview'

describe('print preview order', () => {
  it('keeps stable page identities across reorder, queue removal and append', () => {
    const keys = ['a:0', 'a:1', 'b:0', 'b:1']
    const moved = arrayMove(keys, 3, 0)
    expect(moved).toEqual(['b:1', 'a:0', 'a:1', 'b:0'])
    expect(reconcilePrintPageOrder(moved, ['b:0', 'b:1', 'c:0']))
      .toEqual(['b:1', 'b:0', 'c:0'])
    expect(reconcilePrintPageOrder(['a:0', 'a:0'], keys)).toEqual(keys)
    expect(reconcilePrintPageOrder(moved, [])).toEqual([])
  })

  it('applies source-number ranges, exclusions and subsets before reorder, then reverse before n-up', () => {
    const order = [5, 3, 1, 4, 0, 2]
    const range = excludeFromPageRange('1-6', 6, [3])
    const even = parsePageRanges(range, 6).filter((index) => (index + 1) % 2 === 0)
    const picked = orderPrintPageIndices(even, order, 6)
    expect(picked).toEqual([5, 1])
    expect(picked.reverse()).toEqual([1, 5])
    expect(order).toEqual([5, 3, 1, 4, 0, 2])
    // The composed/rasterized page stream reaches the driver in this order;
    // n-up consumes consecutive pages, never the original source indices.
    const all = orderPrintPageIndices([0, 1, 2, 3, 4, 5], order, 6).reverse()
    const sheets = Array.from({ length: Math.ceil(all.length / 2) }, (_, index) => all.slice(index * 2, index * 2 + 2))
    expect(sheets).toEqual([[2, 0], [4, 1], [3, 5]])
    expect(orderPrintPageIndices([], order, 6)).toEqual([])
  })

  it('composes actual PDF pages in preview order before rasterization and driver n-up', async () => {
    const input = await PDFDocument.create()
    const widths = [100, 200, 300, 400]
    widths.forEach((width) => input.addPage([width, 500]))
    const source: PdfSource = {
      id: 'source', name: 'print.pdf', bytes: await input.save(), pageCount: 4,
      pageText: widths.map(() => ''), pageSizes: widths.map((width) => ({ width, height: 500 })), textIndexed: true,
    }
    const pages: WorkspacePage[] = widths.map((_, index) => ({
      id: `page-${index}`, sourceId: source.id, sourcePage: index, rotation: 0, annotations: [],
    }))
    const picked = orderPrintPageIndices([0, 2, 3], [3, 1, 0, 2], pages.length)
    const output = await PDFDocument.load(await composePdf(picked.map((index) => pages[index]), [source]))
    expect(output.getPages().map((page) => page.getWidth())).toEqual([400, 100, 300])
  })

  it('retains legacy jobs and rejects stale, duplicate and invalid permutations', () => {
    expect(orderPrintPageIndices([2, 0], undefined, 3)).toEqual([2, 0])
    expect(orderPrintPageIndices([], [], 0)).toEqual([])
    for (const order of [[0, 1], [0, 0, 2], [0, 1, 3], [-1, 1, 2], [0, 1, 1.5], [0, 1, NaN]]) {
      expect(() => orderPrintPageIndices([0, 1, 2], order, 3)).toThrow('打印页面顺序已失效')
    }
  })
})
