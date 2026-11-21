import { describe, expect, it } from 'vitest'
import type { OcrTable } from '../types/pdf'
import { ocrTableClipboardForRange, rangeSelectedSpans, reconstructNativeTextLayerTables, textLayerRectsOverlap, updateTextLayerSearchMatches } from './textLayerSelection'

describe('text layer selection helpers', () => {
  it('keeps a rectangular OCR table selection for Excel paste', () => {
    const table: OcrTable = {
      id: 'table', source: 'geometry', confidence: 1, columnCount: 2,
      rows: [['A1', 'B1'], ['A2', 'B2']],
      cells: [
        [{ text: 'A1', wordIndexes: [0] }, { text: 'B1', wordIndexes: [1] }],
        [{ text: 'A2', wordIndexes: [2] }, { text: 'B2', wordIndexes: [3] }],
      ],
    }
    const zeroRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    const spans = [0, 1, 2, 3].map((index) => ({
      dataset: { ocrIndex: String(index) },
      getBoundingClientRect: () => zeroRect,
    })) as unknown as HTMLSpanElement[]
    const range = { intersectsNode: (node: Node) => spans.indexOf(node as HTMLSpanElement) % 2 === 1 }
    const payload = ocrTableClipboardForRange([table], spans, range)
    expect(payload?.tsv).toBe('B1\nB2')
    expect(payload?.html).toContain('<td>B2</td>')
  })

  it('filters a DOM-intersecting neighboring line by visible geometry', () => {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height,
    })
    expect(textLayerRectsOverlap(rect(10, 30, 80, 12), [rect(8, 10, 90, 12)])).toBe(false)
    expect(textLayerRectsOverlap(rect(10, 20, 80, 12), [rect(8, 10, 90, 12)])).toBe(false)
    expect(textLayerRectsOverlap(rect(10, 12, 80, 12), [rect(8, 10, 90, 12)])).toBe(true)
    expect(textLayerRectsOverlap(rect(0, 0, 0, 0), [])).toBe(true)
    const spans = [rect(10, 10, 80, 12), rect(10, 30, 80, 12)].map((bounds) => ({
      getBoundingClientRect: () => bounds,
    })) as unknown as HTMLSpanElement[]
    const range = {
      intersectsNode: () => true,
      getClientRects: () => [rect(8, 10, 90, 12)] as unknown as DOMRectList,
    }
    expect(rangeSelectedSpans(spans, range)).toEqual([spans[0]])
  })

  it('recognizes a dense native grid but rejects long two-column body text', () => {
    const word = (text: string, x: number, y: number) => ({ text, x, y, width: 0.12, height: 0.03, confidence: 1 })
    expect(reconstructNativeTextLayerTables([
      word('项目', 0.1, 0.1), word('金额', 0.5, 0.1),
      word('服务费', 0.1, 0.15), word('120.00', 0.5, 0.15),
    ])).toHaveLength(1)
    expect(reconstructNativeTextLayerTables([
      word('这是很长的正文段落，虽然页面恰好采用了左右双栏排版，但它并不是一张表格，不应当被重排为单元格内容。', 0.1, 0.1),
      word('这是另一栏很长的正文段落，同样只属于普通阅读内容，复制时应保留阅读器原生的文字顺序。', 0.5, 0.1),
      word('第二行仍然是连续的正文说明，其中包含更多描述性文字，以确保长度明显超过表格单元格。', 0.1, 0.15),
      word('右侧第二行也只是正文而不是字段值，因此不应触发表格剪贴板格式。', 0.5, 0.15),
    ])).toHaveLength(0)
  })

  it('updates search marks without changing text', () => {
    // Node has no CSS Custom Highlight API, so the degraded span-flag path runs.
    const span = { textContent: 'Invoice total', dataset: {} as DOMStringMap }
    updateTextLayerSearchMatches(null, [span as HTMLSpanElement], 'TOTAL')
    expect(span.dataset.match).toBe('true')
    expect(span.textContent).toBe('Invoice total')
    updateTextLayerSearchMatches(null, [span as HTMLSpanElement], '')
    expect(span.dataset.match).toBeUndefined()
  })
})
