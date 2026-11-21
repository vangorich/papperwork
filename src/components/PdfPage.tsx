import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppMotion } from '../hooks/useAppMotion'
import { createPortal } from 'react-dom'
import { BookmarkPlus, Bold, Check, Copy, FileImage, Hand, Highlighter, Image as ImageIcon, Info, Italic, Layers2, Layers3, Lock, Maximize2, MessageSquareText, MousePointer2, RotateCw, ScanText, Trash2, Unlock } from 'lucide-react'
import type { DocumentWatermark, Markup, PdfFormField, PdfSource, RenderQuality, Tool, WorkspacePage } from '../types/pdf'
import { PDF_CSS_UNITS, pdfRenderScale } from '../lib/cn'
import { getPdfFormFields, getPdfPage, releasePdfPageResources, retainPdfPageResources } from '../lib/pdf'
import { pageFrames, pdfFrameOwner, thumbnailFrames } from '../lib/pdfFrameCache'
import { fitTextFontSize, rasterizeText, textMinHeightFraction } from '../lib/text'
import { rangeSelectedSpans } from '../lib/textLayerSelection'
import { observeSharedIntersection, observeSharedResize } from '../lib/sharedObservers'
import { findFormBlankAt, type FormBlankSpan } from '../lib/formBlanks'
import { PageTextLayer, type PageTextLayerHandle } from './PageTextLayer'
import { WatermarkLayer } from './WatermarkLayer'
import { ColorPalette } from './ColorPalette'
import { ObjectHandles } from './ObjectHandles'
import { PageToolRail } from './PageToolRail'
import { ObjectTypography } from './ObjectTypography'
import { armObjectHold } from '../lib/textHold'
import { objectMovePreview,frameSampler } from '../lib/gesturePreview'
import { resizeAtGrip, turnFrom, gripCursor, holdObjectCursor } from '../lib/objectTransform'

interface PendingText {
  box: Markup
  onDirty:(dirty:boolean)=>void
  onFinish:(final:Markup,select:boolean)=>void
}
interface PdfPageProps {
  pendingText?: PendingText
  item: WorkspacePage
  source?: PdfSource
  zoom?: number
  query?: string
  textLayer?: boolean
  renderQuality?: RenderQuality
  /** Current monitor density. Kept separate from layout so 100% remains 96 CSS DPI. */
  devicePixelRatio?: number
  /** Use the small, low-memory renderer for thumbnails or folded documents. */
  compact?: boolean
  className?: string
  tool?: Tool
  /** Set false on thumbnails: disables every creation/editing interaction. */
  interactive?: boolean
  onAddAnnotation?: (type: 'text' | 'highlight' | 'note', x: number, y: number, size?: { width: number; height: number }) => void
  onAddTextHighlights?: (boxes: TextHighlightBox[], text: string) => void
  onTextEditSelection?: (boxes: TextHighlightBox[], text: string) => void
  onAddDrawing?: (annotation: Omit<Markup, 'id'>) => void
  drawingColor?: string
  drawingWidth?: number
  drawingFilled?: boolean
  onRemoveAnnotation?: (id: string) => void
  onUpdateAnnotation?: (id: string, patch: Partial<Markup>) => void
  onSetImageExportMode?: (id: string, mode: 'object' | 'flatten-page') => void
  onActivateText?: (annotationId: string) => void
  selectedAnnotationIds?: Set<string>
  primaryAnnotationId?: string
  onSelectAnnotation?: (annotationId: string, additive: boolean) => void
  onClearAnnotationSelection?: () => void
  activeNoteId?: string
  onActivateNote?: (annotationId: string) => void
  onFillText?: (field: Omit<PdfFormField, 'id'> & { id?: string }) => void
  /** Adobe Fill & Sign style: click a detected "label:" blank to drop a text box. */
  onInsertFormBlank?: (blank: { x: number; y: number; width: number; height: number; fontSizePt: number }) => void
  onInsertImage?: (file: File, x: number, y: number) => void
  onCrop?: (crop?: WorkspacePage['crop']) => void
  /** Extract this display-space selection into a new page; leave the original intact. */
  onExtractCrop?: (crop: NonNullable<WorkspacePage['crop']>) => void
  onCancelCrop?: () => void
  onUseHandTool?: () => void
  onUseSelectTool?: () => void
  onExportPageImage?: () => void
  onPageProperties?: () => void
  onResizePage?: () => void
  onAddBookmark?: () => void
  onOcrPage?: () => void
  onAddToWorkspace?: () => void
  /** Document-level watermark rendered on this page; interactive in watermark tool mode. */
  watermark?: DocumentWatermark
  watermarkSelected?: boolean
  onSelectWatermark?: () => void
  onChangeWatermark?: (next: DocumentWatermark) => void
  onRemoveWatermark?: () => void
}

type PageVisibility = 'hidden' | 'preload' | 'visible'

export interface TextHighlightBox {
  x: number
  y: number
  width: number
  height: number
}

export type AnnotationResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export function resizeAnnotationBox(
  initial: Pick<Markup, 'x' | 'y' | 'width' | 'height'>,
  dx: number,
  dy: number,
  preserveAspect: boolean,
  minWidth = 0.05,
  minHeight = 0.035,
  aspectRatio = initial.width / initial.height,
  dir: AnnotationResizeDir = 'se',
) {
  // Directional resize: each dragged edge moves while the opposite one stays
  // anchored. 'se' (the old grip handle) reproduces the historical behavior.
  const right = initial.x + initial.width
  const bottom = initial.y + initial.height
  const clampSize = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))
  let x = initial.x
  let y = initial.y
  let width = initial.width
  let height = initial.height
  if (dir.includes('w')) {
    x = clampSize(initial.x + dx, 0, Math.max(0, right - minWidth))
    width = right - x
  } else if (dir.includes('e')) {
    width = clampSize(initial.width + dx, Math.min(minWidth, 1 - initial.x), 1 - initial.x)
  }
  if (dir.includes('n')) {
    y = clampSize(initial.y + dy, 0, Math.max(0, bottom - minHeight))
    height = bottom - y
  } else if (dir.includes('s')) {
    height = clampSize(initial.height + dy, Math.min(minHeight, 1 - initial.y), 1 - initial.y)
  }
  const corner = dir.length === 2
  if (!preserveAspect || !corner || initial.width <= 0 || initial.height <= 0 || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { x, y, width, height }
  }

  // Locked-ratio corner drag: scale uniformly around the anchored corner.
  const widthScale = width / initial.width
  const heightScale = height / initial.height
  const requestedWidth = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? width : height * aspectRatio
  const maxWidth = dir.includes('w') ? right : 1 - x
  const maxHeight = dir.includes('n') ? bottom : 1 - y
  const effectiveMinWidth = Math.min(minWidth, maxWidth)
  const effectiveMinHeight = Math.min(minHeight, maxHeight)
  const constrainedMinWidth = Math.max(effectiveMinWidth, effectiveMinHeight * aspectRatio)
  const constrainedMaxWidth = Math.min(maxWidth, maxHeight * aspectRatio)
  const proportionalWidth = clampSize(requestedWidth, Math.min(constrainedMinWidth, constrainedMaxWidth), constrainedMaxWidth)
  const proportionalHeight = proportionalWidth / aspectRatio
  return {
    x: dir.includes('w') ? right - proportionalWidth : x,
    y: dir.includes('n') ? bottom - proportionalHeight : y,
    width: proportionalWidth,
    height: proportionalHeight,
  }
}

/** Converts browser selection fragments into compact, page-relative line boxes. */
export function normalizeTextHighlightRects(
  rects: ArrayLike<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>>,
  page: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
): TextHighlightBox[] {
  if (page.width <= 0 || page.height <= 0) return []
  const clipped = Array.from(rects).flatMap((rect) => {
    const left = Math.max(page.left, rect.left)
    const top = Math.max(page.top, rect.top)
    const right = Math.min(page.right, rect.right)
    const bottom = Math.min(page.bottom, rect.bottom)
    return right - left >= 0.75 && bottom - top >= 0.75
      ? [{ left, top, right, bottom, width: right - left, height: bottom - top }]
      : []
  }).sort((a, b) => a.top - b.top || a.left - b.left)

  const lines: typeof clipped = []
  for (const rect of clipped) {
    const previous = lines.at(-1)
    const sameLine = previous
      && Math.abs(rect.top - previous.top) <= Math.max(2, Math.min(rect.height, previous.height) * 0.35)
      && Math.abs(rect.bottom - previous.bottom) <= Math.max(2, Math.min(rect.height, previous.height) * 0.35)
    const closeEnough = previous && rect.left <= previous.right + Math.max(6, Math.min(rect.height, previous.height) * 0.5)
    if (previous && sameLine && closeEnough) {
      previous.left = Math.min(previous.left, rect.left)
      previous.top = Math.min(previous.top, rect.top)
      previous.right = Math.max(previous.right, rect.right)
      previous.bottom = Math.max(previous.bottom, rect.bottom)
      previous.width = previous.right - previous.left
      previous.height = previous.bottom - previous.top
    } else lines.push({ ...rect })
  }

  return lines.map((rect) => ({
    x: (rect.left - page.left) / page.width,
    y: (rect.top - page.top) / page.height,
    width: rect.width / page.width,
    height: rect.height / page.height,
  }))
}

export const pdfPageDisplayRatio = (
  size: PdfSource['pageSizes'][number] | undefined,
  rotation: number,
) => {
  if (!size?.width || !size.height) return 1.414
  const quarterTurn = Math.abs(rotation % 180) === 90
  return quarterTurn ? size.width / size.height : size.height / size.width
}

export const pdfPageRenderProfile = (
  visibility: PageVisibility,
  compact: boolean,
  quality: RenderQuality,
  devicePixelRatio: number,
  displayZoom = 1,
) => {
  if (compact) {
    return { pixelRatio: Math.min(Math.max(devicePixelRatio, 1), 1.25), maxOutput: 1.25, maxPixels: 420_000, maxDimension: 1536 }
  }
  if (visibility === 'preload') {
    return { pixelRatio: Math.min(Math.max(devicePixelRatio, 1), 1.5), maxOutput: 1.5, maxPixels: 2_000_000, maxDimension: 3072 }
  }
  if (quality === 'sharp') {
    // Keep roughly the same source-detail budget while zooming out. A fixed
    // 2x backing store becomes only half/quarter as detailed at 50%/25%, which
    // makes scans and hairlines irreversibly soft before Chromium composites
    // the canvas. Pixel and dimension budgets below still cap large pages.
    const detailRatio = 2 / Math.max(displayZoom, 0.25)
    return { pixelRatio: Math.min(Math.max(devicePixelRatio, detailRatio), 8), maxOutput: 8, maxPixels: 24_000_000, maxDimension: 12_288 }
  }
  return { pixelRatio: Math.max(devicePixelRatio, 1), maxOutput: 1.75, maxPixels: 7_000_000, maxDimension: 4096 }
}

export const pdfPageUsesCompactProfile = (
  compact: boolean,
  textLayer: boolean,
  visibility: PageVisibility,
) => compact || (!textLayer && visibility !== 'visible')

