import type { OcrPageLayer, OcrWord, WorkspacePage } from '../types/pdf'
import type { MarkdownFragment, MarkdownSelectionSnapshot, MarkdownRegion } from './markdownScopeTypes'

type LayerReader = (range: Range | null) => MarkdownFragment | undefined
const readers = new WeakMap<HTMLElement, LayerReader>()

// Only a live DOM Range can supply this evidence. A stored annotation or its comment cannot.
const ocrRanges = new WeakMap<MarkdownFragment, {
  source: OcrPageLayer; revision: OcrPageLayer['revision']; text: string
  slices: { index: number; start: number; raw: string }[]
}>()

function rememberOcrRange(layer: HTMLElement, range: Range, ocr: OcrPageLayer, fragment: MarkdownFragment) {
  const slices: { index: number; start: number; raw: string }[] = []
  let quote = '', separator = ''
  for (const el of layer.querySelectorAll<HTMLSpanElement>('span[data-ocr-index]')) {
    const node = el.firstChild
    if (!(node instanceof Text) || !range.intersectsNode(node)) continue
    const index = Number(el.dataset.ocrIndex), word = ocr.words[index]
    if (!word) return false
    const length = word.text.length
    const start = range.startContainer === node ? Math.min(length, range.startOffset) : 0
    const end = range.endContainer === node ? Math.min(length, range.endOffset) : length
    if (end <= start) continue // The structural separator alone grants no glyphs.
    const raw = word.text.slice(start, end), shown = node.data.slice(start, end)
    if (raw.normalize('NFKC') !== shown.normalize('NFKC')) return false
    quote += separator + shown
    separator = node.data.slice(length) // The reading layer already resolved CJK/Latin spaces and line breaks.
    if (separator !== '' && separator !== ' ' && separator !== '\n') return false
    slices.push({ index, start, raw })
  }
  if (!slices.length || quote.trim() !== fragment.text) return false
  ocrRanges.set(fragment, { source: ocr, revision: ocr.revision, text: fragment.text, slices })
  return true
}

/** Undefined denotes a different kind of selection; false means this exact OCR range is no longer valid. */
export function matchesCapturedOcr(fragment: MarkdownFragment, page: WorkspacePage, visible: (word: OcrWord) => boolean) {
  const captured = ocrRanges.get(fragment)
  if (!captured) return undefined
  const ocr = page.ocr
  return page.id === fragment.pageId && ocr === captured.source && ocr.revision === captured.revision
    && fragment.text === captured.text && captured.slices.every(({ index, start, raw }) => {
      const word = ocr.words[index]
      return word && word.text.slice(start, start + raw.length) === raw && visible(word)
    })
}

export function registerMarkdownLayer(layer: HTMLElement, reader: LayerReader) {
  readers.set(layer, reader)
  return () => { if (readers.get(layer) === reader) readers.delete(layer) }
}
export function selectionBoxes(rects: Iterable<DOMRect>, page: HTMLElement): MarkdownRegion[] {
  const p = page.getBoundingClientRect(), boxes: MarkdownRegion[] = [], seen = new Set<string>()
  if (!p.width || !p.height) return boxes
  for (const rect of rects) {
    const x = (Math.max(rect.left, p.left) - p.left) / p.width, y = (Math.max(rect.top, p.top) - p.top) / p.height
    const width = (Math.min(p.right, rect.right) - p.left) / p.width - x, height = (Math.min(p.bottom, rect.bottom) - p.top) / p.height - y
    if (!(width > 0 && height > 0 && x >= 0 && y >= 0) || !Number.isFinite(width + height)) continue
    const key = [x,y,width,height].map(n=>n.toFixed(6)).join(',')
    if (!seen.has(key)) { seen.add(key); boxes.push({ x,y,width,height }) }
    if (boxes.length > 4096) throw Error('选区过大，请分段导出。')
  }
  return boxes
}
function textLayer(node: Node|null) { return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.text-layer') }

/** Run before a toolbar click moves focus. Never read generic body text or an old tab's selection. */
export function captureMarkdownSelection(stage: HTMLElement | null, pages: readonly WorkspacePage[]): MarkdownSelectionSnapshot | undefined {
  if (!stage || !pages.length) return
  const selection = stage.ownerDocument.defaultView?.getSelection(), byId = new Map(pages.map(p=>[p.id,p]))
  const entries: MarkdownSelectionSnapshot['entries'] = []
  const source = selection && !selection.isCollapsed && selection.rangeCount === 1 ? selection.getRangeAt(0) : undefined
  if (source) {
    for (const n of [source.startContainer,source.endContainer]) {
      const layer=textLayer(n), card=layer?.closest<HTMLElement>('.stage-page[data-page-id]')
      if (!layer || !stage.contains(layer) || !byId.has(card?.dataset.pageId ?? '')) return
    }
  }
  for (const layer of stage.querySelectorAll<HTMLElement>('.stage-page[data-page-id] .text-layer')) {
    const page=byId.get(layer.closest<HTMLElement>('.stage-page')?.dataset.pageId ?? ''), read=readers.get(layer)
    if(!page || !read) continue
    let part:Range|null=null
    if(source) {
      if(!source.intersectsNode(layer)) continue
      part=source.cloneRange();if(!layer.contains(part.startContainer))part.setStart(layer,0)
      if(!layer.contains(part.endContainer))part.setEnd(layer,layer.childNodes.length)
    } else if(!layer.contains(stage.ownerDocument.activeElement)) continue
    const fragment=read(part)
    if (fragment?.text?.trim() && fragment.boxes.length) {
      if (fragment.pageId !== page.id || (part && (page.ocr || layer.dataset.ocr === 'true') &&
        (!page.ocr || layer.dataset.ocr !== 'true' || !rememberOcrRange(layer, part, page.ocr, fragment)))) {
        throw Error('文字层已变化，请重新拉选文字。')
      }
      entries.push({ page, fragment })
    }
  }
  return entries.length?{entries}:undefined
}
export function currentMarkdownFragments(snapshot:MarkdownSelectionSnapshot|undefined,pages:readonly WorkspacePage[]) {
  if(!snapshot)return []
  // All-or-nothing: stale/closed/reordered-to-another-tab ranges don't expand to a different document.
  const current=new Set(pages)
  return snapshot.entries.every(({ page, fragment }) => {
    const captured = ocrRanges.get(fragment)
    return current.has(page) && page.id === fragment.pageId && (!captured ||
      (page.ocr === captured.source && page.ocr.revision === captured.revision))
  }) ? snapshot.entries.map(e => e.fragment) : []
}
