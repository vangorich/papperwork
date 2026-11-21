import type { OcrTable, OcrWord } from '../types/pdf'
import { ocrTableSelectionClipboard, reconstructOcrTables } from './ocr'

export interface TextLayerRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/**
 * DOM Range order alone can include an adjacent absolutely-positioned line.
 * Require visible vertical and area overlap, while zero-layout environments
 * (such as jsdom) deliberately fall back to the DOM Range result.
 */
export function textLayerRectsOverlap(span: TextLayerRect, selectionRects: readonly TextLayerRect[]) {
  const visibleSelections = selectionRects.filter((rect) => rect.width > 0 && rect.height > 0)
  if (span.width <= 0 || span.height <= 0 || !visibleSelections.length) return true
  return visibleSelections.some((selection) => {
    const horizontal = Math.max(0, Math.min(span.right, selection.right) - Math.max(span.left, selection.left))
    const vertical = Math.max(0, Math.min(span.bottom, selection.bottom) - Math.max(span.top, selection.top))
    const verticalMinimum = Math.max(0.5, Math.min(span.height, selection.height) * 0.3)
    const area = horizontal * vertical
    const areaMinimum = Math.min(1, Math.min(span.width * span.height, selection.width * selection.height) * 0.02)
    return vertical >= verticalMinimum && area >= areaMinimum
  })
}

export type TextLayerRange = Pick<Range, 'intersectsNode'> & Partial<Pick<Range, 'getClientRects'>>

/** Shared hit-test for table copy, text highlighting, and native-text editing. */
export function rangeVisuallyIntersectsSpan(
  range: TextLayerRange,
  span: HTMLSpanElement,
  selectionRects = Array.from(range.getClientRects?.() ?? []),
) {
  try {
    if (!range.intersectsNode(span)) return false
  } catch {
    return false
  }
  return textLayerRectsOverlap(span.getBoundingClientRect(), selectionRects)
}

export function rangeSelectedSpans(spans: Iterable<HTMLSpanElement>, range: TextLayerRange) {
  const selectionRects = Array.from(range.getClientRects?.() ?? [])
  return Array.from(spans).filter((span) => rangeVisuallyIntersectsSpan(range, span, selectionRects))
}

/** A selection must start and end in the same page text layer. */
export function selectionBelongsToTextLayer(selection: Selection | null, layer: HTMLElement | null) {
  if (!selection || selection.isCollapsed || !selection.rangeCount || !layer) return false
  const range = selection.getRangeAt(0)
  return layer.contains(range.startContainer) && layer.contains(range.endContainer)
}

/** Resolve intersecting OCR spans to their source-word indexes and table payload. */
export function ocrTableClipboardForRange(
  tables: readonly OcrTable[],
  spans: Iterable<HTMLSpanElement>,
  range: TextLayerRange,
) {
  const indexes: number[] = []
  for (const span of rangeSelectedSpans(spans, range)) {
    const index = Number(span.dataset.tableWordIndex ?? span.dataset.ocrIndex)
    if (Number.isInteger(index)) indexes.push(index)
  }
  return ocrTableSelectionClipboard(tables, indexes)
}

const median = (values: number[]) => {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered.length ? ordered[Math.floor(ordered.length / 2)] : 0
}

/**
 * Native PDF text has no table semantics. Accept only dense, repeated grids;
 * two-column layouts additionally need compact cells or numeric table values.
 */
export function reconstructNativeTextLayerTables(words: OcrWord[]) {
  return reconstructOcrTables(words).filter((table) => {
    if (!table.cells || table.rows.length < 2 || table.columnCount < 2) return false
    const cells = table.cells.flat()
    const occupied = cells.filter((cell) => cell.wordIndexes.length > 0)
    if (occupied.length / cells.length < 0.8) return false
    if (table.columnCount >= 3) return true
    const values = occupied.map((cell) => cell.text.trim()).filter(Boolean)
    const numeric = values.filter((value) => /(?:^|\s)[￥$€£]?[-+]?\d[\d,.]*(?:%|元|圆|万|亿)?(?:\s|$)/.test(value)).length
    return median(values.map((value) => [...value].length)) <= 32 || numeric / values.length >= 0.2
  })
}

const SEARCH_HIGHLIGHT_NAME = 'pdf-search-match'
// Ranges per page layer; one shared Highlight in the CSS registry paints them
// all. Keyed by layer element so a page can replace or drop its own matches.
const searchLayerRanges = new Map<Element, Range[]>()
let sharedSearchHighlight: Highlight | undefined

const searchHighlightSupported = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'

const rebuildSearchHighlight = () => {
  if (!sharedSearchHighlight) {
    sharedSearchHighlight = new Highlight()
    CSS.highlights.set(SEARCH_HIGHLIGHT_NAME, sharedSearchHighlight)
  }
  sharedSearchHighlight.clear()
  for (const ranges of searchLayerRanges.values()) {
    for (const range of ranges) sharedSearchHighlight.add(range)
  }
}

// Every page layer updates its own ranges; coalesce a commit's worth of
// updates into ONE registry rebuild instead of an O(total matches) clear+add
// per layer per keystroke. Passive effects for the whole commit flush before
// the microtask runs, so a typing burst rebuilds exactly once.
let searchRebuildScheduled = false
const scheduleSearchHighlightRebuild = () => {
  if (searchRebuildScheduled) return
  searchRebuildScheduled = true
  queueMicrotask(() => {
    searchRebuildScheduled = false
    rebuildSearchHighlight()
  })
}

/**
 * Search highlighting is intentionally visual; it never changes selectable
 * text. Only the keyword itself is highlighted (via the CSS Custom Highlight
 * API, which does not touch the DOM) — never the whole text run around it.
 */
export function updateTextLayerSearchMatches(
  layer: Element | null,
  spans: Iterable<HTMLSpanElement>,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase()
  if (!searchHighlightSupported()) {
    // Degraded path (unit tests / ancient Chromium): flag the whole span.
    for (const span of spans) {
      const matches = Boolean(needle && span.textContent?.toLocaleLowerCase().includes(needle))
      if (matches) span.dataset.match = 'true'
      else delete span.dataset.match
    }
    return
  }
  const ranges: Range[] = []
  if (needle) {
    for (const span of spans) {
      const doc = span.ownerDocument
      const walker = doc.createTreeWalker(span, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const haystack = node.data.toLocaleLowerCase()
        let index = haystack.indexOf(needle)
        while (index >= 0) {
          const range = doc.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + needle.length)
          ranges.push(range)
          index = haystack.indexOf(needle, index + needle.length)
        }
      }
    }
  }
  if (layer) {
    if (ranges.length) searchLayerRanges.set(layer, ranges)
    else searchLayerRanges.delete(layer)
    scheduleSearchHighlightRebuild()
  }
}

/** Drops a page layer's matches when that layer unmounts or re-renders. */
export function clearTextLayerSearchMatches(layer: Element | null) {
  if (!layer || !searchHighlightSupported()) return
  if (searchLayerRanges.delete(layer)) scheduleSearchHighlightRebuild()
}