export function preparePdfCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  smoothing: ImageSmoothingQuality,
) {
  // Resizing resets every 2D context property, so dimensions must be assigned
  // before requesting/configuring the context. No inline style size is set:
  // the stylesheet keeps the canvas stretched to the page box, so the previous
  // frame can stay visible (scaled) while the next one renders offscreen.
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = smoothing
  return context
}

// Identity is the PDF page/orientation and the actual physical sampling grid,
// not the CSS zoom or a fractional requested DPR. Several zoom levels reach
// the *same* output under the source-detail/pixel limits. Different outputs
// get distinct LRU entries rather than overwriting a useful return frame.
export function pdfFramePlan(
  pageKey: string, natural: { width: number; height: number }, renderWidth: number,
  visibility: PageVisibility, compact: boolean, quality: RenderQuality, dpr: number,
) {
  const cssWidth = Math.max(1, Math.round(renderWidth))
  const profile = pdfPageRenderProfile(visibility, compact, quality, dpr, cssWidth / natural.width / PDF_CSS_UNITS)
  const { display, output } = pdfRenderScale(cssWidth, cssWidth * natural.height / natural.width,
    natural.width, profile.pixelRatio, profile.maxOutput, profile.maxPixels, profile.maxDimension)
  const scale = display * output
  // Avoid allocating an extra pixel when a mathematically integral edge is
  // a few machine epsilons above that integer.
  const width = Math.max(1, Math.ceil(natural.width * scale - 1e-7))
  const height = Math.max(1, Math.ceil(natural.height * scale - 1e-7))
  const smoothing: ImageSmoothingQuality = compact ? 'low' : visibility === 'visible' && quality === 'sharp' ? 'high' : 'medium'
  return { key: `${pageKey}|${width}x${height}|${smoothing}`, width, height, smoothing, scale }
}

type ScheduledRender = {
  id: number
  priority: number
  run: () => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  cancelled: boolean
  started: boolean
}

/** A scheduled/in-flight stage render that survives effect re-runs when the
 * next commit still wants the same page at (nearly) the same width. */
type RenderSession = {
  key: string
  width: number
  visibility: PageVisibility
  /** Profile inputs the run() closure captured; adoption must re-check them. */
  quality: RenderQuality
  dpr: number
  textLayer: boolean
  cancelled: boolean
  adopted: boolean
  sharpen: boolean
  scheduled?: ReturnType<typeof schedulePdfRender>
  renderTask?: { cancel: () => void; promise: Promise<void> }
}
const MAX_CONCURRENT_PDF_RENDERS = 4
const MAX_BACKGROUND_PDF_RENDERS = 3
const renderQueue: ScheduledRender[] = []
let activeRenderCount = 0
let activeBackgroundRenderCount = 0
let nextRenderId = 1

/** Preserve the existing three-render background throughput, with one burst slot
 * reserved for a newly visible page so tail jumps do not wait behind preloads. */
export function canStartPdfRender(
  priority: number,
  activeCount: number,
  activeBackgroundCount: number,
) {
  return activeCount < MAX_CONCURRENT_PDF_RENDERS
    && (priority === 0 || activeBackgroundCount < MAX_BACKGROUND_PDF_RENDERS)
}

function pumpRenderQueue() {
  renderQueue.sort((a, b) => a.priority - b.priority || a.id - b.id)
  while (activeRenderCount < MAX_CONCURRENT_PDF_RENDERS) {
    const job = renderQueue[0]
    if (!job) return
    if (job.cancelled) {
      renderQueue.shift()
      continue
    }
    if (!canStartPdfRender(job.priority, activeRenderCount, activeBackgroundRenderCount)) return
    renderQueue.shift()
    job.started = true
    activeRenderCount += 1
    const background = job.priority > 0
    if (background) activeBackgroundRenderCount += 1
    void job.run().then(job.resolve, job.reject).finally(() => {
      activeRenderCount -= 1
      if (background) activeBackgroundRenderCount -= 1
      pumpRenderQueue()
    })
  }
}

function schedulePdfRender(priority: number, run: () => Promise<void>) {
  let job!: ScheduledRender
  const promise = new Promise<void>((resolve, reject) => {
    job = { id: nextRenderId++, priority, run, resolve, reject, cancelled: false, started: false }
    renderQueue.push(job)
    pumpRenderQueue()
  })
  return {
    promise,
    /** True once the job left the queue and its run() began. */
    get started() {
      return job.started
    },
    cancel() {
      if (job.cancelled) return
      job.cancelled = true
      if (!job.started) {
        const index = renderQueue.indexOf(job)
        if (index >= 0) renderQueue.splice(index, 1)
        job.resolve()
      }
    },
  }
}

const warming = new WeakMap<ReturnType<typeof pdfFrameOwner>, Map<string, ReturnType<typeof schedulePdfRender>>>()

function orientedPageSize(source: PdfSource, page: number, rotation: number) {
  if (page < 0 || page >= source.pageCount || (!source.pageSizesLoaded && !source.pageSizeLoaded?.[page])) return
  const size = source.pageSizes[page]
  return rotation % 180 ? { width: size.height, height: size.width } : size
}

/**
 * Single-page reader prewarm: render a neighbor page into the LRU frame cache
 * at the same width/profile the stage will need, so the next flip restores
 * from cache instead of waiting for a full render. Runs below every other
 * priority; the returned cancel drops the job while it is still queued.
 */
export function prewarmPdfPageRender(
  source: PdfSource, sourcePage: number, rotation: number, renderWidth: number,
  renderQuality: RenderQuality, dpr = window.devicePixelRatio || 1,
) {
  const size = orientedPageSize(source, sourcePage, rotation)
  if (!size || !renderWidth || source.id === 'blank') return () => undefined
  const pageKey = `page:${source.id}:${sourcePage}:${rotation}`
  const plan = pdfFramePlan(pageKey, size, renderWidth, 'visible', false, renderQuality, dpr)
  const owner = pdfFrameOwner(source)
  let jobs = warming.get(owner)
  if (!jobs) warming.set(owner, jobs = new Map())
  if (pageFrames.get(owner, plan.key) || jobs.has(plan.key)) return () => undefined
  const job = schedulePdfRender(4, async () => {
    if (!owner.live || pageFrames.get(owner, plan.key)) return
    retainPdfPageResources(source, sourcePage)
    let scratch: HTMLCanvasElement | undefined
    try {
      const page = await getPdfPage(source, sourcePage)
      if (!owner.live) return
      const viewport = page.getViewport({ scale: plan.scale, rotation: (page.rotate + rotation + 360) % 360 })
      scratch = document.createElement('canvas')
      const context = preparePdfCanvas(scratch, plan.width, plan.height, plan.smoothing)
      if (!context) return
      await page.render({ canvasContext: context, viewport }).promise
      pageFrames.put(owner, plan.key, scratch)
      scratch = undefined
    } finally {
      if (scratch) scratch.width = scratch.height = 0
      if (owner.live) releasePdfPageResources(source, sourcePage)
    }
  })
  jobs.set(plan.key, job)
  void job.promise.catch(() => undefined).finally(() => { if (jobs.get(plan.key) === job) jobs.delete(plan.key) })
  // A queued warm can be dropped; one already rasterizing can be joined by
  // the stage on the imminent flip. The document's lifetime guard handles close.
  return () => job.cancel()
}

