import { lazy, Suspense, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { pageGroupId, planEditorOpen } from './lib/editorDocuments'
import { confirmPdfCopy, downloadBytes, pageSources, prepareStandalonePdfExport, saveWorkspacePdf } from './lib/workspacePdfSave'
import {
  ArrowDown, ArrowUp, BadgeCheck, Bold, CheckCheck, ClipboardPaste, Columns2, Copy, Download, FileText,
  ChevronLeft, ChevronRight, Gauge, Info, Italic, Layers3, Library, ListRestart, LockKeyhole, Maximize, Maximize2, MoveHorizontal, Fullscreen, MessageSquareText, Minus, MoreHorizontal, PanelLeftOpen, Plus, Printer, RotateCcw, RotateCw, Scissors, Search,
  Settings2, Reply, SquareStack, Trash2, Type, Unlock, UserRound, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { clamp, formatBytes, PDF_CSS_UNITS, uid } from './lib/cn'
import { fitTextFontSize, rasterizeText, textMinHeightFraction } from './lib/text'
import {
  buildEditableDocx,
  buildImageDocx,
  extractEditableDocxPages,
  renderPdfPagesToImages,
} from './lib/documentExport'
import { loadShortcutBindings, matchesShortcut, shortcutWithShift, type ShortcutBindings } from './lib/shortcuts'
import { encryptPdfBytes, type PdfEncryptionOptions } from './lib/pdfSecurity'
import { hasSufficientNativeTextLayer } from './lib/ocr'
import { ocrLayerFromResult } from './lib/ocrResultLayer'
import {
  COMMON_PHRASES_STORAGE_KEY,
  LEGACY_COMMON_PHRASES_STORAGE_KEY,
  loadCommonPhrases,
  moveCommonPhrase,
  reorderCommonPhrases,
  serializeCommonPhrases,
} from './lib/phrases'
import {
  composePdf,
  compressPdf,
  savedOriginalBytes,
  snapshotWatermark,
  getPdfPage,
  getPdfFormFields,
  getPdfTextContent,
  imageToPdf,
  imposePdfPages,
  indexPdfText,
  inspectPdf,
  loadPdfPageSizes,
  onPdfPageSizeChange,
  parkImportedPdf,
  pagesForSource,
  parsePageRanges,
  rasterizePdfForPrint,
  readOutline,
  removePdfPassword,
  retainPdfPageResources,
  releasePdfPageResources,
  releasePdfDocument,
  sourceLabel,
  type PdfOpenSecurity,
  type PdfPasswordRequest,
} from './lib/pdf'
import { orderPrintPageIndices } from './lib/printPreview'
import { makePrintProof, type PrintProof } from './lib/printProof'
import { useWorkspace } from './hooks/useWorkspace'
import { useMcpWorkspace } from './hooks/useMcpWorkspace'
const McpPermissionsDialog=lazy(()=>import('./components/McpPermissionsDialog').then(m=>({default:m.McpPermissionsDialog})))
const MarkdownExportDialog=lazy(()=>import('./components/MarkdownExportDialog').then(m=>({default:m.MarkdownExportDialog})))
import { useHandPan } from './hooks/useHandPan'
import { AppMotion, useAppMotion } from './hooks/useAppMotion'
import { PdfPage, prewarmPdfPageRender, type TextHighlightBox } from './components/PdfPage'
import { ColorPalette } from './components/ColorPalette'
import { Toolbar } from './components/Toolbar'
import { DocumentDesk } from './components/DocumentDesk'
import { WorkspaceTabs } from './components/WorkspaceTabs'
import { DEFAULT_OCR_SETTINGS, SettingsPanel, type OcrConnectionStatus, type OcrProvider, type OcrSettings } from './components/SettingsPanel'
import { Button, ToolButton } from './components/ui'
import type { CloseGuardFlow, OcrMode, OcrRunOptions, PageExportOptions, PageImportOperation } from './components/Dialogs'
import type { CommonPhrase, ExportOptions, Markup, OcrPageResult, PdfCompressionMode, PdfCompressionProgress, PdfCompressionResult, PdfFormField, PdfSource, PrintOptions, RenderQuality, Tool, ViewMode, WorkspacePage, WorkspaceTransferContent } from './types/pdf'

import { OFD_MAX_INPUT } from './lib/ofdLimits'
import { MSG_MAX_INPUT, checkMsgSize, openOutlookMemo } from './lib/outlookImport'
import { captureMarkdownSelection, currentMarkdownFragments } from './lib/captureMarkdownSelection'
import type { MarkdownFragment, MarkdownSelectionSnapshot } from './lib/markdownScopeTypes'
import { usePrintInbox } from './hooks/usePrintInbox'
import { nextPrintProjectName, workspaceNameError } from './lib/workspaceNames'

type Mode = 'editor' | 'merge'
type WorkspaceChoice = WorkspaceTransferContent & { withinProject?: { id: string; pages: WorkspacePage[] } }
type Project = { id: string; name: string }
type UserBookmark = { id: string; title: string; pageId: string; sourceId: string; sourcePage: number }
type PendingPageImport = {
  source: PdfSource
  anchorId: string
  operation: PageImportOperation
  replaceIds: Set<string>
}

type PrintQueueItem = {
  id: string
  name: string
  pageCount: number
  size?: number
  origin: 'workspace' | 'file' | 'folder'
  pages: WorkspacePage[]
  sources: PdfSource[]
  external: boolean
  watermark?: ExportOptions['watermark']
}

type PrintFileInput = DesktopFile | PrintPdfFileReference

type PhraseInput = Omit<CommonPhrase, 'id' | 'builtIn'>
type AnnotationSelection = { pageId: string; ids: Set<string>; primaryId: string }
type PasswordPromptRequest = Parameters<PdfPasswordRequest>[0] & { resolve: (password: string | null) => void }

const lazyDialog = <Name extends 'CloseGuardDialog' | 'CompressDialog' | 'ConfirmDialog' | 'ExportDialog' | 'ImagePasteDialog' | 'ImportPagesDialog' | 'OcrDialog' | 'PageExportDialog' | 'PagePropertiesDialog' | 'PageResizeDialog' | 'PasswordDialog' | 'PdfEncryptionDialog' | 'PrintDialog' | 'WatermarkDialog'>(name: Name) =>
  lazy(() => import('./components/Dialogs').then((module) => ({ default: module[name] })))

const ConfirmDialog = lazyDialog('ConfirmDialog')
const CloseGuardDialog = lazyDialog('CloseGuardDialog')
const CompressDialog = lazyDialog('CompressDialog')
const ExportDialog = lazyDialog('ExportDialog')
const ImagePasteDialog = lazyDialog('ImagePasteDialog')
const ImportPagesDialog = lazyDialog('ImportPagesDialog')
const OcrDialog = lazyDialog('OcrDialog')
const PageExportDialog = lazyDialog('PageExportDialog')
const PagePropertiesDialog = lazyDialog('PagePropertiesDialog')
const PageResizeDialog = lazyDialog('PageResizeDialog')
const PasswordDialog = lazyDialog('PasswordDialog')
const PdfEncryptionDialog = lazyDialog('PdfEncryptionDialog')
const PrintDialog = lazyDialog('PrintDialog')
const WatermarkDialog = lazyDialog('WatermarkDialog')
const Sidebar = lazy(() => import('./components/Sidebar').then((module) => ({ default: module.Sidebar })))
const FileInfoDialog = lazy(() => import('./components/Sidebar').then((module) => ({ default: module.FileInfoDialog })))
import { ObjectTypography } from './components/ObjectTypography'
const CommonPhrasesList = lazy(() => import('./components/CommonPhrasesList').then((module) => ({ default: module.CommonPhrasesList })))
const WorkspacePickerDialog = lazy(() => import('./components/WorkspacePickerDialog').then((module) => ({ default: module.WorkspacePickerDialog })))
const ElectronicSealDialog = lazy(() => import('./components/ElectronicSealDialog').then((module) => ({ default: module.ElectronicSealDialog })))

async function browserFileToDesktopFile(file: File): Promise<DesktopFile> {
  const isOfd = /\.ofd$/i.test(file.name)
  // Let the shared import error handler reject oversized files without first
  // materializing the entire File in the browser process.
  const isMsg = /\.msg$/i.test(file.name)
  const tooLarge = (isOfd && file.size > OFD_MAX_INPUT) || (isMsg && file.size > MSG_MAX_INPUT)
  return {
    name: file.name,
    path: window.desktop?.getPathForFile(file) ?? '',
    type: isMsg ? 'msg' : isOfd ? 'ofd' : /\.(png|jpe?g)$/i.test(file.name) ? 'image' : 'pdf',
    bytes: tooLarge ? new Uint8Array() : new Uint8Array(await file.arrayBuffer()),
    size: file.size,
    modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
  }
}

/**
 * OS file-association opens: main resends the same token until acked, and the
 * subscription effect re-runs on dependency changes (and remounts), so token
 * dedupe and open serialization must live outside the component.
 */
const processedExternalOpenTokens = new Set<string>()
let externalOpenQueue: Promise<void> = Promise.resolve()

/** Shared empty array for WorkspaceViews without projects (editor/collector) —
 *  a fresh `[]` default would change identity every render and churn effects. */
const NO_PROJECTS: Project[] = []

/**
 * Per-workspace close registry. Every mounted WorkspaceView (editor, each
 * merge project, collector) registers its display label, dirty flag and save
 * action. Main only cares whether ANY workspace is dirty; the App-level close
 * flow walks the dirty entries one by one, prompting 保存/另存为/不保存 for
 * each. A single shared boolean let a clean view mask a dirty one, silently
 * skipping the close prompt.
 */
type FileCloseTarget = { kind: 'source' | 'all'; ids: Set<string>; label?: string }
type PromptBeforeClose = (entries: ReadonlySet<string> | null, finish: (proceed: boolean) => void) => boolean

type WorkspaceCloseEntry = {
  label: string
  dirty: boolean
  /** Prompt order: 浏览 first, then merge projects in creation order, 打印清单
   *  last. Without it a remounted view (session reset) would sink to the end
   *  of the Map and shuffle the per-file prompt sequence. */
  order: number
  save: (saveAs: boolean) => Promise<boolean>
  getInfo?: () => { pageCount: number; sourceCount: number; dirty: boolean; canUndo: boolean; canRedo: boolean }
}
const workspaceCloseEntries = new Map<string, WorkspaceCloseEntry>()
function syncWorkspaceDirty() {
  window.desktop?.setWorkspaceDirty([...workspaceCloseEntries.values()].some((entry) => entry.dirty))
}
function registerWorkspaceClose(id: string, entry: WorkspaceCloseEntry) {
  workspaceCloseEntries.set(id, entry)
  syncWorkspaceDirty()
}
function forgetWorkspaceClose(id: string) {
  workspaceCloseEntries.delete(id)
  syncWorkspaceDirty()
}

async function inspectDesktopFile(
  file: DesktopFile,
  loadPageSizes = true,
  requestPassword?: PdfPasswordRequest,
  security?: PdfOpenSecurity,
) {
  const isOfd = file.type === 'ofd' || /\.ofd$/i.test(file.name)
  if (isOfd && (file.size ?? file.bytes.byteLength) > OFD_MAX_INPUT) throw new Error('OFD：文件超过 96 MiB 导入上限')
  const ofd = isOfd ? await (await import('./lib/ofd')).previewOfd(file.bytes) : undefined
  const isMsg = file.type === 'msg' || /\.msg$/i.test(file.name)
  if (isMsg) checkMsgSize(file.size ?? file.bytes.byteLength)
  const memo = isMsg ? await openOutlookMemo(file.bytes, window.desktop?.parseOutlookMsg) : undefined
  const bytes = memo?.bytes ?? ofd?.bytes ?? (file.type === 'image' ? await imageToPdf(file) : file.bytes)
  const source = await inspectPdf(
    bytes,
    file.name.replace(/\.(png|jpe?g)$/i, '.pdf'),
    // Converted sources must never become a writable PDF backing file.
    isOfd || isMsg || file.type === 'image' ? undefined : file.path,
    loadPageSizes,
    requestPassword,
    security,
  )
  if (source.path && file.desktopGrant) source.desktopGrant = file.desktopGrant
  source.originalPath = file.path || undefined
  source.fileInfo = {
    ofdSignature:ofd?.signature==='unverified'?'unverified':undefined,
    importWarnings: memo?.warnings?.slice(0, 8),
    size: file.size ?? file.bytes.byteLength,
    extension: file.name.includes('.') ? file.name.split('.').pop()?.toLocaleUpperCase() : undefined,
    createdAt: file.createdAt,
    modifiedAt: file.modifiedAt,
    accessedAt: file.accessedAt,
  }
  return source
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function imageSize(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = reject
    image.src = dataUrl
  })
}

async function normalizePdfImage(dataUrl: string) {
  if (/^data:image\/(png|jpe?g);/i.test(dataUrl)) return dataUrl
  const natural = await imageSize(dataUrl)
  const scale = Math.min(1, 4096 / natural.width, 4096 / natural.height)
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(natural.width * scale))
  canvas.height = Math.max(1, Math.round(natural.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建图片转换画布')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const normalized = canvas.toDataURL('image/png')
  canvas.width = 1
  canvas.height = 1
  return normalized
}

async function transparentStamp(dataUrl: string) {
  const natural = await imageSize(dataUrl)
  const scale = Math.min(1, 2048 / natural.width, 2048 / natural.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(natural.width * scale))
  canvas.height = Math.max(1, Math.round(natural.height * scale))
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const red = pixels.data[index]
    const green = pixels.data[index + 1]
    const blue = pixels.data[index + 2]
    if (red > 245 && green > 245 && blue > 245) pixels.data[index + 3] = 0
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

async function createTocPdf(entries: { title: string; page: number; level: number }[], documentTitle: string) {
  const { PDFDocument } = await import('pdf-lib')
  const output = await PDFDocument.create()
  const perPage = 31
  const safeEntries = entries.length ? entries : [{ title: documentTitle, page: 1, level: 0 }]
  for (let offset = 0; offset < safeEntries.length; offset += perPage) {
    const canvas = document.createElement('canvas')
    canvas.width = 1240
    canvas.height = 1754
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fbfaf7'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#193449'
    context.font = '700 58px "Microsoft YaHei", sans-serif'
    context.fillText('目录', 104, 142)
    context.font = '400 24px "Microsoft YaHei", sans-serif'
    context.fillStyle = '#6b7c88'
    context.fillText(documentTitle, 104, 190)
    context.strokeStyle = '#d9d5cd'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(104, 225)
    context.lineTo(1136, 225)
    context.stroke()
    safeEntries.slice(offset, offset + perPage).forEach((entry, index) => {
      const y = 292 + index * 44
      const indent = Math.min(3, entry.level) * 32
      const title = entry.title.length > 46 ? `${entry.title.slice(0, 45)}…` : entry.title
      context.fillStyle = entry.level === 0 ? '#193449' : '#425765'
      context.font = `${entry.level === 0 ? 600 : 400} 25px "Microsoft YaHei", sans-serif`
      context.fillText(title, 104 + indent, y)
      context.fillStyle = '#80909a'
      context.textAlign = 'right'
      context.fillText(String(entry.page), 1136, y)
      context.textAlign = 'left'
    })
    const png = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (character) => character.charCodeAt(0))
    const image = await output.embedPng(png)
    const page = output.addPage([595.28, 841.89])
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 })
    canvas.width = 1
    canvas.height = 1
  }
  return output.save({ useObjectStreams: true })
}

function formatNoteTime(value?: string) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

async function renderPageForOcr(source: PdfSource, sourcePage: number, mode: OcrMode, workspaceRotation: number) {
  const page = await getPdfPage(source, sourcePage)
  const rotation = ((page.rotate + workspaceRotation) % 360 + 360) % 360
  const natural = page.getViewport({ scale: 1, rotation })
  const targetDpi = mode === 'handwriting' ? 300 : 288
  const maxPixels = mode === 'handwriting' ? 20_000_000 : 18_000_000
  const requestedScale = targetDpi / 72
  const pixelScale = Math.sqrt(maxPixels / Math.max(1, natural.width * natural.height))
  const dimensionScale = 6000 / Math.max(natural.width, natural.height)
  const scale = Math.min(requestedScale, pixelScale, dimensionScale)
  if(!(scale>0) || !Number.isFinite(scale)) throw new Error('页面尺寸无效，无法识别')
  const viewport = page.getViewport({ scale, rotation })
  // OCR engines are prone to clipping glyphs and table rules that touch the
  // raster edge. Render a small white overscan border, then remove it again
  // when mapping recognition boxes into the PDF text layer.
  const padding = Math.max(12, Math.min(32, Math.round(Math.min(viewport.width, viewport.height) * 0.006)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width) + padding * 2)
  canvas.height = Math.max(1, Math.ceil(viewport.height) + padding * 2)
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) throw new Error('无法创建 OCR 页面画布')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, padding, padding] }).promise
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const result = {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength),
    contentBox: { x: padding, y: padding, width: viewport.width, height: viewport.height },
    rotation,
  }
  canvas.width = 1
  canvas.height = 1
  return result
}

