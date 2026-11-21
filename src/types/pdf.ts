export type Tool = 'pan' | 'hand' | 'text' | 'edit-text' | 'fill' | 'highlight' | 'note' | 'crop' | 'draw' | 'rectangle' | 'ellipse' | 'watermark'
export type ViewMode = 'single' | 'continuous' | 'spread'
export type RenderQuality = 'sharp' | 'smooth'
export type PdfCompressionMode = 'lossless' | 'balanced' | 'strong' | 'compact'

export interface PdfDocumentInfo {
  pdfVersion?: string
  title?: string
  author?: string
  subject?: string
  keywords?: string
  createdAt?: string
  modifiedAt?: string
  creator?: string
  producer?: string
  language?: string
  encrypted: boolean
  linearized?: boolean
  hasForms?: boolean
  hasSignatures?: boolean
  fingerprint?: string
  modifiedFingerprint?: string
  /** Private Info hint only. It grants neither watermark ownership nor write access. */
  paperworkWatermarkId?: string
}

export interface PdfFileInfo {
  ofdSignature?: 'unverified'
  importWarnings?: string[]
  size: number
  extension?: string
  createdAt?: string
  modifiedAt?: string
  accessedAt?: string
}

export interface PdfSource {
  id: string
  /** Host-supplied original path for tab identity, never an overwrite destination for converted inputs. */
  originalPath?: string
  /** Workspace-only alias. The original disk filename remains in `name`. */
  displayName?: string
  name: string
  path?: string
  bytes: Uint8Array
  pageCount: number
  pageText: string[]
  pageSizes: { width: number; height: number }[]
  /** Tracks exact geometry independently so 100% never depends on a placeholder. */
  pageSizeLoaded?: boolean[]
  /** True after every source page geometry has been read at least once. */
  pageSizesLoaded?: boolean
  textIndexed: boolean
  documentInfo?: PdfDocumentInfo
  fileInfo?: PdfFileInfo
  /** The read revision belonging to this instance, not another open tab with the same path. */
  desktopGrant?: string
}

export interface NoteReply {
  id: string
  author: string
  text: string
  createdAt: string
  updatedAt?: string
}

export interface CommonPhrase {
  id: string
  text: string
  fontFamily: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  builtIn?: boolean
}

export interface Markup {
  id: string
  type: 'text' | 'highlight' | 'image' | 'signature' | 'stamp' | 'note' | 'ink' | 'rectangle' | 'ellipse'
  x: number
  y: number
  width: number
  height: number
  text?: string
  /** Connects multi-line text-selection rectangles into one native PDF highlight. */
  highlightGroupId?: string
  color?: string
  fontSize?: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  opacity?: number
  rotation?: number
  author?: string
  createdAt?: string
  replies?: NoteReply[]
  imageData?: string
  /** Intrinsic width / height for restoring true media proportions after free transforms. */
  imageAspectRatio?: number
  /** Image/media resize mode. Missing values preserve aspect ratio for legacy documents. */
  lockAspectRatio?: boolean
  /** Points normalized to this annotation's bounding box (0-1). */
  points?: { x: number; y: number }[]
  strokeWidth?: number
  filled?: boolean
  /** Source AcroForm widget id when this text box was created by Fill & Sign. */
  formFieldId?: string
  formFieldName?: string
  formFieldRect?: [number, number, number, number]
  /** Keeps fitted form text inside its detected field while the user types. */
  autoFit?: boolean
  maxLength?: number
  pageAspectRatio?: number
  pageHeight?: number
  autoFitMaxSize?: number
  multiline?: boolean
  required?: boolean
  /**
   * `object` keeps a sharp Image XObject in the page content stream.
   * `flatten-page` rasterizes the final page on export so PDF editors cannot
   * identify this inserted image separately from the original page content.
   */
  imageExportMode?: 'object' | 'flatten-page'
}

export interface PdfFormField {
  id: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  multiline?: boolean
  readOnly?: boolean
  required?: boolean
  hidden?: boolean
  value?: string
  maxLength?: number
  fontSize?: number
  pdfRect?: [number, number, number, number]
}

/**
 * One OCR word positioned against the unrotated source page. Coordinates are
 * normalized (0-1) from the page's top-left, so the layer remains independent
 * of render resolution and zoom.
 */
export interface OcrWord {
  text: string
  rawText?: string
  correctedText?: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  /** Unrotated source height / width; normalized x and y have different physical units. */
  pageAspect?: number
  /** Normalized detection quad (TL,TR,BR,BL). More precise than the AABB for
   * skewed lines: exact line origin, edge lengths, and direction. */
  points?: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
  candidates?: Array<{ text: string; confidence: number }>
  requiresReview?: boolean
}

/** A table reconstructed from OCR geometry or a PaddleOCR-VL markdown result. */
export interface OcrTable {
  id: string
  rows: string[][]
  columnCount: number
  confidence: number
  source: 'geometry' | 'engine'
  /** Normalized top-left page bounds when the table came from positioned words. */
  bounds?: { x: number; y: number; width: number; height: number }
  /** Positioned cell metadata enables rectangular TSV copy from the page text layer. */
  cells?: Array<Array<{
    text: string
    wordIndexes: number[]
    bounds?: { x: number; y: number; width: number; height: number }
  }>>
}

