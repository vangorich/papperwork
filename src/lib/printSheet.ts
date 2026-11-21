import { parsePageRanges, serializePageRanges } from './pdf'
import type { PrintOptions } from '../types/pdf'

export type SheetPage = { key: string; itemId: string; pageIndex: number; sourceIndex: number }
export type PageSizePt = { widthPt: number; heightPt: number }
export type PreviewImage = (itemId: string, index: number, maxWidth?: number) => Promise<string | undefined>
export type PreviewSize = (itemId: string, index: number) => Promise<PageSizePt | undefined>
export type SelectionIssue = { field: 'print-range' | 'print-subset' | 'print-restore' | 'print-add-files'; message: string }

/** Range/parity refer to original, merged page numbers, never the reordered slot. */
export function selectSheetPages(ordered: readonly SheetPage[], range: string, subset: PrintOptions['subset'], excluded: ReadonlySet<string>, reverse: boolean) {
  const empty = (field: SelectionIssue['field'], message: string) => ({ pages: [] as SheetPage[], range: '', issue: { field, message } })
  if (!ordered.length) return empty('print-add-files', '请先添加要打印的文件。')
  const typed = range.trim()
  let indices: Set<number> | undefined
  try {
    if (typed) indices = new Set(parsePageRanges(typed, ordered.length))
  } catch (error) {
    return empty('print-range', error instanceof Error ? error.message : '请输入有效的页码范围。')
  }
  const included = ordered.filter(p => (!indices || indices.has(p.sourceIndex)) && !excluded.has(p.key))
  if (!included.length) return empty('print-restore', '范围内的页面都已排除。请恢复页面或更改打印范围。')
  const pages = !subset || subset === 'all' ? included : included.filter(p => p.sourceIndex % 2 === (subset === 'odd' ? 0 : 1))
  if (!pages.length) return empty('print-subset', '没有符合条件的页面。请更改奇偶页、打印范围或排除项。')
  // Encode exclusions, but leave ordering, parity and reversal to the print pipeline.
  const submitRange = excluded.size ? serializePageRanges(included.map(p => p.sourceIndex)) : typed
  return { pages: reverse ? [...pages].reverse() : pages, range: submitRange, issue: undefined }
}

const mm = (n: number) => n * 72 / 25.4
const papers = { a4: [mm(210), mm(297)], a5: [mm(148), mm(210)], b5: [mm(176), mm(250)], letter: [612, 792], legal: [612, 1008] } as const

export function sheetSize(paper: NonNullable<PrintOptions['paperSize']>, landscape: boolean, firstPage?: PageSizePt): PageSizePt | undefined {
  const size = paper === 'auto' ? firstPage && [firstPage.widthPt, firstPage.heightPt] : papers[paper]
  if (!size || !size.every(n => Number.isFinite(n) && n > 0)) return undefined
  const [w, h] = size
  // Auto follows the first output page; landscape forces the long edge across.
  return landscape ? { widthPt: Math.max(w, h), heightPt: Math.min(w, h) } : { widthPt: w, heightPt: h }
}

export function sheetGrid(n: number, landscape: boolean) {
  const cols = n === 2 ? 1 : n === 6 ? 2 : Math.sqrt(n)
  const rows = n / cols
  return landscape ? { cols: rows, rows: cols } : { cols, rows }
}

/** Geometry in PDF points. Fit uses the composed bitmap's aspect, actual its physical width.
 * The bitmap always retains its own aspect ratio. GDI clips to this inset rectangle. */
export function placeOnSheet(cell: PageSizePt, safe: boolean, aspect: number, scale: number, actualWidthPt?: number) {
  const inset = safe ? 12 : 0
  const width = cell.widthPt - 2 * inset, height = cell.heightPt - 2 * inset
  if (width <= 0 || height <= 0 || !(aspect > 0)) return undefined
  const contentWidth = (actualWidthPt ?? Math.min(width, height * aspect)) * scale / 100
  return { inset, width, height, contentWidth, cropped: contentWidth > width + 0.01 || contentWidth / aspect > height + 0.01 }
}

export function validCopies(value: string) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 99
}

type PreviewAsset = { requested: number; url?: string; size?: PageSizePt }

/** Both views share one worker. A fast scroll/view switch skips abandoned requests before
 * any PDF work and keeps at most the current render in flight. Cache is per dialog. */
export function createPreviewLoader(render?: PreviewImage, measure?: PreviewSize) {
  const cache = new Map<string, PreviewAsset>()
  let tail = Promise.resolve()
  return (page: Pick<SheetPage, 'key' | 'itemId' | 'pageIndex'>, width: number, needSize: boolean, active: () => boolean) => {
    const run = async () => {
      if (!active()) return undefined
      const entry = { ...(cache.get(page.key) ?? { requested: 0 }) }
      if (width > entry.requested) {
        try {
          const url = await render?.(page.itemId, page.pageIndex, width)
          if (url) { entry.url = url; entry.requested = width }
        } catch { /* A failed upgrade must not erase a usable rail image. */ }
      }
      if (active() && needSize && !entry.size) {
        try {
          const size = await measure?.(page.itemId, page.pageIndex)
          if (size && [size.widthPt, size.heightPt].every(n => Number.isFinite(n) && n > 0)) entry.size = size
        } catch { /* No physical size: show unavailable, never infer inches from pixels. */ }
      }
      cache.delete(page.key)
      cache.set(page.key, entry)
      if (cache.size > 32) cache.delete(cache.keys().next().value!)
      return entry
    }
    const result = tail.then(run)
    tail = result.then(() => {}, () => {})
    return result
  }
}
export type PreviewLoader = ReturnType<typeof createPreviewLoader>
