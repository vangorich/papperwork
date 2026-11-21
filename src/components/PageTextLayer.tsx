import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { OcrTable, OcrWord, PdfSource, WorkspacePage } from '../types/pdf'
import { getPdfPage, getPdfTextContent } from '../lib/pdf'
import {
  ocrPairSeparator,
  ocrReadingOrder,
  ocrTableRangeClipboard,
  ocrWordSpanPlacement,
} from '../lib/ocr'
import {
  clearTextLayerSearchMatches,
  ocrTableClipboardForRange,
  rangeSelectedSpans,
  reconstructNativeTextLayerTables,
  selectionBelongsToTextLayer,
  updateTextLayerSearchMatches,
} from '../lib/textLayerSelection'

import { registerMarkdownLayer, selectionBoxes } from '../lib/captureMarkdownSelection'
import { setOcrRunFrame } from '../lib/ocrSelectionBands'
import { installPageReadingSelection, nativeReadingCopy, nativeReadingStream, prepareNativeReading } from '../lib/pageReadingSelection'

/** OCR geometry is authored once at this fixed reference width. Individual
 *  positions use calc(var(--ocr-scale) * npx), matching PDF.js' native layer;
 *  scaling the whole layer with transform caused Chromium hit-testing and drag
 *  selection to drift outside long lines. */
const OCR_REFERENCE_WIDTH = 1200
/** Angles below this are integer-rounding noise; skipping them keeps nearly
 *  every span transform-free on straight scans. */
const MIN_ROTATE_DEGREES = 0.3
/** Deterministic font family keeps canvas measurements and line breaks stable. */
const OCR_FONT_FAMILY = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'

interface PageTextLayerProps {
  item: WorkspacePage
  source?: PdfSource
  enabled: boolean
  /** Lives while the page sits in the preload band; only truly hidden pages
   *  tear the layer down, so fling-scrolling stops churning span DOM. */
  renderable: boolean
  renderWidth: number
  pageRatio: number
  query: string
}

export interface PageTextLayerHandle {
  getElement: () => HTMLDivElement | null
  ownsSelection: () => boolean
  copySelection: () => Promise<void>
  selectionText: () => string | undefined
}

let sharedMeasureContext: CanvasRenderingContext2D | null | undefined

/**
 * Owns PDF.js/OCR selectable text, search marks, and rich table clipboard data.
 * The parent page keeps canvas and annotation coordinates independent.
 */