export type OcrMode = 'printed' | 'handwriting' | 'mixed'

export interface OcrPageLayer {
  text: string
  rawText?: string
  correctedText?: string
  confidence?: number
  words: OcrWord[]
  /** Structured rows remain optional so existing OCR layers stay compatible. */
  tables?: OcrTable[]
  engine: string
  version?: string
  mode: OcrMode
  language?: string
  documentType?: 'printed' | 'handwriting' | 'complex'
  warnings?: string[]
  createdAt: string
  /** Incremented when a source page is recognized again. */
  revision: string | number
}

export interface OcrPageResult {
  sourceId: string
  sourcePage: number
  ocr: OcrPageLayer
}

export interface WorkspacePage {
  id: string
  sourceId: string
  // UI workspace section. It may differ from sourceId after cross-file drag;
  // sourceId always remains the immutable PDF content origin.
  groupId?: string
  sourcePage: number
  rotation: number
  annotations: Markup[]
  /** Read-only artwork carried with this page, below the destination document's watermark. */
  inheritedWatermarks?: readonly DocumentWatermark[]
  ocr?: OcrPageLayer
  crop?: { x: number; y: number; width: number; height: number }
  /** Optional output paper size in PDF points; source content is fitted without rasterizing. */
  pageSize?: { width: number; height: number }
}

/** Immutable snapshot passed between independently mounted editing workspaces. */
export interface WorkspaceTransferContent {
  sources: PdfSource[]
  pages: WorkspacePage[]
  suggestedName: string
  scopeLabel: string
}

export interface OutlineNode {
  title: string
  pageIndex?: number
  children: OutlineNode[]
}

/**
 * Document-level watermark shown interactively on every page and burned in at
 * export. All geometry is normalized (0-1) against the displayed page box
 * (post-rotation), so the same config fits any page size. When `tiled` is on,
 * every tile renders from this one config — editing any tile updates all.
 */
export interface DocumentWatermark {
  kind: 'text' | 'image'
  fontFamily?:string
  italic?:boolean
  text?: string
  /** PNG/JPEG data URL. For text watermarks the renderer rasterizes on export. */
  imageData?: string
  color?: string
  bold?: boolean
  opacity: number
  /** CSS-style degrees (clockwise positive), applied about the box center. */
  rotation: number
  tiled: boolean
  /** Normalized box: the single watermark, or one tile's box when tiled. */
  x: number
  y: number
  width: number
  height: number
  /** Normalized gap between tile origins when tiled. */
  gapX?: number
  gapY?: number
}

export interface ExportOptions {
  normalizeA4?: boolean
  watermark?: DocumentWatermark
  /** Optional scope for mixed print queues; added external files are never watermarked implicitly. */
  watermarkPageIds?: ReadonlySet<string>
  removeMetadata?: boolean
  bookmarks?: { title: string; pageId: string }[]
}

export interface PdfCompressionOptions {
  mode: PdfCompressionMode
  /** Terminates the worker even during a synchronous codec or PDF operation. */
  signal?: AbortSignal
}

export interface PdfCompressionProgress {
  stage: 'loading' | 'optimizing' | 'rendering' | 'encoding' | 'saving' | 'complete'
  current: number
  total: number
  skippedLargeImages?: number
}

export interface PdfCompressionResult {
  mode: PdfCompressionMode
  /** Distinct referenced image objects over the per-image pixel or dimension limit. */
  skippedLargeImages: number
  bytes: Uint8Array
  originalSize: number
  /** Size of the generated candidate, even when it was not smaller. */
  attemptedSize: number
  /** Size of `bytes`; equals originalSize when compression had no benefit. */
  compressedSize: number
  savedBytes: number
  savingsRatio: number
  hasGain: boolean
}

export interface PrintOptions {
  copies: number
  duplex: 'simplex' | 'longEdge' | 'shortEdge'
  range: string
  /** Permutation of zero-based merged-queue page indices; apply after range/subset, before reverse and n-up. */
  pageOrder?: number[]
  landscape: boolean
  collate: boolean
  pagesPerSheet: number
  scaleFactor: number
  sizing?: 'fit' | 'actual'
  color: boolean
  deviceName?: string
  margins: 'default' | 'none' | 'printableArea'
  /** Rasterization resolution in DPI (72–600, default 300). */
  dpi?: number
  /** Target paper size; 'auto' keeps each PDF page's own dimensions. */
  paperSize?: 'auto' | 'a4' | 'a5' | 'b5' | 'letter' | 'legal'
  /** Print only odd/even document pages (applied after the page range). */
  subset?: 'all' | 'odd' | 'even'
  /** Print pages back to front (for printers that stack output face-up). */
  reverse?: boolean
  /** Draw a thin hairline border around each page on the sheet. */
  pageBorder?: boolean
}

export interface NativePrinter {
  name: string
  displayName: string
  description?: string
  status: number
  isDefault: boolean
}