export function PdfPage({
  item, pendingText,
  source,
  zoom = 1,
  query = '',
  textLayer = true,
  renderQuality = 'sharp',
  devicePixelRatio: displayPixelRatio,
  compact = false,
  className,
  tool = 'pan',
  /**
   * Master switch for every creation/editing interaction on the page surface.
   * Thumbnails pass false so tools can never create (or half-edit
   * undeletable) annotations outside the real stage pages.
   */
  interactive = true,
  onAddAnnotation,
  onAddTextHighlights,
  onTextEditSelection,
  onAddDrawing,
  drawingColor = '#2563eb',
  drawingWidth = 3,
  drawingFilled = false,
  onRemoveAnnotation,
  onUpdateAnnotation,
  onSetImageExportMode,
  onActivateText,
  selectedAnnotationIds = new Set(),
  primaryAnnotationId,
  onSelectAnnotation,
  onClearAnnotationSelection,
  activeNoteId,
  onActivateNote,
  onFillText,
  onInsertFormBlank,
  onInsertImage,
  onCrop,
  onExtractCrop,
  onCancelCrop,
  onUseHandTool,
  onUseSelectTool,
  onExportPageImage,
  onPageProperties,
  onResizePage,
  onAddBookmark,
  onOcrPage,
  onAddToWorkspace,
  watermark,
  watermarkSelected = false,
  onSelectWatermark,
  onChangeWatermark,
  onRemoveWatermark,
}: PdfPageProps) {
  const motionEnabled = useContext(AppMotion)
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<PageTextLayerHandle>(null)
  const measuredWidth = useRef(0)
  const resizeTimer = useRef<number>()
  const sourcePageSize = item.sourceId === 'blank'
    ? item.pageSize ?? { width: 595.28, height: 841.89 }
    : source?.pageSizes[item.sourcePage]
  const compactMode = compact || !textLayer
  const [ratio, setRatio] = useState(() => pdfPageDisplayRatio(sourcePageSize, item.rotation))
  const [renderWidth, setRenderWidth] = useState(0)
  // The canvas may keep its last bitmap while resizing; selectable characters
  // must use the current paper width, not the delayed rasterization width.
  const [textWidth, setTextWidth] = useState(0)
  const [visibility, setVisibility] = useState<PageVisibility>('hidden')
  const [loading, setLoading] = useState(true)
  const [drawingDraft, setDrawingDraft] = useState<Omit<Markup, 'id'>>()
  const [formFields, setFormFields] = useState<PdfFormField[]>([])
  const [textSelectionAction, setTextSelectionAction] = useState<{
    boxes: TextHighlightBox[]
    text: string
    x: number
    y: number
  }>()
  const [imageContextMenu, setImageContextMenu] = useState<{
    annotationId: string
    x: number
    y: number
    trigger: HTMLElement
  }>()
  const [pageContextMenu, setPageContextMenu] = useState<{
    x: number
    y: number
    pageX: number
    pageY: number
    canCopyText: boolean
  }>()
  const drawing = useRef<{
    startX: number; startY: number; moved: boolean
    pointerId: number
    points: { x: number; y: number }[]
    draft?: Omit<Markup, 'id'>
  }>()
  /** Page identity of the frame currently in the canvas; '' means blank. */
  const paintedKey = useRef('')
  /** Sampling grid currently displayed (the visible canvas is not owned by the LRU). */
  const paintedFrame = useRef('')
  /** In-flight render of the current page; adopted across effect re-runs. */
  const renderSession = useRef<RenderSession>()
  /** Bumped when an adopted render lands at a drifted width, triggering one
   *  sharp re-render at the settled width without a skeleton flash. */
  const [sharpenTick, setSharpenTick] = useState(0)
  /** Skeleton fade-out: keep the placeholder mounted for one transition after
   *  the first frame lands, then unmount it — a static block while rendering,
   *  a quick fade when the content arrives, no pulsing. */
  const skeletonWasNeeded = useRef(false)
  const [skeletonFading, setSkeletonFading] = useState(false)
  /** Set when a drag-created text box should swallow the trailing click. */
  const suppressClick = useRef(false)
  const pointerDownInAnnotation = useRef(false)
  /** Guards stale transitionend/timeout cleanups of the rotation animation. */
  const spinToken = useRef(0)
  const previousRotation = useRef(item.rotation)
  // "label:" blank detection (Adobe Fill & Sign): span geometry is cached per
  // text-layer version, rebuilt lazily on the next hover after a mutation.
  const [formBlankPreview, setFormBlankPreview] = useState<{
    x: number; y: number; width: number; height: number; fontSizePt: number
  } | null>(null)
  const formBlankCache = useRef<{ spans: FormBlankSpan[]; pageWidth: number; pageHeight: number } | null>(null)
  const formBlankFrame = useRef(0)

  useEffect(() => {
    setTextSelectionAction(undefined)
    drawing.current = undefined; setDrawingDraft(undefined)
  }, [item.id, tool])

  useEffect(() => {
    setRatio(pdfPageDisplayRatio(sourcePageSize, item.rotation))
  }, [item.rotation, item.sourcePage, source, sourcePageSize?.height, sourcePageSize?.width])

  useLayoutEffect(() => {
    const element = pageRef.current
    if (!element) return
    const update = (entry?: ResizeObserverEntry) => {
      // The compositor can be mid-turn when ResizeObserver delivers. Measure the
      // layout box, not the axis-aligned screen bounds of the rotated paper.
      const width = Math.max(1, entry?.contentRect.width ?? element.clientWidth)
      if (textLayer) setTextWidth(previous => Math.abs(previous - width) < .25 ? previous : width)
      if (resizeTimer.current) {
        window.clearTimeout(resizeTimer.current)
        resizeTimer.current = undefined
      }
      if (Math.abs(width - measuredWidth.current) < 0.25) return
      // Render the first frame immediately; debounce later zoom/resize bursts so
      // PDF.js does not start and cancel a large canvas on every slider tick.
      if (!measuredWidth.current) {
        measuredWidth.current = width
        setRenderWidth(width)
      }
      else {
        resizeTimer.current = window.setTimeout(() => {
          measuredWidth.current = width
          setRenderWidth(width)
          resizeTimer.current = undefined
        }, 80)
      }
    }
    update()
    const unobserve = observeSharedResize(element, update)
    return () => {
      unobserve()
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current)
      resizeTimer.current = undefined
    }
  }, [textLayer])

  // Rotation swaps the page box's aspect ratio in the same commit; measure the
  // new width synchronously instead of waiting for the ResizeObserver's 80ms
  // debounce. Otherwise the canvas renders twice per rotation — once at the
  // stale pre-rotation width (wasted full-DPI raster, cancelled mid-flight)
  // and once at the correct width.
  useLayoutEffect(() => {
    const element = pageRef.current
    if (!element || !measuredWidth.current) return
    if (resizeTimer.current) {
      window.clearTimeout(resizeTimer.current)
      resizeTimer.current = undefined
    }
    const width = Math.max(1, element.clientWidth)
    if (Math.abs(width - measuredWidth.current) >= 0.25) {
      measuredWidth.current = width
      setRenderWidth(width)
    }
  }, [item.rotation])

  // Smooth rotation animation: the layout box snaps to the new aspect ratio
  // instantly, but the composited content (canvas + all layers, all absolutely
  // positioned children) spins from the old orientation to the new one on the
  // GPU — no canvas work happens during the spin. Pointer events are suspended
  // mid-spin because hit-test coordinates would be off while rotated.
  useLayoutEffect(() => {
    const previous = previousRotation.current
    previousRotation.current = item.rotation
    const element = pageRef.current
    if (!motionEnabled || !element || previous === item.rotation || compactMode) return
    let delta = ((item.rotation - previous) % 360 + 360) % 360
    if (delta === 270) delta = -90
    const token = ++spinToken.current
    const cleanup = (event?: TransitionEvent) => {
      if (spinToken.current !== token || (event && (event.target !== element || event.propertyName !== 'transform'))) return
      element.style.transition = ''
      element.style.transform = ''
      delete element.dataset.turning
      element.removeEventListener('transitionend', cleanup)
    }
    element.addEventListener('transitionend', cleanup)
    element.dataset.turning = ''
    element.style.transition = 'none'
    element.style.transform = `rotate(${-delta}deg)`
    // Force the pre-rotation frame to paint before transitioning to identity.
    void element.offsetWidth
    element.style.transition = 'transform 220ms var(--ease)'
    element.style.transform = ''
    const fallback = window.setTimeout(cleanup, 320)
    return () => {
      window.clearTimeout(fallback)
      cleanup()
    }
  }, [compactMode, item.rotation, motionEnabled])

  // Zoom changes alter the page's layout width synchronously; the canvas keeps
  // showing the previous frame stretched by CSS while the ResizeObserver above
  // coalesces the burst (80ms debounce) and the sharp frame is rendered
  // offscreen. This trades per-tick re-renders for one render per gesture.

  useEffect(() => {
    const element = pageRef.current
    if (!element) return
    let nearby = false
    let onScreen = false
    const update = () => setVisibility(onScreen ? 'visible' : nearby ? 'preload' : 'hidden')
    const unobservePreload = observeSharedIntersection(element, (entry) => {
      nearby = entry.isIntersecting
      update()
    }, compactMode ? '640px 0px' : '1800px 0px')
    const unobserveVisible = observeSharedIntersection(element, (entry) => {
      onScreen = entry.isIntersecting
      update()
    })
    return () => {
      unobservePreload()
      unobserveVisible()
    }
  }, [compactMode])

  const visible = visibility === 'visible'
  const renderable = visibility !== 'hidden'
  const pageKey = `${compactMode ? 'thumb' : 'page'}:${item.sourceId}:${item.sourcePage}:${item.rotation}`

  // Static placeholder while the first frame renders (no pulsing); once the
  // frame lands it fades out over ~180ms and then unmounts. The render-scope
  // `||=` keeps it mounted through the render where `needed` first flips
  // false; the effect below starts the fade timer afterwards.
  const skeletonNeeded = loading
    && paintedKey.current !== pageKey
    && !paintedKey.current.startsWith(`${compactMode ? 'thumb' : 'page'}:${item.sourceId}:${item.sourcePage}:`)
  skeletonWasNeeded.current ||= skeletonNeeded
  useEffect(() => {
    if (!motionEnabled) {
      setSkeletonFading(false)
      skeletonWasNeeded.current = false
      return
    }
    if (skeletonNeeded || !skeletonWasNeeded.current) return
    skeletonWasNeeded.current = false
    setSkeletonFading(true)
    const timer = window.setTimeout(() => setSkeletonFading(false), 200)
    return () => window.clearTimeout(timer)
  }, [skeletonNeeded, motionEnabled])

  // Displayed page size in PDF points (post-rotation), for watermark geometry.
  const basePointSize = item.sourceId === 'blank' || !sourcePageSize?.width || !sourcePageSize.height
    ? { width: 595.28, height: 841.89 }
    : sourcePageSize
  const watermarkQuarterTurn = Math.abs(item.rotation % 180) === 90
  const pageWidthPt = watermarkQuarterTurn ? basePointSize.height : basePointSize.width
  const pageHeightPt = watermarkQuarterTurn ? basePointSize.width : basePointSize.height

  useEffect(() => {
    if (!renderable || !source || item.sourceId === 'blank') return
    retainPdfPageResources(source, item.sourcePage)
    return () => releasePdfPageResources(source, item.sourcePage, compactMode ? 20_000 : 60_000)
  }, [compactMode, item.sourceId, item.sourcePage, renderable, source])

  useEffect(() => {
    if (!source || item.sourceId === 'blank' || !renderWidth) {
      setLoading(false)
      return
    }
    if (!renderable) {
      const session = renderSession.current
      renderSession.current = undefined
      if (session) {
        session.cancelled = true
        session.scheduled?.cancel()
        session.renderTask?.cancel()
      }
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 1
        canvas.height = 1
      }
      paintedKey.current = ''
      paintedFrame.current = ''
      setLoading(true)
      return
    }
    // Every effect run that leaves a live session behind returns this cleanup.
    // It marks the session dead, but lets the NEXT synchronous effect setup
    // adopt it (microtask ordering) before the queued cancellation lands.
    // Adopting runs must return it too: without a lifeline the adopted session
    // could never be cancelled on unmount or on a key-changing transition.
    const releaseRenderSession = (session: RenderSession) => () => {
      session.cancelled = true
      session.adopted = false
      queueMicrotask(() => {
        if (session.adopted) return
        session.scheduled?.cancel()
        session.renderTask?.cancel()
        if (renderSession.current === session) renderSession.current = undefined
      })
    }
    // Adopt an in-flight render of the same page instead of cancelling it.
    // Transient width settles — the fit-zoom rAF after import, or the real
    // page size replacing the 612x792 placeholder — previously threw away
    // nearly-finished full-DPI renders and repainted from scratch, doubling
    // the wait on open and on every cold page jump.
    const existing = renderSession.current
    if (existing && existing.key === pageKey) {
      const drift = Math.abs(existing.width - renderWidth)
      if (drift < 0.5 || drift / renderWidth <= 0.2) {
        const upgrade = visibility === 'visible' && existing.visibility !== 'visible'
        // The run() closure captured quality/dpr/textLayer at creation; a
        // toggle mid-render makes the in-flight frame stale-profile.
        const profileStale = existing.quality !== renderQuality
          || existing.dpr !== (displayPixelRatio ?? 0)
          || existing.textLayer !== textLayer
        // A still-queued job wins nothing from adoption: a fresh session gets
        // the burst priority and the right profile in ONE render, instead of
        // landing the stale frame and sharpening with a second one.
        const supersede = (upgrade || profileStale) && !!existing.scheduled && !existing.scheduled.started
        if (!supersede) {
          existing.adopted = true
          existing.cancelled = false
          // Small drift: the landing frame is stretched slightly; sharpen at
          // the settled width once it paints. A visibility upgrade or a stale
          // profile sharpens too.
          if (drift >= 0.5 || upgrade || profileStale) existing.sharpen = true
          existing.visibility = visibility
          return releaseRenderSession(existing)
        }
      }
    }
    // No adoption: cancel whatever session the ref still holds. This must run
    // for key MISMATCHES too (rotation/sourcePage change) — an orphaned
    // session would otherwise paint its stale frame onto the live canvas.
    if (existing) {
      renderSession.current = undefined
      existing.cancelled = true
      existing.scheduled?.cancel()
      existing.renderTask?.cancel()
    }
    const session: RenderSession = {
      key: pageKey,
      width: renderWidth,
      visibility,
      quality: renderQuality,
      dpr: displayPixelRatio ?? 0,
      textLayer,
      cancelled: false,
      adopted: false,
      sharpen: false,
    }
    renderSession.current = session
    const owner = pdfFrameOwner(source)
    const foreground = !compactMode && visibility === 'visible'
    const cache = compactMode ? thumbnailFrames : pageFrames
    const makePlan = (size: { width: number; height: number }) => pdfFramePlan(pageKey, size, renderWidth,
      visibility, pdfPageUsesCompactProfile(compact, textLayer, visibility), renderQuality,
      displayPixelRatio ?? window.devicePixelRatio ?? 1)
    const finish = () => {
      if (renderSession.current === session) renderSession.current = undefined
      if (session.sharpen && !session.cancelled && owner.live) setSharpenTick(value => value + 1)
    }
    const present = (bitmap: HTMLCanvasElement, plan: ReturnType<typeof makePlan>) => {
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d', { alpha: false, desynchronized: true })
      if (!canvas || !context) return false
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      context.drawImage(bitmap, 0, 0)
      paintedKey.current = pageKey
      paintedFrame.current = plan.key
      ;(window as unknown as { __painted?: (key: string) => void }).__painted?.(pageKey)
      setLoading(false)
      return true
    }
    const restore = (plan: ReturnType<typeof makePlan>) => {
      const canvas = canvasRef.current
      if (paintedKey.current === pageKey && (paintedFrame.current === plan.key
        || (visibility === 'preload' && canvas && canvas.width >= plan.width && canvas.height >= plan.height))) {
        setLoading(false)
        return true
      }
      const bitmap = cache.get(owner, plan.key, foreground)
      return !!bitmap && present(bitmap, plan)
    }
    // Recently visited pages already know their geometry. Restore immediately:
    // no scheduler slot, worker round-trip or full-page raster on a cache hit.
    const known = orientedPageSize(source, item.sourcePage, item.rotation)
    if (known && restore(makePlan(known))) {
      setRatio(known.height / known.width)
      finish()
      return
    }
    const priority = foreground ? 0 : !compactMode ? 1 : visibility === 'visible' ? 2 : 3
    session.scheduled = schedulePdfRender(priority, async () => {
      if (session.cancelled || !owner.live) return
      setLoading(true)
      const page = await getPdfPage(source, item.sourcePage)
      if (session.cancelled || !owner.live) return
      const rotation = (page.rotate + item.rotation + 360) % 360
      const natural = page.getViewport({ scale: 1, rotation })
      const plan = makePlan(natural)
      setRatio(natural.height / natural.width)
      if (restore(plan)) return
      const warm = warming.get(owner)?.get(plan.key)
      if (warm?.started) {
        // Do not compete with an already rasterizing neighbor. If it failed
        // (or was evicted under pressure), the foreground render still runs.
        await warm.promise.catch(() => undefined)
        if (session.cancelled || !owner.live || restore(plan)) return
      } else warm?.cancel()
      ;(window as unknown as { __renderStart?: (key: string, priority: number, width: number, visibility: string) => void }).__renderStart?.(pageKey, priority, renderWidth, visibility)
      let scratch: HTMLCanvasElement | undefined = document.createElement('canvas')
      try {
        const context = preparePdfCanvas(scratch, plan.width, plan.height, plan.smoothing)
        if (!context) return
        session.renderTask = page.render({ canvasContext: context, viewport: page.getViewport({ scale: plan.scale, rotation }) })
        await session.renderTask.promise
        if (session.cancelled || !owner.live || !present(scratch, plan)) return
        // Move the completed scratch bitmap to the LRU. No third canvas/copy;
        // future sessions (including cancelled renders) never resize this one.
        cache.put(owner, plan.key, scratch, foreground)
        scratch = undefined
      } finally {
        if (scratch) scratch.width = scratch.height = 0
      }
    })
    void session.scheduled.promise.catch(() => {
      if (!session.cancelled) setLoading(false)
    }).finally(finish)
    return releaseRenderSession(session)
  }, [compact, compactMode, displayPixelRatio, item.sourceId, item.sourcePage, item.rotation, renderQuality, renderWidth, renderable, source, textLayer, visibility, sharpenTick])

  useEffect(() => {
    let cancelled = false
    if (!interactive || tool !== 'fill' || !visible || !source || item.sourceId === 'blank') {
      setFormFields([])
      return
    }
    void getPdfFormFields(source, item.sourcePage, item.rotation)
      .then((fields) => { if (!cancelled) setFormFields(fields) })
      .catch(() => { if (!cancelled) setFormFields([]) })
    return () => { cancelled = true }
  }, [interactive, item.rotation, item.sourceId, item.sourcePage, source, tool, visible])

  useEffect(() => {
    if (!imageContextMenu) return
    const close = () => setImageContextMenu(undefined)
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const trigger = imageContextMenu.trigger
      close()
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }))
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [imageContextMenu])

  useEffect(() => {
    if (!pageContextMenu) return
    const close = () => setPageContextMenu(undefined)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [pageContextMenu])

  // Invalidate the form-blank span cache whenever the text layer re-renders
  // (zoom, OCR arrival, rotation). The cache rebuilds lazily on the next hover
  // so the async pdf.js text layer never leaves us measuring stale spans.
  useEffect(() => {
    formBlankCache.current = null
    setFormBlankPreview(null)
    const layer = textLayerRef.current?.getElement()
    if (!interactive || !layer) return
    const observer = new MutationObserver(() => { formBlankCache.current = null })
    observer.observe(layer, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(formBlankFrame.current)
      formBlankCache.current = null
      setFormBlankPreview(null)
    }
  }, [interactive, item.ocr, renderWidth, ratio, source, textLayer, visible])

  const updateFormBlankPreview = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !onInsertFormBlank || (tool !== 'pan' && tool !== 'fill') || !textLayer) return
    if ((event.target as HTMLElement).closest('.annotation, .form-blank-preview')) return
    const { clientX, clientY } = event
    cancelAnimationFrame(formBlankFrame.current)
    formBlankFrame.current = requestAnimationFrame(() => {
      const page = pageRef.current
      const layer = textLayerRef.current?.getElement()
      if (!page || !layer) return
      // Selecting text across the layer must not pop a preview under the drag.
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) { setFormBlankPreview(null); return }
      const pageRect = page.getBoundingClientRect()
      let cache = formBlankCache.current
      if (!cache) {
        const spans: FormBlankSpan[] = []
        for (const span of layer.querySelectorAll('span')) {
          const text = span.textContent ?? ''
          if (!text.trim()) continue
          const rect = span.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) continue
          spans.push({
            text,
            left: rect.left - pageRect.left,
            top: rect.top - pageRect.top,
            right: rect.right - pageRect.left,
            bottom: rect.bottom - pageRect.top,
            // getComputedStyle per span is the expensive part — only pay it
            // for runs that can actually open a blank.
            fontSize: /[:：]\s*$/.test(text) ? parseFloat(getComputedStyle(span).fontSize) || undefined : undefined,
          })
        }
        cache = { spans, pageWidth: pageRect.width, pageHeight: pageRect.height }
        formBlankCache.current = cache
      }
      const blank = findFormBlankAt(cache.spans, { x: clientX - pageRect.left, y: clientY - pageRect.top }, cache.pageWidth)
      if (!blank) { setFormBlankPreview(null); return }
      const pxToPt = 1 / (PDF_CSS_UNITS * zoom)
      setFormBlankPreview({
        x: blank.left / cache.pageWidth,
        y: blank.top / cache.pageHeight,
        width: blank.width / cache.pageWidth,
        height: blank.height / cache.pageHeight,
        fontSizePt: Math.max(6, Math.min(72, blank.fontSizePx * pxToPt)),
      })
    })
  }

  const clearFormBlankPreview = () => {
    cancelAnimationFrame(formBlankFrame.current)
    setFormBlankPreview(null)
  }

  const addMarkup = (event: React.MouseEvent<HTMLDivElement>) => {
    // Thumbnails render this page read-only; creation tools stay stage-only.
    if (!interactive) return
    // A drag that just created an annotation still produces a trailing click;
    // swallow exactly one so no second fixed-size box appears.
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (tool !== 'text' && tool !== 'fill' && tool !== 'highlight' && tool !== 'note') {
      // Ctrl+click multi-select on a text box calls preventDefault on
      // pointerdown; Chrome then retargets the trailing click to the page
      // surface, which would otherwise instantly clear the selection.
      if (!pointerDownInAnnotation.current && !(event.target as HTMLElement).closest('.annotation, .watermark-ui-layer')) onClearAnnotationSelection?.()
      return
    }
    if ((event.target as HTMLElement).closest('.annotation')) return
    // The body-drag pointerdown calls preventDefault, so Chrome retargets the
    // trailing click to the page surface. Without this guard a plain body drag
    // (or click) on a text box would spawn a phantom default box here.
    if (pointerDownInAnnotation.current) return
    const selection = window.getSelection()
    if (tool === 'highlight' && selection && !selection.isCollapsed && selection.toString().trim()) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    onClearAnnotationSelection?.()
    if (tool === 'fill') {
      const height = Math.max(0.035, Math.min(0.075, 38 / rect.height))
      onFillText?.({
        x: Math.max(0, Math.min(0.96, x)),
        y: Math.max(0, Math.min(1 - height, y - height / 2)),
        width: Math.max(0.08, Math.min(0.32, 0.98 - x)),
        height,
        multiline: false,
      })
      return
    }
    onAddAnnotation?.(tool, x, y)
  }

  const captureTextSelection = () => {
    if (!interactive) return
    const editTextMode = (tool as string) === 'edit-text'
    if ((tool !== 'pan' && tool !== 'highlight' && !editTextMode)
      || (editTextMode ? !onTextEditSelection : !onAddTextHighlights)) return
    const selection = window.getSelection()
    const layer = textLayerRef.current?.getElement()
    const page = pageRef.current
    if (!selection || selection.isCollapsed || !selection.rangeCount || !layer || !page) return
    const range = selection.getRangeAt(0)
    if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
    const selectedText = (textLayerRef.current?.selectionText() ?? selection.toString()).trim()
    if (!selectedText) return

    const pageBounds = page.getBoundingClientRect()
    const fragments: Array<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>> = []
    for (const span of rangeSelectedSpans(layer.querySelectorAll('span'), range)) {
      const textNode = span.firstChild
      if (!(textNode instanceof Text)) continue
      if (layer.dataset.ocr === 'true') {
        // OCR spans already carry PaddleOCR's normalized word box. Use that
        // geometry instead of transparent font glyph metrics, which drift on
        // handwriting and rotated scans. Partial-word selections highlight the
        // recognized word, matching common PDF reader behavior.
        const x = Number(span.dataset.ocrX)
        const y = Number(span.dataset.ocrY)
        const width = Number(span.dataset.ocrWidth)
        const height = Number(span.dataset.ocrHeight)
        if (Number.isFinite(x + y + width + height) && width > 0 && height > 0) {
          fragments.push({
            left: pageBounds.left + x * pageBounds.width,
            top: pageBounds.top + y * pageBounds.height,
            right: pageBounds.left + (x + width) * pageBounds.width,
            bottom: pageBounds.top + (y + height) * pageBounds.height,
            width: width * pageBounds.width,
            height: height * pageBounds.height,
          })
        }
        continue
      }
      const fragment = document.createRange()
      fragment.selectNodeContents(textNode)
      if (range.startContainer === textNode) fragment.setStart(textNode, range.startOffset)
      if (range.endContainer === textNode) fragment.setEnd(textNode, range.endOffset)
      fragments.push(...fragment.getClientRects())
      fragment.detach()
    }
    const boxes = normalizeTextHighlightRects(fragments, pageBounds)
    if (!boxes.length) return

    if (tool === 'highlight') {
      onAddTextHighlights?.(boxes, selectedText)
      selection.removeAllRanges()
      setTextSelectionAction(undefined)
      return
    }
    if (editTextMode) {
      onTextEditSelection?.(boxes, selectedText)
      selection.removeAllRanges()
      setTextSelectionAction(undefined)
      return
    }
    const left = Math.min(...boxes.map((box) => box.x))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    setTextSelectionAction({ boxes, text: selectedText, x: (left + right) / 2, y: Math.min(...boxes.map((box) => box.y)) })
  }

  // Latest-callback ref keeps the listeners attached once per tool change
  // instead of re-registering on every render of every interactive page.
  const captureRef = useRef(captureTextSelection)
  captureRef.current = captureTextSelection

  useEffect(() => {
    if (!interactive || !textLayer || (tool !== 'pan' && tool !== 'highlight' && (tool as string) !== 'edit-text')) return
    let frame = 0
    const scheduleCapture = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => captureRef.current())
    }
    window.addEventListener('pointerup', scheduleCapture)
    window.addEventListener('keyup', scheduleCapture)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointerup', scheduleCapture)
      window.removeEventListener('keyup', scheduleCapture)
    }
  }, [interactive, textLayer, tool])

  const drawingPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    }
  }

  const normalizedInk = (points: { x: number; y: number }[]): Omit<Markup, 'id'> => {
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const width = Math.max(0.002, Math.max(...xs) - minX)
    const height = Math.max(0.002, Math.max(...ys) - minY)
    const x = Math.min(minX, 1 - width)
    const y = Math.min(minY, 1 - height)
    return {
      type: 'ink',
      x,
      y,
      width,
      height,
      points: points.map((point) => ({
        x: (point.x - x) / width,
        y: (point.y - y) / height,
      })),
      color: drawingColor,
      strokeWidth: drawingWidth,
      filled: false,
      opacity: 1,
    }
  }

  const updateDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    const state = drawing.current
    if (!state || state.pointerId !== event.pointerId) return
    if (!(event.buttons & 1)) { drawing.current=undefined;setDrawingDraft(undefined);return }
    state.moved ||= Math.hypot(event.clientX-state.startX,event.clientY-state.startY)>=4
    event.preventDefault()
    const point = drawingPoint(event)
    if (tool === 'draw') {
      const previous = state.points.at(-1)
      // Avoid over-sampling tiny pointer movements; this keeps long strokes light.
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.0015) state.points.push(point)
      state.draft = normalizedInk(state.points)
      setDrawingDraft(state.draft)
      return
    }
    if (tool !== 'rectangle' && tool !== 'ellipse' && tool !== 'text') return
    const origin = state.points[0]
    const width = Math.max(0.01, Math.abs(point.x - origin.x))
    const height = Math.max(0.01, Math.abs(point.y - origin.y))
    const x = Math.min(1 - width, Math.min(origin.x, point.x))
    const y = Math.min(1 - height, Math.min(origin.y, point.y))
    state.draft = tool === 'text'
      ? { type: 'text', x, y, width, height, text: '', color: '#18324a', fontSize: 16, fontFamily: 'Microsoft YaHei', opacity: 1 }
      : {
          type: tool,
          x,
          y,
          width,
          height,
          color: drawingColor,
          strokeWidth: drawingWidth,
          filled: drawingFilled,
          opacity: 1,
        }
    setDrawingDraft(state.draft)
  }

  const startDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (tool !== 'draw' && tool !== 'rectangle' && tool !== 'ellipse' && tool !== 'text') return
    if (event.button !== 0 || !event.isPrimary || drawing.current || (event.target as HTMLElement).closest('.annotation, button, input, textarea, .watermark-ui-layer')) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = drawingPoint(event)
    drawing.current = { pointerId: event.pointerId, startX:event.clientX, startY:event.clientY, moved:false, points: [point] }
    if (tool === 'draw') drawing.current.draft = normalizedInk([point])
    else if (tool === 'text') drawing.current.draft = {
      type: 'text',
      x: Math.min(0.99, point.x),
      y: Math.min(0.99, point.y),
      width: 0.01,
      height: 0.01,
      text: '',
      color: '#18324a',
      fontSize: 16,
      fontFamily: 'Microsoft YaHei',
      opacity: 1,
    }
    else drawing.current.draft = {
      type: tool,
      x: Math.min(0.99, point.x),
      y: Math.min(0.99, point.y),
      width: 0.01,
      height: 0.01,
      color: drawingColor,
      strokeWidth: drawingWidth,
      filled: drawingFilled,
      opacity: 1,
    }
    setDrawingDraft(drawing.current.draft)
  }

  const finishDrawing = (event: React.PointerEvent<HTMLDivElement>, commit = true) => {
    if (!interactive) return
    if (!drawing.current || drawing.current.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const draft = drawing.current.draft
    if (commit && draft) {
      if (draft.type === 'text') {
        // A near-zero drag is a click: let addMarkup place the default box.
        if (drawing.current.moved) {
          suppressClick.current = true
          // If the pointer was released off-page no click follows; never let a
          // stale flag swallow the user's next real click.
          window.setTimeout(() => { suppressClick.current = false }, 0)
          onAddAnnotation?.('text', draft.x, draft.y, { width: draft.width, height: draft.height })
        }
      } else if(drawing.current.moved) onAddDrawing?.(draft)
    }
    drawing.current = undefined
    setDrawingDraft(undefined)
  }

  return (
    <div
      ref={pageRef}
      className={`pdf-page ${className ?? ''}`}
      data-drawing-tool={(['draw', 'rectangle', 'ellipse', 'text'] as Tool[]).includes(tool) ? tool : undefined}
      style={{ aspectRatio: `1 / ${ratio}` }}
      onClick={addMarkup}
      onPointerDownCapture={(event) => {
        // Capture phase survives the stopPropagation in annotation pointer
        // handlers, so the trailing click knows whether the press started
        // inside an annotation (see addMarkup). The watermark interaction
        // chrome lives on an unclipped sibling layer (.watermark-ui-layer),
        // not inside the .annotation tile, so it must count as annotation too.
        pointerDownInAnnotation.current = Boolean((event.target as HTMLElement).closest('.annotation, .watermark-ui-layer'))
      }}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest('.text-selection-action')) setTextSelectionAction(undefined)
        startDrawing(event)
      }}
      onPointerMove={(event) => { updateDrawing(event); updateFormBlankPreview(event) }}
      onPointerLeave={clearFormBlankPreview}
      onPointerUp={(event) => {
        finishDrawing(event)
      }}
      onPointerCancel={(event) => finishDrawing(event, false)}
      onLostPointerCapture={event=>finishDrawing(event,false)}
      onContextMenu={(event) => {
        // On thumbnails the sidebar article owns the context menu; never
        // preventDefault here or the page menu (rotate/replace/note) dies.
        if (!interactive) return
        const target = event.target as HTMLElement
        if (target.closest('textarea,input,select,.annotation--image')) return
        const canCopyText = textLayerRef.current?.ownsSelection() ?? false
        if (!canCopyText && !onUseHandTool && !onUseSelectTool && !onExportPageImage && !onAddAnnotation
          && !onPageProperties && !onResizePage && !onAddBookmark && !onOcrPage && !onAddToWorkspace) return
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setImageContextMenu(undefined)
        setPageContextMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 258)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 356)),
          pageX: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
          pageY: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
          canCopyText,
        })
      }}
      onDragOver={(event) => {
        // Non-interactive pages must not swallow drops: the sidebar thumbnail
        // article below handles file replacement via bubbling.
        if (!interactive) return
        if ([...event.dataTransfer.items].some((item) => item.type.startsWith('image/'))) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!interactive) return
        const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'))
        if (!file) return
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        onInsertImage?.(file, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
      }}
      data-tool={tool}
    >
      {item.sourceId !== 'blank' && <canvas ref={canvasRef} aria-label="PDF 页面画布" />}
      <PageTextLayer
        ref={textLayerRef}
        item={item}
        source={source}
        enabled={textLayer}
        renderable={renderable}
        renderWidth={textWidth || renderWidth}
        pageRatio={ratio}
        query={query}
      />
      {formBlankPreview && (
        <button
          type="button"
          className="form-blank-preview"
          aria-label="点击在空白处填写文本"
          title="点击填写"
          style={{
            left: `${formBlankPreview.x * 100}%`,
            top: `${formBlankPreview.y * 100}%`,
            width: `${formBlankPreview.width * 100}%`,
            height: `${formBlankPreview.height * 100}%`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            const blank = formBlankPreview
            setFormBlankPreview(null)
            onInsertFormBlank?.(blank)
          }}
        />
      )}
      <div className="annotation-layer" aria-label="标注层">
        {interactive && pendingText && <AnnotationItem key={pendingText.box.id} creation={pendingText} annotation={pendingText.box} zoom={zoom} interactive selected primary onUpdate={()=>{}} onImageContextMenu={()=>{}} onRemove={()=>{}} onActivate={()=>{}} onSelect={()=>{}} onClearSelection={()=>{}} activeNote={false} onActivateNote={()=>{}}/>}
        {renderable && item.annotations.map((annotation) => (
          <AnnotationItem
            key={annotation.id}
            annotation={annotation}
            zoom={zoom}
            interactive={interactive}
            onUpdate={(patch) => onUpdateAnnotation?.(annotation.id, patch)}
            onImageContextMenu={(x, y, trigger) => {
              onSelectAnnotation?.(annotation.id, false)
              setImageContextMenu({
                annotationId: annotation.id,
                x: Math.max(8, Math.min(x, window.innerWidth - 306)),
                y: Math.max(8, Math.min(y, window.innerHeight - 178)),
                trigger,
              })
            }}
            onRemove={() => onRemoveAnnotation?.(annotation.id)}
            onActivate={() => onActivateText?.(annotation.id)}
            selected={selectedAnnotationIds.has(annotation.id)}
            primary={primaryAnnotationId === annotation.id}
            onSelect={(additive) => onSelectAnnotation?.(annotation.id, additive)}
            onClearSelection={() => onClearAnnotationSelection?.()}
            activeNote={annotation.type === 'note' && activeNoteId === annotation.id}
            onActivateNote={() => onActivateNote?.(annotation.id)}
          />
        ))}
      </div>
      {renderable && item.inheritedWatermarks?.map((mark, i) => (
        <WatermarkLayer key={i} watermark={mark} interactive={false} selected={false}
          zoom={zoom} pageWidthPt={pageWidthPt} pageHeightPt={pageHeightPt} />
      ))}
      {renderable && watermark && (
        <WatermarkLayer
          watermark={watermark}
          interactive={interactive && tool === 'watermark'}
          selected={watermarkSelected}
          zoom={zoom}
          pageWidthPt={pageWidthPt}
          pageHeightPt={pageHeightPt}
          onSelect={onSelectWatermark}
          onChange={onChangeWatermark}
          onRemove={onRemoveWatermark}
          onDone={onUseSelectTool}
        />
      )}
      {interactive && tool === 'fill' && formFields.length > 0 && (
        <div className="form-field-layer" aria-label={`识别到 ${formFields.length} 个可填写文本字段`}>
          {formFields.filter((field) => !field.hidden).map((field) => (
            <button
              key={field.id}
              type="button"
              className="form-field-target"
              disabled={field.readOnly}
              aria-label={`${field.name || '文本字段'}${field.required ? '，必填' : ''}${field.readOnly ? '，只读' : '，点击填写'}`}
              title={field.readOnly ? '只读字段' : `填写 ${field.name || '文本字段'}`}
              style={{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onFillText?.(field) }}
            >
              <span>{field.name || '填写'}</span>
            </button>
          ))}
        </div>
      )}
      {drawingDraft && <DrawingGraphic annotation={drawingDraft} draft />}
      {interactive && tool === 'crop' && (
        <CropOverlay key={`${item.id}:${item.rotation}`} initial={item.crop} onApply={onCrop} onExtract={onExtractCrop} onCancel={onCancelCrop ?? onUseSelectTool} />
      )}
      {interactive && textSelectionAction && tool === 'pan' && (
        <button
          type="button"
          className="text-selection-action"
          style={{ left: `${textSelectionAction.x * 100}%`, top: `${textSelectionAction.y * 100}%` }}
          aria-label={`高亮已选择的文字：${textSelectionAction.text.slice(0, 40)}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onAddTextHighlights?.(textSelectionAction.boxes, textSelectionAction.text)
            window.getSelection()?.removeAllRanges()
            setTextSelectionAction(undefined)
          }}
        >
          <Highlighter size={14} /> 高亮
        </button>
      )}
      {(skeletonNeeded || skeletonFading || skeletonWasNeeded.current) && (
        <div className="page-skeleton" data-done={!skeletonNeeded || undefined} aria-hidden="true" />
      )}
      {item.sourceId === 'blank' && <span className="blank-label">A4 空白页</span>}
      {pageContextMenu && createPortal((() => {
        const run = (action?: () => void) => {
          action?.()
          setPageContextMenu(undefined)
        }
        return (
          <div
            className="page-context-menu page-surface-context-menu"
            role="menu"
            aria-label="当前页面操作"
            style={{
              left: pageContextMenu.x,
              top: pageContextMenu.y,
              maxHeight: Math.max(120, window.innerHeight - pageContextMenu.y - 8),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'ArrowDown' ? (index + 1) % items.length
                : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
              if (next < 0) return
              event.preventDefault()
              items[next]?.focus()
            }}
          >
            <button autoFocus role="menuitem" disabled={!onUseHandTool} onClick={() => run(onUseHandTool)}><Hand size={14} /><span>手型工具</span><kbd>H</kbd></button>
            <button role="menuitem" disabled={!onUseSelectTool} onClick={() => run(onUseSelectTool)}><MousePointer2 size={14} /><span>选择工具</span><kbd>V</kbd></button>
            {pageContextMenu.canCopyText && <button role="menuitem" onClick={() => run(() => { void textLayerRef.current?.copySelection() })}><Copy size={14} /><span>复制所选内容</span><kbd>Ctrl+C</kbd></button>}
            <span className="page-context-menu__line" />
            <button role="menuitem" disabled={!onAddToWorkspace} onClick={() => run(onAddToWorkspace)}><Layers3 size={14} /><span>加入工作区</span></button>
            <button role="menuitem" disabled={!onExportPageImage} onClick={() => run(onExportPageImage)}><FileImage size={14} /><span>当页转换为图片输出</span></button>
            <button role="menuitem" disabled={!onAddAnnotation} onClick={() => run(() => onAddAnnotation?.('note', pageContextMenu.pageX, pageContextMenu.pageY))}><MessageSquareText size={14} /><span>在此处插入备注</span></button>
            <button role="menuitem" disabled={!onPageProperties} onClick={() => run(onPageProperties)}><Info size={14} /><span>查看页面属性</span></button>
            <button role="menuitem" disabled={!onResizePage} onClick={() => run(onResizePage)}><Maximize2 size={14} /><span>调整页面大小</span></button>
            <button role="menuitem" disabled={!onAddBookmark} onClick={() => run(onAddBookmark)}><BookmarkPlus size={14} /><span>添加书签</span></button>
            <button role="menuitem" disabled={!onOcrPage || item.sourceId === 'blank'} onClick={() => run(onOcrPage)}><ScanText size={14} /><span>OCR 识别本页</span></button>
          </div>
        )
      })(), document.body)}
      {imageContextMenu && createPortal((() => {
        const annotation = item.annotations.find((entry) => entry.id === imageContextMenu.annotationId)
        if (!annotation || annotation.type !== 'image') return null
        const mode = annotation.imageExportMode ?? 'object'
        const choose = (nextMode: 'object' | 'flatten-page') => {
          onSetImageExportMode?.(annotation.id, nextMode)
          setImageContextMenu(undefined)
        }
        return (
          <div
            className="page-context-menu image-context-menu"
            role="menu"
            aria-label="图片导出方式"
            style={{
              left: imageContextMenu.x,
              top: imageContextMenu.y,
              maxHeight: Math.max(120, window.innerHeight - imageContextMenu.y - 8),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'ArrowDown' ? (index + 1) % items.length
                : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
              if (next < 0) return
              event.preventDefault()
              items[next]?.focus()
            }}
          >
            <div className="image-context-menu__heading"><ImageIcon size={14} /> 图片导出方式</div>
            <button autoFocus role="menuitemradio" aria-checked={mode === 'object'} onClick={() => choose('object')}>
              <MousePointer2 size={15} />
              <span><strong>高清页面内容</strong><small>保持清晰；专业编辑器仍可能识别图片</small></span>
              {mode === 'object' && <Check size={14} />}
            </button>
            <button role="menuitemradio" aria-checked={mode === 'flatten-page'} onClick={() => choose('flatten-page')}>
              <Layers2 size={15} />
              <span><strong>彻底融入整页…</strong><small>覆盖原内容，导出后不能单独识别</small></span>
              {mode === 'flatten-page' && <Check size={14} />}
            </button>
          </div>
        )
      })(), document.body)}
    </div>
  )
}

function AnnotationItem({
  annotation, creation,
  zoom,
  interactive,
  onUpdate,
  onImageContextMenu,
  onRemove,
  onActivate,
  selected,
  primary,
  onSelect,
  onClearSelection,
  activeNote,
  onActivateNote,
}: {
  annotation: Markup
  creation?: PendingText
  zoom: number
  /** False on thumbnails: annotations render as inert previews (no focus, no edit affordances). */
  interactive: boolean
  onUpdate: (patch: Partial<Markup>) => void
  onImageContextMenu: (x: number, y: number, trigger: HTMLElement) => void
  onRemove: () => void
  onActivate: () => void
  selected: boolean
  primary: boolean
  onSelect: (additive: boolean) => void
  onClearSelection: () => void
  activeNote: boolean
  onActivateNote: () => void
}) {
  const [draft, setDraft] = useState(annotation)
  const [dragging, setDragging] = useState(false)
  const [dragMode, setDragMode] = useState<'move'|'resize'|'rotate'|null>(null)
  const object = useRef<HTMLDivElement>(null), input=useRef<HTMLTextAreaElement>(null)
  const latestDraft=useRef(draft), session=useRef(creation), finished=useRef(false), dirtyInput=useRef(false)
  latestDraft.current=draft;session.current=creation
  const finishNew=(select=false,cancel=false)=>{
    if(finished.current || !session.current)return
    finished.current=true;session.current.onFinish(cancel?{...latestDraft.current,text:''}:latestDraft.current,select)
  }
  const owns=(node:EventTarget|null)=>node instanceof Element && (object.current?.contains(node) || node.closest('[data-editor-owner]')?.getAttribute('data-editor-owner')===annotation.id || !!node.closest('.color-palette-popover,.eyedrop-hint'))
  useLayoutEffect(()=>{
    if(!session.current)return
    const field=input.current!,shell=field.closest('.app-shell');field.focus({preventScroll:true})
    const flush=()=>finishNew(false);shell?.addEventListener('paperwork-flush-text',flush)
    const outside=(ev:Event)=>{if(!owns(ev.target))finishNew()}
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside)
    return()=>{shell?.removeEventListener('paperwork-flush-text',flush);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);if(!finished.current&&latestDraft.current.text?.trim())finishNew()}
  },[annotation.id])
  const teardownDrag = useRef<() => void>(), stopHold = useRef<() => void>(), positionRail = useRef<() => void>()
  useEffect(()=>()=>{stopHold.current?.();teardownDrag.current?.()},[])
  const discardEdit = useRef(false)
  const pointerFocus = useRef(false)
  useEffect(() => {if(!session.current)setDraft(annotation)}, [annotation])
  const itemSelected = selected || activeNote

  const activate = () => {
    if (draft.type === 'note') {
      onActivateNote()
      return
    }
    if (draft.type === 'text') onActivate()
  }

  const startPointer = (event: React.PointerEvent, mode: 'move'|'resize'|'rotate', dir:AnnotationResizeDir='se') => {
    if (!interactive || event.button!==0 || !event.isPrimary || teardownDrag.current) return
    stopHold.current?.()
    const el=object.current, target=event.target as HTMLElement
    const page=el?.closest('.annotation-layer')?.getBoundingClientRect()
    if(!el || !page || !page.width || !page.height)return
    const captureNode=mode==='move'?el:event.currentTarget as HTMLElement
    const textBody=mode==='move' && draft.type==='text' && target.closest('textarea')
    if(mode==='move' && !textBody && target.closest('button,input,select,textarea,.object-tools'))return
    const pointer=event.pointerId, start={x:event.clientX,y:event.clientY}, initial={...draft}
    const centre={x:page.left+(initial.x+initial.width/2)*page.width,y:page.top+(initial.y+initial.height/2)*page.height}
    const additive=event.ctrlKey||event.metaKey||event.shiftKey
    const begin=(holdPoint?:{x:number;y:number}, firstMove?:PointerEvent)=>{
      if(!el.isConnected)return
      if(holdPoint){start.x=holdPoint.x;start.y=holdPoint.y}
      // Defocus the textarea only after a deliberate hold; an ordinary drag
      // before the timer fires is a native character selection.
      if(!(creation && document.activeElement===input.current)){pointerFocus.current=true;el.focus({preventScroll:true});pointerFocus.current=false}
      if(!creation && (!selected || additive))onSelect(mode==='move' && !textBody && additive)
      if(!creation && initial.type!=='note')activate()
      const unpin=mode==='move'?undefined:holdObjectCursor(mode==='rotate'?'var(--object-turn-cursor)':gripCursor(dir,initial.rotation??0))
      let latest=initial,moved=false
      setDragging(true);setDragMode(mode)
      const fastMove=mode==='move'?objectMovePreview(el,initial,page,start,initial.type==='text'?undefined:()=>positionRail.current?.()):undefined
      const updateFrom=(ev:PointerEvent)=>{
        const dx=ev.clientX-start.x,dy=ev.clientY-start.y
        if(!moved && Math.hypot(dx,dy)<2)return
        moved=true
        if(mode==='rotate') latest={...initial,rotation:turnFrom(start,{x:ev.clientX,y:ev.clientY},centre,initial.rotation??0,ev.shiftKey)}
        else if(fastMove){fastMove.move(ev);return}
        else {
          const minH=initial.formFieldId?0.005:initial.type==='text'?textMinHeightFraction(initial.autoFit?4:initial.fontSize??16,page.height/(PDF_CSS_UNITS*zoom),zoom):0.035
          const aspect=dir.length===2 && ev.ctrlKey
          latest={...initial,...resizeAtGrip(initial,dir,dx,dy,page.width,page.height,initial.rotation??0,{aspect,minW:initial.formFieldId?0.005:0.05,minH})}
        }
        setDraft(latest)
      }
      const samples=frameSampler(updateFrom)
      const detach=()=>{
        samples.cancel();fastMove?.dispose();unpin?.()
        teardownDrag.current=undefined
        window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',lost,true);el.removeEventListener('lostpointercapture',lost);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',escape,true)
        if(captureNode.hasPointerCapture(pointer))captureNode.releasePointerCapture(pointer)
      }
      const stop=()=>{detach();setDragging(false);setDragMode(null)}
      const cancel=()=>{stop();setDraft(initial)}
      const escape=(ev:KeyboardEvent)=>{if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();cancel()}}
      const lost=(ev:PointerEvent)=>{if(ev.pointerId===pointer)cancel()}
      const move=(ev:PointerEvent)=>{if(ev.pointerId!==pointer)return;if(!(ev.buttons&1)){cancel();return}ev.preventDefault();if(fastMove)updateFrom(ev);else samples.push(ev)}
      const up=(ev:PointerEvent)=>{
        if(ev.pointerId!==pointer || ev.button!==0)return
        samples.cancel();updateFrom(ev);if(fastMove){latest={...initial,...fastMove.finish(ev)};moved=latest.x!==initial.x||latest.y!==initial.y;if(moved)setDraft(latest)}stop();if(!moved){if(initial.type==='note')onActivateNote();return}
        if(creation){latestDraft.current=latest;setDraft(latest);return}
        if(mode==='rotate'){if(latest.rotation!==(initial.rotation??0))onUpdate({rotation:latest.rotation});return}
        if(mode==='move'){if(latest.x!==initial.x||latest.y!==initial.y)onUpdate({x:latest.x,y:latest.y});return}
        const next=latest.autoFit?{...latest,fontSize:fitTextFontSize(latest.text??'',latest.width*page.width/zoom/PDF_CSS_UNITS-6,latest.height*page.height/zoom/PDF_CSS_UNITS-6,latest.autoFitMaxSize??28,4)}:latest
        if(next.x!==initial.x||next.y!==initial.y||next.width!==initial.width||next.height!==initial.height)onUpdate({x:next.x,y:next.y,width:next.width,height:next.height,...(['image','signature','stamp'].includes(next.type)?{lockAspectRatio:false}:{}),...(next.type==='text'?{fontSize:next.fontSize,imageData:rasterizeText(next)}:{})})
        setDraft(next)
      }
      teardownDrag.current=detach
      try{captureNode.setPointerCapture(pointer)}catch{/* window listeners still own this gesture */}
      window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',lost,true);el.addEventListener('lostpointercapture',lost);window.addEventListener('blur',cancel);window.addEventListener('keydown',escape,true)
      if (firstMove) updateFrom(firstMove)
    }
    if(textBody){
      stopHold.current=armObjectHold(event,begin)
      return
    }
    if(mode==='move' && draft.type==='image' && event.pointerType==='mouse' && !additive && !event.altKey && event.detail<=1){
      // A tap selects. Actual movement starts an image drag without waiting for
      // the timer; a steady press arms the same move at the shorter hold time.
      event.preventDefault();event.stopPropagation()
      if(!selected)onSelect(false)
      pointerFocus.current=true;el.focus({preventScroll:true});pointerFocus.current=false
      stopHold.current=armObjectHold(event,begin,ev=>begin(undefined,ev))
      return
    }
    event.preventDefault();event.stopPropagation();begin()
  }

  const update = (patch: Partial<Markup>) => {
    const next = { ...draft, ...patch }
    // Raising the font size must never clip the first line: grow the box to
    // the new one-line minimum (the resize floor shrinks back down later).
    if (draft.type === 'text' && !next.autoFit && patch.fontSize && draft.pageHeight) {
      const grown = Math.min(1 - next.y, textMinHeightFraction(patch.fontSize, draft.pageHeight, zoom))
      if (next.height < grown) {
        next.height = grown
        patch = { ...patch, height: grown }
      }
    }
    setDraft(next)
    latestDraft.current=next
    if(creation)return
    onUpdate(draft.type === 'text' ? { ...patch, imageData: rasterizeText(next) } : patch)
  }

  // Opacity slider: dragging fires onChange per pixel — commit to the store
  // once on release/blur while the local draft gives live preview. Keyboard
  // stepping commits on blur (pointerup never fires for keys).
  const [opacityDraft, setOpacityDraft] = useState<number>()
  const commitOpacity = () => {
    if (opacityDraft === undefined) return
    update({ opacity: opacityDraft / 100 })
    setOpacityDraft(undefined)
  }

  return (
    <div
      ref={object}
      className={`annotation annotation--${draft.type}${creation?' inline-draft':''}`}
      data-editor-owner={annotation.id}
      data-annotation-id={creation?undefined:draft.id}
      data-form-field={draft.formFieldId || undefined}
      data-selected={itemSelected || undefined}
      data-primary={primary || undefined}
      data-dragging={dragging || undefined}
      data-drag-mode={dragMode ?? undefined}
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        height: `${draft.height * 100}%`,
        color: draft.color,
        background: draft.type === 'highlight' ? draft.color : undefined,
        fontSize: draft.fontSize ? draft.fontSize * PDF_CSS_UNITS * zoom : undefined,
        fontFamily: draft.fontFamily,
        fontWeight: draft.bold ? 700 : 400,
        fontStyle: draft.italic ? 'italic' : 'normal',
        opacity: draft.opacity ?? (draft.type === 'highlight' ? 0.48 : 1),
        transform: draft.rotation ? `rotate(${draft.rotation}deg)` : undefined,
        // Thumbnail previews are inert: `.annotation` re-enables pointer events
        // inside the pointer-events:none layer, so explicitly re-disable here.
        pointerEvents: interactive ? undefined : 'none',
      }}
      tabIndex={!interactive || draft.type === 'note' ? -1 : 0}
      onFocus={() => {
        // Merely tabbing onto a note must not open the side panel. Enter/Space
        // performs activation, while pointer interaction activates before drag.
        if (draft.type !== 'note' && !pointerFocus.current) {
          if (!selected) onSelect(false)
          activate()
        }
      }}
      onKeyDown={(event) => {
        if(creation&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();finishNew(true);return}
        if(event.target===event.currentTarget && draft.type==='text' && selected && !event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
          const p=event.currentTarget.closest('.annotation-layer')?.getBoundingClientRect();if(!p)return
          event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:1
          const x=Math.max(0,Math.min(1-draft.width,draft.x+step*(Number(event.key==='ArrowRight')-Number(event.key==='ArrowLeft'))/p.width))
          const y=Math.max(0,Math.min(1-draft.height,draft.y+step*(Number(event.key==='ArrowDown')-Number(event.key==='ArrowUp'))/p.height))
          if(creation)setDraft(v=>({...v,x,y}));else onUpdate({x,y});return
        }
        if (draft.type === 'image' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onImageContextMenu(rect.right, rect.top + 8, event.currentTarget)
        } else if (draft.type === 'note' && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          event.stopPropagation()
          activate()
        } else if (event.key === 'Escape') { if(creation){event.preventDefault();event.stopPropagation();finishNew(false,true)}else onClearSelection() }
        if (event.key === 'Delete' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
          event.preventDefault()
          event.stopPropagation()
          if(creation)finishNew(false,true);else onRemove()
        }
      }}
      onDragStart={e=>{if (teardownDrag.current && draft.type==='text') e.preventDefault()}}
      onPointerDown={(event) => startPointer(event, 'move')}
      onContextMenu={draft.type === 'image' ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        onImageContextMenu(event.clientX, event.clientY, event.currentTarget)
      } : undefined}
      aria-label={draft.type === 'note' ? undefined : '可编辑标注'}
    >
      {draft.type === 'text' && (
        <textarea
          ref={input} data-inline-draft={creation ? true : undefined} aria-label="文本内容" title="单击编辑；长按拖动文本框"
          aria-required={draft.required || undefined}
          readOnly={!interactive || dragMode === 'move'}
          tabIndex={interactive ? undefined : -1}
          placeholder={draft.autoFit ? '输入内容' : '输入文本'}
          value={draft.text ?? ''}
          data-pending-text={interactive && ((draft.text ?? '') !== (annotation.text ?? '') || draft.fontSize !== annotation.fontSize) || undefined}
          onCompositionStart={e => { e.currentTarget.dataset.composing = 'true' }}
          onCompositionEnd={e => { delete e.currentTarget.dataset.composing }}
          onFocus={() => {discardEdit.current=false;activate()}}
          onPointerDown={(event) => {
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return
            event.preventDefault()
            event.stopPropagation()
            onSelect(true)
          }}
          maxLength={draft.maxLength ?? (draft.autoFit ? 4000 : undefined)}
          onChange={(event) => {
            const text = draft.autoFit && !draft.multiline ? event.target.value.replace(/[\r\n]+/g, ' ') : event.target.value
            if(creation){latestDraft.current={...latestDraft.current,text};const dirty=!!text.trim();if(dirty!==dirtyInput.current){dirtyInput.current=dirty;creation.onDirty(dirty)}}
            const layer = event.currentTarget.closest('.annotation-layer')?.getBoundingClientRect()
            setDraft((current) => ({
              ...current,
              text,
              fontSize: current.autoFit && layer
                ? fitTextFontSize(
                    text,
                    current.width * layer.width / zoom / PDF_CSS_UNITS - 6,
                    current.height * layer.height / zoom / PDF_CSS_UNITS - 6,
                    current.autoFitMaxSize ?? 28,
                    4,
                  )
                : current.fontSize,
            }))
          }}
          onKeyDown={(event) => {
            if(event.nativeEvent.isComposing || event.keyCode===229 || event.currentTarget.hasAttribute('data-composing')) { event.stopPropagation(); return }
            if(creation&&(event.key==='Escape'||(event.key==='Enter'&&(event.ctrlKey||event.metaKey)))){event.preventDefault();event.stopPropagation();finishNew(true,event.key==='Escape');return}
            if ((event.key === 'Enter' && (event.ctrlKey || event.metaKey || (draft.autoFit && !draft.multiline))) || event.key === 'Escape') {
              event.preventDefault();event.stopPropagation();discardEdit.current = event.key === 'Escape';event.currentTarget.blur()
            }
          }}
          onBlur={e => {
            delete e.currentTarget.dataset.composing
            if(creation){if(!owns(e.relatedTarget)&&!e.relatedTarget)finishNew();return}
            if(discardEdit.current){ discardEdit.current=false;setDraft(annotation);return }
            if((draft.text ?? '') === (annotation.text ?? '') && draft.fontSize === annotation.fontSize) return
            onUpdate({text:draft.text,fontSize:draft.fontSize,imageData:rasterizeText(draft)})
          }}
        />
      )}
      {['image', 'signature', 'stamp'].includes(draft.type) && draft.imageData && (
        <img
          src={draft.imageData}
          alt={draft.type === 'stamp' ? '电子章' : draft.type === 'signature' ? '签名' : '插入图片'}
          draggable={false}
          data-free-transform={draft.lockAspectRatio === false || dragMode==='resize' || undefined}
        />
      )}
      {draft.type === 'note' && (
        <span
          id={`note-pin-${draft.id}`}
          className="annotation__note-pin"
          role="button"
          tabIndex={0}
          aria-pressed={activeNote}
          aria-controls={`note-thread-${draft.id}`}
          aria-label={`页面备注，作者 ${draft.author || '未知作者'}，${draft.replies?.length ?? 0} 条回复`}
          onClick={(event) => {
            event.stopPropagation()
            onActivateNote()
          }}
        >
          <MessageSquareText size={11} strokeWidth={2.1} aria-hidden="true" />
        </span>
      )}
      {['ink', 'rectangle', 'ellipse'].includes(draft.type) && <DrawingSvg annotation={draft} />}
      {selected && primary && draft.type === 'text' && dragMode !== 'move' && (
        <PageToolRail owner={annotation.id} anchor={object} geometry={`${draft.x}:${draft.y}:${draft.width}:${draft.height}:${draft.rotation}:${zoom}:${dragMode ?? ''}`} label="文本格式" className="annotation-editor text-format-rail shared-object-rail">
          <ObjectTypography value={draft} onPatch={patch=>update({...patch,...(patch.fontSize?{autoFit:false}:{})})}/>
        </PageToolRail>
      )}
      {selected && primary && ['image', 'signature', 'stamp'].includes(draft.type) && (
        <PageToolRail anchor={object} followMove={positionRail} geometry={`${draft.x}:${draft.y}:${draft.width}:${draft.height}:${draft.rotation}:${zoom}:${dragMode ?? ''}`} label="图片格式" className="annotation-editor annotation-editor--media shared-object-rail">
          {draft.imageExportMode === 'flatten-page' && <span className="annotation-editor__merge-status"><Layers2 size={12} /> 整页融入</span>}
          <button type="button" className="annotation-editor__aspect-toggle" aria-label="恢复图片原始比例" title="恢复图片原始比例；拖角时按 Ctrl 保持当前比例" onClick={()=>{
            const page=object.current?.closest('.annotation-layer')?.getBoundingClientRect();if(!page||!draft.imageAspectRatio)return
            const r=draft.imageAspectRatio*page.height/page.width,w=Math.min(draft.width,draft.height*r),h=w/r
            update({x:draft.x+(draft.width-w)/2,y:draft.y+(draft.height-h)/2,width:w,height:h,lockAspectRatio:true})
          }}><Lock size={13}/><span>原始比例</span></button>
          <label>透明度<input
            aria-label="透明度"
            type="range"
            min="10"
            max="100"
            value={opacityDraft ?? (draft.opacity ?? 1) * 100}
            onChange={(event) => {
              const percent = Number(event.target.value)
              setOpacityDraft(percent)
              setDraft((current) => ({ ...current, opacity: percent / 100 }))
            }}
            onPointerUp={commitOpacity}
            onBlur={commitOpacity}
          /></label>
          <output>{Math.round(draft.rotation ?? 0)}°</output>
        </PageToolRail>
      )}
      {interactive && primary && selected && !['highlight','note'].includes(draft.type) && <ObjectHandles
        label={draft.type==='text'?'文本框':draft.type==='image'?'图片':draft.type==='stamp'?'电子章':draft.type==='signature'?'签名':'图形'} angle={draft.rotation??0} turning={dragMode==='rotate'}
        onStart={(event,mode,dir)=>startPointer(event,mode,dir)} onAngle={rotation=>{setDraft(current=>({...current,rotation}));if(!creation)onUpdate({rotation})}}
        onSizeKey={(e,dir)=>{if(!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const p=object.current?.closest('.annotation-layer')?.getBoundingClientRect();if(!p)return;const step=e.shiftKey?10:1;const b=resizeAtGrip(draft,dir,e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0,p.width,p.height,draft.rotation??0,{aspect:e.ctrlKey,minW:draft.formFieldId?0.005:.05,minH:draft.formFieldId?.length?0.005:draft.type==='text'?textMinHeightFraction(draft.autoFit?4:draft.fontSize??16,p.height/(PDF_CSS_UNITS*zoom),zoom):.035});update({...b,...(['image','signature','stamp'].includes(draft.type)?{lockAspectRatio:false}:{})})}}/>}
      {interactive && itemSelected && <button className="annotation__remove" aria-label="删除标注" onClick={()=>creation?finishNew(false,true):onRemove()}><Trash2 size={12} /></button>}
    </div>
  )
}

function DrawingGraphic({
  annotation,
  draft = false,
}: {
  annotation: Omit<Markup, 'id'>
  draft?: boolean
}) {
  return (
    <div
      className={`annotation annotation--${annotation.type} ${draft ? 'annotation--draft' : ''}`}
      aria-hidden="true"
      style={{
        left: `${annotation.x * 100}%`,
        top: `${annotation.y * 100}%`,
        width: `${annotation.width * 100}%`,
        height: `${annotation.height * 100}%`,
        pointerEvents: 'none',
      }}
    >
      <DrawingSvg annotation={annotation} />
    </div>
  )
}

function DrawingSvg({ annotation }: { annotation: Omit<Markup, 'id'> }) {
  const stroke = annotation.color ?? '#2563eb'
  const strokeWidth = Math.max(1, annotation.strokeWidth ?? 3)
  const common = {
    fill: annotation.filled ? stroke : 'none',
    fillOpacity: annotation.filled ? 0.22 : undefined,
    stroke,
    strokeWidth,
    vectorEffect: 'non-scaling-stroke' as const,
  }
  return (
    <svg
      className="annotation__drawing"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height: '100%', overflow: 'visible' }}
    >
      {annotation.type === 'ink' && (
        <polyline
          points={(annotation.points ?? []).map((point) => `${point.x},${point.y}`).join(' ')}
          {...common}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {annotation.type === 'rectangle' && <rect x="0.01" y="0.01" width="0.98" height="0.98" rx="0.01" {...common} />}
      {annotation.type === 'ellipse' && <ellipse cx="0.5" cy="0.5" rx="0.49" ry="0.49" {...common} />}
    </svg>
  )
}

type CropBox = NonNullable<WorkspacePage['crop']>
type CropDragMode = 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se'

export function adjustCropSelection(box: CropBox, dx: number, dy: number, mode: Exclude<CropDragMode, 'draw'>): CropBox {
  if (mode !== 'move') return resizeAnnotationBox(box, dx, dy, false, 0.01, 0.01, undefined, mode)
  return {
    ...box,
    x: Math.max(0, Math.min(1 - box.width, box.x + dx)),
    y: Math.max(0, Math.min(1 - box.height, box.y + dy)),
  }
}

export function CropOverlay({
  initial,
  onApply,
  onExtract,
  onCancel,
}: {
  initial?: WorkspacePage['crop']
  onApply?: (crop?: WorkspacePage['crop']) => void
  onExtract?: (crop: CropBox) => void
  onCancel?: () => void
}) {
  const [box, setBox] = useState<CropBox | undefined>(initial)
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const overlayRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; box?: CropBox; mode: CropDragMode }>()

  useEffect(() => { (boxRef.current ?? overlayRef.current)?.focus({ preventScroll: true }) }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(undefined)
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const point = (event: React.PointerEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    }
  }
  const start = (event: React.PointerEvent, mode: CropDragMode) => {
    event.stopPropagation()
    if (event.button !== 0) return
    event.preventDefault()
    setMenu(undefined)
    boxRef.current?.focus({ preventScroll: true })
    drag.current = { ...point(event), box, mode, pointerId: event.pointerId }
    overlayRef.current?.setPointerCapture(event.pointerId)
  }
  const update = (event: React.PointerEvent) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    const next = point(event)
    const dx = next.x - active.x
    const dy = next.y - active.y
    setBox(active.mode === 'draw'
      ? { x: Math.min(active.x, next.x), y: Math.min(active.y, next.y), width: Math.abs(dx), height: Math.abs(dy) }
      : active.box ? adjustCropSelection(active.box, dx, dy, active.mode) : undefined)
  }
  const finish = (event: React.PointerEvent, cancel = false) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    if (!cancel) update(event)
    setBox((current) => cancel || !current || current.width < 0.01 || current.height < 0.01 ? active.box : current)
    drag.current = undefined
    if (overlayRef.current?.hasPointerCapture(event.pointerId)) overlayRef.current.releasePointerCapture(event.pointerId)
    // Keep the selection available for further adjustment; only explicit actions apply it.
  }
  const openMenu = (x: number, y: number) => setMenu({
    x: Math.max(8, Math.min(x, window.innerWidth - 228)),
    y: Math.max(8, Math.min(y, window.innerHeight - 160)),
  })
  const cancel = () => {
    setMenu(undefined)
    onCancel?.()
  }

  return (
    <div
      ref={overlayRef}
      className="crop-overlay"
      tabIndex={-1}
      onPointerDown={(event) => start(event, 'draw')}
      onPointerMove={update}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={() => { drag.current = undefined }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        if (menu) { setMenu(undefined); boxRef.current?.focus({ preventScroll: true }) }
        else cancel()
      }}
    >
      {box && <div
        ref={boxRef}
        className="crop-box"
        tabIndex={0}
        role="group"
        aria-label="页面选区，方向键移动，右键拆分页面"
        style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
        onPointerDown={(event) => start(event, 'move')}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY) }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            openMenu(rect.left + 12, rect.top + 12)
            return
          }
          const step = event.shiftKey ? 0.02 : 0.002
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          if (!dx && !dy) return
          event.preventDefault()
          event.stopPropagation()
          setBox((current) => current && adjustCropSelection(current, dx, dy, 'move'))
        }}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            className={`crop-handle crop-handle--${dir}`}
            aria-label={`调整选区${{ nw: '左上', ne: '右上', sw: '左下', se: '右下' }[dir]}角`}
            onPointerDown={(event) => start(event, dir)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.02 : 0.002
              const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
              const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
              if (!dx && !dy) return
              event.preventDefault()
              event.stopPropagation()
              setBox((current) => current && adjustCropSelection(current, dx, dy, dir))
            }}
          />
        ))}
      </div>}
      <div className="crop-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" disabled={!onExtract || !box} onClick={() => box && onExtract?.(box)}>拆分页面</button>
        <button type="button" disabled={!onApply || !box} onClick={() => box && onApply?.(box)}>应用裁剪</button>
        {initial && <button type="button" disabled={!onApply} onClick={() => onApply?.(undefined)}>重置</button>}
        <button type="button" onClick={cancel}>取消</button>
      </div>
      {menu && box && createPortal(
        <div
          className="page-context-menu crop-context-menu"
          role="menu"
          aria-label="选区操作"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length
              : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
            if (next < 0) return
            event.preventDefault()
            event.stopPropagation()
            items[next]?.focus()
          }}
        >
          <button autoFocus type="button" role="menuitem" disabled={!onExtract} onClick={() => { setMenu(undefined); onExtract?.(box) }}><Layers2 size={14} /><span>拆分页面</span></button>
          <button type="button" role="menuitem" disabled={!onApply} onClick={() => { setMenu(undefined); onApply?.(box) }}><Check size={14} /><span>应用裁剪</span></button>
          <button type="button" role="menuitem" onClick={cancel}>取消</button>
        </div>, document.body,
      )}
    </div>
  )
}