function WorkspaceView({
  mode,
  hidden,
  onModeChange,
  projects = NO_PROJECTS,
  activeProjectId,
  onProjectChange,
  onProjectAdd,
  onProjectClose,
  onProjectRename,
  renderQuality,
  onRenderQuality,
  shortcutBindings,
  currentAuthor,
  onCurrentAuthorChange,
  commonPhrases,
  onAddCommonPhrase,onEditCommonPhrase,
  onRemoveCommonPhrase,
  onReorderCommonPhrase,
  onMoveCommonPhrase,
  onOpenSettings,
  settingsOpen,
  displayPixelRatio,
  ocrSettings,
  ocrCapabilities,
  workspaceId,
  closeLabel: closeLabelProp,
  incomingTransfer,
  promptBeforeClose,
  onRequestWorkspaceTransfer,
  onWorkspaceTransferApplied,
  handleExternalOpens, onOpenPrintInbox,
  passwordHistory,
  onPasswordAccepted,
}: {
  mode: Mode
  hidden: boolean
  onModeChange: (mode: Mode) => void
  projects?: Project[]
  activeProjectId?: string
  onProjectChange?: (id: string) => void
  onProjectAdd?: () => void
  onProjectClose?: (id: string) => void
  onProjectRename?: (id: string, name: string) => void
  renderQuality: RenderQuality
  onRenderQuality: (quality: RenderQuality) => void
  shortcutBindings: ShortcutBindings
  currentAuthor: string
  onCurrentAuthorChange: (author: string) => void
  commonPhrases: CommonPhrase[]
  onAddCommonPhrase: (phrase: PhraseInput) => void
  onEditCommonPhrase:(id:string,patch:PhraseInput)=>void
  onRemoveCommonPhrase: (id: string) => void
  onReorderCommonPhrase: (activeId: string, overId: string) => void
  onMoveCommonPhrase: (id: string, delta: -1 | 1) => void
  onOpenSettings: () => void
  settingsOpen: boolean
  displayPixelRatio: number
  ocrSettings: OcrSettings
  ocrCapabilities?: OcrCapabilities
  workspaceId?: string
  /** Name shown for this workspace in the window-close save prompt (merge
   *  views pass the project name; editor/collector derive their own). */
  closeLabel?: string
  incomingTransfer?: WorkspaceTransferContent & { id: string; targetId: string }
  promptBeforeClose: PromptBeforeClose
  onRequestWorkspaceTransfer: (content: WorkspaceChoice) => void
  onWorkspaceTransferApplied?: (id: string, targetId: string, suggestedName: string, wasEmpty: boolean, added: number) => void
  /** Only one mounted view (the editor) may consume OS file-association opens;
   *  hidden views render null and their import would vanish from the UI. */
  onOpenPrintInbox?: () => void
  handleExternalOpens?: boolean
  passwordHistory: PdfPasswordHistoryEntry[]
  onPasswordAccepted: (accepted: { fileName: string; fingerprint?: string; password: string }) => void | Promise<void>
}) {
  const workspace = useWorkspace()
  // Queued external-open tasks read the latest workspace through this ref —
  // their closures capture the state at delivery time, which is stale by the
  // time a serialized second open runs.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [splitSourceIds, setSplitSourceIds] = useState<Set<string>>(new Set())
  const lastPageByGroup = useRef(new Map<string, string>())
  const editorImportTail = useRef<Promise<unknown>>()
  const [stageWidth, setStageWidth] = useState(0)
  const [tool, setTool] = useState<Tool>('pan')
  const [drawingColor, setDrawingColor] = useState('#dc2626')
  const [drawingWidth, setDrawingWidth] = useState(3)
  const [drawingFilled, setDrawingFilled] = useState(false)
  const [zoom, setZoom] = useState(1.15)
  // Live mirror so the Ctrl+wheel rAF can fold any zoom steps that interleaved
  // between the wheel event and its scroll correction into the ratio math.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 700px)').matches)
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 700px)')
    const collapse = () => { if (compact.matches) setSidebarOpen(false) }
    compact.addEventListener('change', collapse)
    return () => compact.removeEventListener('change', collapse)
  }, [])
  const [multiSelect, setMultiSelect] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Typing stays responsive: the per-page scan and the text-layer highlight
  // pass trail the input through the deferred value.
  const deferredQuery = useDeferredValue(query)
  const [pageJumpValue, setPageJumpValue] = useState('0')
  const [searchIndexVersion, setSearchIndexVersion] = useState(0)
  const [searchIndexing, setSearchIndexing] = useState(false)
  const [pageSizeVersion, setPageSizeVersion] = useState(0)
  const [phraseFilter,setPhraseFilter] = useState(''), [noteFilter,setNoteFilter] = useState('')
  const [editingPhrase,setEditingPhrase]=useState<string>()
  const phraseReturn=useRef<HTMLElement|null>(null)
  const phraseDetails = useRef<HTMLDetailsElement>(null), phraseToggle = useRef<HTMLElement>(null)
  const [rightPanel, setRightPanel] = useState<'notes' | 'phrases'>()
  const [activeTextTarget, setActiveTextTarget] = useState<{ pageId: string; annotationId: string }>()
  const [activeNoteTarget, setActiveNoteTarget] = useState<{ pageId: string; annotationId: string }>()
  const [noteEditDraft, setNoteEditDraft] = useState({ author: '', text: '' })
  const [phraseDraft, setPhraseDraft] = useState<PhraseInput>({
    text: '', fontFamily: 'Microsoft YaHei', fontSize: 16, color: '#18324a', bold: false, italic: false,
  })
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [confirmIds, setConfirmIds] = useState<Set<string> | null>(null)
  // Closing files is NOT deleting: separate confirm with wording that makes
  // clear the on-disk source file is never touched.
  const [closeConfirm, setCloseConfirm] = useState<FileCloseTarget | null>(null)
  const [pendingImageFlatten, setPendingImageFlatten] = useState<{ pageId: string; annotationId: string } | null>(null)
  const [ocrOpen, setOcrOpen] = useState(false)
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrLastIssue,setOcrLastIssue]=useState<{sourceIds:string[];message:string}>()
  const [ocrProgress, setOcrProgress] = useState({ stage: '准备 OCR', currentPage: 0, totalPages: 0, sourceName: '' })
  const [printOpen, setPrintOpen] = useState(false)
  const [printQueue, setPrintQueue] = useState<PrintQueueItem[]>([])
  const [mdExport,setMdExport]=useState<{pages:WorkspacePage[];sources:PdfSource[];name:string;selection:MarkdownFragment[]}>()
  const mdSelection=useRef<MarkdownSelectionSnapshot>()
  const [exportOpen, setExportOpen] = useState(false)
  const [watermarkDialogScope, setWatermarkDialogScope] = useState<string>()
  const [selectedWatermarkScope, selectWatermarkScope] = useState<string>()
  const [pageExportIds, setPageExportIds] = useState<string[]>()
  const [pageExportDefaultFormat, setPageExportDefaultFormat] = useState<PageExportOptions['format']>('pdf')
  const [pagePropertiesId, setPagePropertiesId] = useState<string>()
  const [pageResizeId, setPageResizeId] = useState<string>()
  const [userBookmarks, setUserBookmarks] = useState<UserBookmark[]>([])
  const [compressionSourceId, setCompressionSourceId] = useState<string>()
  const [externalCompression, setExternalCompression]=useState<PdfSource>()
  const compressionPicking=useRef(false)
  const [sourceInfoId, setSourceInfoId] = useState<string>()
  const [encryptionSourceId, setEncryptionSourceId] = useState<string>()
  const [encryptionRunning, setEncryptionRunning] = useState(false)
  const [sourceMenu, setSourceMenu] = useState<{ sourceId: string; trigger: HTMLButtonElement; x: number; y: number }>()
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const openSourceMenu = (sourceId: string, trigger: HTMLButtonElement, x?: number, y?: number) => {
    const rect = trigger.getBoundingClientRect()
    setSourceMenu({ sourceId, trigger, x: Math.max(8, Math.min(x ?? rect.left, window.innerWidth - 250)),
      y: Math.max(8, Math.min(y ?? rect.bottom + 5, window.innerHeight - 360)) })
  }
  const closeSourceMenu = useCallback(() => {
    if (sourceMenu?.trigger.isConnected) sourceMenu.trigger.focus({ preventScroll: true })
    setSourceMenu(undefined)
  }, [sourceMenu])
  const [compressionRunning, setCompressionRunning] = useState(false)
  const compressionCandidate = useRef<{source: PdfSource; input: Uint8Array; result: PdfCompressionResult}>()
  const [compressionNotice, setCompressionNotice] = useState('')
  const [choosingCopy, setChoosingCopy] = useState(false)
  const [compressionProgress, setCompressionProgress] = useState<PdfCompressionProgress>()
  const [sealOpen, setSealOpen] = useState(false)
  const [pageClipboard, setPageClipboard] = useState<WorkspacePage[]>([])
  const [annotationSelection, setAnnotationSelection] = useState<AnnotationSelection>()
  useLayoutEffect(() => {
    if (['text','note','draw','rectangle','ellipse','highlight','watermark'].includes(tool)) {
      setAnnotationSelection(undefined)
      setActiveTextTarget(undefined)
    }
  }, [tool])
  const [annotationClipboard, setAnnotationClipboard] = useState<Markup[]>([])
  const [clipboardKind, setClipboardKind] = useState<'pages' | 'annotations'>()
  const [pendingPageImport, setPendingPageImport] = useState<PendingPageImport | null>(null)
  const [pendingImagePaste, setPendingImagePaste] = useState<{ file: File; pageId: string } | null>(null)
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptRequest>()
  const searchRef = useRef<HTMLInputElement>(null)
  const searchResultsRef = useRef<HTMLDivElement>(null)
  const signatureRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const [textPlacement,setTextPlacement] = useState<{pageId:string; box:Markup; nonempty?:boolean}>()
  const [placingImage,setPlacingImage] = useState<{file:File;pageId:string}>()
  const imagePlacementRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>{if(placingImage)imagePlacementRef.current?.focus({preventScroll:true})},[placingImage])
  useEffect(()=>{if(placingImage && (hidden || workspace.activeId!==placingImage.pageId || tool!=='pan')) setPlacingImage(undefined)},[hidden,placingImage,tool,workspace.activeId])
  useEffect(()=>{if(textPlacement && (hidden || workspace.activeId!==textPlacement.pageId))setTextPlacement(undefined)},[hidden,textPlacement,workspace.activeId])
  const stageRef = useRef<HTMLElement>(null)
  useHandPan(stageRef, !hidden && tool === 'hand')
  const noteCardRefs = useRef(new Map<string, HTMLElement>())
  const noteEditCancelRef = useRef<'author' | 'text'>()
  const ocrCancelRef = useRef(false)
  const ocrInFlightRef = useRef(false)
  const ocrInteractionUntilRef = useRef(0)
  const imagePasteActionRef = useRef(false)
  const printSessionRef = useRef(0)
  const printQueueRef = useRef(printQueue)
  const printProofs = useRef(new Map<string, Promise<PrintProof | undefined>>())
  const proofTail = useRef<Promise<unknown>>(Promise.resolve())
  const clipboardTokenRef = useRef('')
  const compressionAbortRef = useRef<AbortController>()
  const workspaceSourcesRef = useRef(workspace.sources)
  const passwordPromptRef = useRef<PasswordPromptRequest>()
  const passwordPromptQueueRef = useRef<PasswordPromptRequest[]>([])
  const appliedTransferRef = useRef<string>()
  printQueueRef.current = printQueue
  workspaceSourcesRef.current = workspace.sources

  const passwordSecurityFor = useCallback((fileName: string): PdfOpenSecurity => {
    const ordered = [
      ...passwordHistory.filter((entry) => entry.documents.includes(fileName)),
      ...passwordHistory.filter((entry) => !entry.documents.includes(fileName)),
    ]
    return {
      passwordCandidates: [...new Set(ordered.map((entry) => entry.password))],
      onPasswordAccepted: ({ fileName: acceptedFileName, fingerprint, password }) =>
        onPasswordAccepted({ fileName: acceptedFileName, fingerprint, password }),
    }
  }, [onPasswordAccepted, passwordHistory])

  const requestPdfPassword = useCallback<PdfPasswordRequest>((request) => new Promise((resolve) => {
    const prompt = { ...request, resolve }
    if (passwordPromptRef.current) {
      passwordPromptQueueRef.current.push(prompt)
      return
    }
    passwordPromptRef.current = prompt
    setPasswordPrompt(prompt)
  }), [])

  const finishPasswordPrompt = useCallback((password: string | null) => {
    const current = passwordPromptRef.current
    if (!current) return
    const next = passwordPromptQueueRef.current.shift()
    passwordPromptRef.current = next
    setPasswordPrompt(next)
    current.resolve(password)
  }, [])

  useEffect(() => () => {
    passwordPromptRef.current?.resolve(null)
    passwordPromptQueueRef.current.splice(0).forEach((prompt) => prompt.resolve(null))
    passwordPromptRef.current = undefined
  }, [])

  const activeSourceIds = useMemo(
    () => new Set(workspace.pages.flatMap((page) => [page.sourceId, pageGroupId(page)])),
    [workspace.pages],
  )
  const visibleSources = useMemo(
    () => workspace.sources.filter((source) => activeSourceIds.has(source.id)),
    [activeSourceIds, workspace.sources],
  )
  useEffect(() => {
    // Most renders have no detached files. Walk bounded undo history only when
    // a source is no longer visible; current clipboard/print jobs still own it.
    if (workspace.sources.length === visibleSources.length) return
    const candidates = workspace.sources.filter(s => !activeSourceIds.has(s.id)).map(s => s.id)
    const pinned = new Set(printQueue.flatMap(job => job.sources.map(s => s.id)))
    if (clipboardKind === 'pages') for (const page of pageClipboard) { pinned.add(page.sourceId); pinned.add(pageGroupId(page)) }
    workspace.collectClosedSources(candidates, pinned)
  }, [activeSourceIds, clipboardKind, pageClipboard, printQueue, visibleSources, workspace.collectClosedSources, workspace.sources, workspace.pages, workspace.watermarks])
  const sourcesById = useMemo(
    () => new Map(workspace.sources.map((source) => [source.id, source])),
    [workspace.sources],
  )
  const pagesByGroupId = useMemo(() => {
    const grouped = new Map<string, WorkspacePage[]>()
    for (const page of workspace.pages) {
      const groupId = pageGroupId(page)
      const pages = grouped.get(groupId)
      if (pages) pages.push(page)
      else grouped.set(groupId, [page])
    }
    return grouped
  }, [workspace.pages])
  const standaloneBlankPages = pagesByGroupId.get('blank') ?? []
  const compressionSource = externalCompression ?? (compressionSourceId ? sourcesById.get(compressionSourceId) : undefined)
  const compressionInput = compressionSource && savedOriginalBytes(compressionSource)
  useEffect(() => {
    compressionCandidate.current = undefined
    setCompressionNotice('')
  }, [compressionInput])
  const encryptionSource = encryptionSourceId ? sourcesById.get(encryptionSourceId) : undefined
  const activePage = workspace.pages.find((page) => page.id === workspace.activeId) ?? workspace.pages[0]
  const activeGroupId = activePage ? pageGroupId(activePage) : undefined
  useLayoutEffect(() => {
    if (mode === 'editor' && activeGroupId && activePage) lastPageByGroup.current.set(activeGroupId, activePage.id)
  }, [mode, activeGroupId, activePage?.id])
  const activeSource = activeGroupId ? sourcesById.get(activeGroupId) : undefined
  const watermarkFor = useCallback((groupId?: string) => workspace.watermarks.get(mode === 'editor' ? groupId : undefined), [mode, workspace.watermarks])
  const activeWatermark = watermarkFor(activeGroupId)
  const setDocumentWatermark = (next: Parameters<typeof workspace.setWatermark>[0], groupId = activeGroupId) => {
    if (mode !== 'editor' || groupId) workspace.setWatermark(next, mode === 'editor' ? groupId : undefined)
  }
  const watermarkScope = mode === 'editor' ? activeGroupId : 'workspace'
  const watermarkOpen = !!watermarkDialogScope && watermarkDialogScope === watermarkScope
  useEffect(() => {
    // An OS open can change the underlying tab even while its dialog is modal.
    if (watermarkDialogScope && !watermarkOpen) setWatermarkDialogScope(undefined)
  }, [watermarkDialogScope, watermarkOpen])
  const watermarkSelected = !!activeWatermark && selectedWatermarkScope === watermarkScope
  const setWatermarkSelected = (selected: boolean) => selectWatermarkScope(selected ? watermarkScope : undefined)
  const selectedSplitSources = useMemo(
    () => visibleSources.filter((source) => splitSourceIds.has(source.id)),
    [splitSourceIds, visibleSources],
  )
  const splitActive = mode === 'editor' && selectedSplitSources.length >= 2
  const navigationPages = useMemo(
    () => mode === 'editor' && activeGroupId ? pagesByGroupId.get(activeGroupId) ?? [] : workspace.pages,
    [activeGroupId, mode, pagesByGroupId, workspace.pages],
  )
  const navigationIndex = activePage ? navigationPages.findIndex((page) => page.id === activePage.id) : -1
  // Adjust during render (React-sanctioned pattern): the jump input reflects
  // the new page in the SAME commit instead of one paint later via an effect.
  const pageJumpKey = `${mode === 'editor' ? activeGroupId : ''}:${navigationIndex}:${navigationPages.length}`
  const [prevPageJumpKey, setPrevPageJumpKey] = useState(pageJumpKey)
  if (prevPageJumpKey !== pageJumpKey) {
    setPrevPageJumpKey(pageJumpKey)
    setPageJumpValue(String(navigationIndex >= 0 ? navigationIndex + 1 : 0))
  }
  const readingGroupIds = useMemo(() => new Set(splitActive
    ? selectedSplitSources.map((source) => source.id)
    : activeGroupId ? [activeGroupId] : []), [activeGroupId, selectedSplitSources, splitActive])
  const navigationIds = useMemo(() => new Set(navigationPages.map(page => page.id)), [navigationPages])
  const documentSelection = useMemo(() => mode !== 'editor' ? workspace.selectedIds : new Set([...workspace.selectedIds].filter(id => navigationIds.has(id))), [mode, navigationIds, workspace.selectedIds])
  const documentSources = useMemo(() => {
    const ids = new Set(navigationPages.map(page => page.sourceId))
    return visibleSources.filter(source => ids.has(source.id))
  }, [navigationPages, visibleSources])
  const totalBytes = documentSources.reduce((sum, source) => sum + source.bytes.byteLength, 0)
  // Use editor positions, not the original page number of inserted or reordered pages.
  const searchCorpus = useMemo(() => navigationPages.map((page, i) => {
    const source = sourcesById.get(page.sourceId), group = sourcesById.get(pageGroupId(page))
    return { id: page.id, sourceId: pageGroupId(page), number: i + 1,
      sourceName: group ? sourceLabel(group) : source ? sourceLabel(source) : '空白页',
      text: page.ocr?.text || source?.pageText[page.sourcePage] || '' }
  }), [navigationPages, searchIndexVersion, sourcesById])
  // Search results are per-OCCURRENCE items (not pages): each carries its
  // context snippet so the panel reads like a conventional find-results list.
  const [searchLimit,setSearchLimit] = useState(200)
  useEffect(()=>setSearchLimit(200),[activeGroupId,deferredQuery])
  const searchResults = useMemo(() => {
    type SearchHit = {
      id: string; pageId: string; sourceId: string; sourceName: string
      pageNumber: number; before: string; match: string; after: string
    }
    const needle = deferredQuery.trim().toLocaleLowerCase()
    const hits: SearchHit[] = []
    if (!needle) return {hits, more:false}
    const collapse = (value: string) => value.replace(/\s+/g, ' ')
    for (const page of searchCorpus) {
      const text = page.text
      if (!text) continue
      const haystack = text.toLocaleLowerCase()
      let index = haystack.indexOf(needle)
      while (index >= 0) {
        if(hits.length >= searchLimit)return {hits, more:true}
        hits.push({
          id: `${page.id}:${index}`,
          pageId: page.id,
          sourceId: page.sourceId,
          sourceName: page.sourceName,
          pageNumber: page.number,
          before: collapse(text.slice(Math.max(0, index - 24), index)),
          match: text.slice(index, index + needle.length),
          after: collapse(text.slice(index + needle.length, index + needle.length + 40)),
        })
        index = haystack.indexOf(needle, index + needle.length)
      }
    }
    return {hits, more:false}
  }, [deferredQuery, searchCorpus, searchLimit])
  const searchHits=searchResults.hits
  // Grouped under each file for the results panel, in first-appearance order.
  const searchHitGroups = useMemo(() => {
    const groups: { sourceId: string; sourceName: string; hits: typeof searchHits }[] = []
    for (const hit of searchHits) {
      const last = groups.at(-1)
      if (last?.sourceId === hit.sourceId) last.hits.push(hit)
      else groups.push({ sourceId: hit.sourceId, sourceName: hit.sourceName, hits: [hit] })
    }
    return groups
  }, [searchHits])
  const [activeSearchHitId, setActiveSearchHitId] = useState<string>()
  // The pinned hit wins while its page is still active; after manual page
  // navigation the indicator falls back to that page's first hit.
  const currentSearchHit = (() => {
    const pinned = searchHits.findIndex((hit) => hit.id === activeSearchHitId && hit.pageId === workspace.activeId)
    if (pinned >= 0) return pinned
    return Math.max(0, searchHits.findIndex((hit) => hit.pageId === workspace.activeId))
  })()
  // Keep the selected result row inside the list's own viewport when stepping
  // with the prev/next buttons. Adjusting scrollTop directly (never
  // scrollIntoView) guarantees only this list scrolls.
  useEffect(() => {
    const list = searchResultsRef.current
    const item = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !item) return
    const itemRect = item.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top + 4
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom + 4
  }, [currentSearchHit, searchHits])
  const pageNotes = useMemo(() => navigationPages.flatMap((page, pageIndex) => page.annotations
    .filter((annotation) => annotation.type === 'note')
    .map((annotation) => ({ annotation, page, pageIndex }))), [navigationPages])
  const matchingNotes = pageNotes.filter(({annotation,pageIndex}) => !noteFilter.trim() || [String(pageIndex+1),annotation.text,annotation.author,...(annotation.replies??[]).flatMap(r=>[r.author,r.text])].join(' ').toLocaleLowerCase().includes(noteFilter.trim().toLocaleLowerCase()))
  const activeNoteSelection = activeNoteTarget
    ? pageNotes.find(({ annotation, page }) => annotation.id === activeNoteTarget.annotationId && page.id === activeNoteTarget.pageId)
    : undefined
  const activeTextSelection = useMemo(() => {
    if (!activeTextTarget) return undefined
    const page = workspace.pages.find((item) => item.id === activeTextTarget.pageId)
    const annotation = page?.annotations.find((item) => item.id === activeTextTarget.annotationId && item.type === 'text')
    return page && annotation ? { page, annotation } : undefined
  }, [activeTextTarget, workspace.pages])

  useEffect(() => {
    if (activeTextTarget && (activeTextTarget.pageId !== workspace.activeId || !activeTextSelection)) {
      setActiveTextTarget(undefined)
    }
  }, [activeTextSelection, activeTextTarget, workspace.activeId])

  useEffect(() => {
    setAnnotationSelection((current) => {
      if (!current || current.pageId !== workspace.activeId) return undefined
      const page = workspace.pages.find((item) => item.id === current.pageId)
      if (!page) return undefined
      const available = new Set(page.annotations.map((annotation) => annotation.id))
      const ids = new Set([...current.ids].filter((id) => available.has(id)))
      if (!ids.size) return undefined
      if (ids.size === current.ids.size) return current
      return { pageId: current.pageId, ids, primaryId: ids.has(current.primaryId) ? current.primaryId : [...ids].at(-1)! }
    })
  }, [workspace.activeId, workspace.pages])

  useEffect(() => {
    if (!activeNoteSelection) return
    noteEditCancelRef.current = undefined
    setNoteEditDraft({
      author: activeNoteSelection.annotation.author ?? '',
      text: activeNoteSelection.annotation.text ?? '',
    })
  }, [
    activeNoteSelection?.annotation.id,
    activeNoteSelection?.annotation.author,
    activeNoteSelection?.annotation.text,
  ])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3600)
  }, [])

  useEffect(() => {
    if (!workspaceId || !incomingTransfer || incomingTransfer.targetId !== workspaceId
      || appliedTransferRef.current === incomingTransfer.id) return
    appliedTransferRef.current = incomingTransfer.id
    const wasEmpty = workspace.pages.length === 0
    let added = 0
    try {
      added = workspace.appendTransfer(incomingTransfer)
      if (added) notify(`已将 ${added} 页加入工作区`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法加入工作区')
    }
    // Even when staging failed, allow the parent to remove a provisional destination
    // and keep the print job pending. Never acknowledge a page that wasn't appended.
    onWorkspaceTransferApplied?.(incomingTransfer.id, workspaceId, incomingTransfer.suggestedName, wasEmpty, added)
  }, [incomingTransfer, notify, onWorkspaceTransferApplied, workspace, workspaceId])

  const requestWorkspaceTransfer = useCallback((pages: WorkspacePage[], scopeLabel: string, suggestedSource?: PdfSource) => {
    if (!pages.length) return
    const sourceIds = new Set(pages.map((page) => page.sourceId).filter((id) => id !== 'blank'))
    const sources = workspace.sources.filter((source) => sourceIds.has(source.id))
    const firstSource = suggestedSource ?? sources[0]
    // A transferred group becomes page artwork. The destination's editable
    // document overlay stays independent; a removed source mark stays absent.
    const captured = new Map<NonNullable<ExportOptions['watermark']>, NonNullable<ExportOptions['watermark']>>()
    try {
      const transferred = pages.map(page => {
        const group = pageGroupId(page), mark = watermarkFor(group)
        if (!mark) return page
        let art = captured.get(mark)
        if (!art) {
          art = { ...snapshotWatermark(mark, mode === 'editor' ? sourcesById.get(group) : undefined), kind: 'image' }
          captured.set(mark, art)
        }
        return { ...page, inheritedWatermarks: [...page.inheritedWatermarks ?? [], art] }
      })
      onRequestWorkspaceTransfer({ sources, pages: transferred, scopeLabel,
        withinProject: workspaceId ? { id: workspaceId, pages } : undefined,
        suggestedName: (firstSource ? sourceLabel(firstSource) : '页面工作区').replace(/\.pdf$/i, ''),
      })
    } catch (error) { notify(error instanceof Error ? error.message : '无法准备工作区水印') }
  }, [mode, notify, onRequestWorkspaceTransfer, sourcesById, watermarkFor, workspace.sources, workspaceId])

  const addSourceToWorkspace = useCallback((sourceId: string) => {
    const source = sourcesById.get(sourceId)
    const pages = workspace.pages.filter((page) => pageGroupId(page) === sourceId)
    requestWorkspaceTransfer(pages, source ? `整个文件“${sourceLabel(source)}”` : '整个来源文件', source)
  }, [requestWorkspaceTransfer, sourcesById, workspace.pages])

  const addPageSelectionToWorkspace = useCallback((pageId: string) => {
    const ids = documentSelection.has(pageId) && documentSelection.size > 1
      ? documentSelection : new Set([pageId])
    const pages = navigationPages.filter((page) => ids.has(page.id))
    const source = pages[0] ? sourcesById.get(pages[0].sourceId) : undefined
    requestWorkspaceTransfer(pages, pages.length > 1 ? `已选择 ${pages.length} 页` : '当前页面', source)
  }, [documentSelection, navigationPages, requestWorkspaceTransfer, sourcesById])

  const addBookmark = useCallback((pageId: string) => {
    const page = workspace.pages.find((item) => item.id === pageId)
    if (!page) return
    const source = sourcesById.get(page.sourceId)
    const defaultTitle = `${source ? sourceLabel(source).replace(/\.pdf$/i, '') : '文档'} · 第 ${page.sourcePage + 1} 页`
    const title = window.prompt('书签名称', defaultTitle)?.trim()
    if (!title) return
    workspace.markDocumentMetadataDirty(pageGroupId(page))
    setUserBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.pageId === pageId)
      return existing
        ? current.map((bookmark) => bookmark.id === existing.id ? { ...bookmark, title } : bookmark)
        : [...current, { id: uid(), title, pageId, sourceId: page.sourceId, sourcePage: page.sourcePage }]
    })
    notify('书签已添加，可在左侧“目录”中查看。')
  }, [notify, sourcesById, workspace.markDocumentMetadataDirty, workspace.pages])

  const applyFileClose = useCallback((target: FileCloseTarget) => {
    const current = workspaceRef.current
    // An OS association may open a new tab while the prompt is up. Close only the snapshot.
    if (target.kind === 'all' && current.pages.every(page => target.ids.has(page.id))) {
      current.sources.forEach(releasePdfDocument)
      current.reset()
      notify('已关闭所有文件，磁盘上的源文件未受影响')
      return
    }
    const remaining = current.pages.filter(p => !target.ids.has(p.id))
    const keptSources = new Set(remaining.map(p => p.sourceId))
    current.sources.filter(s => !keptSources.has(s.id)).forEach(releasePdfDocument)
    current.remove(target.ids)
    if (mode === 'editor' && remaining.length && current.activeId && target.ids.has(current.activeId)) {
      const nextGroup = pageGroupId(remaining[0]), remembered = lastPageByGroup.current.get(nextGroup)
      if (remembered && remaining.some(p => pageGroupId(p) === nextGroup && p.id === remembered)) current.select(remembered)
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) stageRef.current?.closest('.app-shell')?.querySelector<HTMLButtonElement>('.editor-tabs [aria-selected="true"]')?.focus({ preventScroll: true })
      })
    }
    notify(`已关闭${target.label ? `“${target.label}”` : '选定文件'}`)
  }, [mode, notify])

  const guardFileClose = useCallback((target: FileCloseTarget) => {
    const groups = mode === 'editor'
      ? new Set(workspaceRef.current.pages.filter(p => target.ids.has(p.id)).map(p => `editor:${pageGroupId(p)}`))
      : new Set([workspaceId ?? mode])
    return promptBeforeClose(groups, proceed => { if (proceed) applyFileClose(target) })
  }, [applyFileClose, mode, promptBeforeClose, workspaceId])

  const requestCloseSource = useCallback((sourceId?: string) => {
    const pages = workspaceRef.current.pages.filter(p => !sourceId || pageGroupId(p) === sourceId)
    if (!pages.length) return
    const source = sourceId ? sourcesById.get(sourceId) : undefined
    const target: FileCloseTarget = { kind: sourceId ? 'source' : 'all', ids: new Set(pages.map(p => p.id)),
      label: source ? sourceLabel(source) : sourceId === 'blank' ? '未命名 PDF' : undefined }
    if (!guardFileClose(target)) {
      if (sourceId) applyFileClose(target)
      else setCloseConfirm(target)
    }
  }, [applyFileClose, guardFileClose, sourcesById])
  const requestCloseAllSources = useCallback(() => requestCloseSource(), [requestCloseSource])

  useEffect(() => {
    const available = new Set(visibleSources.map((source) => source.id))
    setSplitSourceIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
    for (const groupId of lastPageByGroup.current.keys()) {
      if (!pagesByGroupId.has(groupId)) lastPageByGroup.current.delete(groupId)
    }
  }, [pagesByGroupId, visibleSources])

  useEffect(() => {
    if (!splitActive) return
    setZoom(1)
  }, [splitActive])

  useLayoutEffect(() => {
    if (hidden) return
    // A page proxy already carries its true geometry. Only pages actually
    // requested by the reader, thumbnails, OCR or search refine the layout.
    // Coalesce mixed-size pages discovered together into a single layout pass.
    let frame = 0
    const changed = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        setPageSizeVersion(value => value + 1)
      })
    }
    const unsubscribes = [...sourcesById.values()].map(source => onPdfPageSizeChange(source, changed))
    return () => { cancelAnimationFrame(frame); unsubscribes.forEach(unsubscribe => unsubscribe()) }
  }, [hidden, sourcesById])

  // Single-page reader prewarm: while the user reads a page, render its
  // neighbors into the frame LRU so the next flip is a cache restore instead
  // of a full cold render. Priority 4 keeps it behind every on-screen render;
  // the 120ms debounce folds fast flip/zoom bursts.
  useEffect(() => {
    if (hidden || viewMode !== 'single' || navigationIndex < 0 || !activePage) return
    let cancels: Array<() => void> = []
    let disposed = false
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const offset of [1, -1]) {
          const neighbor = navigationPages[navigationIndex + offset]
          if (!neighbor || neighbor.sourceId === 'blank') continue
          const source = sourcesById.get(neighbor.sourceId)
          if (!source) continue
          // AWAIT the neighbor's real page size: prewarming at the 612x792
          // placeholder width lands a frame the stage's cache check (0.5px
          // tolerance) never hits — the whole prewarm would be wasted work.
          await loadPdfPageSizes(source, [neighbor.sourcePage]).catch(() => undefined)
          if (disposed) return
          // pageDimensions() is declared further below; inline its size math so
          // this early effect stays close to the other page-size loader.
          const size = source.pageSizes[neighbor.sourcePage] ?? { width: 612, height: 792 }
          const oriented = neighbor.rotation % 180 === 0 ? size : { width: size.height, height: size.width }
          cancels.push(prewarmPdfPageRender(source, neighbor.sourcePage, neighbor.rotation, oriented.width * PDF_CSS_UNITS * zoom, renderQuality, displayPixelRatio))
        }
      })()
    }, 120)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      for (const cancel of cancels) cancel()
      cancels = []
    }
  }, [hidden, viewMode, activePage?.id, navigationIndex, zoom, renderQuality, displayPixelRatio, navigationPages, sourcesById])

  // Scroll just the document pane. Start oversized pages at their top edge.
  const scrollStagePageIntoView = useCallback((id: string) => {
    const stage = stageRef.current
    const target = stage?.querySelector(`[data-page-id="${id}"]`)
    if (!stage || !target) return
    const stageRect = stage.getBoundingClientRect(), rect = target.getBoundingClientRect()
    const delta = rect.height > stage.clientHeight - 24 ? rect.top - stageRect.top - 12
      : (rect.top + rect.height / 2) - (stageRect.top + stageRect.height / 2)
    if (Math.abs(delta) < 4) return
    stage.scrollTo({ top: stage.scrollTop + delta, behavior: 'instant' })
  }, [])
  const selectPage = useCallback((id: string, additive = false, range = false) => {
    workspaceRef.current.select(id, additive, range)
    if (!additive && !range && (viewMode !== 'single' || splitActive)) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (workspaceRef.current.activeId === id) scrollStagePageIntoView(id)
    }))
  }, [scrollStagePageIntoView, splitActive, viewMode])
  // Navigation to a different single sheet starts at its head, even when the
  // previous sheet was scrolled down. Zoom/pan on the same sheet is untouched.
  useLayoutEffect(() => {
    if (!hidden && viewMode === 'single' && !splitActive) stageRef.current?.scrollTo({top:0,behavior:'instant'})
  }, [activePage?.id, hidden, splitActive, viewMode])
  // In continuous reading the sheet under the viewport is the active page. Hit
  // test in the paint tree (no linear DOM scan on every scroll); keep explicit
  // selection and pane navigation in charge while a gesture/menu is active.
  useEffect(() => {
    const stage = stageRef.current
    if(!stage || hidden || splitActive || viewMode==='single' || multiSelect) return
    let frame=0
    const update=()=>{
      frame=0; const r=stage.getBoundingClientRect(), model=workspaceRef.current
      const hits: string[]=[]
      for(const x of viewMode==='spread' ? [.32,.68,.5] : [.5]) {
        for(const y of [.5,.41,.59]) {
          const el=document.elementsFromPoint(r.left+r.width*x,r.top+r.height*y).map(e=>e.closest<HTMLElement>('.stage-page')).find(e=>e && stage.contains(e))
          if(el?.dataset.pageId){hits.push(el.dataset.pageId);break}
        }
      }
      if(hits.length && (!model.activeId || !hits.includes(model.activeId))) model.select(hits[0],false)
    }
    const queue=()=>{if(!frame)frame=requestAnimationFrame(update)}
    stage.addEventListener('scroll',queue,{passive:true});return()=>{stage.removeEventListener('scroll',queue);cancelAnimationFrame(frame)}
  },[hidden,splitActive,viewMode,multiSelect])
  const activateEditorGroup = useCallback((groupId: string) => {
    const { pages, activeId } = workspaceRef.current
    const active = pages.find(page => page.id === activeId) ?? pages[0]
    if (active && pageGroupId(active) === groupId) return
    const remembered = lastPageByGroup.current.get(groupId)
    const page = pages.find(p => p.id === remembered && pageGroupId(p) === groupId) ?? pages.find(p => pageGroupId(p) === groupId)
    if (page) selectPage(page.id)
  }, [selectPage])

  const importFitWidth = useRef<number>()
  useLayoutEffect(() => {
    const stage = stageRef.current, width = importFitWidth.current
    if (hidden || !stage || !width) return
    importFitWidth.current = undefined
    // Measure after new tabs/scrollbars mount but before the browser paints.
    setZoom(clamp((stage.clientWidth - 76) / (width * PDF_CSS_UNITS), 0.25, 2.4))
  }, [hidden, workspace.sources])

  const importIntoWorkspace = useCallback(async (files: DesktopFile[], append: boolean, onFirstPage?: (pageId: string) => void) => {
    if (!files.length) return false
    const current = workspaceRef.current
    if (mode === 'editor') {
      const plan = planEditorOpen(files, current.sources, current.pages)
      if (plan.activate) {
        activateEditorGroup(plan.activate.id)
        notify(`已转到正在浏览的“${sourceLabel(plan.activate)}”`)
      }
      files = plan.files
      if (!files.length) return true
      append = current.pages.length > 0
    }
    setBusy('正在解析文档')
    try {
      const wasEmpty = current.pages.length === 0
      const sources: PdfSource[] = []
      const opensFirst = !append || !current.activeId || Boolean(onFirstPage)
      for (let index = 0; index < files.length; index += 2) {
        const batch = files.slice(index, index + 2)
        const parsed = await Promise.allSettled(batch.map(async (file, offset) => {
          const source = await inspectDesktopFile(file, false, requestPdfPassword, passwordSecurityFor(file.name))
          sources[index + offset] = source
          await loadPdfPageSizes(source, [0])
        }))
        const failed = parsed.find(result => result.status === 'rejected')
        if (failed) {
          // A sibling may have parsed successfully after another failed. The
          // batch wasn't committed: tear down every staged worker, not the tab
          // the user still has open.
          await Promise.all(sources.map(releasePdfDocument))
          throw failed.reason
        }
        // A folder must not retain a worker per file until the very end of
        // import. Keep the actual destination plus at most one likely next tab.
        for (let i = index; i < index + batch.length; i++) {
          if (i > (opensFirst ? 1 : 0)) await releasePdfDocument(sources[i])
        }
      }
      // A single-file open replaces the previous document. Release its PDF.js
      // worker/document caches only after the replacement parsed successfully.
      // releasePdfDocument also frees only that source's cached bitmaps.
      if (mode === 'editor') append = workspaceRef.current.pages.length > 0
      if (!append) workspaceRef.current.sources.forEach(releasePdfDocument)
      // Start the handoff timeout when the tab becomes selectable, not while
      // later files are still opening in a slow folder import.
      const nextTab = sources[opensFirst ? 1 : 0]
      if (nextTab) parkImportedPdf(nextTab)
      // Appending in the background must not change the current PDF's zoom.
      if (opensFirst) importFitWidth.current = sources[0]?.pageSizes[0]?.width
      const load = () => {
        const first = workspaceRef.current.load(sources, append, mode === 'editor')
        if (first) onFirstPage?.(first)
      }
      // Publish the tab before processing the next picker/drop/association request,
      // including consecutive already-resolved native promises in the same task.
      if (mode === 'editor') flushSync(load)
      else load()
      const activeProject = projects.find((project) => project.id === activeProjectId)
      if (mode === 'merge' && wasEmpty && activeProjectId && sources[0]
        && (!activeProject || /^工作区 \d+$/.test(activeProject.name))) {
        onProjectRename?.(activeProjectId, sourceLabel(sources[0]).replace(/\.pdf$/i, ''))
      }
      notify('已导入 ' + sources.length + ' 个文件，共 ' + sources.reduce((sum, source) => sum + source.pageCount, 0) + ' 页'
        + (sources.some(source=>source.fileInfo?.ofdSignature) ? '。当前是 OFD 阅览副本，未验证原件的签名。' : sources.some(source => source.fileInfo?.extension === 'OFD') ? '。OFD 转为 PDF 工作副本；保存不会修改原件。' : sources.some(s=>s.fileInfo?.extension==='MSG') ? '。邮件以 A4 纵向备忘录打开；保存仅生成 PDF 副本。' : '')
        + (sources.flatMap(s=>s.fileInfo?.importWarnings??[])[0] ? ` ${sources.flatMap(s=>s.fileInfo?.importWarnings??[])[0]}` : ''))
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法读取该文件')
      return false
    } finally {
      setBusy('')
    }
  }, [activateEditorGroup, activeProjectId, mode, notify, onProjectRename, passwordSecurityFor, projects, requestPdfPassword])

  const importDesktopFiles = useCallback((files: DesktopFile[], append: boolean, onFirstPage?: (pageId: string) => void) => {
    if (mode !== 'editor') return importIntoWorkspace(files, append, onFirstPage)
    const run = () => importIntoWorkspace(files, append, onFirstPage)
    const pending = (editorImportTail.current ?? Promise.resolve()).then(run, run)
    editorImportTail.current = pending
    return pending
  }, [importIntoWorkspace, mode])

  useEffect(() => {
    if (hidden) return
    const shell = stageRef.current?.closest('.app-shell')
    if (!shell) return
    const receiveDrop = (event: Event) => {
      const files = (event as CustomEvent<DesktopFile[]>).detail
      if (!Array.isArray(files) || !files.length) return
      event.preventDefault() // signals the native bridge not to deliver the same drop again
      void importDesktopFiles(files, mode !== 'editor' || workspace.pages.length > 0)
    }
    shell.addEventListener('paperwork-native-drop', receiveDrop)
    return () => shell.removeEventListener('paperwork-native-drop', receiveDrop)
  }, [hidden, importDesktopFiles, mode, workspace.pages.length])

  const pickFiles = useCallback(async () => {
    const append = mode !== 'editor' || workspace.pages.length > 0
    if (window.desktop) {
      await importDesktopFiles(await window.desktop.openFiles({ images: true, documents: true, multiple: append }), append)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.ofd,.png,.jpg,.jpeg'
    input.multiple = append
    input.onchange = async () => {
      const selected = [...(input.files ?? [])]
      await importDesktopFiles(await Promise.all(selected.map(browserFileToDesktopFile)), append)
    }
    input.click()
  }, [importDesktopFiles, mode, workspace.pages.length])

  useEffect(() => {
    const importForMode = (event: Event) => {
      const targetMode = (event as CustomEvent<Mode>).detail
      if (targetMode === mode && !hidden) void pickFiles()
    }
    window.addEventListener('paperwork:import-files', importForMode)
    return () => window.removeEventListener('paperwork:import-files', importForMode)
  }, [hidden, mode, pickFiles])

  // Let the compositor choose the raster: an unchanged, re-opened watermark
  // must keep the verified embedded pixels even if this machine has different fonts.
  const documentWatermark = useCallback((groupId = activeGroupId): ExportOptions['watermark'] => {
    const mark = watermarkFor(groupId)
    if (!mark) return undefined
    if (mark.kind === 'text') return mark.imageData ? { ...mark, imageData: undefined } : mark
    return mark.imageData ? mark : undefined
  }, [activeGroupId, watermarkFor])


  const closeCompression = useCallback(() => {
    compressionCandidate.current = undefined
    setCompressionNotice(''); setExternalCompression(undefined); setCompressionSourceId(undefined)
  }, [])
  const openCompression=useCallback(async (explicitId?:string)=>{
    if(compressionPicking.current||compressionRunning||compressionSource)return
    const target=explicitId?sourcesById.get(explicitId):(mode==='editor'?activeSource:activePage?sourcesById.get(activePage.sourceId):undefined)
    if(target){setCompressionProgress(undefined);setCompressionSourceId(target.id);return}
    compressionPicking.current=true
    try{
      let selected:DesktopFile|undefined
      if(window.desktop)selected=(await window.desktop.openFiles({pdfOnly:true,multiple:false,maxReadBytes:(await import('./lib/pdfCompression')).MAX_COMPRESSION_BYTES}))[0]
      else {
        const file=await new Promise<File|undefined>(resolve=>{const input=document.createElement('input');input.type='file';input.accept='.pdf,application/pdf';input.onchange=()=>resolve(input.files?.[0]);input.oncancel=()=>resolve(undefined);input.click()})
        if(!file)return
        if(file.size>(await import('./lib/pdfCompression')).MAX_COMPRESSION_BYTES)throw Error('压缩上限为 96 MiB，未写入文件。')
        selected=await browserFileToDesktopFile(file)
      }
      if(!selected)return
      if(!/\.pdf$/i.test(selected.name))throw Error('请选择 PDF 文件')
      if(selected.bytes.byteLength>(await import('./lib/pdfCompression')).MAX_COMPRESSION_BYTES)throw Error('压缩上限为 96 MiB，未写入文件。')
      const source=await inspectDesktopFile(selected,false,requestPdfPassword,passwordSecurityFor(selected.name));await releasePdfDocument(source)
      setCompressionProgress(undefined);setExternalCompression(source)
    }catch(error){notify(error instanceof Error?error.message:'无法打开待压缩文件')}finally{compressionPicking.current=false}
  },[compressionRunning,compressionSource,mode,activeSource,activePage,sourcesById,requestPdfPassword,passwordSecurityFor,notify])
  const runCompression = useCallback(async (mode: PdfCompressionMode) => {
    if (!compressionSource || compressionRunning || compressionAbortRef.current) return
    if(compressionSource.fileInfo?.ofdSignature && !await confirmPdfCopy([compressionSource])) return
    setCompressionNotice('')
    const controller = new AbortController()
    compressionAbortRef.current = controller
    setCompressionRunning(true)
    setCompressionProgress({ stage: 'loading', current: 0, total: compressionSource.pageCount })
    let imageLimitNote = ''
    try {
      const input = savedOriginalBytes(compressionSource)
      const cached = compressionCandidate.current
      compressionCandidate.current = undefined
      const result = cached?.source === compressionSource && cached.input === input && cached.result.mode === mode ? cached.result
        : await compressPdf(compressionSource, { mode, signal: controller.signal }, setCompressionProgress)
      if (input !== savedOriginalBytes(compressionSource)) throw new Error('原件已重新保存，请重新压缩')
      if (result.skippedLargeImages) imageLimitNote = ` 已跳过 ${result.skippedLargeImages} 张超限图像，保留原像素。`
      if (!result.hasGain) {
        setCompressionNotice(`此档位没有变小（原件 ${formatBytes(result.originalSize)}，试算 ${formatBytes(result.attemptedSize)}）。未写入文件；可以更换档位再试。${imageLimitNote}`)
        return
      }
      const baseName = sourceLabel(compressionSource).replace(/\.pdf$/i, '') || '文档'
      const name = `${baseName}-${mode === 'lossless' ? '无损优化' : '压缩版'}.pdf`
      if (window.desktop && !window.desktop.savePdfCopy) throw new Error('当前宿主不能保证副本不覆盖原件，未写入文件。')
      compressionCandidate.current = { source: compressionSource, input, result }
      setChoosingCopy(true)
      const saved = window.desktop?.savePdfCopy ? await window.desktop.savePdfCopy(result.bytes, name) : await downloadBytes(result.bytes, name)
      if (!saved) {
        setCompressionNotice(`已取消另存为。${formatBytes(result.compressedSize)} 的压缩结果仍在，重选保存位置无需再次压缩。${imageLimitNote}`)
        return
      }
      notify(`压缩副本已保存：${formatBytes(result.originalSize)} → ${formatBytes(result.compressedSize)}，节省 ${Math.round(result.savingsRatio * 100)}%${imageLimitNote}`)
      closeCompression()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError') {
        setCompressionNotice('已取消压缩，未写入文件。')
      } else {
        const why = error instanceof Error ? error.message : String(error || '未知错误')
        setCompressionNotice(compressionCandidate.current ? `保存未完成：${why}。可重选位置，无需再次压缩。${imageLimitNote}` : `压缩未完成：${why}。原件未改动。${imageLimitNote}`)
      }
    } finally {
      compressionAbortRef.current = undefined
      setChoosingCopy(false)
      setCompressionRunning(false)
      setCompressionProgress(undefined)
    }
  }, [closeCompression, compressionRunning, compressionSource, downloadBytes, notify])

  const ai = useMcpWorkspace({enabled:mode==='editor', workspace, busy:Boolean(busy||compressionRunning||ocrRunning), notify, show:()=>onModeChange('editor'),
    exportPdf:async(pages,group,valid)=>{
      const selected=pageSources(pages,workspace.sources)
      if(!valid()||!await confirmPdfCopy(selected)||!valid())return false
      const output=await composePdf(pages,selected,{watermark:documentWatermark(group)})
      const name=`${(sourcesById.get(group)?.name??'文档').replace(/\.pdf$/i,'')}-导出副本.pdf`
      if(!valid()||!window.desktop?.saveGuardedPdfCopy)return false
      return Boolean(await window.desktop.saveGuardedPdfCopy(output,name,valid))
    }})
  const savingGroups = useRef(new Set<string | undefined>())
  const save = useCallback(async (options: Parameters<typeof composePdf>[2] = {}, saveAsCopy = false, groupId?: string): Promise<boolean> => {
    const targetGroupId = mode === 'editor' ? groupId ?? activeGroupId : undefined
    const browsingPages = mode === 'editor' && targetGroupId
      ? workspace.pages.filter((page) => pageGroupId(page) === targetGroupId)
      : workspace.pages
    if (!browsingPages.length || savingGroups.current.has(targetGroupId)) return false
    // Only the group's actual backing file can ever be an overwrite target;
    // pasted pages aren't authorization to write their own source file.
    const source = targetGroupId ? sourcesById.get(targetGroupId) : undefined
    const suggested = mode === 'merge' ? '合并文档.pdf'
      : source?.fileInfo?.extension === 'OFD' ? `${sourceLabel(source).replace(/\.(?:ofd|pdf)$/i, '')}${source.fileInfo?.ofdSignature ? '-未验签阅览' : '-副本'}.pdf`
      : source ? sourceLabel(source).replace(/\.(?:msg|ofd|png|jpe?g|docx?)$/i, '.pdf') : '编辑后的文档.pdf'
    let generating = false
    savingGroups.current.add(targetGroupId)
    try {
      const result = await saveWorkspacePdf({
        target: source, dirty: targetGroupId ? workspace.dirtyGroupIds.has(targetGroupId) : workspace.dirty,
        saveAs: saveAsCopy, sources: pageSources(browsingPages, workspace.sources), suggested,
        compose: () => {
          generating = true
          setBusy('正在生成 PDF')
          return composePdf(browsingPages, workspace.sources, {
            ...options, watermark: documentWatermark(targetGroupId),
            bookmarks: userBookmarks.map(({ title, pageId }) => ({ title, pageId })),
          })
        },
      })
      if (!result) return false
      if (result !== 'unchanged') {
        // The picker/composition is asynchronous. A newer edit must remain
        // dirty, including bookmark-only edits (which don't change page refs).
        if (workspaceRef.current.dirtyGroupIds !== workspace.dirtyGroupIds) {
          notify('已写入保存时的版本；工作区在保存期间有变化，请再次保存。')
          return false
        }
        notify(result === 'original' && source ? `已保存当前文档：${sourceLabel(source)}` : 'PDF 副本已另存到本地')
        workspace.markSaved(targetGroupId)
      }
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败')
      return false
    } finally {
      savingGroups.current.delete(targetGroupId)
      if (generating) setBusy('')
    }
  }, [activeGroupId, documentWatermark, mode, notify, sourcesById, userBookmarks, workspace.dirty, workspace.dirtyGroupIds, workspace.pages, workspace.sources, workspace.markSaved])

  const encryptSourceCopy = useCallback(async (source: PdfSource, options: PdfEncryptionOptions) => {
    if (encryptionRunning) return
    const pages = workspace.pages.filter((page) => pageGroupId(page) === source.id)
    if (!pages.length) return
    setEncryptionRunning(true)
    setBusy('正在加密 PDF')
    try {
      const decision = await confirmPdfCopy([source, ...pageSources(pages, workspace.sources).filter(item => item !== source)], true)
      if (!decision) return
      const plain = await composePdf(pages, workspace.sources, {
        watermark: documentWatermark(source.id),
        bookmarks: userBookmarks.map(({ title, pageId }) => ({ title, pageId })),
      })
      const encrypted = await encryptPdfBytes(plain, options)
      const stem = sourceLabel(source).replace(/\.pdf$/i, '')
      const saved = await downloadBytes(encrypted, `${stem}-加密.pdf`, true)
      if (saved) {
        setEncryptionSourceId(undefined)
        notify('AES-256 加密副本已保存')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'PDF 加密失败')
    } finally {
      setEncryptionRunning(false)
      setBusy('')
    }
  }, [documentWatermark, downloadBytes, encryptionRunning, notify, userBookmarks, workspace.pages, workspace.sources])

  const savePasswordRemovedCopy = useCallback(async (source: PdfSource) => {
    setBusy('正在移除 PDF 密码')
    try {
      const sourcePages = workspace.pages.filter((page) => pageGroupId(page) === source.id)
      const decision = await confirmPdfCopy([source, ...pageSources(sourcePages, workspace.sources).filter(item => item !== source)])
      if (!decision) return
      const hasWorkspaceEdits = workspace.dirtyGroupIds.has(source.id)
      const bytes = hasWorkspaceEdits
        ? await composePdf(sourcePages, workspace.sources, {
            watermark: documentWatermark(source.id),
            bookmarks: userBookmarks.map(({ title, pageId }) => ({ title, pageId })),
          })
        : await removePdfPassword(source)
      const stem = sourceLabel(source).replace(/\.pdf$/i, '')
      const saved = await downloadBytes(bytes, `${stem}-无密码.pdf`, true)
      if (saved) notify('无密码 PDF 副本已保存')
    } catch (error) {
      notify(error instanceof Error ? error.message : '移除 PDF 密码失败')
    } finally {
      setBusy('')
    }
  }, [documentWatermark, downloadBytes, notify, userBookmarks, workspace.dirtyGroupIds, workspace.pages, workspace.sources])

  const extractSelected = useCallback(async () => {
    const selected = navigationPages.filter((page) => workspace.selectedIds.has(page.id))
    const subset = selected.length ? selected : activePage ? [activePage] : []
    if (!subset.length) return
    setPageExportDefaultFormat('pdf')
    setPageExportIds(subset.map((page) => page.id))
  }, [activePage, navigationPages, workspace.selectedIds])

  const exportSelectedPages = useCallback(async (options: PageExportOptions) => {
    const wanted = new Set(pageExportIds ?? [])
    const pages = workspace.pages.filter((page) => wanted.has(page.id))
    if (!pages.length) return
    setPageExportIds(undefined)
    setBusy(options.format === 'pdf' ? '正在生成 PDF' : '正在渲染页面')
    try {
      const decision = options.format === 'pdf' ? await confirmPdfCopy(pageSources(pages, workspace.sources)) : 'ordinary'
      if (!decision) return
      const compose = prepareStandalonePdfExport(pages, workspace.sources, mode === 'editor', documentWatermark)
      if (options.format === 'pdf' && options.splitPdf && pages.length > 1) {
        const files = await Promise.all(pages.map(async (page, index) => ({
          name: `页面-${String(index + 1).padStart(3, '0')}.pdf`,
          bytes: await compose([page]),
        })))
        if (window.desktop) {
          if (!await window.desktop.saveMany(files)) return
        } else for (const file of files) await downloadBytes(file.bytes, file.name)
        notify(`已拆分导出 ${files.length} 个 PDF`)
        return
      }

      const pdf = await compose()
      if (options.format === 'pdf') {
        const saved = await downloadBytes(pdf, pages.length === 1 ? '导出该页.pdf' : '提取选中页.pdf', decision === 'new-file')
        if (saved) notify(`已导出 ${pages.length} 页 PDF`)
        return
      }

      if (options.format === 'docx' && options.wordMode === 'editable') {
        setBusy('正在提取可编辑文字与表格')
        const editablePages = await extractEditableDocxPages(pdf, {
          tablesByPage: pages.map((page) => page.ocr?.tables),
          ocrWordsByPage: pages.map((page) => page.ocr?.words),
        })
        const bytes = buildEditableDocx(editablePages, { title: 'PDF 页面可编辑导出' })
        const fileName = 'PDF页面-可编辑.docx'
        if (window.desktop?.saveExport) {
          if (!await window.desktop.saveExport(bytes, fileName, 'docx')) return
        } else {
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
          Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
          URL.revokeObjectURL(url)
        }
        notify(`已生成包含 ${editablePages.length} 页可编辑文字与表格的 Word 文档`)
        return
      }

      setBusy(options.format === 'docx' ? '正在生成精准版式 Word' : '正在渲染页面')
      const imageFormat = options.format === 'jpeg' ? 'jpeg' : 'png'
      const images = await renderPdfPagesToImages(pdf, {
        format: imageFormat,
        dpi: options.dpi,
        jpegQuality: 0.9,
      })
      if (options.format === 'docx') {
        const bytes = buildImageDocx(images, { title: 'PDF 页面精准版式导出' })
        const fileName = 'PDF页面-精准版式.docx'
        if (window.desktop?.saveExport) {
          if (!await window.desktop.saveExport(bytes, fileName, 'docx')) return
        } else {
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
          Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
          URL.revokeObjectURL(url)
        }
        notify(`已生成包含 ${images.length} 张页面图片的精准版式 Word 文档`)
      } else if (window.desktop) {
        if (images.length === 1 && window.desktop.saveExport) {
          if (!await window.desktop.saveExport(images[0].bytes, images[0].name, imageFormat)) return
        } else {
          if (!await window.desktop.saveMany(images.map(({ name, bytes }) => ({ name, bytes })))) return
        }
        notify(`已导出 ${images.length} 张${options.format === 'png' ? '无损 PNG' : ' JPEG'}图片`)
      } else {
        for (const image of images) {
          const url = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }))
          Object.assign(document.createElement('a'), { href: url, download: image.name }).click()
          URL.revokeObjectURL(url)
        }
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '页面导出失败')
    } finally {
      setBusy('')
    }
  }, [documentWatermark, mode, notify, pageExportIds, workspace.pages, workspace.sources])

  const splitDocument = useCallback(async (groupId?: string) => {
    const targetPages = groupId
      ? workspace.pages.filter((page) => pageGroupId(page) === groupId)
      : mode === 'editor' ? navigationPages : workspace.pages
    if (!targetPages.length) return
    const input = window.prompt('每个文件包含多少页？', '5')
    if (!input) return
    const size = Number(input)
    if (!Number.isInteger(size) || size < 1) {
      notify('请输入大于 0 的整数')
      return
    }
    setBusy('正在拆分文档')
    try {
      if (!await confirmPdfCopy(pageSources(targetPages, workspace.sources))) return
      const compose = prepareStandalonePdfExport(targetPages, workspace.sources, mode === 'editor', documentWatermark)
      const files = []
      for (let index = 0; index < targetPages.length; index += size) {
        files.push({
          name: '拆分-' + (Math.floor(index / size) + 1) + '.pdf',
          bytes: await compose(targetPages.slice(index, index + size)),
        })
      }
      if (window.desktop) {
        const saved = await window.desktop.saveMany(files)
        if (saved) notify('已生成 ' + files.length + ' 个拆分文件')
      } else {
        for (const file of files) await downloadBytes(file.bytes, file.name)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '拆分文档失败')
    } finally {
      setBusy('')
    }
  }, [documentWatermark, mode, navigationPages, notify, workspace.pages, workspace.sources])

  const stitchPages = useCallback(async () => {
    const selected = navigationPages.filter((page) => workspace.selectedIds.has(page.id))
    const pages = selected.length > 1 ? selected : navigationPages
    if (pages.length < 2) {
      notify('多页拼接至少需要两页；可先开启页面多选。')
      return
    }
    const raw = window.prompt('每张输出纸放几页？支持 2、4、6、8、9。', '4')
    if (!raw) return
    const perSheet = Number(raw)
    if (![2, 4, 6, 8, 9].includes(perSheet)) {
      notify('请输入 2、4、6、8 或 9。')
      return
    }
    setBusy('正在拼接页面')
    try {
      const decision = await confirmPdfCopy(pageSources(pages, workspace.sources))
      if (!decision) return
      const compose = prepareStandalonePdfExport(pages, workspace.sources, mode === 'editor', documentWatermark)
      const output = await imposePdfPages(await compose(), perSheet as 2 | 4 | 6 | 8 | 9)
      const saved = await downloadBytes(output, `多页拼接-${perSheet}合1.pdf`, decision === 'new-file')
      if (saved) notify(`已将 ${pages.length} 页按每张 ${perSheet} 页拼接输出`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '多页拼接失败')
    } finally {
      setBusy('')
    }
  }, [documentWatermark, mode, navigationPages, notify, workspace.pages, workspace.selectedIds, workspace.sources])

  const archiveInvoices = useCallback(async () => {
    const selected = navigationPages.filter((page) => workspace.selectedIds.has(page.id))
    const pages = selected.length ? selected : navigationPages
    if (!pages.length) return
    setBusy('正在整理发票归档')
    try {
      if (!await confirmPdfCopy(pageSources(pages, workspace.sources))) return
      const compose = prepareStandalonePdfExport(pages, workspace.sources, mode === 'editor', documentWatermark)
      const files = []
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]
        const source = sourcesById.get(page.sourceId)
        const text = page.ocr?.text ?? source?.pageText[page.sourcePage] ?? ''
        const date = text.match(/(20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})日?/)?.slice(1, 4)
        const number = text.match(/(?:发票号码|号码)\s*[:：]?\s*([0-9]{8,20})/)?.[1]
        const datePart = date ? date.map((part, partIndex) => partIndex ? part.padStart(2, '0') : part).join('-') : '日期未识别'
        const numberPart = number ?? `${(source ? sourceLabel(source) : '发票').replace(/\.pdf$/i, '')}-第${page.sourcePage + 1}页`
        files.push({
          name: `发票-${datePart}-${numberPart.replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
          bytes: await compose([page]),
        })
      }
      if (window.desktop) {
        if (!await window.desktop.saveMany(files)) return
      } else for (const file of files) await downloadBytes(file.bytes, file.name)
      notify(`已整理 ${files.length} 份发票；未识别日期或号码的文件已保留来源页码`) 
    } catch (error) {
      notify(error instanceof Error ? error.message : '发票归档失败')
    } finally {
      setBusy('')
    }
  }, [documentWatermark, mode, navigationPages, notify, sourcesById, workspace.pages, workspace.selectedIds, workspace.sources])

  const createDirectoryPages = useCallback(async () => {
    if (!activePage) return
    const source = sourcesById.get(activePage.sourceId)
    if (!source) {
      notify('空白页无法自动创建目录。')
      return
    }
    setBusy('正在创建目录')
    try {
      const outline = await readOutline(source)
      const entries: { title: string; page: number; level: number }[] = []
      const flatten = (nodes: typeof outline, level = 0) => nodes.forEach((node) => {
        entries.push({ title: node.title || '未命名章节', page: (node.pageIndex ?? 0) + 1, level })
        flatten(node.children, level + 1)
      })
      flatten(outline)
      userBookmarks
        .filter((bookmark) => bookmark.sourceId === source.id)
        .forEach((bookmark) => entries.push({ title: bookmark.title, page: bookmark.sourcePage + 1, level: 0 }))
      if (!entries.length) {
        notify('当前 PDF 没有可用于生成目录的原始书签；请先添加书签。')
        return
      }
      const bytes = await createTocPdf(entries, sourceLabel(source))
      const toc = await inspectPdf(bytes, `${sourceLabel(source).replace(/\.pdf$/i, '')}-目录.pdf`, undefined, true)
      const groupPages = workspace.pages.filter((page) => pageGroupId(page) === activeGroupId)
      const anchor = groupPages[0] ?? activePage
      workspace.insertSourcePages(anchor.id, toc, 'before', Array.from({ length: toc.pageCount }, (_, index) => index))
      notify(`已根据 ${entries.length} 个书签创建 ${toc.pageCount} 页目录并插入文档开头`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建目录失败')
    } finally {
      setBusy('')
    }
  }, [activeGroupId, activePage, notify, sourcesById, userBookmarks, workspace])

  useEffect(() => {
    if (hidden || !ocrRunning) return
    const stage = stageRef.current
    const markInteraction = () => {
      // Do not start the next high-resolution OCR raster while the user is
      // actively scrolling. In-flight ONNX inference continues in its worker.
      ocrInteractionUntilRef.current = performance.now() + 220
    }
    stage?.addEventListener('scroll', markInteraction, { passive: true })
    stage?.addEventListener('wheel', markInteraction, { passive: true })
    stage?.addEventListener('pointerdown', markInteraction, { passive: true })
    window.addEventListener('keydown', markInteraction)
    return () => {
      stage?.removeEventListener('scroll', markInteraction)
      stage?.removeEventListener('wheel', markInteraction)
      stage?.removeEventListener('pointerdown', markInteraction)
      window.removeEventListener('keydown', markInteraction)
    }
  }, [hidden, ocrRunning])

  const waitForOcrInteractionIdle = useCallback(async () => {
    while (!ocrCancelRef.current && performance.now() < ocrInteractionUntilRef.current) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }, [])

  const runOcr = useCallback(async (options: OcrRunOptions) => {
    if (ocrInFlightRef.current) {
      notify('当前工作区已有 OCR 任务，请等待完成或先取消')
      return
    }
    if (!window.desktop?.recognizeOcrPage) {
      notify('OCR 需要在 Windows 桌面版中运行。')
      return
    }
    const wantedSources = new Set(options.sourceIds)
    const wantedPages = options.pageIds ? new Set(options.pageIds) : undefined
    const uniqueTasks = new Map<string, WorkspacePage>()
    workspace.pages.forEach((page) => {
      if (page.sourceId !== 'blank' && wantedSources.has(page.sourceId) && (!wantedPages || wantedPages.has(page.id))) {
        uniqueTasks.set(`${page.sourceId}:${page.sourcePage}`, page)
      }
    })
    const tasks = [...uniqueTasks.values()]
    if (!tasks.length) {
      notify('所选文件在当前工作区中没有可识别页面。')
      return
    }

    ocrInFlightRef.current = true
    ocrCancelRef.current = false
    setOcrRunning(true)
    setOcrLastIssue(undefined)
    setOcrProgress({ stage: '正在准备本地 OCR 引擎', currentPage: 0, totalPages: tasks.length, sourceName: '' })
    const results: OcrPageResult[] = []
    let skipped = 0, failed = 0, empty = 0, firstFailure = ''
    try {
      for (let index = 0; index < tasks.length; index += 1) {
        if (ocrCancelRef.current) break
        const page = tasks[index]
        const source = sourcesById.get(page.sourceId)
        if (!source) {
          failed += 1
          firstFailure ||= `第 ${page.sourcePage + 1} 页：来源已关闭，请重新打开文件。`
          continue
        }
        const baseProgress = {
          currentPage: index + 1,
          totalPages: tasks.length,
          sourceName: sourceLabel(source),
        }
        // Match the release in finally. Without this retain, recognizing the
        // currently visible page decremented PdfPage's own lease and could let
        // the delayed cleanup discard resources while that page was on screen.
        retainPdfPageResources(source, page.sourcePage)
        try {
          if (options.skipTextPages) {
            setOcrProgress({ ...baseProgress, stage: '正在检查现有文字层' })
            const nativeText = await getPdfTextContent(source, page.sourcePage)
            const pageSize = source.pageSizes[page.sourcePage] ?? { width: 612, height: 792 }
            const textItems = nativeText.items.filter((item) => 'str' in item)
            if (page.ocr?.words.some((word) => word.text.trim() && word.width > 0 && word.height > 0)
              || hasSufficientNativeTextLayer(textItems, pageSize)) {
              skipped += 1
              continue
            }
          }

          await waitForOcrInteractionIdle()
          if (ocrCancelRef.current) break
          setOcrProgress({ ...baseProgress, stage: `正在渲染第 ${page.sourcePage + 1} 页` })
          const {contentBox,rotation,...image} = await renderPageForOcr(source, page.sourcePage, options.mode, page.rotation)
          if (ocrCancelRef.current) break
          setOcrProgress({ ...baseProgress, stage: options.mode === 'handwriting' ? '正在识别手写内容' : '正在识别页面文字' })
          const systemOcr = '__TAURI_INTERNALS__' in window
          const configuredMode = systemOcr ? (options.mode === 'printed' ? 'printed' : 'auto') : options.mode !== 'auto'
            ? options.mode
            : ocrSettings.routingMode === 'automatic' ? 'auto'
              : ocrSettings.routingMode === 'printed' ? 'printed'
                : ocrSettings.routingMode === 'handwriting' ? 'handwriting' : 'auto'
          const recognized = await window.desktop.recognizeOcrPage({
            ...image,
            mode: configuredMode,
            documentType: !systemOcr && options.mode === 'auto' && ocrSettings.routingMode === 'complex' ? 'complex' : undefined,
            pipeline: systemOcr ? undefined : {
              preprocess: ocrSettings.preprocess,
              handwritingProvider: ocrSettings.handwritingProvider,
              lowConfidenceProvider: ocrSettings.lowConfidenceProvider,
              lowConfidenceThreshold: ocrSettings.lowConfidenceThreshold,
              contextualCorrection: ocrSettings.contextualCorrection,
              tencent: ocrSettings.tencent,
              custom: ocrSettings.custom,
            },
          })
          const ocr = ocrLayerFromResult(recognized, contentBox, rotation, options.mode)
          if (ocr.words.length) results.push({ sourceId: page.sourceId, sourcePage: page.sourcePage, ocr })
          else empty++ // An empty engine result is not an IPC failure or a reason to erase an existing layer.
        } catch (error) {
          failed++
          firstFailure ||= `第 ${page.sourcePage + 1} 页：${(error instanceof Error ? error.message : '页面识别失败，请检查本机识别器后重试。').slice(0, 200)}`
        } finally {
          releasePdfPageResources(source, page.sourcePage)
        }
        // requestAnimationFrame pauses in an occluded/background renderer. A
        // timer yield keeps cancellation and the next OCR page moving while
        // still returning control to foreground interactions between pages.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }

      if (results.length) {
        workspace.applyOcrResults(results)
        setSearchIndexVersion((value) => value + 1)
      }
      const cancelled = ocrCancelRef.current
      const summary = cancelled
        ? `OCR 已停止，保留已完成的 ${results.length} 页`
        : `OCR 已完成 ${results.length} 页${skipped ? `，跳过 ${skipped} 页已有文字` : ''}${empty ? `，${empty} 页未检出文字` : ''}${failed ? `，${failed} 页失败` : ''}`
      const reason = firstFailure || (empty ? '若不是空白页，请确认页面朝向和系统 OCR 语言后重试。' : '')
      const receipt = reason ? `${summary}。${reason}` : summary
      if (reason) setOcrLastIssue({sourceIds:[...wantedSources], message:receipt})
      notify(receipt)
      setOcrProgress({
        stage: cancelled ? '已停止' : failed ? '部分页面识别失败，可重试' : '识别完成',
        currentPage: cancelled ? results.length + skipped + empty + failed : tasks.length,
        totalPages: tasks.length,
        sourceName: '',
      })
      setOcrOpen(false)
    } finally {
      ocrInFlightRef.current = false
      setOcrRunning(false)
    }
  }, [notify, ocrSettings, sourcesById, waitForOcrInteractionIdle, workspace])

  const releasePrintItems = useCallback((items: PrintQueueItem[]) => {
    items.filter((item) => item.external).flatMap((item) => item.sources).forEach(releasePdfDocument)
  }, [])

  const clearPrintQueue = useCallback(() => {
    printProofs.current.clear()
    printSessionRef.current += 1
    setPrintQueue((current) => {
      releasePrintItems(current)
      return []
    })
  }, [releasePrintItems])

  const closePrintDialog = useCallback(() => {
    setPrintOpen(false)
    clearPrintQueue()
  }, [clearPrintQueue])

  const openPrintDialog = useCallback(() => {
    clearPrintQueue()
    // In the reader Ctrl+P means this document, not every tab left open.
    // The merge/collector navigation scope already includes the full workspace.
    const selected = multiSelect && workspace.selectedIds.size
      ? navigationPages.filter((page) => workspace.selectedIds.has(page.id))
      : navigationPages
    const selectedSourceIds = new Set(selected.map((page) => page.sourceId))
    const selectedSources = workspace.sources.filter((source) => selectedSourceIds.has(source.id))
    setPrintQueue(selected.length ? [{
      id: uid(),
      name: multiSelect && workspace.selectedIds.size
        ? `当前工作区 · 选中 ${selected.length} 页`
        : mode === 'editor' && activeSource ? `${sourceLabel(activeSource)} · ${selected.length} 页` : `当前工作区 · 全部 ${selected.length} 页`,
      pageCount: selected.length,
      size: selectedSources.reduce((total, source) => total + source.bytes.byteLength, 0),
      origin: 'workspace',
      watermark: documentWatermark(),
      pages: selected,
      sources: selectedSources,
      external: false,
    }] : [])
    setPrintOpen(true)
  }, [activeSource, clearPrintQueue, documentWatermark, mode, multiSelect, navigationPages, workspace.selectedIds, workspace.sources])

  const addPrintFiles = useCallback(async (
    files: PrintFileInput[],
    origin: 'file' | 'folder',
    expectedSession = printSessionRef.current,
  ) => {
    if (!files.length) return
    const session = expectedSession
    if (session !== printSessionRef.current) return
    setBusy(origin === 'folder' ? '正在读取文件夹 PDF' : '正在读取打印文件')
    const pathKey = (path?: string) => path?.trim().toLocaleLowerCase() || ''
    const knownPaths = new Set(printQueueRef.current.flatMap((item) => item.sources)
      .map((source) => pathKey(source.path)).filter(Boolean))
    let duplicateCount = 0
    const pending = files.filter((file) => {
      const key = pathKey(file.path)
      if (!key || !knownPaths.has(key)) {
        if (key) knownPaths.add(key)
        return true
      }
      duplicateCount += 1
      return false
    })
    try {
      const results: PromiseSettledResult<PrintQueueItem>[] = []
      // Resolve only two PDFs at once so large selections do not multiply
      // source bytes, PDF.js worker buffers and pdf-lib copies across the batch.
      for (let index = 0; index < pending.length; index += 2) {
        const batch = pending.slice(index, index + 2)
        results.push(...await Promise.allSettled(batch.map(async (file): Promise<PrintQueueItem> => {
          const desktopFile = 'bytes' in file
            ? file
            : await window.desktop!.readPdfFileForPrint(file.path)
          const source = await inspectDesktopFile(desktopFile, false, requestPdfPassword, passwordSecurityFor(desktopFile.name))
          const item: PrintQueueItem = {
            id: uid(),
            name: source.name,
            pageCount: source.pageCount,
            size: file.size ?? source.bytes.byteLength,
            origin,
            pages: pagesForSource(source),
            sources: [source],
            external: true,
          }
          // The print queue only needs source bytes and page metadata. Dispose
          // the pdf.js document immediately instead of retaining a renderer per file.
          releasePdfDocument(source)
          return item
        })))
        if (session !== printSessionRef.current) break
      }
      const added = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      const errors = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${pending[index]?.name ?? '文件'}：${result.reason instanceof Error ? result.reason.message : '无法读取'}`]
        : [])
      if (session !== printSessionRef.current) {
        releasePrintItems(added)
        return
      }
      setPrintQueue((current) => [...current, ...added])
      const summary = added.length ? `已加入 ${added.length} 个文件，共 ${added.reduce((sum, item) => sum + item.pageCount, 0)} 页` : '没有可加入的 PDF'
      notify([summary, duplicateCount ? `跳过 ${duplicateCount} 个重复文件` : '', errors.length ? `${errors.length} 个失败（${errors.slice(0, 2).join('；')}）` : ''].filter(Boolean).join('；'))
    } finally {
      setBusy('')
    }
  }, [notify, passwordSecurityFor, releasePrintItems, requestPdfPassword])

  const addPrintFilesFromPicker = useCallback(async () => {
    const session = printSessionRef.current
    if (window.desktop) {
      const files = await window.desktop.openPdfFilesForPrint(true)
      await addPrintFiles(files, 'file', session)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,application/pdf'
    input.multiple = true
    input.onchange = async () => {
      const files = await Promise.all([...(input.files ?? [])].map(browserFileToDesktopFile))
      await addPrintFiles(files, 'file', session)
    }
    input.click()
  }, [addPrintFiles])

  const addPrintFolder = useCallback(async () => {
    if (!window.desktop) {
      notify('浏览器无法直接读取文件夹，请使用“添加文件”批量选择 PDF。')
      return
    }
    const session = printSessionRef.current
    const files = await window.desktop.openPdfFolderForPrint()
    await addPrintFiles(files, 'folder', session)
  }, [addPrintFiles, notify])

  const removePrintItem = useCallback((id: string) => {
    setPrintQueue((current) => {
      const removed = current.find((item) => item.id === id)
      if (removed) releasePrintItems([removed])
      return current.filter((item) => item.id !== id)
    })
  }, [releasePrintItems])

  useEffect(() => () => {
    printSessionRef.current += 1
    releasePrintItems(printQueueRef.current)
  }, [releasePrintItems])

  // The rail and sheet proof share the same bounded, serial renderer. The large
  // bitmap is created only on demand, not for every page in a print queue.
  const printProof = useCallback((itemId: string, index: number, width = 144) => {
    const size = width > 144 ? Math.min(768, Math.round(width)) : 144
    const key = `${itemId}:${index}:${size}`
    const cache = printProofs.current, hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }
    const session = printSessionRef.current
    const job = proofTail.current.then(async () => {
      const item = printQueueRef.current.find(entry => entry.id === itemId)
      if (printSessionRef.current !== session || !item?.pages[index]) return undefined
      return makePrintProof(item.pages[index], item.sources, item.watermark, size)
    }).catch(() => undefined)
    proofTail.current = job
    cache.set(key, job)
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return job
  }, [])
  const renderPrintPreview = useCallback(async (id: string, index: number, width?: number) => (await printProof(id,index,width))?.url, [printProof])
  const getPreviewPageSize = useCallback(async (id: string, index: number) => {
    const prefix = `${id}:${index}:`
    const cached = [...printProofs.current].find(([key]) => key.startsWith(prefix))?.[1]
    const proof = await (cached ?? printProof(id,index))
    return proof && {widthPt:proof.widthPt, heightPt:proof.heightPt}
  }, [printProof])

  const print = useCallback(async (options: PrintOptions) => {
    const allPages = printQueue.flatMap((item) => item.pages)
    const allSources = printQueue.flatMap((item) => item.sources)
    if (!allPages.length) {
      notify('请先把工作区、PDF 文件或文件夹加入打印清单。')
      return 'explained'
    }
    setBusy('正在准备打印')
    try {
      const baseIndices = options.range
        ? parsePageRanges(options.range, allPages.length)
        : allPages.map((_, index) => index)
      // 子集 (odd/even) applies to absolute document page numbers, like Adobe's
      // "Subset" — a 1-6 range plus 仅偶数页 prints pages 2, 4 and 6.
      const subset = options.subset ?? 'all'
      const picked = orderPrintPageIndices(
        subset === 'all'
          ? baseIndices
          : baseIndices.filter((index) => ((index + 1) % 2 === 1) === (subset === 'odd')),
        options.pageOrder,
        allPages.length,
      )
      if (!picked.length) {
        throw new Error('当前打印范围与奇偶页、排除条件没有交集，请调整选择。')
      }
      if (options.reverse) picked.reverse()
      const pages = picked.map((index) => allPages[index])
      const selectedSourceIds = new Set(pages.map((page) => page.sourceId))
      const selectedSources = [...new Map(allSources
        .filter((source) => selectedSourceIds.has(source.id))
        .map((source) => [source.id, source])).values()]
      const inputBytes = selectedSources.reduce((total, source) => total + source.bytes.byteLength, 0)
      if ((inputBytes > 384 * 1024 ** 2 || pages.length > 3000) && !window.confirm(
        `本次任务包含 ${pages.length} 页、约 ${formatBytes(inputBytes)} 源文件，合并打印可能占用较多内存。\n\n建议关闭其他大型程序，或分批打印。是否继续？`,
      )) return 'explained'
      const native = window.desktop
      const tauri = '__TAURI_INTERNALS__' in window
      if (tauri && pages.length > 2000) throw new Error('单次最多打印 2000 页，请缩小范围或分批打印。')
      const marked = printQueue.find(item => item.origin === 'workspace' && item.watermark)
      const pdf = await composePdf(pages, selectedSources, marked ? {
        watermark: marked.watermark, watermarkPageIds: new Set(marked.pages.map(page => page.id)),
      } : {})
      if (!native) {
        await downloadBytes(pdf, '待打印文档.pdf')
        notify('已生成待打印 PDF，请在 PDF 阅读器中确认纸张与打印机。')
        return true
      }
      const rasters = await rasterizePdfForPrint(pdf, {
        grayscale: !options.color, dpi: Math.min(600, Math.max(72, Math.round(options.dpi ?? 300))),
        maxEncodedBytes: tauri ? 128 * 1024 ** 2 - 512 * 1024 : undefined,
        onProgress: (n, total) => setBusy(`正在准备打印页 ${n} / ${total}`),
      })
      setBusy('正在提交到打印服务…')
      return await native.printPages(rasters, options)
    } finally {
      setBusy('')
    }
  }, [downloadBytes, notify, printQueue])

  const pickExternalFile = useCallback(async () => {
    if (window.desktop) return (await window.desktop.openFiles({ images: true, documents: true, multiple: false }))[0]
    return new Promise<DesktopFile | undefined>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.pdf,.ofd,.png,.jpg,.jpeg'
      input.addEventListener('cancel', () => resolve(undefined), { once: true })
      input.onchange = async () => resolve(input.files?.[0]
        ? await browserFileToDesktopFile(input.files[0])
        : undefined)
      input.click()
    })
  }, [])

  const beginPageImport = useCallback(async (
    pageId: string,
    operation: PageImportOperation,
    droppedFile?: File,
  ) => {
    setBusy('正在读取待导入 PDF')
    try {
      const file = droppedFile ? await browserFileToDesktopFile(droppedFile) : await pickExternalFile()
      if (!file) return
      const source = await inspectDesktopFile(file, false, requestPdfPassword, passwordSecurityFor(file.name))
      const replaceIds = operation === 'replace' && documentSelection.has(pageId)
        ? new Set(documentSelection)
        : new Set([pageId])
      setPendingPageImport({ source, anchorId: pageId, operation, replaceIds })
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法读取该 PDF')
    } finally {
      setBusy('')
    }
  }, [documentSelection, notify, passwordSecurityFor, pickExternalFile, requestPdfPassword])

  const applyPageImport = useCallback(async (pageIndices: number[]) => {
    const pending = pendingPageImport
    if (!pending) return
    setPendingPageImport(null)
    setBusy('正在准备所选页面')
    try {
      await loadPdfPageSizes(pending.source, pageIndices)
      if (pending.operation === 'replace') {
        workspace.replacePagesWithSource(pending.replaceIds, pending.source, pageIndices)
        notify(`已删除 ${pending.replaceIds.size} 个选中页，并在原位置插入 ${pageIndices.length} 页`)
      } else {
        workspace.insertSourcePages(pending.anchorId, pending.source, pending.operation, pageIndices)
        notify(`已在目标页${pending.operation === 'before' ? '上方' : '下方'}插入 ${pageIndices.length} 页`)
      }
    } catch (error) {
      releasePdfDocument(pending.source)
      notify(error instanceof Error ? error.message : '页面导入失败')
    } finally {
      setBusy('')
    }
  }, [notify, pendingPageImport, workspace])

  const jumpToSearchHit = (hit: { id: string; pageId: string }) => {
    setActiveSearchHitId(hit.id)
    selectPage(hit.pageId)
  }

  const navigateMatch = (direction: number) => {
    if (!searchHits.length) return
    const next = (currentSearchHit + direction + searchHits.length) % searchHits.length
    jumpToSearchHit(searchHits[next])
  }

  const navigatePage = useCallback((direction: number) => {
    if (!navigationPages.length) return
    const current = Math.max(0, navigationPages.findIndex((page) => page.id === workspace.activeId))
    const next = clamp(current + direction, 0, navigationPages.length - 1)
    const target = navigationPages[next]
    if (!target || target.id === workspace.activeId) return
    workspace.select(target.id, false)
    if (viewMode !== 'single' || splitActive) scrollStagePageIntoView(target.id)
  }, [navigationPages, scrollStagePageIntoView, splitActive, viewMode, workspace])

  const commitPageJump = (value: string) => {
    const requested = Number(value)
    if (!navigationPages.length || !Number.isFinite(requested)) {
      setPageJumpValue(String(navigationIndex >= 0 ? navigationIndex + 1 : 0))
      return
    }
    const targetIndex = clamp(Math.trunc(requested) - 1, 0, navigationPages.length - 1)
    const target = navigationPages[targetIndex]
    setPageJumpValue(String(targetIndex + 1))
    if (target && target.id !== workspace.activeId) selectPage(target.id)
  }

  const motionEnabled = useContext(AppMotion)
  const noteFrame = useRef(0)
  const endNoteScroll = useRef<(settle?: boolean) => void>()
  useLayoutEffect(() => {
    if (!motionEnabled) endNoteScroll.current?.(true)
  }, [motionEnabled])
  useLayoutEffect(() => () => {
    cancelAnimationFrame(noteFrame.current)
    endNoteScroll.current?.()
  }, [hidden])

  const activateNote = useCallback((pageId: string, annotationId: string, focus: 'editor' | 'pin' = 'editor') => {
    setAnnotationSelection(undefined);setActiveTextTarget(undefined)
    setActiveNoteTarget({ pageId, annotationId })
    setRightPanel('notes')
    selectPage(pageId)
    cancelAnimationFrame(noteFrame.current)
    endNoteScroll.current?.()
    const reveal = () => {
      const card = noteCardRefs.current.get(annotationId)
      const target = focus === 'pin'
        ? stageRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`note-pin-${annotationId}`)}`)
        : card?.querySelector<HTMLElement>('textarea[id]') ?? card
      if (!target) return
      const scroll = (behavior: ScrollBehavior) => target.scrollIntoView({ behavior, block: 'nearest', inline: 'nearest' })
      const smooth = document.documentElement.dataset.motion === 'on'
      const pane = target.closest('.notes-drawer__list, .split-pane__body, .stage')
      if (smooth && pane) {
        const box = target.getBoundingClientRect(), view = pane.getBoundingClientRect()
        // An already-visible target won't emit scrollend. Don't retain it as an intent.
        if (box.top < view.top || box.bottom > view.bottom || box.left < view.left || box.right > view.right) {
          const done = () => { pane.removeEventListener('scrollend', done); endNoteScroll.current = undefined }
          pane.addEventListener('scrollend', done)
          endNoteScroll.current = settle => {
            done()
            if (settle && target.isConnected) scroll('instant')
          }
        }
      }
      scroll(smooth ? 'smooth' : 'instant')
      target.focus({ preventScroll: true })
    }
    noteFrame.current = requestAnimationFrame(() => { noteFrame.current = requestAnimationFrame(reveal) })
  }, [selectPage])

  useEffect(() => {
    if (activeNoteTarget && activeNoteSelection) return
    const fallback = pageNotes.find(({ page }) => page.id === workspace.activeId) ?? pageNotes[0]
    setActiveNoteTarget(fallback ? { pageId: fallback.page.id, annotationId: fallback.annotation.id } : undefined)
  }, [activeNoteSelection, activeNoteTarget, pageNotes, workspace.activeId])

  const toggleMultiSelect = useCallback(() => {
    setMultiSelect((current) => {
      if (current) {
        if (workspace.activeId) workspace.select(workspace.activeId, false)
        else workspace.clearSelection()
      }
      return !current
    })
  }, [workspace])

  const toggleSplitSource = useCallback((sourceId: string) => {
    if (mode !== 'editor') return
    const next = new Set(splitSourceIds)
    if (next.has(sourceId)) next.delete(sourceId)
    else {
      if (next.size >= 4) {
        notify('最多同时分屏浏览 4 个 PDF')
        return
      }
      // Comparing another file usually means “current document + this one”.
      if (!next.size && activeGroupId && activeGroupId !== sourceId) next.add(activeGroupId)
      if (next.size >= 4) {
        notify('最多同时分屏浏览 4 个 PDF')
        return
      }
      next.add(sourceId)
    }
    setSplitSourceIds(next)
    if (next.size === 1 && splitSourceIds.size < 2) notify('已勾选 1 个 PDF，再勾选一个即可开始分屏')
    if (next.size === 1 && splitSourceIds.size >= 2 && sourceId === activeGroupId) {
      const remainingId = [...next][0]
      const target = workspace.pages.find((page) => pageGroupId(page) === remainingId && page.id === lastPageByGroup.current.get(remainingId))
        ?? workspace.pages.find((page) => pageGroupId(page) === remainingId)
      if (target) selectPage(target.id)
    }
  }, [activeGroupId, mode, notify, selectPage, splitSourceIds, workspace.pages])

  const pageDimensions = useCallback((page = activePage) => {
    if (!page) return { width: 595.28, height: 841.89 }
    const size = page.sourceId === 'blank'
      ? page.pageSize ?? { width: 595.28, height: 841.89 }
      : sourcesById.get(page.sourceId)?.pageSizes[page.sourcePage] ?? { width: 612, height: 792 }
    return page.rotation % 180 === 0
      ? size
      : { width: size.height, height: size.width }
  }, [activePage, pageSizeVersion, sourcesById])

  // The page under (or nearest) the stage's viewport centre, with the centre's
  // in-page fractions clamped to [0,1]. This is the spot the user is actually
  // looking at — activeId can lag behind wheel scrolling, so zoom and view
  // switches anchor here instead of to the last clicked page.
  const centreStageAnchor = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const stageRect = stage.getBoundingClientRect()
    const cx = stageRect.left + stageRect.width / 2
    const cy = stageRect.top + stageRect.height / 2
    let best: { pageId: string; fx: number; fy: number; distance: number } | undefined
    for (const el of stage.querySelectorAll<HTMLElement>('[data-page-id]')) {
      const rect = el.getBoundingClientRect()
      const gapX = Math.max(rect.left - cx, 0, cx - rect.right)
      const gapY = Math.max(rect.top - cy, 0, cy - rect.bottom)
      const distance = Math.hypot(gapX, gapY)
      if (rect.width > 0 && rect.height > 0 && (!best || distance < best.distance)) {
        best = {
          pageId: el.dataset.pageId!,
          fx: clamp((cx - rect.left) / rect.width, 0, 1),
          fy: clamp((cy - rect.top) / rect.height, 0, 1),
          distance,
        }
      }
      if (distance === 0) break
    }
    return best
  }, [])

  // Zoom anchor: remember the content under the viewport centre (page + in-page
  // fraction) so every zoom path keeps the current page's relative position
  // instead of jumping to whatever happens to share the old pixel offset.
  const zoomAnchorRef = useRef<{ pageId: string; fx: number; fy: number } | null>(null)
  const applyZoom = useCallback((next: number | ((value: number) => number)) => {
    const resolved = clamp(typeof next === 'function' ? next(zoom) : next, 0.25, 5)
    zoomAnchorRef.current = null
    // No-op zooms (already at a clamp boundary / same value) must not leave a
    // stale anchor behind for an unrelated setZoom to consume later.
    if (resolved === zoom) return
    if (!splitActive) zoomAnchorRef.current = centreStageAnchor() ?? null
    setZoom(resolved)
  }, [centreStageAnchor, splitActive, zoom])

  const fitView = useCallback((kind: 'width' | 'page', mode = viewMode) => {
    const stage = stageRef.current
    if (!stage) return
    const size = pageDimensions()
    if (splitActive) {
      const columns = stage.clientWidth >= 920 ? 2 : 1
      const rows = Math.ceil(selectedSplitSources.length / columns)
      const paneWidth = (stage.clientWidth - 18 - (columns - 1) * 10) / columns
      const widthFit = Math.max(0.01, (paneWidth - 42) / (size.width * PDF_CSS_UNITS))
      if (kind === 'width') applyZoom(clamp(widthFit, 0.25, 5))
      else {
        const paneHeight = Math.max(260, stage.clientHeight / Math.max(1, rows) - 50)
        const heightFit = (paneHeight - 72) / (size.height * PDF_CSS_UNITS)
        applyZoom(clamp(Math.min(widthFit, heightFit), 0.25, 5))
      }
      return
    }
    const spread = mode === 'spread'
    const widthZoom = (stage.clientWidth - 76 - (spread ? 24 : 0))
      / (size.width * PDF_CSS_UNITS * (spread ? 2 : 1))
    const pageZoom = Math.min(widthZoom, (stage.clientHeight - 48) / (size.height * PDF_CSS_UNITS))
    applyZoom(clamp(kind === 'width' ? widthZoom : pageZoom, 0.25, 5))
  }, [applyZoom, pageDimensions, selectedSplitSources.length, splitActive, viewMode])

  const actualSize = useCallback(() => {
    applyZoom(1)
  }, [applyZoom])

  const changeViewMode = useCallback((mode: ViewMode) => {
    // Entering a paged view re-renders the stage around the current file;
    // bring the page the user is actually looking at back under the viewport.
    // (activeId can lag wheel scrolling, so prefer the viewport-centre page.)
    const centrePageId = mode === 'single' ? undefined : centreStageAnchor()?.pageId ?? workspace.activeId ?? undefined
    setViewMode(mode)
    if (centrePageId) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollStagePageIntoView(centrePageId)))
    }
  }, [centreStageAnchor, scrollStagePageIntoView, workspace.activeId])

  const markInternalClipboard = useCallback((kind: 'pages' | 'annotations') => {
    const token = `paperwork:${kind}:${uid()}`
    clipboardTokenRef.current = token
    setClipboardKind(kind)
    // Electron uses a private clipboard format so internal page/element copy
    // never leaks a marker into text boxes or external applications.
    window.desktop?.writeInternalClipboardToken(token)
  }, [])

  const selectAnnotation = useCallback((pageId: string, annotationId: string, additive = false) => {
    setMultiSelect(false)
    workspace.select(pageId, false)
    const annotation = workspace.pages.find((page) => page.id === pageId)?.annotations.find((item) => item.id === annotationId)
    if (annotation?.type !== 'text') setActiveTextTarget(undefined)
    setAnnotationSelection((current) => {
      if (!additive || current?.pageId !== pageId) {
        return { pageId, ids: new Set([annotationId]), primaryId: annotationId }
      }
      const ids = new Set(current.ids)
      if (ids.has(annotationId)) ids.delete(annotationId)
      else ids.add(annotationId)
      if (!ids.size) return undefined
      return { pageId, ids, primaryId: ids.has(annotationId) ? annotationId : [...ids].at(-1)! }
    })
  }, [workspace])

  const copyAnnotations = useCallback((cut = false) => {
    if (!annotationSelection?.ids.size) return
    const page = workspace.pages.find((item) => item.id === annotationSelection.pageId)
    const selected = page?.annotations.filter((annotation) => annotationSelection.ids.has(annotation.id)) ?? []
    if (!selected.length) return
    setAnnotationClipboard(selected.map((annotation) => ({
      ...annotation,
      points: annotation.points?.map((point) => ({ ...point })),
      replies: annotation.replies?.map((reply) => ({ ...reply })),
    })))
    markInternalClipboard('annotations')
    if (cut && page) {
      workspace.removeAnnotations(page.id, annotationSelection.ids)
      setAnnotationSelection(undefined)
      setActiveTextTarget(undefined)
    }
    notify(`${cut ? '已剪切' : '已复制'} ${selected.length} 个页面元素，可在其他页原位置粘贴`)
  }, [annotationSelection, markInternalClipboard, notify, workspace])

  const pasteAnnotations = useCallback((pageId = activePage?.id) => {
    if (!pageId || !annotationClipboard.length) return
    const page = workspace.pages.find((item) => item.id === pageId)
    const size = pageDimensions(page)
    const templates = annotationClipboard.map((annotation) => {
      if (annotation.type !== 'text') return annotation
      const next = {
        ...annotation,
        pageAspectRatio: size.width / size.height,
        pageHeight: size.height,
        formFieldId: undefined,
        formFieldName: undefined,
        formFieldRect: undefined,
      }
      return { ...next, imageData: rasterizeText(next) }
    })
    const ids = workspace.addAnnotations(pageId, templates)
    if (!ids.length) return
    setAnnotationSelection({ pageId, ids: new Set(ids), primaryId: ids.at(-1)! })
    notify(`已在当前页相同位置粘贴 ${ids.length} 个元素`)
  }, [activePage?.id, annotationClipboard, notify, pageDimensions, workspace])

  const removeSelectedAnnotations = useCallback(() => {
    if (!annotationSelection?.ids.size) return
    workspace.removeAnnotations(annotationSelection.pageId, annotationSelection.ids)
    notify(`已删除 ${annotationSelection.ids.size} 个页面元素，可按 Ctrl+Z 恢复`)
    setAnnotationSelection(undefined)
    setActiveTextTarget(undefined)
  }, [annotationSelection, notify, workspace])

  const copySelection = useCallback((cut = false) => {
    const selected = navigationPages.filter((page) => workspace.selectedIds.has(page.id))
    const pages = selected.length ? selected : activePage ? [activePage] : []
    if (!pages.length) return
    setPageClipboard(pages.map((page) => ({
      ...page,
      annotations: page.annotations.map((annotation) => ({ ...annotation })),
    })))
    markInternalClipboard('pages')
    if (cut) workspace.remove(new Set(pages.map((page) => page.id)))
    notify((cut ? '已剪切 ' : '已复制 ') + pages.length + ' 页，可在目标页后粘贴')
  }, [activePage, markInternalClipboard, navigationPages, notify, workspace])

  const pastePages = useCallback((anchorId = workspace.activeId) => {
    if (!pageClipboard.length) return
    workspace.insertPagesAfter(anchorId, pageClipboard)
    notify('已在目标位置后插入 ' + pageClipboard.length + ' 页')
  }, [notify, pageClipboard, workspace])

  const addAnnotation = (type: 'text' | 'highlight' | 'note', x: number, y: number, pageId: string, size?: { width: number; height: number }) => {
    if (type === 'text') {
      const page = workspace.pages.find((entry) => entry.id === pageId)
      const dimensions = pageDimensions(page)
      const width = size ? Math.max(0.05, Math.min(0.96, size.width)) : 0.3
      // The height floor is exactly one line at the default 16pt font, so a
      // drawn box never starts smaller than its text.
      const height = size
        ? Math.max(textMinHeightFraction(16, dimensions.height), Math.min(0.9, size.height))
        : 0.08
      const next: Markup = {
        id: uid(),
        type,
        x: clamp(x, 0, 1 - width), y: clamp(y, 0, 1 - height),
        width, height,
        text: '', color: '#18324a', fontSize: 16, fontFamily: 'Microsoft YaHei',
        pageAspectRatio: dimensions.width / dimensions.height, pageHeight: dimensions.height,
      }
      setTool('pan')
      setTextPlacement({pageId,box:next})
    } else if (type === 'note') {
      const annotationId = workspace.addAnnotation(pageId, {
        type, x: Math.min(x, 0.94), y: Math.min(y, 0.94), width: 0.045, height: 0.045,
        text: '', color: '#ac7644', author: currentAuthor.trim() || '当前用户', createdAt: new Date().toISOString(),
      })
      if (annotationId) {setTool('pan');activateNote(pageId, annotationId)}
    } else {
      workspace.addAnnotation(pageId, {
        type, x, y, width: 0.24, height: 0.035, color: '#f4c84a',
      })
    }
  }

  const addTextHighlights = useCallback((pageId: string, boxes: TextHighlightBox[], text: string) => {
    if (!boxes.length) return
    if(text.length>1_000_000){notify('所选文字太长，请分段高亮。');return}
    const excerpt = text.trim()
    const highlightGroupId = uid()
    const ids = workspace.addAnnotations(pageId, boxes.map((box, index) => ({
      id: uid(),
      type: 'highlight',
      highlightGroupId,
      ...box,
      color: '#f4c84a',
      opacity: 0.48,
      text: index === 0 ? excerpt : undefined,
    })))
    if (ids.length) notify(`已高亮所选文字${boxes.length > 1 ? `（${boxes.length} 行）` : ''}，可按 Ctrl+Z 撤销`)
  }, [notify, workspace])

  const addTextReplacement = useCallback((pageId: string, boxes: TextHighlightBox[], text: string) => {
    if (!boxes.length) return
    const page = workspace.pages.find((item) => item.id === pageId)
    if (!page) return
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    const width = Math.max(0.04, right - left)
    const height = Math.max(0.025, bottom - top)
    const size = pageDimensions(page)
    const coverIds = workspace.addAnnotations(pageId, boxes.map((box) => ({
      id: uid(), type: 'rectangle' as const, ...box, color: '#ffffff', filled: true, strokeWidth: 0,
    })))
    const replacement: Omit<Markup, 'id'> = {
      type: 'text', x: left, y: top, width, height,
      text, color: '#182f41', fontFamily: 'Microsoft YaHei',
      fontSize: fitTextFontSize(text, width * size.width - 4, height * size.height - 4, 28, 5),
      autoFit: true, autoFitMaxSize: 28,
      pageAspectRatio: size.width / size.height, pageHeight: size.height,
    }
    const replacementId = workspace.addAnnotation(pageId, {
      ...replacement,
      imageData: rasterizeText({ ...replacement, id: 'replacement-preview' }),
    })
    if (!replacementId) return
    setAnnotationSelection({ pageId, ids: new Set([...coverIds, replacementId]), primaryId: replacementId })
    setActiveTextTarget({ pageId, annotationId: replacementId })
    setTool('pan')
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`#pdf-stage [data-annotation-id="${replacementId}"] textarea`)?.focus())
    notify('已建立覆盖式文字编辑层；原内容流保持不变，导出后视觉效果兼容常用阅读器')
  }, [notify, pageDimensions, workspace])

  // Adobe Fill & Sign style: drop a text box exactly over a detected "label:"
  // blank, sized to the preview and matched to the label's font size. autoFit
  // keeps longer input inside the box by shrinking from that starting size.
  const addFormBlankText = useCallback((pageId: string, blank: { x: number; y: number; width: number; height: number; fontSizePt: number }) => {
    const page = workspace.pages.find((entry) => entry.id === pageId)
    if (!page) return
    const size = pageDimensions(page)
    const maxFontSize = clamp(blank.fontSizePt, 6, 72)
    const width = Math.max(0.04, Math.min(0.98, blank.width))
    const height = Math.max(0.008, Math.min(0.9, blank.height))
    const x = Math.max(0, Math.min(1 - width, blank.x))
    const y = Math.max(0, Math.min(1 - height, blank.y))
    const next: Omit<Markup, 'id'> = {
      type: 'text', x, y, width, height,
      text: '', color: '#18324a', fontFamily: 'Microsoft YaHei',
      fontSize: maxFontSize, autoFit: true, autoFitMaxSize: maxFontSize,
      pageAspectRatio: size.width / size.height, pageHeight: size.height,
    }
    const annotationId = workspace.addAnnotation(pageId, { ...next, imageData: rasterizeText({ ...next, id: 'form-blank-preview' }) })
    if (!annotationId) return
    setAnnotationSelection({ pageId, ids: new Set([annotationId]), primaryId: annotationId })
    setActiveTextTarget({ pageId, annotationId })
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(`#pdf-stage [data-annotation-id="${annotationId}"] textarea`)?.focus()
    }))
  }, [pageDimensions, workspace])

  const addFittedText = useCallback((pageId: string, field: Omit<PdfFormField, 'id'> & { id?: string }) => {    const page = workspace.pages.find((item) => item.id === pageId)
    if (!page || field.hidden || field.readOnly) return
    const existing = field.id
      ? page.annotations.find((annotation) => annotation.type === 'text' && annotation.formFieldId === field.id)
      : undefined
    if (existing) {
      selectAnnotation(pageId, existing.id)
      setActiveTextTarget({ pageId, annotationId: existing.id })
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#pdf-stage [data-annotation-id="${existing.id}"] textarea`)?.focus())
      return
    }
    const size = pageDimensions(page)
    const minWidth = field.id ? 0.005 : 0.05
    const minHeight = field.id ? 0.005 : 0.025
    const x = Math.max(0, Math.min(1 - minWidth, field.x))
    const y = Math.max(0, Math.min(1 - minHeight, field.y))
    const width = Math.max(minWidth, Math.min(1 - x, field.width))
    const height = Math.max(minHeight, Math.min(1 - y, field.height))
    const maxFontSize = field.fontSize && field.fontSize > 0
      ? clamp(field.fontSize, 8, 48)
      : clamp(height * size.height / 1.35, 8, 28)
    const next: Omit<Markup, 'id'> = {
      type: 'text', x, y, width, height,
      text: field.value ?? '', color: '#18324a', fontFamily: 'Microsoft YaHei',
      fontSize: fitTextFontSize(
        field.value ?? '',
        width * size.width - 6,
        height * size.height - 6,
        maxFontSize,
        4,
      ),
      autoFit: true,
      autoFitMaxSize: maxFontSize,
      maxLength: field.maxLength,
      multiline: field.multiline,
      required: field.required,
      formFieldId: field.id,
      formFieldName: field.name,
      formFieldRect: field.pdfRect,
      pageAspectRatio: size.width / size.height,
      pageHeight: size.height,
    }
    const annotationId = workspace.addAnnotation(pageId, { ...next, imageData: rasterizeText({ ...next, id: 'fill-preview' }) })
    if (!annotationId) return
    setAnnotationSelection({ pageId, ids: new Set([annotationId]), primaryId: annotationId })
    setActiveTextTarget({ pageId, annotationId })
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`#pdf-stage [data-annotation-id="${annotationId}"] textarea`)?.focus()
    }))
    notify(field.id ? `已定位${field.name ? `“${field.name}”` : ''}表单字段` : '已添加自动适配填表文本框')
  }, [notify, pageDimensions, selectAnnotation, workspace])

  const autoFillActiveForm = useCallback(async () => {
    if (!activePage) return
    const source = sourcesById.get(activePage.sourceId)
    if (!source) return
    const fields = await getPdfFormFields(source, activePage.sourcePage, activePage.rotation)
    const editable = fields.filter((field) => !field.hidden && !field.readOnly)
    if (!editable.length) {
      notify('当前页没有可填写的 PDF 文本表单字段。')
      return
    }
    const example = editable.slice(0, 4).map((field) => `${field.name || '未命名字段'}=`).join('\n')
    const input = window.prompt('按“字段名=内容”逐行输入。未匹配字段不会改动。', example)
    if (!input) return
    const values = new Map(input.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf('=')
      return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1)]] : []
    }))
    let filled = 0
    editable.forEach((field) => {
      const value = values.get(field.name ?? '')
      if (value === undefined) return
      addFittedText(activePage.id, { ...field, value })
      filled += 1
    })
    notify(filled ? `已自动填写 ${filled} 个匹配字段` : '没有找到名称匹配的字段，请核对字段名。')
  }, [activePage, addFittedText, notify, sourcesById])

  const verifyInvoice = useCallback(async () => {
    if (!activePage) return
    const pageText = activePage.ocr?.text ?? sourcesById.get(activePage.sourceId)?.pageText[activePage.sourcePage] ?? ''
    if (!pageText.trim() && window.desktop?.recognizeOcrPage) {
      notify('当前发票还没有文字层，已开始识别本页；完成后可复制发票代码和号码进行查验。')
      await runOcr({ sourceIds: [activePage.sourceId], pageIds: [activePage.id], mode: 'auto', skipTextPages: false })
    }
    if (window.desktop?.openExternal) {
      await window.desktop.openExternal('https://inv-veri.chinatax.gov.cn/')
      notify('已打开国家税务总局发票查验平台；验证码和查验结果需在官方页面完成。')
    } else {
      window.open('https://inv-veri.chinatax.gov.cn/', '_blank', 'noopener,noreferrer')
    }
  }, [activePage, notify, runOcr, sourcesById])

  const applyCommonPhrase = (phrase: CommonPhrase, forceNew = false) => {
    const selection = forceNew ? undefined : activeTextSelection
    const typography: Partial<Markup> = {
      text: phrase.text,
      fontFamily: phrase.fontFamily,
      fontSize: phrase.fontSize,
      color: phrase.color,
      bold: phrase.bold,
      italic: phrase.italic,
    }
    if (selection) {
      const current = selection.annotation
      const rawText = current.autoFit && !current.multiline
        ? phrase.text.replace(/[\r\n]+/g, ' ')
        : phrase.text
      const text = current.maxLength ? rawText.slice(0, current.maxLength) : rawText
      const pageSize = pageDimensions(selection.page)
      const autoFitMaxSize = current.autoFit ? phrase.fontSize : current.autoFitMaxSize
      const next: Markup = {
        ...current,
        ...typography,
        text,
        ...(current.autoFit ? {
          autoFitMaxSize,
          fontSize: fitTextFontSize(
            text,
            current.width * pageSize.width - 6,
            current.height * pageSize.height - 6,
            autoFitMaxSize,
            4,
          ),
          pageAspectRatio: pageSize.width / pageSize.height,
          pageHeight: pageSize.height,
        } : {}),
      }
      workspace.updateAnnotation(selection.page.id, current.id, {
        ...typography,
        text: next.text,
        fontSize: next.fontSize,
        autoFitMaxSize: next.autoFitMaxSize,
        pageAspectRatio: next.pageAspectRatio,
        pageHeight: next.pageHeight,
        imageData: rasterizeText(next),
      })
      notify('已应用到当前文本框')
      return
    }
    if (!activePage) {
      notify('请先打开或选择一页 PDF')
      return
    }
    const next: Markup = {
      id: 'phrase-preview', type: 'text', x: 0.18, y: 0.16, width: 0.38, height: 0.09,
      ...typography,
    }
    const { id: _previewId, ...annotation } = next
    workspace.addAnnotation(activePage.id, { ...annotation, imageData: rasterizeText(next) })
    setTool('pan')
    notify('已在当前页新建常用语文本框')
  }

  const saveCommonPhrase = () => {
    const text = phraseDraft.text.trim()
    if (!text) {
      notify('请输入常用语内容')
      return
    }
    const payload={ ...phraseDraft, text, fontSize: clamp(phraseDraft.fontSize, 8, 96) }
    if(editingPhrase)onEditCommonPhrase(editingPhrase,payload);else onAddCommonPhrase(payload)
    setEditingPhrase(undefined)
    setPhraseDraft((current) => ({ ...current, text: '' }))
    setPhraseFilter('');if(phraseDetails.current)phraseDetails.current.open=false;phraseToggle.current?.focus()
    if(phraseReturn.current?.isConnected)phraseReturn.current.focus({preventScroll:true})
    notify(editingPhrase?'常用语已更新':'已保存常用语')
  }

  const addImageMarkup = useCallback(async (
    file: File,
    type: 'image' | 'signature' | 'stamp' = 'image',
    x = 0.34,
    y = 0.28,
    pageId = activePage?.id,
  ) => {
    if (!pageId || !file.type.startsWith('image/')) return
    try {
      const rawData = await normalizePdfImage(await fileToDataUrl(file))
      const data = type === 'stamp' ? await transparentStamp(rawData) : rawData
      const natural = await imageSize(data)
      const targetPage = workspace.pages.find((page) => page.id === pageId)
      const pageSize = pageDimensions(targetPage)
      const imageAspectRatio = natural.width / natural.height
      let width = type === 'stamp' ? 0.18 : type === 'signature' ? 0.24 : 0.32
      let height = width * pageSize.width / pageSize.height / imageAspectRatio
      if (height > 0.42) {
        width *= 0.42 / height
        height = 0.42
      }
      if (!workspaceRef.current.pages.some(p => p.id === pageId)) return
      const id = workspaceRef.current.addAnnotation(pageId, {
        type,
        x: Math.max(0, Math.min(1 - width, x - width / 2)),
        y: Math.max(0, Math.min(1 - height, y - height / 2)),
        width,
        height,
        imageData: data,
        imageAspectRatio,
        lockAspectRatio: true,
        opacity: type === 'stamp' ? 0.92 : 1,
      })
      if (id && workspaceRef.current.activeId === pageId) {setTool('pan');setAnnotationSelection({pageId,ids:new Set([id]),primaryId:id})}
      notify(type === 'stamp' ? '电子章已插入，可拖动和缩放' : type === 'signature' ? '签名已插入' : '图片已贴入当前页')
    } catch {
      notify('图片读取失败')
    }
  }, [activePage?.id, notify, pageDimensions, workspace])

  const insertPastedImageAsPage = useCallback(async () => {
    const pending = pendingImagePaste
    if (!pending || imagePasteActionRef.current) return
    imagePasteActionRef.current = true
    setPendingImagePaste(null)
    setBusy('正在将截图转换为 PDF 页面')
    let source: PdfSource | undefined
    try {
      source = await inspectDesktopFile(
        await browserFileToDesktopFile(pending.file),
        false,
        requestPdfPassword,
      )
      await loadPdfPageSizes(source, [0])
      workspace.insertSourcePages(pending.pageId, source, 'after', [0])
      source = undefined
      notify('已在所选页后插入截图 PDF 页')
    } catch (error) {
      if (source) releasePdfDocument(source)
      notify(error instanceof Error ? error.message : '截图转换为 PDF 页面失败')
    } finally {
      imagePasteActionRef.current = false
      setBusy('')
    }
  }, [notify, pendingImagePaste, requestPdfPassword, workspace])

  const placePastedImageOnPage = useCallback(async () => {
    const pending = pendingImagePaste
    if (!pending || imagePasteActionRef.current) return
    imagePasteActionRef.current = true
    setPendingImagePaste(null)
    try {
      await addImageMarkup(pending.file, 'image', 0.5, 0.35, pending.pageId)
    } finally {
      imagePasteActionRef.current = false
    }
  }, [addImageMarkup, pendingImagePaste])

  useEffect(() => {
    if (hidden || !searchOpen) return
    const pending = documentSources.filter((source) => !source.textIndexed)
    if (!pending.length) {
      // A previous extraction can finish after its popover closed. Publish the
      // now-populated text cache even though that effect no longer owns the UI.
      setSearchIndexing(false)
      setSearchIndexVersion(value => value + 1)
      return
    }
    let cancelled = false
    setSearchIndexing(true)
    // Text extraction is already page-concurrent inside one source. Indexing
    // sources sequentially avoids opening every large PDF worker at once.
    void (async () => {
      for (const source of pending) {
        if (cancelled) return
        await indexPdfText(source)
      }
    })().then(() => {
      if (!cancelled) setSearchIndexVersion((value) => value + 1)
    }).catch(() => {
      if (!cancelled) notify('部分页面无法建立文字索引')
    }).finally(() => {
      if (!cancelled) setSearchIndexing(false)
    })
    return () => { cancelled = true }
  }, [documentSources, hidden, notify, searchOpen])

  // Hidden workspaces need no eager release: display:none drops every page's
  // intersection → renderable=false → resource retain ends → the 8s page TTL
  // and 20s DOCUMENT_IDLE_TTL tear the document down on their own. Re-showing
  // within that window reuses the still-warm document for free.

  useEffect(() => () => {
    ocrCancelRef.current = true
    compressionAbortRef.current?.abort()
    workspaceSourcesRef.current.forEach(releasePdfDocument)
  }, [])

  // Keyboard/paste listeners register ONCE per hidden-state change; the
  // latest handlers live in refs so workspace re-renders no longer re-attach
  // two window listeners per render (the old dep array held the
  // fresh-per-render `workspace` object).
  const shortcutsRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const pasteRef = useRef<(event: ClipboardEvent) => void>(() => {})
  shortcutsRef.current = (event: KeyboardEvent) => {
      // Nested controls (notably OCR table cells) consume their own shortcuts
      // before the window-level page commands see them.
      if (event.defaultPrevented) return
      // A modal owns the keyboard until it is dismissed. Native editing and
      // the modal's own Escape handler continue to work without mutating the PDF behind it.
      if (document.querySelector('[aria-modal="true"]')) return
      const command = event.ctrlKey || event.metaKey
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || Boolean(event.target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')))
      const selectedText = Boolean(window.getSelection()?.toString())
      const textLayerClipboard = event.target instanceof Element
        && Boolean(event.target.closest('.text-layer'))
      const nativeClipboard = editing || selectedText || textLayerClipboard
      if (!editing && !event.altKey && !event.shiftKey && !command && !event.isComposing &&
        (event.key.toLowerCase() === 'h' || event.key.toLowerCase() === 'v')) {
        event.preventDefault(); setTool(event.key.toLowerCase() === 'h' ? 'hand' : 'pan'); return
      }
      const saveAsBinding = shortcutWithShift(shortcutBindings.save)
      const saveAsShortcut = saveAsBinding !== shortcutBindings.save && matchesShortcut(event, saveAsBinding)
      if (matchesShortcut(event, shortcutBindings.save) || saveAsShortcut) {
        event.preventDefault()
        // Publish an in-place text edit before taking the snapshot for Ctrl+S.
        if(textPlacement){flushSync(()=>stageRef.current?.closest('.app-shell')?.dispatchEvent(new Event('paperwork-flush-text')));void closeSaveRef.current(saveAsShortcut)}
        else if(event.target instanceof HTMLTextAreaElement && event.target.closest('.annotation, .note-thread-card')) {
          const field=event.target;flushSync(()=>field.blur());void closeSaveRef.current(saveAsShortcut)
        } else void save({}, saveAsShortcut)
      } else if (matchesShortcut(event, shortcutBindings.search)) {
        event.preventDefault()
        setSearchOpen(true)
        window.setTimeout(() => searchRef.current?.focus(), 0)
      } else if (matchesShortcut(event, shortcutBindings.rotatePageLeft) && !editing) {
        event.preventDefault()
        if (activePage) workspace.rotate(activePage.id, -90)
      } else if (matchesShortcut(event, shortcutBindings.rotatePageRight) && !editing) {
        event.preventDefault()
        if (activePage) workspace.rotate(activePage.id)
      } else if (matchesShortcut(event, shortcutBindings.rotateDocumentLeft) && !editing) {
        event.preventDefault()
        workspace.rotateMany(new Set(navigationPages.map((page) => page.id)), -90)
      } else if (matchesShortcut(event, shortcutBindings.rotateDocumentRight) && !editing) {
        event.preventDefault()
        workspace.rotateMany(new Set(navigationPages.map((page) => page.id)))
      } else if (matchesShortcut(event, shortcutBindings.previousPage) && !editing) {
        event.preventDefault()
        navigatePage(-1)
      } else if (matchesShortcut(event, shortcutBindings.nextPage) && !editing) {
        event.preventDefault()
        navigatePage(1)
      } else if (matchesShortcut(event, shortcutBindings.zoomIn) && !editing) {
        event.preventDefault()
        applyZoom((value) => clamp(value + 0.1, 0.25, 5))
      } else if (matchesShortcut(event, shortcutBindings.zoomOut) && !editing) {
        event.preventDefault()
        applyZoom((value) => clamp(value - 0.1, 0.25, 5))
      } else if (matchesShortcut(event, shortcutBindings.ocrCurrentPage) && !editing) {
        event.preventDefault()
        if (!window.desktop?.recognizeOcrPage) notify('OCR 需要在 Windows 桌面版中运行。')
        else if (activePage && activePage.sourceId !== 'blank') void runOcr({
          sourceIds: [activePage.sourceId],
          pageIds: [activePage.id],
          mode: 'auto',
          skipTextPages: false,
        })
      } else if (command && event.key.toLowerCase() === 'c' && !nativeClipboard) {
        event.preventDefault()
        if (annotationSelection?.ids.size) copyAnnotations(false)
        else copySelection(false)
      } else if (command && event.key.toLowerCase() === 'x' && !nativeClipboard) {
        event.preventDefault()
        if (annotationSelection?.ids.size) copyAnnotations(true)
        else copySelection(true)
      } else if (command && event.key.toLowerCase() === 'p') {
        // Standard print muscle memory (Chrome / mainstream PDF readers).
        event.preventDefault()
        openPrintDialog()
      } else if (command && event.key.toLowerCase() === 'w' && !editing) {
        // Close the current file (tab-like semantics), never the window.
        event.preventDefault()
        if (activeGroupId) requestCloseSource(activeGroupId)
      } else if (command && event.key.toLowerCase() === 'z' && !editing) {
        event.preventDefault()
        event.shiftKey ? workspace.redo() : workspace.undo()
      } else if (command && event.key.toLowerCase() === 'y' && !editing) {
        event.preventDefault()
        workspace.redo()
      } else if (command && event.key.toLowerCase() === 'a' && !nativeClipboard) {
        event.preventDefault()
        if (annotationSelection?.pageId === activePage?.id && activePage.annotations.length) {
          const ids = new Set(activePage.annotations.map((annotation) => annotation.id))
          setAnnotationSelection({ pageId: activePage.id, ids, primaryId: activePage.annotations.at(-1)!.id })
        } else {
          setMultiSelect(true)
          workspace.selectAll(navigationPages)
        }
      } else if (command && event.key === '0' && !editing) {
        event.preventDefault()
        applyZoom(1)
      } else if (event.key === 'Delete' && !nativeClipboard && watermarkSelected && tool === 'watermark') {
        event.preventDefault()
        setDocumentWatermark(undefined)
        setWatermarkSelected(false)
        notify('已移除水印，可按 Ctrl+Z 撤销')
      } else if (event.key === 'Delete' && !nativeClipboard && annotationSelection?.ids.size) {
        event.preventDefault()
        removeSelectedAnnotations()
      } else if (event.key === 'Delete' && !nativeClipboard && documentSelection.size) {
        setConfirmIds(new Set(documentSelection))
      } else if (event.key === 'Escape' && watermarkSelected) {
        setWatermarkSelected(false)
      } else if (event.key === 'Escape' && !editing && tool !== 'pan' && tool !== 'hand') {
        setTool('pan')
      } else if (event.key === 'Escape' && annotationSelection?.ids.size) {
        setAnnotationSelection(undefined)
      } else if (event.key === 'Escape' && multiSelect) {
        setMultiSelect(false)
        if (workspace.activeId) workspace.select(workspace.activeId, false)
        else workspace.clearSelection()
      } else if (event.key === 'ArrowRight' && !editing && !annotationSelection?.ids.size) {
        // Reader-style paging; in continuous view vertical arrows still scroll.
        event.preventDefault()
        navigatePage(1)
      } else if (event.key === 'ArrowLeft' && !editing && !annotationSelection?.ids.size) {
        event.preventDefault()
        navigatePage(-1)
      }
    }
  pasteRef.current = (event: ClipboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || Boolean(event.target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')))
      if (editing) return
      const image = [...(event.clipboardData?.items ?? [])].find((item) => item.type.startsWith('image/'))?.getAsFile()
      const desktopToken = window.desktop?.readInternalClipboardToken()
      const internalClipboard = desktopToken
        ? desktopToken === clipboardTokenRef.current
        : !image && Boolean(clipboardTokenRef.current)
      if (internalClipboard && clipboardKind === 'annotations' && annotationClipboard.length) {
        event.preventDefault()
        pasteAnnotations()
      } else if (internalClipboard && clipboardKind === 'pages' && pageClipboard.length) {
        event.preventDefault()
        pastePages()
      } else if (image && activePage) {
        event.preventDefault()
        // A clipboard screenshot can either become a structural PDF page or a
        // movable page annotation. Ask once instead of guessing: silently
        // choosing either path is difficult to undo after more edits.
        setPendingImagePaste({ file: image, pageId: activePage.id })
      }
    }
  useEffect(() => {
    if (hidden) return
    const shortcuts = (event: KeyboardEvent) => shortcutsRef.current(event)
    const paste = (event: ClipboardEvent) => pasteRef.current(event)
    window.addEventListener('keydown', shortcuts)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('keydown', shortcuts)
      window.removeEventListener('paste', paste)
    }
  }, [hidden])

  // Register with the window-close guard: the App-level close flow lists
  // dirty workspaces and asks 保存/另存为/不保存 for each in turn. The editor
  // registers ONE ENTRY PER DIRTY SOURCE GROUP (its save writes exactly that
  // file's group), so edits in every open file are listed and saved
  // individually; merge projects and the collector register a single
  // workspace-wide entry. Clean views stay registered with dirty=false so
  // they never mask another workspace's flag.
  const dirtyRegistryId = workspaceId ?? mode
  const closeLabel = mode === 'editor'
    ? '浏览区文档'
    : closeLabelProp ?? '工作区'
  const closeSaveRef = useRef<(saveAs: boolean, groupId?: string) => Promise<boolean>>(async () => false)
  closeSaveRef.current = (saveAs: boolean, groupId?: string) => {
    if (busy) {
      notify('正在处理其他任务，请完成后再保存')
      return Promise.resolve(false)
    }
    return save({}, saveAs, groupId)
  }
  const draftPage = textPlacement?.nonempty ? workspace.pages.find(p=>p.id===textPlacement.pageId) : undefined
  const inlineDraftGroup = draftPage && pageGroupId(draftPage)
  const closeRegisteredIds = useRef<string[]>([])
  useEffect(() => {
    const entries: [string, WorkspaceCloseEntry][] = []
    if (mode === 'editor') {
      // Group key == source id in browse mode; a group whose pages were all
      // removed has nothing writable, so it gets no prompt.
      const dirtyIds = inlineDraftGroup ? new Set([...workspace.dirtyGroupIds,inlineDraftGroup]) : workspace.dirtyGroupIds
      for (const source of workspace.sources) {
        if (!dirtyIds.has(source.id)) continue
        if (!workspace.pages.some((page) => pageGroupId(page) === source.id)) continue
        entries.push([`editor:${source.id}`, {
          label: workspace.sources.some(s => s !== source && sourceLabel(s) === sourceLabel(source))
            ? source.originalPath || source.path || sourceLabel(source) : sourceLabel(source),
          dirty: true,
          order: 0,
          save: (saveAs) => closeSaveRef.current(saveAs, source.id),
        }])
      }
      // A new blank document has no PdfSource yet, but it is still unsaved work.
      // Register source-less groups so closing the window cannot discard them.
      for (const groupId of dirtyIds) {
        if (workspace.sources.some((source) => source.id === groupId)) continue
        if (!workspace.pages.some((page) => pageGroupId(page) === groupId)) continue
        entries.push([`editor:${groupId}`, {
          label: groupId === 'blank' ? '未命名 PDF' : '未命名文档',
          dirty: true,
          order: 0,
          save: (saveAs) => closeSaveRef.current(saveAs, groupId),
        }])
      }
    } else {
      entries.push([dirtyRegistryId, {
        label: closeLabel,
        dirty: (workspace.dirty || Boolean(inlineDraftGroup)) && workspace.pages.length > 0,
        order: mode === 'merge' ? 1 : 2,
        save: (saveAs) => closeSaveRef.current(saveAs),
        getInfo: () => {
          const current = workspaceRef.current
          return {
            pageCount: current.pages.length,
            sourceCount: new Set(current.pages.filter((page) => page.sourceId !== 'blank').map((page) => page.sourceId)).size,
            dirty: current.dirty,
            canUndo: current.canUndo,
            canRedo: current.canRedo,
          }
        },
      }])
    }
    const nextIds = new Set(entries.map(([id]) => id))
    for (const previous of closeRegisteredIds.current) if (!nextIds.has(previous)) forgetWorkspaceClose(previous)
    // Map.set preserves the original position of existing keys, so updating
    // an entry (label/dirty/save) never shuffles the prompt order.
    for (const [id, entry] of entries) registerWorkspaceClose(id, entry)
    closeRegisteredIds.current = entries.map(([id]) => id)
  }, [inlineDraftGroup, mode, dirtyRegistryId, closeLabel, workspace.dirty, workspace.dirtyGroupIds, workspace.sources, workspace.pages])
  useEffect(() => () => {
    for (const id of closeRegisteredIds.current) forgetWorkspaceClose(id)
    closeRegisteredIds.current = []
  }, [])

  // A document opened through the OS file association (double-click / Open
  // with) arrives from main as a path; main reads it privileged-side and we
  // import it like any other file. A different file joins the current browsing
  // session (append + jump to its first page); a file whose canonical path matches
  // an open source just jumps to that source instead of duplicating it. Only
  // the editor view subscribes: hidden views render null, so their import
  // would vanish.
  useEffect(() => {
    const desktop = window.desktop
    if (!desktop || !handleExternalOpens) return
    const unsubscribe = desktop.onOpenFileRequested((filePath, token) => {
      // Main resends the same token until acked (speculative + ready pings),
      // and React may remount or re-subscribe this listener — the module-level
      // set dedupes absolutely. Each new user open carries a fresh token.
      if (processedExternalOpenTokens.has(token)) return
      processedExternalOpenTokens.add(token)
      desktop.acknowledgeOpenFile(token)
      // Serialize opens: concurrent handlers would race workspace.load and
      // the same-file check, silently dropping or duplicating documents.
      externalOpenQueue = externalOpenQueue.then(async () => {
        try {
          // Bring the reader forward so the user sees where the document went.
          onModeChange('editor')
          const file = await desktop.readFileAtPath(token)
          await importDesktopFiles([file], true, selectPage)
        } catch (error) {
          notify(error instanceof Error ? error.message : '无法打开该文件')
        }
      })
    })
    // The listener is up only after React mounts; tell main it may flush any
    // document path that arrived via argv before we were ready.
    desktop.notifyRendererReady()
    return unsubscribe
  }, [handleExternalOpens, importDesktopFiles, notify, onModeChange, selectPage])

  // Leaving the watermark tool ends the watermark editing session; the
  // watermark itself stays visible on every page.
  useEffect(() => {
    if (tool !== 'watermark') setWatermarkSelected(false)
  }, [tool])

  useEffect(() => {
    if (hidden) return
    const stage = stageRef.current
    if (!stage) return
    const updateWidth = () => setStageWidth(Math.max(0, Math.round(stage.clientWidth)))
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [hidden])

  useEffect(() => {
    if (hidden) return
    const stage = stageRef.current
    if (!stage) return
    const zoomWithWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomAnchorRef.current = null // wheel zoom anchors at the pointer, never the centre ref
      const rect = stage.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      const documentX = stage.scrollLeft + pointerX
      const documentY = stage.scrollTop + pointerY
      const factor = Math.exp(-event.deltaY * 0.0012)
      setZoom((current) => {
        const next = clamp(current * factor, 0.25, 5)
        requestAnimationFrame(() => {
          // Live ratio: an applyZoom step may have committed between this
          // event and the rAF; fold it in instead of stomping its restore
          // with stale event-time math. 'instant' beats the stage's CSS
          // smooth scrolling so rapid wheel ticks stay crisp.
          const ratio = zoomRef.current / current
          stage.scrollTo({ left: documentX * ratio - pointerX, top: documentY * ratio - pointerY, behavior: 'instant' })
        })
        return next
      })
    }
    stage.addEventListener('wheel', zoomWithWheel, { passive: false })
    return () => stage.removeEventListener('wheel', zoomWithWheel)
  }, [hidden])

  // Restore the applyZoom anchor after the new layout commits: scroll so the
  // captured in-page point sits back under the viewport centre. Ctrl+wheel
  // zoom anchors at the pointer itself and never sets the ref, so it no-ops.
  // behaviour:'instant' overrides the stage's CSS smooth scrolling — a smooth
  // glide here would lag behind zoom steps and compound error on slider drags.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null
    if (!anchor) return
    const stage = stageRef.current
    const target = stage?.querySelector<HTMLElement>(`[data-page-id="${anchor.pageId}"]`)
    if (!stage || !target) return
    const stageRect = stage.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    stage.scrollTo({
      left: stage.scrollLeft + (rect.left + rect.width * anchor.fx) - (stageRect.left + stageRect.width / 2),
      top: stage.scrollTop + (rect.top + rect.height * anchor.fy) - (stageRect.top + stageRect.height / 2),
      behavior: 'instant',
    })
  }, [zoom])

  const renderPage = (page: typeof activePage, options?: { zoom?: number; split?: boolean; number?: number }) => {
    if (!page) return null
    const size = pageDimensions(page)
    const pageZoom = options?.zoom ?? zoom
    const compactPage = !readingGroupIds.has(pageGroupId(page))
    return (
      <div
        key={page.id}
        data-page-id={page.id}
        className="stage-page"
        data-current={page.id === workspace.activeId || undefined}
        data-compact={compactPage || undefined}
        data-split={options?.split || undefined}
        style={{ width: size.width * PDF_CSS_UNITS * pageZoom + 'px' }}
        onPointerDownCapture={tool === 'crop' ? (event) => workspace.select(
          page.id, multiSelect || event.ctrlKey || event.metaKey, event.shiftKey,
        ) : undefined}
        onMouseDown={tool !== 'crop' ? (event) => workspace.select(
          page.id,
          multiSelect || event.ctrlKey || event.metaKey,
          event.shiftKey,
        ) : undefined}
      >
        <PdfPage
          item={page}
          source={sourcesById.get(page.sourceId)}
          zoom={pageZoom}
          renderQuality={renderQuality}
          devicePixelRatio={displayPixelRatio}
          compact={compactPage}
          textLayer={!compactPage}
          query={deferredQuery}
          tool={compactPage ? 'pan' : tool}
          drawingColor={drawingColor}
          drawingWidth={drawingWidth}
          drawingFilled={drawingFilled}
          selectedAnnotationIds={annotationSelection?.pageId === page.id ? annotationSelection.ids : undefined}
          primaryAnnotationId={annotationSelection?.pageId === page.id ? annotationSelection.primaryId : undefined}
          activeNoteId={rightPanel==='notes' && activeNoteTarget?.pageId === page.id ? activeNoteTarget.annotationId : undefined}
          pendingText={textPlacement?.pageId===page.id?{box:textPlacement.box,
            onDirty:nonempty=>setTextPlacement(old=>old?.box.id===textPlacement.box.id?{...old,nonempty}:old),
            onFinish:(final,select)=>{
              setTextPlacement(old=>old?.box.id===final.id?undefined:old)
              if(!final.text?.trim()||!workspaceRef.current.pages.some(v=>v.id===page.id))return
              const {id:tempId,...mark}=final
              const id=workspaceRef.current.addAnnotation(page.id,{...mark,multiline:true,imageData:rasterizeText(final)})
              if(id&&workspaceRef.current.activeId===page.id){setAnnotationSelection({pageId:page.id,ids:new Set([id]),primaryId:id});setActiveTextTarget({pageId:page.id,annotationId:id});if(select)requestAnimationFrame(()=>stageRef.current?.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`)?.focus({preventScroll:true}))}
            }}:undefined}
          onAddAnnotation={(type, x, y, size) => addAnnotation(type, x, y, page.id, size)}
          onAddTextHighlights={(boxes, text) => tool === 'edit-text'
            ? addTextReplacement(page.id, boxes, text)
            : addTextHighlights(page.id, boxes, text)}
          onTextEditSelection={(boxes, text) => addTextReplacement(page.id, boxes, text)}
          onAddDrawing={(annotation) => workspace.addAnnotation(page.id, annotation)}
          onActivateText={(annotationId) => setActiveTextTarget({ pageId: page.id, annotationId })}
          onSelectAnnotation={(annotationId, additive) => selectAnnotation(page.id, annotationId, additive)}
          onClearAnnotationSelection={() => { setAnnotationSelection(undefined); setWatermarkSelected(false) }}
          onActivateNote={(annotationId) => activateNote(page.id, annotationId)}
          onRemoveAnnotation={(id) => {
            if (annotationSelection?.pageId === page.id && annotationSelection.ids.has(id)) {
              removeSelectedAnnotations()
              return
            }
            const removingActiveNote = activeNoteTarget?.pageId === page.id && activeNoteTarget.annotationId === id
            const noteIndex = removingActiveNote ? pageNotes.findIndex(({ annotation }) => annotation.id === id) : -1
            const nextNote = noteIndex >= 0 ? pageNotes[noteIndex + 1] ?? pageNotes[noteIndex - 1] : undefined
            workspace.removeAnnotation(page.id, id)
            if (!removingActiveNote) return
            setActiveNoteTarget(nextNote ? { pageId: nextNote.page.id, annotationId: nextNote.annotation.id } : undefined)
            requestAnimationFrame(() => {
              const target = nextNote ? noteCardRefs.current.get(nextNote.annotation.id) : document.getElementById('notes-tab')
              target?.focus({ preventScroll: true })
            })
          }}
          onUpdateAnnotation={(id, patch) => workspace.updateAnnotation(page.id, id, patch)}
          onSetImageExportMode={(id, exportMode) => {
            if (exportMode === 'flatten-page') {
              setPendingImageFlatten({ pageId: page.id, annotationId: id })
              return
            }
            workspace.updateAnnotation(page.id, id, { imageExportMode: 'object' })
            notify('已恢复高清页面内容模式，可按 Ctrl+Z 撤销')
          }}
          onFillText={(field) => addFittedText(page.id, field)}
          onInsertFormBlank={(blank) => addFormBlankText(page.id, blank)}
          onInsertImage={(file, x, y) => void addImageMarkup(file, 'image', x, y, page.id)}
          onUseHandTool={() => setTool('hand')}
          onUseSelectTool={() => setTool('pan')}
          onExportPageImage={() => { setPageExportDefaultFormat('png'); setPageExportIds([page.id]) }}
          onPageProperties={() => setPagePropertiesId(page.id)}
          onResizePage={() => setPageResizeId(page.id)}
          onAddBookmark={() => addBookmark(page.id)}
          onOcrPage={() => void runOcr({ sourceIds: [page.sourceId], pageIds: [page.id], mode: 'auto', skipTextPages: false })}
          onAddToWorkspace={() => addPageSelectionToWorkspace(page.id)}
          onCrop={(crop) => { workspace.setCrop(page.id, crop); setTool('pan') }}
          onCancelCrop={() => setTool('pan')}
          onExtractCrop={async (crop) => {
            if (busy) return
            setBusy('正在将选区拆分为新页面')
            try {
              const insertedId = await workspace.extractCrop(page.id, crop)
              if (insertedId) {
                setTool('pan')
                selectPage(insertedId)
                notify('已将选区拆分为新页面，原页保留，可按 Ctrl+Z 撤销')
              }
            } catch (error) {
              notify(error instanceof Error ? error.message : '拆分页面失败')
            } finally {
              setBusy('')
            }
          }}
          watermark={watermarkFor(pageGroupId(page))}
          watermarkSelected={page.id===workspace.activeId && watermarkSelected && (mode !== 'editor' || pageGroupId(page) === activeGroupId)}
          onSelectWatermark={() => {
            setAnnotationSelection(undefined)
            if (mode === 'editor') workspace.select(page.id)
            selectWatermarkScope(mode === 'editor' ? pageGroupId(page) : 'workspace')
          }}
          onChangeWatermark={(next) => setDocumentWatermark(next, pageGroupId(page))}
          onRemoveWatermark={() => {
            setDocumentWatermark(undefined, pageGroupId(page))
            setWatermarkSelected(false)
            notify('已移除水印，可按 Ctrl+Z 撤销')
          }}
        />
        {placingImage?.pageId === page.id && <div className="placement-sheet" ref={imagePlacementRef} role="button" tabIndex={0} aria-label="放置图片，按回车居中，Esc 取消"
          onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();const f=placingImage.file;setPlacingImage(undefined);void addImageMarkup(f,'image',(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height,page.id)}}
          onKeyDown={e=>{if(e.key==='Escape'||e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();setPlacingImage(undefined);if(e.key!=='Escape')void addImageMarkup(placingImage.file,'image',.5,.5,page.id)}}}>
          <span>单击放置图片　↵ 居中　Esc 取消</span></div>}
        <span className="stage-page__number">{options?.number ?? workspace.pages.indexOf(page) + 1}</span>
      </div>
    )
  }

  useLayoutEffect(() => {
    if (!sourceMenu) return
    if (hidden || !sourceMenu.trigger.isConnected) { setSourceMenu(undefined); return }
    sourceMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || sourceMenuRef.current?.contains(event.target) || sourceMenu.trigger.contains(event.target)) return
      closeSourceMenu()
    }
    const origin=sourceMenu.trigger.getBoundingClientRect()
    const moved=()=>{const rect=sourceMenu.trigger.getBoundingClientRect();if(Math.abs(rect.left-origin.left)>.5 || Math.abs(rect.top-origin.top)>.5)closeSourceMenu()}
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', closeSourceMenu)
    window.addEventListener('scroll', moved, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', closeSourceMenu)
      window.removeEventListener('scroll', moved, true)
    }
  }, [closeSourceMenu, hidden, sourceMenu])

  // Hidden workspaces keep OCR/state alive, but must still call every Hook.
  if (hidden) return null

  const splitColumns = stageWidth >= 920 ? 2 : 1
  const splitPanes = selectedSplitSources.flatMap((source) => {
    const pages = workspace.pages.filter((page) => pageGroupId(page) === source.id)
    if (!pages.length) return []
    const preferredId = activeGroupId === source.id ? activePage?.id : lastPageByGroup.current.get(source.id)
    const page = pages.find((item) => item.id === preferredId) ?? pages[0]
    const index = pages.indexOf(page)
    return [{ source, pages, page, index, pageZoom: zoom }]
  })

  return (
    <div
      className="app-shell"
      hidden={hidden}
      onDragOver={(event) => event.preventDefault()}
      onDrop={async (event) => {
        if ((event.target as HTMLElement).closest('.thumbnail')) return
        event.preventDefault()
        const files = [...event.dataTransfer.files]
        await importDesktopFiles(
          await Promise.all(files.map(browserFileToDesktopFile)),
          mode !== 'editor' || workspace.pages.length > 0,
        )
      }}
    >
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand">
          <span className="brand__mark"><img src="./app-icon-32.png" srcSet="./app-icon-32.png 1x, ./app-icon-64.png 2x" width="30" height="30" alt="" /></span>
          <div><strong>Paperwork</strong><small>文档工坊</small></div>
        </div>
        <nav className="mode-switcher" aria-label="工作模式">
          <button aria-current={mode === 'editor' ? 'page' : undefined} data-active={mode === 'editor' || undefined} onClick={() => onModeChange('editor')} title="专注阅读、搜索、OCR 与多文档分屏"><FileText size={15} aria-hidden="true" />浏览</button>
          <button aria-current={mode === 'merge' ? 'page' : undefined} data-active={mode === 'merge' || undefined} onClick={() => onModeChange('merge')} title="跨文件拼接、排序、拆分与合并输出"><Layers3 size={15} aria-hidden="true" />工作区</button>
        </nav>
        <div className="titlebar__end" data-tauri-drag-region>
          <div className="titlebar__file" data-tauri-drag-region title={visibleSources.map(sourceLabel).join(', ')}>
            {mode==='editor' && activeSource ? sourceLabel(activeSource) : visibleSources.length === 0 ? '未打开文档' : visibleSources.length === 1 ? sourceLabel(visibleSources[0]) : visibleSources.length + ' 个来源文件'}
          </div>
          <div className="window-controls" role="group" aria-label="窗口控制">
            <button
              className="window-controls__settings"
              aria-label="打开常用设置"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              title="常用设置"
              onClick={onOpenSettings}
            ><Settings2 size={15} /></button>
            {window.desktop && <>
            <button aria-label="最小化窗口" title="最小化" onClick={() => window.desktop?.minimizeWindow()}><Minus size={15} /></button>
            <button aria-label="最大化或还原窗口" title="最大化 / 还原" onClick={() => window.desktop?.toggleMaximizeWindow()}><Maximize2 size={14} /></button>
            <button className="window-controls__close" aria-label="关闭窗口" title="关闭" onClick={() => window.desktop?.closeWindow()}><X size={16} /></button>
            </>}
          </div>
        </div>
      </header>

      <Toolbar
        viewMode={viewMode}
        tool={tool}
        canUndo={workspace.canUndo}
        canRedo={workspace.canRedo}
        disabled={!workspace.pages.length}
        onOpen={pickFiles}
        onSave={() => void save()}
        onExport={() => setExportOpen(true)}
        onShareMcp={ai.available && activeSource ? ai.show : undefined}
        onPrepareMarkdown={()=>{try{mdSelection.current=captureMarkdownSelection(stageRef.current,navigationPages)}catch{mdSelection.current=undefined}}}
        onMarkdown={navigationPages.length ? ()=>{
          let snapshot:MarkdownSelectionSnapshot|undefined
          try {snapshot=captureMarkdownSelection(stageRef.current,navigationPages)??mdSelection.current} catch (e){notify(e instanceof Error?e.message:'选区无法读取');return}
          mdSelection.current=undefined
          flushSync(()=>stageRef.current?.closest('.app-shell')?.dispatchEvent(new Event('paperwork-flush-text')))
          const current=workspaceRef.current, pages=mode==='editor'?current.pages.filter(p=>pageGroupId(p)===activeGroupId):current.pages
          setMdExport({pages:[...pages],sources:pageSources(pages,current.sources),selection:currentMarkdownFragments(snapshot,pages),name:(mode==='editor'&&activeSource?sourceLabel(activeSource):closeLabelProp??'工作区').replace(/\.[^.]+$/,'')+'.md'})
        }:undefined}
        onOcr={() => {
          if (!window.desktop?.recognizeOcrPage) notify('OCR 需要在 Windows 桌面版中运行。')
          else setOcrOpen(true)
        }}
        onOcrCurrentPage={activePage && activePage.sourceId !== 'blank' ? () => {
          void runOcr({
            sourceIds: [activePage.sourceId],
            pageIds: [activePage.id],
            mode: 'auto',
            skipTextPages: false,
          })
        } : undefined}
        onPrint={openPrintDialog}
        workspaceActions={mode === 'merge' ? {
          inbox:onOpenPrintInbox, reverse:workspace.reverse, clear:()=>setConfirmIds(new Set(workspace.pages.map(p=>p.id))), export:()=>void save(),
        } : undefined}
        onSearch={() => { setSearchOpen(true); window.setTimeout(() => searchRef.current?.focus(), 0) }}
        onViewMode={changeViewMode}
        onTool={setTool}
        drawingColor={drawingColor}
        drawingWidth={drawingWidth}
        drawingFilled={drawingFilled}
        onDrawingColor={setDrawingColor}
        onDrawingWidth={setDrawingWidth}
        onDrawingFilled={setDrawingFilled}
        onUndo={workspace.undo}
        onRedo={workspace.redo}
        onBlank={workspace.insertBlank}
        onSignature={() => signatureRef.current?.click()}
        onImage={() => imageRef.current?.click()}
        onStamp={() => setSealOpen(true)}
        onCrop={() => setTool((current) => current === 'crop' ? 'pan' : 'crop')}
        multiSelect={multiSelect}
        onMultiSelect={toggleMultiSelect}
        canSecurePdf={Boolean(activeSource)}
        activePdfEncrypted={Boolean(activeSource?.documentInfo?.encrypted)}
        onEncryptPdf={() => { if (activeSource) setEncryptionSourceId(activeSource.id) }}
        onRemovePdfPassword={() => { if (activeSource?.documentInfo?.encrypted) void savePasswordRemovedCopy(activeSource) }}
        onManagePasswords={() => {
          onOpenSettings()
          window.setTimeout(() => {
            const section = document.getElementById('pdf-password-history') as HTMLDetailsElement | null
            if (section) section.open = true
            section?.scrollIntoView({ block: 'center' })
          }, 120)
        }}
        renderQuality={renderQuality}
        onRenderQuality={onRenderQuality}
        onEditTextOverlay={() => setTool('edit-text')}
        onEditForm={() => setTool('fill')}
        onAutoFillForm={() => void autoFillActiveForm()}
        onOpenBookmarks={() => {
          setSidebarOpen(true)
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.sidebar__tabs [data-outline-step]')?.click())
        }}
        onWatermark={() => setWatermarkDialogScope(watermarkScope)}
        hasWatermark={Boolean(activeWatermark)}
        onRemoveWatermark={() => {
          setDocumentWatermark(undefined)
          setWatermarkSelected(false)
          setTool((current) => current === 'watermark' ? 'pan' : current)
          notify('已移除工作区水印，可按 Ctrl+Z 撤销')
        }}
        onVerifyInvoice={() => void verifyInvoice()}
        onMergeInvoices={() => {
          onModeChange('merge')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent<Mode>('paperwork:import-files', { detail: 'merge' })), 80)
        }}
        onArchiveInvoices={() => void archiveInvoices()}
        onStitchPages={() => void stitchPages()}
        onCreateTableOfContents={() => void createDirectoryPages()}
        onCompress={compressionRunning||busy?undefined:()=>void openCompression()}
        onSaveAs={() => void save({}, true)}
        zoom={zoom}
        onFitWidth={() => fitView('width')}
        onFitPage={() => fitView('page')}
        onActualSize={actualSize}
        selection={annotationSelection?.ids.size
          ? {
              kind: 'annotations' as const,
              count: annotationSelection.ids.size,
              canPaste: clipboardKind === 'annotations' && annotationClipboard.length > 0,
              onCopy: () => copyAnnotations(false),
              onCut: () => copyAnnotations(true),
              onPaste: () => pasteAnnotations(),
              onRemove: removeSelectedAnnotations,
              onClear: () => setAnnotationSelection(undefined),
            }
          : multiSelect
            ? {
                kind: 'pages' as const,
                count: documentSelection.size,
                canAct: documentSelection.size > 0,
                canPaste: clipboardKind === 'pages' && pageClipboard.length > 0,
                onSelectAll: () => workspace.selectAll(navigationPages),
                onClearSelection: workspace.clearSelection,
                onRotate: () => workspace.rotateMany(documentSelection),
                onCopy: () => copySelection(false),
                onCut: () => copySelection(true),
                onPaste: () => pastePages(),
                onRemove: () => setConfirmIds(new Set(documentSelection)),
                onExit: toggleMultiSelect,
              }
            : undefined}
      />

      {mode === 'editor' && (visibleSources.length > 0 || standaloneBlankPages.length > 0) && (
        <div className="editor-bar">
          <div className="editor-tabs" role="tablist" aria-label="已打开的文档" onKeyDown={event => {
            if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute('role') !== 'tab'
              || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
            event.preventDefault(); event.stopPropagation()
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const index = tabs.indexOf(event.target)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            tabs[next].focus(); tabs[next].click()
          }}>
            {standaloneBlankPages.length > 0 && (
              <div className="editor-tab" data-active={activeGroupId === 'blank' || undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeGroupId === 'blank'}
                  title={`未命名 PDF (${standaloneBlankPages.length} 页)`}
                  tabIndex={activeGroupId === 'blank' ? 0 : -1}
                  onClick={() => activateEditorGroup('blank')}
                >
                  <FileText size={13} />
                  <span>未命名 PDF</span>
                  <small>{standaloneBlankPages.length} 页</small>
                </button>
                <button
                  type="button"
                  className="editor-tab__close"
                  aria-label="关闭未命名 PDF"
                  title="关闭文件"
                  onClick={() => requestCloseSource('blank')}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {visibleSources.filter(source => pagesByGroupId.has(source.id)).map((source) => {
              const pages = pagesByGroupId.get(source.id)!
              const isActive = activeGroupId === source.id
              return (
                <div
                  key={source.id}
                  className="editor-tab"
                  data-active={isActive || undefined}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')
                    if (trigger) openSourceMenu(source.id, trigger, event.clientX, event.clientY)
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={`${source.originalPath || source.path || sourceLabel(source)} (${pages.length} 页)`}
                    onDoubleClick={() => {
                      const name = window.prompt('文件显示名称', sourceLabel(source))?.trim()
                      if (name && workspace.renameSource(source.id, name)) notify(`已重命名为“${name}”`)
                    }}
                    tabIndex={isActive ? 0 : -1}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault(); event.stopPropagation(); openSourceMenu(source.id, event.currentTarget)
                      }
                    }}
                    onClick={() => activateEditorGroup(source.id)}
                  >
                    <FileText size={13} />
                    <span>{sourceLabel(source)}</span>
                    <small>{pages.length} 页</small>
                  </button>
                  <button
                    type="button"
                    className="editor-tab__more"
                    aria-label={`更多文件操作：${sourceLabel(source)}`}
                    aria-haspopup="menu"
                    aria-expanded={sourceMenu?.sourceId === source.id}
                    title="文件操作"
                    onClick={event => sourceMenu?.sourceId === source.id ? closeSourceMenu() : openSourceMenu(source.id, event.currentTarget)}
                    onKeyDown={event => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault(); event.stopPropagation(); openSourceMenu(source.id, event.currentTarget)
                      }
                    }}
                  ><MoreHorizontal size={13} /></button>
                  <button
                    type="button"
                    className="editor-tab__close"
                    aria-label={`关闭 ${sourceLabel(source)}`}
                    title="关闭文件"
                    onClick={() => requestCloseSource(source.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
            <button className="editor-tabs__add" title="打开或添加 PDF、OFD、Outlook 邮件或图片" onClick={pickFiles}>
              <Plus size={13} aria-hidden="true" /> 添加文件
            </button>
          </div>
        </div>
      )}

      {mode === 'merge' && (
        <div className="project-bar">
          <WorkspaceTabs
            projects={projects}
            activeId={activeProjectId ?? ''}
            onChange={(id) => onProjectChange?.(id)}
            onAdd={() => onProjectAdd?.()}
            onClose={(id) => onProjectClose?.(id)}
            onRename={(id, name) => onProjectRename?.(id, name)}
            getInfo={(id) => workspaceCloseEntries.get(id)?.getInfo?.()}
            onAddFiles={pickFiles}
          />
        </div>
      )}

      <main className="workspace">
        {!sidebarOpen && workspace.pages.length > 0 && (
          <button
            type="button"
            className="sidebar-reopen"
            aria-label="展开侧边栏"
            title="展开侧边栏"
            onClick={() => setSidebarOpen(true)}
          ><PanelLeftOpen size={16} /></button>
        )}
        {sidebarOpen && workspace.pages.length > 0 && (
          <Suspense fallback={<aside className="sidebar" aria-label="正在加载文档导航" />}><Sidebar
            onClose={() => setSidebarOpen(false)}
            pages={navigationPages}
            showAllPages={mode !== 'editor'}
            sources={visibleSources}
            activeId={workspace.activeId}
            selectedIds={documentSelection}
            multiSelect={multiSelect}
            splitSourceIds={mode === 'editor' ? splitSourceIds : undefined}
            onToggleSplitSource={mode === 'editor' ? toggleSplitSource : undefined}
            onClearSplitSources={mode === 'editor' ? () => setSplitSourceIds(new Set()) : undefined}
            onSelect={(id, additive, range) => {
              setAnnotationSelection(undefined)
              selectPage(id, additive, range)
            }}
            onReorder={workspace.reorder}
            onReorderSources={workspace.reorderSources}
            onRenameSource={(sourceId, name) => {
              if (workspace.renameSource(sourceId, name)) notify(`已重命名为“${name}”`)
            }}
            onCompressSource={sourceId=>void openCompression(sourceId)}
            onAddSourceToWorkspace={addSourceToWorkspace}
            onAddPagesToWorkspace={addPageSelectionToWorkspace}
            onRotate={workspace.rotate}
            onRotateLeft={(id) => workspace.rotate(id, -90)}
            onDelete={(id) => setConfirmIds(new Set([id]))}
            onReplace={(id, file) => void beginPageImport(id, 'replace', file)}
            onRemoveSource={requestCloseSource}
            onCloseAllSources={requestCloseAllSources}
            onImport={() => void pickFiles()}
            canPaste={clipboardKind === 'pages' && pageClipboard.length > 0}
            pasteCount={clipboardKind === 'pages' ? pageClipboard.length : 0}
            onCopy={() => copySelection(false)}
            onCut={() => copySelection(true)}
            onPaste={pastePages}
            onInsertExternal={(id, position) => void beginPageImport(id, position)}
            onReplaceExternal={(id) => void beginPageImport(id, 'replace')}
            onExportSelected={() => void extractSelected()}
            onSplitDocument={(id) => {
              const page = workspace.pages.find((item) => item.id === id)
              if (page) void splitDocument(pageGroupId(page))
            }}
            onUseHandTool={(id) => { selectPage(id); setTool('hand') }}
            onUseSelectTool={(id) => { selectPage(id); setTool('pan') }}
            onExportPage={(id) => { setPageExportDefaultFormat('pdf'); setPageExportIds([id]) }}
            onExportPageImage={(id) => { setPageExportDefaultFormat('png'); setPageExportIds([id]) }}
            onInsertNote={(id) => {
              selectPage(id)
              addAnnotation('note', 0.9, 0.08, id)
            }}
            onPageProperties={(id) => setPagePropertiesId(id)}
            onResizePage={(id) => setPageResizeId(id)}
            onAddBookmark={addBookmark}
            onOcrPage={(id) => {
              const page = workspace.pages.find((item) => item.id === id)
              if (page) void runOcr({ sourceIds: [page.sourceId], pageIds: [id], mode: 'auto', skipTextPages: false })
            }}
            userBookmarks={userBookmarks.filter(b => navigationIds.has(b.pageId))}
            onBookmarkJump={(id) => selectPage(id)}
            onStepOutlinePage={viewMode === 'single' && !splitActive ? navigatePage : undefined}
            onRemoveBookmark={(id) => {
              const bookmark = userBookmarks.find(b => b.id === id)
              const page = bookmark && workspace.pages.find(p => p.id === bookmark.pageId)
              if (page) workspace.markDocumentMetadataDirty(pageGroupId(page))
              setUserBookmarks((current) => current.filter(b => b.id !== id))
            }}
            onOutlineJump={(sourceId, sourcePage) => {
              const page = navigationPages.find((item) => item.sourceId === sourceId && item.sourcePage === sourcePage)
              if (page) selectPage(page.id)
            }}
          /></Suspense>
        )}
        <section onPointerDownCapture={()=>{mdSelection.current=undefined}} onKeyDownCapture={e=>{if(e.key==='Tab'){try{mdSelection.current=captureMarkdownSelection(stageRef.current,navigationPages)}catch{mdSelection.current=undefined}}else mdSelection.current=undefined}} ref={stageRef} id="pdf-stage" data-hand={tool === 'hand' || undefined} data-empty={!workspace.pages.length || undefined} className={`stage ${splitActive ? 'stage--split' : ''}`} aria-label="PDF 预览工作区">
          {searchOpen && (
            <div className="search-popover">
              <div className="search-popover__bar">
                <Search size={16} />
                <label className="sr-only" htmlFor="pdf-search">搜索 PDF 文本</label>
                <input ref={searchRef} id="pdf-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档内容…" />
                <span>{searchIndexing ? '正在建立索引…' : query ? `${searchHits.length}${searchResults.more ? '+' : ''} 个匹配` : '输入关键词'}</span>
                <ToolButton label="上一个匹配" onClick={() => navigateMatch(-1)} disabled={!searchHits.length}><ArrowUp size={15} /></ToolButton>
                <ToolButton label="下一个匹配" onClick={() => navigateMatch(1)} disabled={!searchHits.length}><ArrowDown size={15} /></ToolButton>
                <ToolButton label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery('') }}><X size={15} /></ToolButton>
              </div>
              {searchResults.more && <button type="button" className="search-more" onClick={()=>setSearchLimit(n=>n+200)}>显示更多匹配</button>}
              {query.trim() && !searchIndexing && (
                <div className="search-results" role="listbox" aria-label="搜索结果" ref={searchResultsRef}>
                  {searchHitGroups.length ? searchHitGroups.map((group) => (
                    <section className="search-results__group" key={group.sourceId}>
                      <header className="search-results__file" title={group.sourceName}>
                        <span className="search-results__file-name">{group.sourceName}</span>
                        <span className="search-results__file-count">{group.hits.length} 个匹配</span>
                      </header>
                      {group.hits.map((hit) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={hit.id === searchHits[currentSearchHit]?.id}
                          className="search-results__item"
                          key={hit.id}
                          onClick={() => jumpToSearchHit(hit)}
                        >
                          <span className="search-results__page">第 {hit.pageNumber} 页</span>
                          <span className="search-results__context">
                            {hit.before}<mark>{hit.match}</mark>{hit.after}
                          </span>
                        </button>
                      ))}
                    </section>
                  )) : <p className="search-results__empty">没有找到与“{query.trim()}”匹配的内容</p>}
                </div>
              )}
            </div>
          )}
          {!workspace.pages.length ? (
            <DocumentDesk mode={mode} busy={busy} printing={printOpen} onOpen={pickFiles} onBlank={workspace.insertBlank} />
          ) : splitActive ? (
            <div className="stage__split" style={{ gridTemplateColumns: `repeat(${splitColumns}, minmax(0, 1fr))` }}>
              {splitPanes.map(({ source, pages, page, index, pageZoom }) => (
                <article className="split-pane" data-current={activeGroupId === source.id || undefined} key={source.id}>
                  <header className="split-pane__header">
                    <div>
                      <span className="split-pane__dot" />
                      <strong title={sourceLabel(source)}>{sourceLabel(source)}</strong>
                    </div>
                    <nav aria-label={`${sourceLabel(source)} 翻页`}>
                      <ToolButton label="上一页" disabled={index <= 0} onClick={() => pages[index - 1] && selectPage(pages[index - 1].id)}><ChevronLeft size={14} /></ToolButton>
                      <button
                        type="button"
                        className="split-pane__page"
                        title="输入页码后按回车"
                        onClick={(event) => {
                          const value = window.prompt(`跳转页码（1-${pages.length}）`, String(index + 1))
                          if (!value) return
                          const target = pages[clamp(Number(value) - 1, 0, pages.length - 1)]
                          if (target) selectPage(target.id)
                          event.currentTarget.blur()
                        }}
                      >{index + 1} / {pages.length}</button>
                      <ToolButton label="下一页" disabled={index >= pages.length - 1} onClick={() => pages[index + 1] && selectPage(pages[index + 1].id)}><ChevronRight size={14} /></ToolButton>
                      <ToolButton label={`关闭 ${sourceLabel(source)} 的分屏`} onClick={() => toggleSplitSource(source.id)}><X size={13} /></ToolButton>
                    </nav>
                  </header>
                  <div className="split-pane__body">
                    {renderPage(page, { zoom: pageZoom, split: true, number: index + 1 })}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={'stage__pages stage__pages--' + viewMode}>
              {// Continuous/spread reading stays inside the current file: in
               // browse mode navigationPages is the active group only, so the
               // scroller never flows into the next document — and the on-page
               // numbers count within that file. Merge/collector keep every
               // page (navigationPages === workspace.pages there).
               }
              {viewMode === 'single' ? renderPage(activePage, { number: navigationIndex + 1 }) : navigationPages.map((page, index) => renderPage(page, { number: index + 1 }))}
            </div>
          )}
        </section>
        <aside className="notes-drawer right-drawer" data-empty={!workspace.pages.length || undefined} data-open={rightPanel || undefined} aria-label="文档辅助面板">
            <div className="right-drawer__rail">
              <div className="right-drawer__tabs" role="tablist" aria-label="右侧面板">
                <button
                id="notes-tab"
                className="notes-drawer__toggle right-drawer__tab"
                data-active={rightPanel === 'notes' || undefined}
                aria-selected={rightPanel === 'notes'}
                aria-controls="notes-panel"
                role="tab"
                title={rightPanel === 'notes' ? '收起备注' : `展开备注（${pageNotes.length}）`}
                onClick={() => {
                  if (rightPanel === 'notes') {
                    setRightPanel(undefined)
                    return
                  }
                  setRightPanel('notes')
                  requestAnimationFrame(()=>stageRef.current?.closest('.app-shell')?.querySelector<HTMLInputElement>('[aria-label="筛选备注"]')?.focus({preventScroll:true}))
                }}
              >
                <MessageSquareText size={16} /><span>备注</span><em>{pageNotes.length}</em>
                </button>
                <button
                className="notes-drawer__toggle right-drawer__tab"
                data-active={rightPanel === 'phrases' || undefined}
                aria-selected={rightPanel === 'phrases'}
                role="tab"
                title={rightPanel === 'phrases' ? '收起常用语' : '展开常用语'}
                onClick={() => setRightPanel((value) => value === 'phrases' ? undefined : 'phrases')}
              >
                <Library size={16} /><span>常用语</span><em>{commonPhrases.length}</em>
                </button>
              </div>
              <form
                className="right-drawer__pager"
                aria-label="页面导航"
                onSubmit={(event) => {
                  event.preventDefault()
                  commitPageJump(pageJumpValue)
                }}
              >
                <ToolButton
                  label="向左旋转当前页"
                  onClick={() => activePage && workspace.rotate(activePage.id, -90)}
                  disabled={!activePage}
                ><RotateCcw size={15} /></ToolButton>
                <ToolButton
                  label="上一页（Page Up）"
                  onClick={() => navigatePage(-1)}
                  disabled={navigationIndex <= 0}
                ><ChevronLeft size={15} /></ToolButton>
                <label title={`输入页码跳转，共 ${navigationPages.length} 页`}>
                  <span className="sr-only">当前页码，共 {navigationPages.length} 页</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={navigationPages.length ? 1 : 0}
                    max={navigationPages.length}
                    value={pageJumpValue}
                    disabled={!navigationPages.length}
                    aria-label={`当前页码，共 ${navigationPages.length} 页。输入页码后按回车跳转`}
                    onChange={(event) => setPageJumpValue(event.target.value)}
                    onBlur={(event) => commitPageJump(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        const currentPage = String(navigationIndex >= 0 ? navigationIndex + 1 : 0)
                        event.currentTarget.value = currentPage
                        setPageJumpValue(currentPage)
                        event.currentTarget.blur()
                      }
                    }}
                  />
                </label>
                <output aria-label={`总页数 ${navigationPages.length}`}>/{navigationPages.length}</output>
                <ToolButton
                  label="下一页（Page Down）"
                  onClick={() => navigatePage(1)}
                  disabled={navigationIndex < 0 || navigationIndex >= navigationPages.length - 1}
                ><ChevronRight size={15} /></ToolButton>
                <ToolButton
                  label="向右旋转当前页"
                  onClick={() => activePage && workspace.rotate(activePage.id)}
                  disabled={!activePage}
                ><RotateCw size={15} /></ToolButton>
              </form>
            </div>
            {rightPanel === 'notes' && (
              <div id="notes-panel" className="notes-drawer__content notes-book" role="tabpanel" aria-labelledby="notes-tab">
                <header className="drawer-section-head"><div><h3>页边备注</h3><small className="notes-book__count">第 {navigationIndex+1} 页　/　共 {pageNotes.length} 条</small></div>
                  <button className="note-write" type="button" aria-label="本页备注" title={`在第 ${navigationIndex+1} 页写备注`} disabled={!activePage} onClick={()=>{if(activePage){setNoteFilter('');addAnnotation('note',.88,.12,activePage.id)}}}><MessageSquareText size={14} aria-hidden="true"/>写备注</button></header>
                <label className="drawer-filter"><Search size={14}/><input aria-label="筛选备注" placeholder="按内容、作者或页码查找" type="search" value={noteFilter} onChange={e=>setNoteFilter(e.target.value)}/></label>
                <details className="drawer-disclosure"><summary>署名：{currentAuthor || '当前用户'}</summary><label className="notes-author-field">
                  <span><UserRound size={14} /> 回复署名</span>
                  <input
                    aria-label="新备注和回复署名"
                    value={currentAuthor}
                    onChange={(event) => onCurrentAuthorChange(event.target.value)}
                    onBlur={(event) => {
                      if (!event.target.value.trim()) onCurrentAuthorChange('当前用户')
                    }}
                  />
                </label></details>
                <div className="notes-drawer__list">
                  {!pageNotes.length && (
                    <div className="notes-panel__empty">
                      <MessageSquareText size={22} />
                      <p>还没有页边备注</p>
                      <small>点“写备注”记在本页，或用备注工具标在具体位置。</small>
                    </div>
                  )}
                  {pageNotes.length > 0 && !matchingNotes.length && <p className="drawer-zero">没有匹配的备注</p>}
                  {matchingNotes.map(({ annotation, page, pageIndex }) => {
                    const draft = replyDrafts[annotation.id] ?? ''
                    const noteSource = sourcesById.get(page.sourceId)
                    const selected = activeNoteTarget?.pageId === page.id && activeNoteTarget.annotationId === annotation.id
                    const commitNoteField = (field: 'author' | 'text') => {
                      if (noteEditCancelRef.current === field) {
                        noteEditCancelRef.current = undefined
                        return
                      }
                      const value = field === 'author'
                        ? noteEditDraft.author.trim() || '当前用户'
                        : noteEditDraft.text
                      if (value !== (annotation[field] ?? '')) workspace.updateAnnotation(page.id, annotation.id, { [field]: value })
                    }
                    const submitReply = () => {
                      const text = draft.trim()
                      if (!text) return
                      workspace.addNoteReply(page.id, annotation.id, {
                        author: currentAuthor.trim() || '当前用户',
                        text,
                        createdAt: new Date().toISOString(),
                      })
                      setReplyDrafts((current) => ({ ...current, [annotation.id]: '' }))
                      notify('回复已添加')
                    }
                    return (
                      <article
                        key={annotation.id}
                        id={`note-thread-${annotation.id}`}
                        ref={(node) => {
                          if (node) noteCardRefs.current.set(annotation.id, node)
                          else noteCardRefs.current.delete(annotation.id)
                        }}
                        className="note-thread-card" data-current-page={page.id===activePage?.id || undefined}
                        data-selected={selected || undefined}
                        tabIndex={-1}
                        aria-labelledby={`note-heading-${annotation.id}`}
                      >
                        <header>
                          <button
                            id={`note-heading-${annotation.id}`}
                            className="note-thread-card__jump"
                            aria-pressed={selected}
                            onClick={() => activateNote(page.id, annotation.id, 'pin')}
                          >
                            <strong>第 {pageIndex + 1} 页</strong>
                            <small>{noteSource ? sourceLabel(noteSource) : '当前文档'}</small>
                          </button>
                          <time dateTime={annotation.createdAt}>{formatNoteTime(annotation.createdAt)}</time>
                          {selected && <button type="button" className="note-remove" title="移除备注（可撤销）" aria-label="移除这条备注" onClick={()=>{workspace.removeAnnotation(page.id,annotation.id);notify('备注已移除，可按 Ctrl+Z 撤销');requestAnimationFrame(()=>stageRef.current?.closest('.app-shell')?.querySelector<HTMLInputElement>('[aria-label="筛选备注"]')?.focus())}}><Trash2 size={13}/></button>}
                        </header>
                        {selected ? (
                          <>
                            <div className="note-thread-card__editor">
                              <label className="note-byline">
                                <UserRound size={13} aria-hidden="true"/><span className="sr-only">备注作者</span>
                                <input
                                  value={noteEditDraft.author}
                                  onChange={(event) => setNoteEditDraft((current) => ({ ...current, author: event.target.value }))}
                                  onBlur={() => commitNoteField('author')}
                                  onKeyDown={(event) => {
                                    if(event.nativeEvent.isComposing || event.keyCode===229)return
                                    if (event.key === 'Enter') event.currentTarget.blur()
                                    else if (event.key === 'Escape') {
                                      noteEditCancelRef.current = 'author'
                                      setNoteEditDraft((current) => ({ ...current, author: annotation.author ?? '' }))
                                      event.currentTarget.blur()
                                    }
                                  }}
                                />
                              </label>
                              <label>
                                <span className="sr-only">备注内容</span>
                                <textarea
                                  id={`note-body-${annotation.id}`}
                                  value={noteEditDraft.text}
                                  placeholder="输入备注内容…"
                                  onChange={(event) => setNoteEditDraft((current) => ({ ...current, text: event.target.value }))}
                                  onBlur={() => commitNoteField('text')}
                                  onKeyDown={(event) => {
                                    if(event.nativeEvent.isComposing || event.keyCode===229)return
                                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                      event.preventDefault()
                                      event.currentTarget.blur()
                                    } else if (event.key === 'Escape') {
                                      noteEditCancelRef.current = 'text'
                                      setNoteEditDraft((current) => ({ ...current, text: annotation.text ?? '' }))
                                      event.currentTarget.blur()
                                    }
                                  }}
                                />
                                <small className="note-ink-status"><span data-dirty={(noteEditDraft.text!==annotation.text)||undefined}>{noteEditDraft.text!==annotation.text?'编辑中':'已记入文档'}</span><span>Ctrl+Enter 确认</span></small>
                              </label>
                            </div>
                            <div className="note-thread-card__replies" aria-label={`${annotation.replies?.length ?? 0} 条回复`}>
                              {(annotation.replies ?? []).map((reply) => (
                                <div className="note-reply" key={reply.id}>
                                  <span><UserRound size={11} /></span>
                                  <div><strong>{reply.author || '未知作者'}</strong><time dateTime={reply.createdAt}>{formatNoteTime(reply.createdAt)}</time><p>{reply.text}</p></div>
                                </div>
                              ))}
                            </div>
                            <form className="note-reply-composer" onSubmit={(event) => { event.preventDefault(); submitReply() }}>
                              <label className="sr-only" htmlFor={`note-reply-${annotation.id}`}>回复此备注</label>
                              <textarea
                                id={`note-reply-${annotation.id}`}
                                value={draft}
                                placeholder={`以 ${currentAuthor.trim() || '当前用户'} 回复…`}
                                onChange={(event) => setReplyDrafts((current) => ({ ...current, [annotation.id]: event.target.value }))}
                                onKeyDown={(event) => {
                                  if(event.nativeEvent.isComposing || event.keyCode===229)return
                                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                    event.preventDefault()
                                    submitReply()
                                  }
                                }}
                              />
                              <button type="submit" disabled={!draft.trim()} title="回复（Ctrl+Enter）">
                                <Reply size={14} /> 回复
                              </button>
                            </form>
                          </>
                        ) : (
                          <button className="note-thread-card__summary" onClick={() => activateNote(page.id, annotation.id)}>
                            <span><UserRound size={12} /> {annotation.author || '未知作者'}</span>
                            <p>{annotation.text || '空备注'}</p>
                            <small>{annotation.replies?.length ?? 0} 条回复 · 点击编辑</small>
                          </button>
                        )}
                      </article>
                    )
                  })}
                </div>
              </div>
            )}
            {rightPanel === 'phrases' && (
              <div className="notes-drawer__content phrases-panel" role="tabpanel" aria-label="常用语">
                <header className="phrases-panel__header">
                  <span><Library size={15} /> 常用语库</span>
                  <small>{activeTextSelection ? '点击后应用到当前文本框' : '点击后在当前页新建文本框'}</small>
                </header>
                <details ref={phraseDetails} className="drawer-disclosure" onToggle={e=>{if(!e.currentTarget.open&&editingPhrase){setEditingPhrase(undefined);setPhraseDraft(d=>({...d,text:''}))}}}><summary ref={phraseToggle} onClick={()=>{if(!phraseDetails.current?.open)requestAnimationFrame(()=>phraseDetails.current?.querySelector('textarea')?.focus())}}>{editingPhrase?'编辑常用语':'＋ 新建常用语'}</summary>
                  <form className="phrase-form" onSubmit={e=>{e.preventDefault();saveCommonPhrase()}} onKeyDown={e=>{if(e.key==='Escape'&&!e.nativeEvent.isComposing){e.preventDefault();if(phraseDetails.current)phraseDetails.current.open=false;phraseToggle.current?.focus()}}}>
                    <label className="phrase-form__text"><span>正文</span><textarea value={phraseDraft.text} placeholder="输入要保存的常用内容…" onChange={e=>setPhraseDraft(d=>({...d,text:e.target.value}))} style={{fontFamily:phraseDraft.fontFamily,fontWeight:phraseDraft.bold?700:400,fontStyle:phraseDraft.italic?'italic':undefined}}/></label>
                    <ObjectTypography value={phraseDraft} min={8} colorLabel="常用语颜色" onPatch={patch=>setPhraseDraft(d=>({...d,...patch}))}/>
                    <div className="phrase-edit-actions"><Button type="button" onClick={()=>{if(phraseDetails.current)phraseDetails.current.open=false;phraseToggle.current?.focus()}}>取消</Button><Button variant="primary" type="submit" disabled={!phraseDraft.text.trim()}>{editingPhrase?'保存修改':'保存常用语'}</Button></div>
                  </form></details>
                <label className="drawer-filter"><Search size={14}/><input type="search" aria-label="筛选常用语" value={phraseFilter} onChange={e=>setPhraseFilter(e.target.value)} placeholder="查找常用语"/></label>
                <Suspense fallback={<div className="phrase-list phrase-list--loading">正在载入常用语…</div>}>
                  <CommonPhrasesList
                    phrases={commonPhrases}
                    filter={phraseFilter}
                    activeTextSelection={Boolean(activeTextSelection)}
                    onApply={applyCommonPhrase} onEdit={phrase=>{
                      phraseReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null
                      setEditingPhrase(phrase.id);setPhraseDraft({text:phrase.text,fontFamily:phrase.fontFamily,fontSize:phrase.fontSize,color:phrase.color,bold:phrase.bold,italic:phrase.italic})
                      if(phraseDetails.current)phraseDetails.current.open=true;requestAnimationFrame(()=>phraseDetails.current?.querySelector('textarea')?.focus())
                    }}
                    onRemove={(id) => { onRemoveCommonPhrase(id); notify('常用语已删除') }}
                    onReorder={onReorderCommonPhrase}
                    onMove={onMoveCommonPhrase}
                  />
                </Suspense>
              </div>
            )}
        </aside>
      </main>

      <footer className="statusbar" data-empty={!navigationPages.length || undefined}>
        <div className="statusbar__state" role="status" data-working={Boolean(busy || ocrRunning) || undefined}><span className="status-dot" aria-hidden="true" /> {busy || (ocrRunning ? 'OCR 后台识别中' : '就绪')}
          {documentSources.some(s=>s.fileInfo?.ofdSignature) && <span className="ofd-provenance" role="note" title="这是本地生成的 PDF 阅览副本，不含原件的签名和附件；请在可信验签工具中验证 OFD 原件。">OFD 原件含签名 · 未验签</span>}
        </div>
        {ocrRunning && (
          <div className="ocr-task" role="status" aria-live="polite">
            <span className="ocr-task__label" title={ocrProgress.sourceName}>{ocrProgress.stage}</span>
            <span
              className="ocr-task__track"
              role="progressbar"
              aria-label="OCR 后台识别进度"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, ocrProgress.totalPages)}
              aria-valuenow={Math.min(ocrProgress.totalPages, ocrProgress.currentPage)}
            >
              <span style={{ width: `${ocrProgress.totalPages ? Math.round((ocrProgress.currentPage / ocrProgress.totalPages) * 100) : 0}%` }} />
            </span>
            <strong>{ocrProgress.totalPages ? `${ocrProgress.currentPage}/${ocrProgress.totalPages}` : '准备中'}</strong>
            <button
              type="button"
              disabled={ocrCancelRef.current}
              onClick={() => {
                ocrCancelRef.current = true
                setOcrProgress((current) => ({ ...current, stage: '正在结束当前页识别…' }))
              }}
            >取消</button>
          </div>
        )}
        <div className="statusbar__details">
          {// File-scoped like the pager: navigationPages is the current file in
           // browse mode and the whole workspace in merge/collector, matching
           // what the stage actually renders.
           }
          <span>{navigationPages.length ? `第 ${navigationIndex + 1} / ${navigationPages.length} 页` : '尚无页面'}</span>

          {splitActive && <span>分屏 {selectedSplitSources.length} 份</span>}
          <span>{mode === 'editor' ? activeSource ? sourceLabel(activeSource) : '当前文档' : `${documentSources.length} 个来源`}</span>
          <span>{formatBytes(totalBytes)}</span>
          <span className="statusbar__zoom" role="group" aria-label="缩放控制">
            <button type="button" aria-label="缩小 Ctrl+-" title="缩小 Ctrl+-" onClick={() => applyZoom((value) => clamp(value - 0.1, 0.25, 5))}><ZoomOut size={13} /></button>
            <label className="zoom-control"><span className="sr-only">缩放比例</span><input type="range" min="0.25" max="5" step="0.1" value={zoom} onChange={(event) => applyZoom(clamp(Number(event.target.value), 0.25, 5))} /><output>{Math.round(zoom * 100)}%</output></label>
            <button type="button" aria-label="放大 Ctrl++" title="放大 Ctrl++" onClick={() => applyZoom((value) => clamp(value + 0.1, 0.25, 5))}><ZoomIn size={13} /></button>
            <button type="button" aria-label="适合宽度" title="适合宽度" onClick={() => fitView('width')}><MoveHorizontal size={13} /></button>
            <button type="button" aria-label="适合页面" title="适合页面" onClick={() => fitView('page')}><Fullscreen size={13} /></button>
            <button type="button" className="statusbar__zoom-actual" onClick={actualSize}>100%</button>
          </span>
          {query && <span>{searchHits.length ? currentSearchHit + 1 : 0} / {searchHits.length}{searchResults.more ? '+' : ''} 个匹配</span>}
        </div>
      </footer>

      {sourceMenu && (() => {
        const source = sourcesById.get(sourceMenu.sourceId)
        if (!source) return null
        const splitSelected = splitSourceIds.has(source.id)
        const splitDisabled = !splitSelected && splitSourceIds.size >= 4
        const closeMenu = closeSourceMenu
        return createPortal(
          <div
            className="editor-source-menu"
            ref={sourceMenuRef}
            role="menu"
            onKeyDown={event => {
              event.stopPropagation() // Don't page the PDF behind the menu.
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault()
                closeMenu()
              } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
                const i = items.findIndex(item => item === document.activeElement)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                  : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                items[next]?.focus()
              }
            }}
            aria-label={`${sourceLabel(source)}的文件操作`}
            style={{
              left: sourceMenu.x,
              top: sourceMenu.y,
              maxHeight: Math.max(120, window.innerHeight - sourceMenu.y - 8),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button role="menuitem" onClick={() => {
              closeMenu()
              const name = window.prompt('文件显示名称', sourceLabel(source))?.trim()
              if (name && workspace.renameSource(source.id, name)) notify(`已重命名为“${name}”`)
            }}><FileText size={14} /><span>重命名</span></button>
            <button role="menuitem" onClick={() => { closeMenu(); setSourceInfoId(source.id) }}><Info size={14} /><span>文件信息</span></button>
            <button role="menuitem" onClick={() => { closeMenu(); void openCompression(source.id) }}><Gauge size={14} /><span>压缩 PDF</span></button>
            {documentSelection.size > 1 && <button role="menuitem" onClick={() => { closeMenu(); void extractSelected() }}><Download size={14} /><span>提取已选 {documentSelection.size} 页…</span></button>}
            <button role="menuitem" onClick={() => { closeMenu(); void splitDocument(source.id) }}><Scissors size={14} /><span>拆分 PDF…</span></button>
            <button role="menuitem" onClick={() => { closeMenu(); setEncryptionSourceId(source.id) }}><LockKeyhole size={14} /><span>设置密码</span></button>
            {source.documentInfo?.encrypted && <button role="menuitem" onClick={() => { closeMenu(); void savePasswordRemovedCopy(source) }}><Unlock size={14} /><span>移除密码</span></button>}
            <button role="menuitem" onClick={() => { closeMenu(); addSourceToWorkspace(source.id) }}><Layers3 size={14} /><span>加入工作区</span></button>
            <button role="menuitem" disabled={splitDisabled} title={splitDisabled ? '最多同时分屏 4 个 PDF' : undefined} onClick={() => { closeMenu(); toggleSplitSource(source.id) }}><Columns2 size={14} /><span>{splitSelected ? '退出分屏' : '加入分屏'}</span></button>
            <hr />
            <button role="menuitem" data-danger onClick={() => { closeMenu(); requestCloseSource(source.id) }}><X size={14} /><span>关闭此文件</span></button>
            {visibleSources.length > 1 && <button role="menuitem" data-danger onClick={() => { closeMenu(); requestCloseAllSources() }}><Trash2 size={14} /><span>关闭全部文件</span></button>}
          </div>,
          document.body,
        )
      })()}
      {sourceInfoId && sourcesById.get(sourceInfoId) && <Suspense fallback={null}><FileInfoDialog source={sourcesById.get(sourceInfoId)!} onClose={() => setSourceInfoId(undefined)} /></Suspense>}

      <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{
        const file=e.currentTarget.files?.[0]; e.currentTarget.value=''
        if(file && activePage){setTool('pan');setPlacingImage({file,pageId:activePage.id})}
      }} />
      <input ref={signatureRef} hidden type="file" accept="image/png,image/jpeg" onChange={(event) => event.target.files?.[0] && void addImageMarkup(event.target.files[0], 'signature', 0.7, 0.82)} />
      {sealOpen && <Suspense fallback={null}><ElectronicSealDialog
        source={activePage ? sourcesById.get(activePage.sourceId) : undefined}
        onClose={() => setSealOpen(false)}
        onInsert={async (asset) => {
          const file = new File([asset.bytes], asset.fileName, { type: asset.mimeType })
          await addImageMarkup(file, 'stamp', 0.7, 0.72)
          setSealOpen(false)
        }}
      /></Suspense>}
      {encryptionSource && <Suspense fallback={null}><PdfEncryptionDialog
        open
        sourceName={sourceLabel(encryptionSource)}
        running={encryptionRunning}
        onClose={() => { if (!encryptionRunning) setEncryptionSourceId(undefined) }}
        onEncrypt={(options) => void encryptSourceCopy(encryptionSource, options)}
      /></Suspense>}
      {passwordPrompt && <Suspense fallback={null}><PasswordDialog
        open
        fileName={passwordPrompt.fileName}
        reason={passwordPrompt.reason}
        onCancel={() => finishPasswordPrompt(null)}
        onSubmit={finishPasswordPrompt}
      /></Suspense>}
      {confirmIds && <Suspense fallback={null}><ConfirmDialog
        open={Boolean(confirmIds)}
        title={confirmIds?.size === workspace.pages.length ? '清空全部页面？' : '删除 ' + (confirmIds?.size ?? 0) + ' 个页面？'}
        description="可用 Ctrl+Z 撤销。"
        onClose={() => setConfirmIds(null)}
        onConfirm={() => {
          if (!confirmIds) return
          visibleSources
            .filter((source) => workspace.pages
              .filter((page) => page.sourceId === source.id)
              .every((page) => confirmIds.has(page.id)))
            .forEach(releasePdfDocument)
          workspace.remove(confirmIds)
          notify('已移出 ' + confirmIds.size + ' 页，可按 Ctrl+Z 恢复')
        }}
      /></Suspense>}
      {closeConfirm && <Suspense fallback={null}><ConfirmDialog
        open
        tone="warning"
        title={closeConfirm.kind === 'all' ? '关闭所有文件？' : `关闭“${closeConfirm.label ?? '该文件'}”？`}
        description={closeConfirm.kind === 'all'
          ? `${visibleSources.length} 个文件将从当前窗口关闭，磁盘文件不受影响。`
          : '磁盘文件不会被删除。'}
        confirmLabel={closeConfirm.kind === 'all' ? '全部关闭' : '关闭文件'}
        onClose={() => setCloseConfirm(null)}
        onConfirm={() => { if (!guardFileClose(closeConfirm)) applyFileClose(closeConfirm) }}
      /></Suspense>}
      {pendingImageFlatten && <Suspense fallback={null}><ConfirmDialog
        open
        tone="warning"
        confirmLabel="融入页面"
        title="将图片彻底融入当前页？"
        description={`导出时会将第 ${workspace.pages.findIndex((page) => page.id === pendingImageFlatten.pageId) + 1} 页合成为一张 240 DPI 高清页面图像。图片将无法被 PDF 编辑器单独识别，但该页原文字选择、搜索、表单和矢量编辑可能失效。此设置可在导出前使用 Ctrl+Z 撤销。`}
        onClose={() => setPendingImageFlatten(null)}
        onConfirm={() => {
          workspace.updateAnnotation(pendingImageFlatten.pageId, pendingImageFlatten.annotationId, { imageExportMode: 'flatten-page' })
          notify('已设为导出时彻底融入当前页，可按 Ctrl+Z 撤销')
        }}
      /></Suspense>}
      {printOpen && <Suspense fallback={null}><PrintDialog
        open
        pageCount={printQueue.reduce((sum, item) => sum + item.pageCount, 0)}
        items={printQueue.map(({ id, name, pageCount, size, origin }) => ({ id, name, pageCount, size, origin }))}
        onAddFiles={addPrintFilesFromPicker}
        onAddFolder={addPrintFolder}
        onRemoveItem={removePrintItem}
        onClear={clearPrintQueue}
        onClose={closePrintDialog}
        onPrint={print}
        onRenderPreview={renderPrintPreview}
        onGetPreviewPageSize={getPreviewPageSize}
        printProgress={busy}
      /></Suspense>}
      {ocrOpen && <Suspense fallback={null}><OcrDialog
        open
        sources={visibleSources.map((source) => {
          const pages = [...new Map(workspace.pages
            .filter((page) => page.sourceId === source.id)
            .map((page) => [page.sourcePage, page])).values()]
            .sort((left, right) => left.sourcePage - right.sourcePage)
          return {
            id: source.id,
            name: sourceLabel(source),
            pageCount: pages.length,
            pages: pages.map((page, index) => ({ id: page.id, pageNumber: index + 1 })),
          }
        })}
        defaultSourceId={activePage?.sourceId}
        capabilities={ocrCapabilities}
        running={ocrRunning}
        progress={ocrProgress}
        lastIssue={ocrLastIssue && (mode === 'editor' ? ocrLastIssue.sourceIds.includes(activePage?.sourceId ?? '') : visibleSources.some(s=>ocrLastIssue.sourceIds.includes(s.id))) ? ocrLastIssue.message : undefined}
        onClose={() => setOcrOpen(false)}
        onRun={runOcr}
        onCancel={() => {
          ocrCancelRef.current = true
          setOcrProgress((current) => ({ ...current, stage: '正在结束当前页识别…' }))
        }}
      /></Suspense>}
      {pendingImagePaste && <Suspense fallback={null}><ImagePasteDialog
        open
        fileName={pendingImagePaste.file.name || '剪贴板截图'}
        onClose={() => setPendingImagePaste(null)}
        onInsertPage={() => void insertPastedImageAsPage()}
        onPlaceImage={() => void placePastedImageOnPage()}
      /></Suspense>}
      {pendingPageImport && <Suspense fallback={null}><ImportPagesDialog
        open={Boolean(pendingPageImport)}
        sourceName={pendingPageImport?.source.name ?? ''}
        pageCount={pendingPageImport?.source.pageCount ?? 0}
        operation={pendingPageImport?.operation ?? 'after'}
        replaceCount={pendingPageImport?.replaceIds.size ?? 1}
        onClose={() => {
          if (pendingPageImport) releasePdfDocument(pendingPageImport.source)
          setPendingPageImport(null)
        }}
        onApply={(pageIndices) => void applyPageImport(pageIndices)}
      /></Suspense>}
      {ai.available && ai.open && <Suspense fallback={null}><McpPermissionsDialog api={ai} group={activeSource?.id} name={activeSource?sourceLabel(activeSource):''}/></Suspense>}
      {mdExport && <Suspense fallback={null}><MarkdownExportDialog {...mdExport} onClose={()=>setMdExport(undefined)} onSaved={notify}/></Suspense>}
      {compressionSource && compressionInput && <Suspense fallback={null}><CompressDialog
        open
        sourceName={sourceLabel(compressionSource)}
        sourceSize={compressionInput.byteLength}
        encrypted={Boolean(compressionSource.documentInfo?.encrypted)}
        hasSignatures={Boolean(compressionSource.documentInfo?.hasSignatures)}
        running={compressionRunning}
        progress={compressionProgress}
        notice={compressionNotice} choosingCopy={choosingCopy}
        readyMode={compressionCandidate.current?.source === compressionSource && compressionCandidate.current.input === compressionInput ? compressionCandidate.current.result.mode : undefined}
        onModeChange={() => setCompressionNotice('')}
        onClose={() => { if (!compressionRunning) closeCompression() }}
        onCancel={() => compressionAbortRef.current?.abort()}
        onCompress={(compressionMode) => void runCompression(compressionMode)}
      /></Suspense>}
      {pageExportIds && <Suspense fallback={null}><PageExportDialog
        open
        pageCount={pageExportIds.length}
        initialFormat={pageExportDefaultFormat}
        onClose={() => setPageExportIds(undefined)}
        onExport={(options) => void exportSelectedPages(options)}
      /></Suspense>}
      {pagePropertiesId && (() => {
        const page = workspace.pages.find((item) => item.id === pagePropertiesId)
        if (!page) return null
        const source = sourcesById.get(page.sourceId)
        const rawSize = source?.pageSizes[page.sourcePage] ?? { width: 595.28, height: 841.89 }
        const quarterTurn = (page.rotation % 180 + 180) % 180 !== 0
        const width = quarterTurn ? rawSize.height : rawSize.width
        const height = quarterTurn ? rawSize.width : rawSize.height
        return <Suspense fallback={null}><PagePropertiesDialog
          open
          title={`${source ? sourceLabel(source) : '空白页'} · 第 ${page.sourcePage + 1} 页`}
          rows={[
            { label: mode === 'editor' ? '文件内位置' : '工作区位置', value: `第 ${navigationPages.indexOf(page) + 1} 页 / 共 ${navigationPages.length} 页` },
            { label: '页面尺寸', value: `${(width / 72 * 25.4).toFixed(1)} × ${(height / 72 * 25.4).toFixed(1)} mm` },
            { label: '方向与旋转', value: `${width > height ? '横向' : '纵向'} · ${page.rotation}°` },
            { label: '内容来源', value: source ? source.path || sourceLabel(source) : '新建空白页' },
            { label: 'OCR 文字层', value: page.ocr ? `${page.ocr.engine} · ${page.ocr.words.length} 个文本块` : '未识别' },
            { label: '页面元素', value: `${page.annotations.length} 个批注 / 图片 / 文本元素` },
            { label: '裁剪状态', value: page.crop ? '已应用可视裁剪' : '原始页面范围' },
          ]}
          onClose={() => setPagePropertiesId(undefined)}
        /></Suspense>
      })()}
      {pageResizeId && (() => {
        const page = workspace.pages.find((item) => item.id === pageResizeId)
        if (!page) return null
        const source = sourcesById.get(page.sourceId)
        const size = page.pageSize ?? source?.pageSizes[page.sourcePage] ?? { width: 595.28, height: 841.89 }
        return <Suspense fallback={null}><PageResizeDialog
          open
          currentWidthMm={size.width / 72 * 25.4}
          currentHeightMm={size.height / 72 * 25.4}
          onClose={() => setPageResizeId(undefined)}
          onApply={(widthMm, heightMm) => {
            workspace.setPageSize(page.id, { width: widthMm / 25.4 * 72, height: heightMm / 25.4 * 72 })
            setPageResizeId(undefined)
            notify(`已设置导出纸张为 ${widthMm} × ${heightMm} mm，可按 Ctrl+Z 撤销`)
          }}
        /></Suspense>
      })()}
      {exportOpen && <Suspense fallback={null}><ExportDialog
        open={exportOpen}
        hasWatermark={Boolean(activeWatermark)}
        onClose={() => setExportOpen(false)}
        onExport={(options) => void save({ removeMetadata: options.removeMetadata }, true)}
      /></Suspense>}
      {watermarkOpen && <Suspense fallback={null}><WatermarkDialog
        open={watermarkOpen}
        initial={activeWatermark}
        pageWidthPt={pageDimensions().width}
        pageHeightPt={pageDimensions().height}
        onClose={() => setWatermarkDialogScope(undefined)}
        onApply={(next) => {
          setDocumentWatermark(next)
          setWatermarkSelected(true)
          setTool('watermark')
          notify('已应用水印，可按 Ctrl+Z 撤销')
          // Only explicit application should reveal a watermark. Normal reading
          // and manual scrolling must not snap back to the document centre.
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const node=stageRef.current?.querySelector<HTMLElement>('.stage-page[data-current] .watermark-ui')
            const pane=node?.closest<HTMLElement>('.split-pane__body, .stage');if(!node||!pane)return
            const a=node.getBoundingClientRect(),v=pane.getBoundingClientRect()
            const by=(lo:number,hi:number,vlo:number,vhi:number)=>hi>vhi-16?Math.min(hi-vhi+16,lo-vlo-32):lo<vlo+32?lo-vlo-32:0
            pane.scrollBy({top:by(a.top,a.bottom,v.top,v.bottom),left:by(a.left,a.right,v.left,v.right),behavior:'instant'})
          }))
        }}
        onRemove={() => {
          setDocumentWatermark(undefined)
          setWatermarkSelected(false)
          notify('已移除水印，可按 Ctrl+Z 撤销')
        }}
      /></Suspense>}
      {toast && <div className="toast" role="status"><Info size={16} aria-hidden="true" /><span>{toast}</span></div>}
    </div>
  )
}

export default function App() {
  const [mode, setMode] = useState<Mode>('editor')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { animations, setAnimations, motionEnabled } = useAppMotion()
  const [dark, setDark] = useState(() => localStorage.getItem('paperwork-theme') === 'dark')
  const [uiFontScale, setUiFontScale] = useState(() => {
    const raw = localStorage.getItem('paperwork-ui-font-scale')
    const stored = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(stored) ? clamp(stored, 0.9, 1.3) : 1.2
  })
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(() =>
    localStorage.getItem('paperwork-render-quality') === 'smooth' ? 'smooth' : 'sharp')
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(() =>
    loadShortcutBindings(localStorage.getItem('paperwork-shortcuts-v1')))
  const [displayPixelRatio, setDisplayPixelRatio] = useState(() => window.devicePixelRatio || 1)
  const [currentAuthor, setCurrentAuthor] = useState(() =>
    localStorage.getItem('paperwork-note-author')?.trim() || '当前用户')
  const [ocrSettings, setOcrSettings] = useState<OcrSettings>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('paperwork-ocr-settings-v1') ?? '{}') as Partial<OcrSettings>
      return {
        ...DEFAULT_OCR_SETTINGS,
        ...stored,
        tencent: { ...DEFAULT_OCR_SETTINGS.tencent, ...stored.tencent, secretId: '', secretKey: '' },
        custom: { ...DEFAULT_OCR_SETTINGS.custom, ...stored.custom, apiKey: '' },
      }
    } catch {
      return DEFAULT_OCR_SETTINGS
    }
  })
  const [ocrConnections, setOcrConnections] = useState<Partial<Record<OcrProvider, OcrConnectionStatus>>>({})
  const [ocrCapabilities, setOcrCapabilities] = useState<OcrCapabilities>()
  const [ocrVaultLoaded, setOcrVaultLoaded] = useState(false)
  const [pdfPasswordHistory, setPdfPasswordHistory] = useState<PdfPasswordHistoryEntry[]>([])
  const [commonPhrases, setCommonPhrases] = useState<CommonPhrase[]>(() => loadCommonPhrases(
    localStorage.getItem(COMMON_PHRASES_STORAGE_KEY),
    localStorage.getItem(LEGACY_COMMON_PHRASES_STORAGE_KEY),
  ))
  const projectCounter = useRef(1)
  const [projectState, setProjectState] = useState<{ items: Project[]; activeId: string }>(() => {
    const id = uid()
    return { items: [{ id, name: '工作区 1' }], activeId: id }
  })
  // Printed files are single PDF jobs. Keep OS spool paths out of writable PDF origin grants.
  const preparePrintJob = useCallback(async (job: VirtualPrintJob): Promise<WorkspaceTransferContent> => {
    const source = await inspectDesktopFile({...job, path:'',desktopGrant:undefined}, false)
    try {
      const pages=Array.from({length:source.pageCount},(_,sourcePage)=>({id:uid(),sourceId:source.id,sourcePage,rotation:0,annotations:[]}))
      if(!pages.length) throw new Error('打印文件不含页面，未导入。')
      return {sources:[source],pages,suggestedName:source.name,scopeLabel:`本地打印机 · ${source.name}`}
    } finally {await releasePdfDocument(source)}
  }, [])
  const printInbox=usePrintInbox(preparePrintJob)
  // Renaming an existing destination is committed only after its pages arrive.
  // A newly mounted destination is removed again if the transfer fails.
  const printTransfer = useRef<{ id: string; created: boolean; previousId: string; renameTo?: string }>()
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceChoice>()
  const [workspaceTransfer, setWorkspaceTransfer] = useState<WorkspaceTransferContent & { id: string; targetId: string }>()
  // Bumped when main parks the window in the tray: only the editor
  // WorkspaceView key carries the epoch, so the browse area closes its
  // documents and a reshown window comes up empty — while merge workspaces
  // and the print queue keep their state across the hide.
  const [sessionEpoch, setSessionEpoch] = useState(0)

  useEffect(() => {
    void window.desktop?.loadPdfPasswordHistory?.()
      .then(setPdfPasswordHistory)
      .catch(() => setPdfPasswordHistory([]))
  }, [])

  const rememberPdfPassword = useCallback(async (accepted: {
    fileName: string
    fingerprint?: string
    password: string
  }) => {
    const updated = await window.desktop?.rememberPdfPassword?.(accepted)
    if (updated) setPdfPasswordHistory(updated)
  }, [])

  useEffect(() => window.desktop?.onSessionReset(() => {
    setSessionEpoch((value) => value + 1)
    setWorkspaceChoice(undefined)
    setWorkspaceTransfer(undefined)
    // Ack after React committed the editor remount, so main hides the window
    // knowing no stale editor can still receive a virtual-print import.
    requestAnimationFrame(() => requestAnimationFrame(() => window.desktop?.acknowledgeSessionReset()))
  }), [])

  // File Close and host Exit share one per-file save/discard/cancel sequence.
  // Only the final decision may detach documents or release the host's quit guard.
  type CloseSequence = Omit<CloseGuardFlow, 'queue'> & {
    queue: { id: string; label: string; save: WorkspaceCloseEntry['save'] }[]
    host: boolean; finish: (proceed: boolean) => void
  }
  const [closeFlow, setCloseFlow] = useState<CloseSequence | null>(null)
  const closeFlowRef = useRef<CloseSequence | null>(null)
  const updateCloseFlow = useCallback((flow: CloseSequence | null) => {
    closeFlowRef.current = flow
    setCloseFlow(flow)
  }, [])
  const closeActionAt = useRef(0)
  const promptBeforeClose = useCallback<PromptBeforeClose>((entries, finish) => {
    if (closeFlowRef.current) return true
    const queue = [...workspaceCloseEntries.entries()]
      .filter(([id, entry]) => entry.dirty && (!entries || entries.has(id)))
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id, entry]) => ({ id, label: entry.label, save: entry.save }))
    if (!queue.length) return false
    closeActionAt.current = 0
    updateCloseFlow({ queue, host: entries === null, finish, index: 0, saving: false })
    return true
  }, [updateCloseFlow])

  useEffect(() => window.desktop?.onCloseRequest(() => {
    const reply = (proceed: boolean) => window.desktop?.confirmClose(proceed)
    const pending = closeFlowRef.current
    if (pending) { if (!pending.host) reply(false); return }
    flushSync(()=>document.querySelector('.app-shell:not([hidden])')?.dispatchEvent(new Event('paperwork-flush-text')))
    const focused=document.activeElement
    if(focused instanceof HTMLTextAreaElement && focused.closest('.annotation, .note-thread-card')) flushSync(()=>focused.blur())
    if (!promptBeforeClose(null, reply)) reply(true)
  }), [promptBeforeClose])

  const finishCloseFlow = useCallback((flow: CloseSequence, proceed: boolean) => {
    updateCloseFlow(null)
    flow.finish(proceed)
  }, [updateCloseFlow])
  const advanceCloseFlow = useCallback((flow: CloseSequence) => {
    if (flow.index + 1 === flow.queue.length) finishCloseFlow(flow, true)
    else updateCloseFlow({ ...flow, index: flow.index + 1, saving: false })
  }, [finishCloseFlow, updateCloseFlow])
  const cancelCloseFlow = useCallback(() => {
    const flow = closeFlowRef.current
    if (flow) finishCloseFlow(flow, false)
  }, [finishCloseFlow])
  const skipCloseFlowEntry = useCallback(() => {
    const flow = closeFlowRef.current, now = Date.now()
    if (!flow || flow.saving || now - closeActionAt.current < 400) return
    closeActionAt.current = now // a double-click must not discard the next file too
    advanceCloseFlow(flow)
  }, [advanceCloseFlow])
  const saveCloseFlowEntry = useCallback(async (saveAs: boolean) => {
    const flow = closeFlowRef.current
    if (!flow || flow.saving) return
    const saving = { ...flow, saving: true }
    updateCloseFlow(saving)
    let saved = false
    try { saved = await flow.queue[flow.index].save(saveAs) } catch { /* A failed write never authorizes a close. */ }
    // The user may cancel via Escape while a native save dialog is pending.
    if (closeFlowRef.current !== saving) return
    if (saved) advanceCloseFlow(flow)
    else finishCloseFlow(flow, false)
  }, [advanceCloseFlow, finishCloseFlow, updateCloseFlow])

  const addProject = () => {
    const id = uid()
    projectCounter.current += 1
    setProjectState((current) => ({
      items: [...current.items, { id, name: '工作区 ' + projectCounter.current }],
      activeId: id,
    }))
    setMode('merge')
  }

  const closeProject = (id: string) => {
    const project = projectState.items.find((item) => item.id === id)
    if (project && !window.confirm('关闭“' + project.name + '”？其中未导出的页面不会保留。')) return
    setProjectState((current) => {
      const remaining = current.items.filter((project) => project.id !== id)
      if (!remaining.length) {
        const replacementId = uid()
        projectCounter.current += 1
        return {
          items: [{ id: replacementId, name: '工作区 ' + projectCounter.current }],
          activeId: replacementId,
        }
      }
      return {
        items: remaining,
        activeId: current.activeId === id ? remaining[0].id : current.activeId,
      }
    })
  }

  const confirmWorkspaceTransfer = (selectedTarget: string, fromPrinter = false, requestedName?: string): string | void => {
    const choice = fromPrinter ? printInbox.proposal?.content : workspaceChoice
    if (!choice || workspaceTransfer || printTransfer.current) return '当前任务已变化，请重新选择。'
    const created = selectedTarget === 'new'
    const existing = projectState.items.find(p => p.id === selectedTarget)
    if (!created && !existing) return '这个工作区已关闭，请选择其他工作区。'
    const name = fromPrinter ? (requestedName ?? (created ? nextPrintProjectName(projectState.items) : existing!.name)).trim() : undefined
    if (name !== undefined && (created || name !== existing?.name)) {
      const reason = workspaceNameError(name, projectState.items, existing?.id)
      if (reason) return reason
    }
    const targetId = created ? uid() : selectedTarget
    const id = uid()
    if (fromPrinter) {
      printTransfer.current = { id, created, previousId: projectState.activeId, renameTo: !created && requestedName !== undefined ? name : undefined }
      printInbox.confirming()
    } else setWorkspaceChoice(undefined)
    if (created) {
      projectCounter.current += 1
      const label = name ?? (choice.suggestedName || `工作区 ${projectCounter.current}`)
      setProjectState(current => ({ items: [...current.items, { id: targetId, name: label }], activeId: targetId }))
    } else setProjectState(current => ({ ...current, activeId: targetId }))
    // A copy within the same project is already beneath that project's overlay.
    const local = !fromPrinter ? workspaceChoice?.withinProject : undefined
    setWorkspaceTransfer({ ...choice, pages: local?.id === targetId ? local.pages : choice.pages, id, targetId })
    setMode('merge')
  }

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('paperwork-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    const offset = Math.round((uiFontScale - 1) * 100) / 10
    document.documentElement.style.setProperty('--ui-font-offset', `${offset}px`)
    localStorage.setItem('paperwork-ui-font-scale', String(uiFontScale))
  }, [uiFontScale])

  useEffect(() => {
    localStorage.setItem('paperwork-render-quality', renderQuality)
  }, [renderQuality])

  useEffect(() => {
    localStorage.setItem('paperwork-shortcuts-v1', JSON.stringify(shortcutBindings))
  }, [shortcutBindings])

  useEffect(() => {
    // Chromium fires resize when an Electron window crosses monitors with a
    // different Windows scaling factor. Re-render only the Canvas backing
    // store; the 100% CSS page size intentionally stays unchanged.
    const update = () => setDisplayPixelRatio((current) => {
      const next = window.devicePixelRatio || 1
      return Math.abs(current - next) < 0.001 ? current : next
    })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    localStorage.setItem('paperwork-note-author', currentAuthor.trim() || '当前用户')
  }, [currentAuthor])

  useEffect(() => {
    void window.desktop?.getOcrStatus().then((status) => setOcrConnections((current) => ({
      ...current,
      local: status.available
        ? { state: 'connected', message: `${status.model} 已就绪` }
        : { state: 'error', message: status.error || '本地 OCR 模型缺失' },
    })))
    void window.desktop?.getOcrCapabilities().then(setOcrCapabilities)
  }, [])

  useEffect(() => {
    const safe = {
      ...ocrSettings,
      tencent: { ...ocrSettings.tencent, secretId: '', secretKey: '' },
      custom: { ...ocrSettings.custom, apiKey: '' },
    }
    localStorage.setItem('paperwork-ocr-settings-v1', JSON.stringify(safe))
    // Never replace protected keys with initial empty values while the vault is opening.
    if (!ocrVaultLoaded) return
    const timer = window.setTimeout(() => void window.desktop?.saveOcrSecrets?.({
      secretId: ocrSettings.tencent.secretId,
      secretKey: ocrSettings.tencent.secretKey,
      apiKey: ocrSettings.custom.apiKey,
    }), 300)
    return () => window.clearTimeout(timer)
  }, [ocrSettings, ocrVaultLoaded])

  useEffect(() => {
    let live = true
    void window.desktop?.loadOcrSecrets?.().then((secrets) => {
      if (!live) return
      setOcrSettings((current) => ({
        ...current,
        tencent: { ...current.tencent, ...secrets.tencent },
        custom: { ...current.custom, ...secrets.custom },
      }))
      setOcrVaultLoaded(true)
    }).catch(() => { /* Keep the vault untouched if it could not be read. */ })
    return () => { live = false }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(COMMON_PHRASES_STORAGE_KEY, serializeCommonPhrases(commonPhrases))
    } catch {
      // Storage can be disabled by policy; the in-memory library still works.
    }
  }, [commonPhrases])

  const addCommonPhrase = (phrase: PhraseInput) => {
    setCommonPhrases((current) => [...current, { ...phrase, id: uid(), builtIn: false }])
  }

  const removeCommonPhrase = (id: string) => {
    setCommonPhrases((current) => current.some((phrase) => phrase.id === id)
      ? current.filter((phrase) => phrase.id !== id)
      : current)
  }

  const reorderCommonPhrase = (activeId: string, overId: string) => {
    setCommonPhrases((current) => reorderCommonPhrases(current, activeId, overId))
  }

  const moveCommonPhraseBy = (id: string, delta: -1 | 1) => {
    setCommonPhrases((current) => moveCommonPhrase(current, id, delta))
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const shared = {
    onModeChange: setMode,
    renderQuality,
    onRenderQuality: setRenderQuality,
    shortcutBindings,
    currentAuthor,
    onCurrentAuthorChange: setCurrentAuthor,
    commonPhrases,
    onAddCommonPhrase: addCommonPhrase,
    onEditCommonPhrase:(id:string,patch:PhraseInput)=>setCommonPhrases(list=>list.map(p=>p.id===id?{...p,...patch}:p)),
    onRemoveCommonPhrase: removeCommonPhrase,
    onReorderCommonPhrase: reorderCommonPhrase,
    onMoveCommonPhrase: moveCommonPhraseBy,
    onOpenSettings: () => setSettingsOpen(true),
    settingsOpen,
    displayPixelRatio,
    ocrSettings,
    ocrCapabilities,
    passwordHistory: pdfPasswordHistory,
    onPasswordAccepted: rememberPdfPassword,
    promptBeforeClose,
    onRequestWorkspaceTransfer: setWorkspaceChoice,
    onOpenPrintInbox:window.desktop?.takeVirtualPrintJobs ? printInbox.reopen : undefined,
  }

  return (
    <AppMotion.Provider value={motionEnabled}>
      <WorkspaceView {...shared} key={`editor-${sessionEpoch}`} mode="editor" hidden={mode !== 'editor'} handleExternalOpens />
      {projectState.items.map((project) => (
        <WorkspaceView
          {...shared}
          key={project.id}
          mode="merge"
          hidden={mode !== 'merge' || project.id !== projectState.activeId}
          projects={projectState.items}
          activeProjectId={projectState.activeId}
          workspaceId={project.id}
          closeLabel={project.name}
          incomingTransfer={workspaceTransfer?.targetId === project.id ? workspaceTransfer : undefined}
          onProjectChange={(id) => setProjectState((current) => ({ ...current, activeId: id }))}
          onProjectAdd={addProject}
          onProjectClose={closeProject}
          onProjectRename={(id, name) => setProjectState((current) => ({
            ...current,
            items: current.items.map((item) => item.id === id ? { ...item, name } : item),
          }))}
          onWorkspaceTransferApplied={(transferId, targetId, suggestedName, wasEmpty, added) => {
            const receipt = printTransfer.current
            setWorkspaceTransfer(current => current?.id === transferId ? undefined : current)
            if (receipt?.id === transferId) {
              printTransfer.current = undefined
              if (added > 0 && receipt.renameTo !== undefined) {
                const name = receipt.renameTo
                setProjectState(current => ({ ...current, items: current.items.map(item => item.id === targetId ? { ...item, name } : item) }))
              } else if (!added && receipt.created) {
                setProjectState(current => {
                  const items = current.items.filter(p => p.id !== targetId)
                  return { items, activeId: items.some(p => p.id === receipt.previousId) ? receipt.previousId : items[0].id }
                })
              }
              printInbox.finish(added > 0)
              return
            }
            if (!wasEmpty || !added) return
            setProjectState((current) => ({
              ...current,
              items: current.items.map((item) => item.id === targetId && /^工作区 \d+$/.test(item.name)
                ? { ...item, name: suggestedName || item.name }
                : item),
            }))
          }}
        />
      ))}

      <SettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        fontScale={uiFontScale}
        onFontScale={(value) => setUiFontScale(clamp(value, 0.9, 1.3))}
        dark={dark}
        onDark={setDark}
        animations={animations}
        onAnimations={setAnimations}
        renderQuality={renderQuality}
        onRenderQuality={setRenderQuality}
        currentAuthor={currentAuthor}
        onCurrentAuthor={setCurrentAuthor}
        shortcutBindings={shortcutBindings}
        onShortcutBindings={setShortcutBindings}
        ocrSettings={ocrSettings}
        onOcrSettings={setOcrSettings}
        ocrCapabilities={ocrCapabilities}
        ocrConnections={ocrConnections}
        passwordHistory={pdfPasswordHistory}
        onRemovePasswordHistory={async (id) => {
          const updated = await window.desktop?.removePdfPasswordHistoryEntry?.(id)
          if (updated) setPdfPasswordHistory(updated)
        }}
        onClearPasswordHistory={async () => {
          const updated = await window.desktop?.clearPdfPasswordHistory?.()
          if (updated) setPdfPasswordHistory(updated)
        }}
        onTestOcrConnection={async (provider) => {
          setOcrConnections((current) => ({ ...current, [provider]: { state: 'checking' } }))
          try {
            const result = await window.desktop?.testOcrConnection?.(provider, ocrSettings)
            setOcrConnections((current) => ({
              ...current,
              [provider]: result?.ok
                ? { state: 'connected', message: result.message }
                : { state: 'error', message: result?.message ?? '当前环境不支持连接检测' },
            }))
          } catch (error) {
            setOcrConnections((current) => ({
              ...current,
              [provider]: { state: 'error', message: error instanceof Error ? error.message : '连接失败' },
            }))
          }
        }}
      />
      {printInbox.message && <div className="toast" role="status">{printInbox.message} <button onClick={printInbox.dismissMessage} aria-label="关闭收件箱提示">×</button></div>}
      {printInbox.proposal && !workspaceChoice && !workspaceTransfer && !settingsOpen && !closeFlow && <Suspense fallback={null}><WorkspacePickerDialog
        key={printInbox.proposal.id} projects={projectState.items} newPrintName={nextPrintProjectName(projectState.items)} pageCount={printInbox.proposal.content.pages.length}
        scopeLabel={printInbox.proposal.content.scopeLabel} onClose={printInbox.postpone}
        onConfirm={(target, name) => confirmWorkspaceTransfer(target, true, name)}
      /></Suspense>}
      {workspaceChoice && !workspaceTransfer && <Suspense fallback={null}><WorkspacePickerDialog
        projects={projectState.items}
        pageCount={workspaceChoice.pages.length}
        scopeLabel={workspaceChoice.scopeLabel}
        onClose={() => setWorkspaceChoice(undefined)}
        onConfirm={target => confirmWorkspaceTransfer(target)}
      /></Suspense>}
      {closeFlow && <Suspense fallback={null}><CloseGuardDialog
        flow={closeFlow}
        onSave={() => saveCloseFlowEntry(false)}
        onSkip={skipCloseFlowEntry}
        onCancel={cancelCloseFlow}
      /></Suspense>}
    </AppMotion.Provider>
  )
}