export const PageTextLayer = forwardRef<PageTextLayerHandle, PageTextLayerProps>(function PageTextLayer({
  item,
  source,
  enabled,
  renderable,
  renderWidth,
  pageRatio,
  query,
}, forwardedRef) {
  const layerRef = useRef<HTMLDivElement>(null)
  const nativeTablesRef = useRef<OcrTable[]>([])
  /** Unscaled natural page width backing --scale-factor on native layers. */
  const nativeNaturalWidthRef = useRef(0)
  /** Source-word → reading-line assignment, rebuilt with the span layer. */
  const ocrLineIndexRef = useRef<Map<OcrWord, number> | null>(null)
  const tableSelectionRef = useRef<{
    table: OcrTable
    anchorRow: number
    anchorColumn: number
    focusRow: number
    focusColumn: number
  } | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const renderWidthRef = useRef(renderWidth)
  renderWidthRef.current = renderWidth

  const currentExplicitTableClipboard = () => {
    const selected = tableSelectionRef.current
    if (!selected) return
    return ocrTableRangeClipboard(
      selected.table,
      [selected.anchorRow, selected.focusRow],
      [selected.anchorColumn, selected.focusColumn],
    )
  }

  const paintTableSelection = () => {
    const layer = layerRef.current
    const selected = tableSelectionRef.current
    if (!layer) return
    const rowStart = selected ? Math.min(selected.anchorRow, selected.focusRow) : -1
    const rowEnd = selected ? Math.max(selected.anchorRow, selected.focusRow) : -1
    const columnStart = selected ? Math.min(selected.anchorColumn, selected.focusColumn) : -1
    const columnEnd = selected ? Math.max(selected.anchorColumn, selected.focusColumn) : -1
    layer.querySelectorAll<HTMLElement>('[data-table-cell]').forEach((cell) => {
      const row = Number(cell.dataset.tableRow)
      const column = Number(cell.dataset.tableColumn)
      const active = Boolean(selected)
        && cell.dataset.tableId === selected!.table.id
        && row >= rowStart && row <= rowEnd
        && column >= columnStart && column <= columnEnd
      if (active) cell.dataset.selected = 'true'
      else delete cell.dataset.selected
    })
  }

  const clearTableSelection = () => {
    tableSelectionRef.current = null
    paintTableSelection()
  }

  const currentTableClipboard = () => {
    const explicit = currentExplicitTableClipboard()
    // OCR cells have an explicit rectangular gesture. A drag on the ink must
    // stay a text range, even if its endpoints enclose a whole word in a cell.
    if (explicit || item.ocr) return explicit
    const layer = layerRef.current
    const selection = window.getSelection()
    const tables = nativeTablesRef.current
    if (!tables.length || !selectionBelongsToTextLayer(selection, layer)) return
    const range = selection!.getRangeAt(0)
    if(range.startContainer instanceof Text && range.startOffset>0 || range.endContainer instanceof Text && range.endOffset<range.endContainer.length) return
    return ocrTableClipboardForRange(
      tables,
      layer!.querySelectorAll<HTMLSpanElement>('span[data-table-word-index], span[data-ocr-index]'),
      selection!.getRangeAt(0),
    )
  }

  /**
   * Deterministic plain-text copy for OCR layers: span hit-testing decides
   * WHICH lines are selected, but the text is rebuilt from the stored words
   * and reading-order separators — no dependence on how Chromium serializes
   * absolutely positioned block spans (doubled newlines, fused junctions).
   */
  const currentOcrCopyText = (specified?: Range) => {
    const layer = layerRef.current
    const words = item.ocr?.words
    const selection = window.getSelection()
    if (!words?.length || !layer || (!specified && !selectionBelongsToTextLayer(selection, layer))) return
    const range = specified ?? selection!.getRangeAt(0)
    const spans = rangeSelectedSpans(layer!.querySelectorAll<HTMLSpanElement>('span[data-ocr-index]'), range)
    if (!spans.length) return
    // DOM order is reading order: spans were appended in ocrReadingOrder.
    const picked = spans.flatMap((span) => {
      const word = words[Number(span.dataset.ocrIndex)]
      return word ? [{ span, word }] : []
    })
    if (!picked.length) return
    const lineIndex = ocrLineIndexRef.current ?? undefined
    return picked.map(({ span, word }, index) => {
      // Reading glyphs (e.g. a contextual decimal point) have source-length offsets.
      let text = (span.textContent ?? word.text).slice(0, word.text.length)
      // Clip partial drags at the selection endpoints. Offsets land on the
      // span's single text node; the baked separator is not part of the word.
      const startsHere = index === 0 && span.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE
      const endsHere = index === picked.length - 1 && span.contains(range.endContainer) && range.endContainer.nodeType === Node.TEXT_NODE
      if (startsHere && endsHere && picked.length === 1) {
        text = text.slice(Math.min(range.startOffset, text.length), Math.min(range.endOffset, text.length))
      } else {
        if (startsHere) text = text.slice(Math.min(range.startOffset, text.length))
        if (endsHere) text = text.slice(0, Math.min(range.endOffset, text.length))
      }
      const separator = index < picked.length - 1 ? ocrPairSeparator(word, picked[index + 1].word, lineIndex) : ''
      return text + separator
    }).join('')
  }

  const currentPlainText = () => {
    const layer=layerRef.current, selection=window.getSelection()
    if(!layer || !selectionBelongsToTextLayer(selection,layer)) return
    return currentOcrCopyText() ?? nativeReadingCopy(layer,selection!.getRangeAt(0)) ?? selection!.toString()
  }
  const copySelection = async () => {
    const selection = window.getSelection()
    if (!tableSelectionRef.current && !selectionBelongsToTextLayer(selection, layerRef.current)) return
    const payload = currentTableClipboard()
    try {
      if (payload && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([payload.tsv], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' }),
        })])
      } else {
        await navigator.clipboard.writeText(payload?.tsv ?? currentPlainText() ?? '')
      }
    } catch {
      if (payload) {
        // With an explicit cell selection there is no DOM Range, so the copy
        // event targets document rather than this layer. Seed the fallback
        // event directly instead of relying on the layer's onCopy handler.
        document.addEventListener('copy', (event) => {
          event.preventDefault()
          event.clipboardData?.setData('text/plain', payload.tsv)
          event.clipboardData?.setData('text/html', payload.html)
        }, { capture: true, once: true })
      }
      document.execCommand('copy')
    }
  }

  // The registry contains mounted page readers only. It never retains PDF/mail text.
  useEffect(() => {
    const layer=layerRef.current, page=layer?.closest<HTMLElement>('.pdf-page')
    if(!enabled || !renderable || !layer || !page)return
    return registerMarkdownLayer(layer,range=>{
      if (!range) {
        const cells=currentExplicitTableClipboard();if(!cells)return
        const boxes=selectionBoxes(Array.from(layer.querySelectorAll<HTMLElement>('[data-table-cell][data-selected]'),el=>el.getBoundingClientRect()),page)
        return {pageId:item.id,boxes,text:cells.tsv,table:true}
      }
      const rects:DOMRect[]=[]
      for(const span of rangeSelectedSpans(layer.querySelectorAll<HTMLSpanElement>('span:not(.markedContent):not([hidden])'),range)){
        const n=span.firstChild;if(!(n instanceof Text))continue
        const part=document.createRange();part.selectNodeContents(n)
        if(range.startContainer===n)part.setStart(n,range.startOffset)
        if(range.endContainer===n)part.setEnd(n,range.endOffset)
        if(!part.collapsed)rects.push(...part.getClientRects())
        if(rects.length>4096)throw Error('选区过大，请分段导出。')
      }
      const text=(currentOcrCopyText(range)??nativeReadingCopy(layer,range)??range.toString()).trim()
      if(!text)return
      if(text.length>1_000_000)throw Error('选区过大，请分段导出。')
      return {pageId:item.id,boxes:selectionBoxes(rects,page),text}
    })
  },[enabled,renderable,item])
  useImperativeHandle(forwardedRef, () => ({
    getElement: () => layerRef.current,
    ownsSelection: () => Boolean(tableSelectionRef.current)
      || selectionBelongsToTextLayer(window.getSelection(), layerRef.current),
    copySelection, selectionText: currentPlainText,
  }))

  useEffect(() => {
    let cancelled = false
    let pdfTextLayer: TextLayer | undefined
    let tableDragCleanup: (() => void) | undefined
    const layer = layerRef.current
    nativeTablesRef.current = []
    nativeNaturalWidthRef.current = 0
    ocrLineIndexRef.current = null
    tableSelectionRef.current = null
    if (!enabled || !layer || item.sourceId === 'blank' || !renderable) {
      layer?.replaceChildren()
      clearTextLayerSearchMatches(layer)
      return
    }

    const releaseSelection = installPageReadingSelection(layer)
    const appendEndOfContent = (target: ParentNode) => {
      const end = document.createElement('div')
      end.className = 'endOfContent'
      target.append(end)
    }

    // OCR owns the selectable layer, avoiding duplicate native extraction for scans.
    if (item.ocr) {
      layer.removeAttribute('data-main-rotation')
      layer.style.removeProperty('--scale-factor')
      const words = item.ocr.words
      const sourceIndexes = new Map(words.map((word, index) => [word, index]))
      // This identity is for the visual wash only. Do not bridge a column divider
      // just because two selected words have the same baseline.
      const cellByWord = new Map<number, number>()
      let cellNumber = 0
      for (const table of item.ocr.tables ?? []) for (const row of table.cells ?? []) for (const cell of row) {
        const id = ++cellNumber
        for (const index of cell.wordIndexes) cellByWord.set(index, cellByWord.has(index) ? -1 - index : id)
      }
      void (async () => {
        // page.rotate composes with the workspace rotation; fetching it here
        // (cached in lib/pdf) keeps the layer build single-pass.
        const pageRotate = source ? await getPdfPage(source, item.sourcePage).then((page) => page.rotate).catch(() => 0) : 0
        if (cancelled) return
        const quarter = (pageRotate + item.rotation + 360) % 360
        // Turning the sheet changes where glyphs land, not their logical order.
        // Sorting the rotated boxes puts the last word first at 180°.
        const reading = ocrReadingOrder(words, quarter % 180 ? 1 / pageRatio : pageRatio)
        ocrLineIndexRef.current = reading.lineIndex
        const boxWidth = OCR_REFERENCE_WIDTH
        const boxHeight = Math.max(1, OCR_REFERENCE_WIDTH * pageRatio)
        const ocrScale = renderWidthRef.current / OCR_REFERENCE_WIDTH
        layer.style.width = `${renderWidthRef.current}px`
        layer.style.height = `${renderWidthRef.current * pageRatio}px`
        layer.style.removeProperty('transform')
        layer.style.setProperty('--ocr-scale', String(ocrScale))
        const fragment = document.createDocumentFragment()
        const fitTargets: { span: HTMLSpanElement; text: string; width: number; fontSize: number; angle: number }[] = []
        reading.ordered.forEach((sourceWord, orderIndex) => {
          const placement = ocrWordSpanPlacement(sourceWord, quarter, pageRatio)
          const span = document.createElement('span')
          const text = reading.texts[orderIndex]
          span.textContent = text + reading.separators[orderIndex]
          const left = placement.x * boxWidth
          const top = placement.y * boxHeight
          const width = placement.width * boxWidth
          const height = placement.height * boxHeight
          const fontSize = Math.max(2, height)
          span.style.left = `calc(var(--ocr-scale) * ${left}px)`
          span.style.top = `calc(var(--ocr-scale) * ${top}px)`
          span.style.width = `calc(var(--ocr-scale) * ${width}px)`
          span.style.height = `calc(var(--ocr-scale) * ${height}px)`
          span.style.fontSize = `calc(var(--ocr-scale) * ${fontSize}px)`
          span.style.fontFamily = OCR_FONT_FAMILY
          // The AABB datasets feed the highlight-annotation path, which wants
          // the axis-aligned display box, not the rotated quad.
          span.dataset.ocrX = String(placement.box.x)
          span.dataset.ocrY = String(placement.box.y)
          span.dataset.ocrWidth = String(placement.box.width)
          span.dataset.ocrHeight = String(placement.box.height)
          span.dataset.ocrIndex = String(sourceIndexes.get(sourceWord) ?? orderIndex)
          span.dataset.tableWordIndex = span.dataset.ocrIndex
          span.dataset.confidence = String(sourceWord.confidence)
          if (sourceWord.requiresReview) {
            span.dataset.review = 'true'
            span.title = `低置信度 ${Math.round(sourceWord.confidence * 100)}% · ${sourceWord.candidates?.map((candidate) => candidate.text).join(' / ') || '待人工复核'}`
          }
          const angle = Math.abs(placement.angle) >= MIN_ROTATE_DEGREES ? placement.angle : 0
          setOcrRunFrame(span, {
            line: reading.lineIndex.get(sourceWord) ?? -1 - orderIndex,
            cell: cellByWord.get(Number(span.dataset.ocrIndex)) ?? null,
            x: placement.x, y: placement.y, width: placement.width, height: placement.height,
            angle, length: text.length,
          })
          if (angle) span.style.transform = `rotate(${angle}deg)`
          fitTargets.push({ span, text, width, fontSize, angle })
          fragment.append(span)
        })
        ;(item.ocr?.tables ?? []).forEach((table) => table.cells?.forEach((row, rowIndex) => {
          row.forEach((cell, columnIndex) => {
            if (!cell.bounds) return
            const placement = ocrWordSpanPlacement({
              text: cell.text,
              confidence: table.confidence,
              ...cell.bounds,
            }, quarter, pageRatio)
            const target = document.createElement('div')
            target.className = 'ocr-table-cell'
            target.dataset.tableCell = 'true'
            target.dataset.tableId = table.id
            target.dataset.tableRow = String(rowIndex)
            target.dataset.tableColumn = String(columnIndex)
            target.tabIndex = -1
            target.setAttribute('role', 'gridcell')
            target.title = '拖动空白处框选单元格，拖动文字可逐字选择'
            target.setAttribute('aria-label', `第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列${cell.text ? `：${cell.text}` : ''}`)
            target.style.left = `calc(var(--ocr-scale) * ${placement.x * boxWidth}px)`
            target.style.top = `calc(var(--ocr-scale) * ${placement.y * boxHeight}px)`
            target.style.width = `calc(var(--ocr-scale) * ${placement.width * boxWidth}px)`
            target.style.height = `calc(var(--ocr-scale) * ${placement.height * boxHeight}px)`
            if (placement.angle) {
              target.style.transformOrigin = 'left top'
              target.style.transform = `rotate(${placement.angle}deg)`
            }
            target.addEventListener('pointerdown', (event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              tableDragCleanup?.()
              window.getSelection()?.removeAllRanges()
              tableSelectionRef.current = {
                table,
                anchorRow: rowIndex,
                anchorColumn: columnIndex,
                focusRow: rowIndex,
                focusColumn: columnIndex,
              }
              paintTableSelection()
              target.focus({ preventScroll: true })
              const move = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) return
                if (!(moveEvent.buttons & 1)) { finish(); return }
                // A rectangle can finish over text now that glyphs sit above the cells.
                const hit = document.elementsFromPoint(moveEvent.clientX, moveEvent.clientY)
                  .find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.tableId === table.id && layer.contains(el))
                if (!hit) return
                const selected = tableSelectionRef.current
                if (!selected) return
                selected.focusRow = Number(hit.dataset.tableRow)
                selected.focusColumn = Number(hit.dataset.tableColumn)
                paintTableSelection()
              }
              const finish = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', finish)
                window.removeEventListener('pointercancel', finish)
                tableDragCleanup = undefined
              }
              tableDragCleanup = finish
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', finish, { once: true })
              window.addEventListener('pointercancel', finish, { once: true })
            })
            target.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                clearTableSelection()
              } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
                event.preventDefault()
                event.stopPropagation()
                void copySelection()
              } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'a') {
                event.preventDefault()
                tableSelectionRef.current = {
                  table,
                  anchorRow: 0,
                  anchorColumn: 0,
                  focusRow: table.rows.length - 1,
                  focusColumn: table.columnCount - 1,
                }
                paintTableSelection()
              }
            })
            fragment.append(target)
          })
        }))
        appendEndOfContent(fragment)
        layer.dataset.ocr = 'true'
        layer.replaceChildren(fragment)
        // pdf.js-style horizontal glyph fit: one canvas measurement per line
        // aligns span endpoints with the printed glyphs, so character-level
        // hit-testing stops drifting along the line.
        sharedMeasureContext ??= document.createElement('canvas').getContext('2d')
        if (sharedMeasureContext) {
          for (const target of fitTargets) {
            if (target.width <= 1) continue
            sharedMeasureContext.font = `${target.fontSize}px ${OCR_FONT_FAMILY}`
            const natural = sharedMeasureContext.measureText(target.text).width
            if (!Number.isFinite(natural) || natural < 1) continue
            // overflow:hidden clips before transforms. The layout box must hold
            // the natural glyph run; scale that box AND its text to the OCR width.
            // Giving it the OCR width first clipped every compressed line's tail.
            target.span.style.width = `calc(var(--ocr-scale) * ${natural}px)`
            const fit = target.width / natural
            const rotate = target.angle ? `rotate(${target.angle}deg) ` : ''
            target.span.style.transform = `${rotate}scaleX(${fit})`
          }
        }
        updateTextLayerSearchMatches(layer, layer.querySelectorAll('span'), queryRef.current)
      })().catch(() => undefined)
      return () => {
        cancelled = true
        tableDragCleanup?.()
        releaseSelection()
        clearTextLayerSearchMatches(layer)
      }
    }

    layer.style.removeProperty('width')
    layer.style.removeProperty('height')
    layer.style.removeProperty('transform')
    layer.style.removeProperty('--ocr-scale')
    if (!source) {
      releaseSelection()
      layer.replaceChildren()
      clearTextLayerSearchMatches(layer)
      return
    }
    delete layer.dataset.ocr
    void (async () => {
      const page = await getPdfPage(source, item.sourcePage)
      if (cancelled) return
      // Marked-content operators belong to the rendered structure, not to search,
      // Markdown or saved OCR. Stream them to PDF.js instead of keeping a second
      // extraction in the shared page LRU. Pure XFA has no PDF text stream.
      const paper = page.isPureXfa ? undefined : nativeReadingStream(page.view)
      const content = paper ? page.streamTextContent({ includeMarkedContent: true }).pipeThrough(paper.stream)
        : await getPdfTextContent(source, item.sourcePage)
      if (cancelled) return
      const rotation = (page.rotate + item.rotation + 360) % 360
      const natural = page.getViewport({ scale: 1, rotation })
      const viewport = page.getViewport({ scale: renderWidthRef.current / natural.width, rotation })
      nativeNaturalWidthRef.current = natural.width
      layer.replaceChildren()
      layer.style.setProperty('--scale-factor', String(viewport.scale))
      pdfTextLayer = new TextLayer({ textContentSource: content, container: layer, viewport })
      await pdfTextLayer.render()
      if (cancelled) return
      const { runs, width, height } = prepareNativeReading(layer, pdfTextLayer.textDivs, paper)
      if (width > 0 && height > 0) {
        const positioned = runs.flatMap(({ el: span, b: bounds, text }) => {
          const x = Math.max(0, bounds.left / width)
          const y = Math.max(0, bounds.top / height)
          const right = Math.min(1, bounds.right / width)
          const bottom = Math.min(1, bounds.bottom / height)
          if (right <= x || bottom <= y) return []
          return [{
            span,
            word: { text, confidence: 1, x, y, width: right - x, height: bottom - y } satisfies OcrWord,
          }]
        })
        const words = positioned.map(({ word }) => word)
        // A whole-line range can enter the rich table-copy path. Aligned word
        // fragments within a confirmed prose column aren't spreadsheet cells.
        nativeTablesRef.current = reconstructNativeTextLayerTables(words).filter(table =>
          !table.cells?.some(row => row.some(cell => cell.wordIndexes.some(i => positioned[i].span.dataset.readCol !== undefined))))
        positioned.forEach(({ span }, index) => { span.dataset.tableWordIndex = String(index) })
      }
      appendEndOfContent(layer)
      updateTextLayerSearchMatches(layer, pdfTextLayer.textDivs, queryRef.current)
    })().catch(() => undefined)
    return () => {
      cancelled = true
      releaseSelection()
      pdfTextLayer?.cancel()
      clearTextLayerSearchMatches(layer)
    }
  }, [enabled, item.ocr, item.rotation, item.sourceId, item.sourcePage, pageRatio, renderable, source])

  // Zoom without rebuild: OCR layers rescale via --ocr-scale, native pdf.js
  // layers via --scale-factor (spans are positioned in calc() user units).
  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !renderWidth) return
    if (layer.dataset.ocr === 'true') {
      layer.style.setProperty('--ocr-scale', String(renderWidth / OCR_REFERENCE_WIDTH))
      layer.style.width = `${renderWidth}px`
      layer.style.height = `${renderWidth * pageRatio}px`
      layer.style.removeProperty('transform')
    } else if (nativeNaturalWidthRef.current) {
      layer.style.setProperty('--scale-factor', String(renderWidth / nativeNaturalWidthRef.current))
    }
  }, [pageRatio, renderWidth])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const needle = query.trim().toLocaleLowerCase()
    // Cheap pre-filter: pages without the needle skip the span TreeWalker pass
    // entirely (one string scan instead of per-span Range building).
    if (needle && !layer.textContent?.toLocaleLowerCase().includes(needle)) {
      updateTextLayerSearchMatches(layer, [], '')
      return
    }
    // A marked-content wrapper contains its descendants' text again. Search
    // only leaves so a single glyph can't contribute one range per ancestor.
    updateTextLayerSearchMatches(layer, layer.querySelectorAll('span:not(.markedContent)'), query)
  }, [query])

  return enabled ? (
    <div
      ref={layerRef}
      className="text-layer textLayer"
      aria-label={item.ocr ? 'OCR 可选择文字层' : '可选择的 PDF 文本层'}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest('[data-table-cell]')) clearTableSelection()
      }}
      onCopy={(event) => {
        const payload = currentTableClipboard()
        if (payload) {
          event.preventDefault()
          event.clipboardData.setData('text/plain', payload.tsv)
          event.clipboardData.setData('text/html', payload.html)
          return
        }
        const text = currentPlainText()
        if (text != null) {
          event.preventDefault()
          event.clipboardData.setData('text/plain', text)
        }
      }}
    />
  ) : null
})
