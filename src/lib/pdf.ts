import { getDocument, GlobalWorkerOptions, PasswordResponses, PDFDataRangeTransport } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type {
  DocumentWatermark,
  ExportOptions,
  Markup,
  OutlineNode,
  PdfCompressionOptions,
  PdfCompressionProgress,
  PdfCompressionResult,
  PdfDocumentInfo,
  PdfFormField,
  PdfSource,
  WorkspacePage,
} from '../types/pdf'
import { uid } from './cn'
import { releasePdfFrames } from './pdfFrameCache'
import { decryptPdfBytes } from './pdfSecurity'
import { rasterizeWatermarkText, watermarkTileBoxes } from './watermark'
import type { OcrPlacement } from './pdfOcrPersistence'
import { centredPdfImage } from './objectTransform'

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const pdfJsRuntimeUrl = typeof document === 'undefined'
  ? 'file:///pdfjs/'
  : new URL('./pdfjs/', document.baseURI).toString()
const cmapsRelativeUrl = `${pdfJsRuntimeUrl}cmaps/`
const standardFontsRelativeUrl = `${pdfJsRuntimeUrl}standard_fonts/`
export const pdfPrintAssets = { cMapUrl: cmapsRelativeUrl, cMapPacked: true, standardFontDataUrl: standardFontsRelativeUrl }

const documentCache = new WeakMap<PdfSource, Promise<PDFDocumentProxy>>()
// Passwords and decrypted working copies are scoped to the in-memory source.
// Persistent history, when enabled, is encrypted by Electron safeStorage.
const documentPasswords = new WeakMap<PdfSource, string>()
const decryptedDocumentBytes = new WeakMap<PdfSource, Promise<Uint8Array>>()
// The reader/compositor may use a verified clean base. An overwrite never
// replaces that working input: rotations and annotations still live on the pages.
const savedOriginals = new WeakMap<PdfSource, { bytes: Uint8Array }>()
function originalRevision(source: PdfSource) {
  let revision = savedOriginals.get(source)
  if (!revision) savedOriginals.set(source, revision = { bytes: source.bytes })
  return revision
}
export function savedOriginalBytes(source: PdfSource) {
  return savedOriginals.get(source)?.bytes ?? source.bytes
}
/** Only after the host confirms an overwrite of this opened original (not Save As). */
export function recordOriginalOverwrite(source: PdfSource, bytes: Uint8Array) {
  originalRevision(source).bytes = bytes
}

const preparedMarks = new WeakMap<PdfSource, { original: Uint8Array; bytes: Uint8Array; watermark: DocumentWatermark }>()
const editingMarks = new WeakSet<PdfSource>()
function watermarkBase(source: PdfSource) {
  const entry = editingMarks.has(source) && preparedMarks.get(source)
  return entry && entry.original === source.bytes ? entry.bytes : undefined
}

/** Use only for a native-content edit in a live workspace. A verified owned mark is
 * already being drawn by its workspace layer; never bake the original copy in again.
 * Deliberately do not decrypt here: the native text writer refuses protected PDFs. */
export function getPdfNativeTextEditInput(source: PdfSource): Uint8Array {
  return watermarkBase(source) ?? source.bytes
}

/** Freeze exactly the ink the compositor would use. Geometry-only text edits
 * reuse the verified embedded raster; changed typography must get new pixels. */
export function snapshotWatermark(mark: DocumentWatermark, backing?: PdfSource): DocumentWatermark {
  if (mark.kind !== 'text' || mark.imageData) return mark
  const previous = backing && watermarkBase(backing) ? preparedMarks.get(backing)?.watermark : undefined
  const unchangedInk = previous?.kind === 'text' && previous.text === mark.text && previous.fontFamily === mark.fontFamily && previous.bold === mark.bold && previous.italic === mark.italic && previous.color === mark.color
  if (unchangedInk && previous.imageData) return { ...mark, imageData: previous.imageData }
  if (typeof document === 'undefined') throw new Error('文字水印需要当前文字和样式的 PNG，或浏览器画布环境')
  return { ...mark, imageData: rasterizeWatermarkText(mark.text ?? '', mark) }
}

/** Opt an editor source (never a plain reader/print import) into a clean base
 * and a single group overlay. This is hydration, not a content edit. */
export function activatePersistedWatermark(source: PdfSource) {
  const entry = preparedMarks.get(source)
  if (!entry || entry.original !== source.bytes || source.documentInfo?.encrypted || source.documentInfo?.hasSignatures || source.documentInfo?.hasForms || source.fileInfo?.ofdSignature || documentPasswords.has(source)) return
  if (!editingMarks.has(source)) {
    void releasePdfDocument(source)
    editingMarks.add(source)
  }
  const mark = { ...entry.watermark }
  // A text edit must never silently reuse the previous text's PNG. Unchanged
  // typography can still reuse the verified raster when composed headlessly.
  if (mark.kind === 'text') delete mark.imageData
  return mark
}
type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
const textCache = new WeakMap<PdfSource, Map<number, Promise<PdfTextContent>>>()
type PdfAnnotations = Awaited<ReturnType<PDFPageProxy['getAnnotations']>>
const annotationCache = new WeakMap<PdfSource, Map<number, Promise<PdfAnnotations>>>()
type PageResourceUse = { count: number; cleanup?: ReturnType<typeof setTimeout> }
const pageResourceUse = new WeakMap<PdfSource, Map<number, PageResourceUse>>()
const MAX_CACHED_TEXT_PAGES = 80
const PAGE_RESOURCE_TTL = 60_000

type CompressionProgressCallback = (progress: PdfCompressionProgress) => void

export type PdfPasswordReason = 'required' | 'incorrect'
export type PdfPasswordRequest = (request: {
  fileName: string
  reason: PdfPasswordReason
  attempt: number
}) => Promise<string | null>

export interface PdfPasswordAccepted {
  fileName: string
  filePath?: string
  fingerprint?: string
  password: string
  fromHistory: boolean
}

export interface PdfOpenSecurity {
  passwordCandidates?: readonly string[]
  onPasswordAccepted?: (accepted: PdfPasswordAccepted) => void | Promise<void>
}

export class PdfPasswordCancelledError extends Error {
  constructor(fileName: string) {
    super(`已取消打开加密文件“${fileName}”`)
    this.name = 'PdfPasswordCancelledError'
  }
}

export const normalizeSourceDisplayName = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128)

/** Human-facing source name; never changes the physical file path/name. */
export const sourceLabel = (source: PdfSource) =>
  normalizeSourceDisplayName(source.displayName ?? '') || source.name

const metadataText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

const metadataBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined

function metadataDate(value: unknown) {
  const text = metadataText(value)
  if (!text) return undefined
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(text)
  if (!match) {
    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? text : date.toISOString()
  }
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone, zoneHour = '00', zoneMinute = '00'] = match
  let timestamp = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)
  if (zone === '+' || zone === '-') {
    const offset = (+zoneHour * 60 + +zoneMinute) * 60_000
    timestamp += zone === '+' ? -offset : offset
  }
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? text : date.toISOString()
}

export async function readPdfDocumentInfo(doc: PDFDocumentProxy): Promise<PdfDocumentInfo> {
  let info: Record<string, unknown> = {}
  try {
    info = (await doc.getMetadata()).info as Record<string, unknown>
  } catch {
    // Broken optional metadata must not prevent the document from opening.
  }
  const formFlags = [metadataBoolean(info.IsAcroFormPresent), metadataBoolean(info.IsXFAPresent)]
    .filter((value): value is boolean => value !== undefined)
  return {
    pdfVersion: metadataText(info.PDFFormatVersion),
    title: metadataText(info.Title),
    author: metadataText(info.Author),
    subject: metadataText(info.Subject),
    keywords: metadataText(info.Keywords),
    createdAt: metadataDate(info.CreationDate),
    modifiedAt: metadataDate(info.ModDate),
    creator: metadataText(info.Creator),
    producer: metadataText(info.Producer),
    language: metadataText(info.Language),
    encrypted: metadataText(info.EncryptFilterName) !== undefined,
    linearized: metadataBoolean(info.IsLinearized),
    hasForms: formFlags.length ? formFlags.some(Boolean) : undefined,
    hasSignatures: metadataBoolean(info.IsSignaturesPresent),
    fingerprint: metadataText(doc.fingerprints[0]),
    modifiedFingerprint: metadataText(doc.fingerprints[1]),
    paperworkWatermarkId: metadataText((info.Custom as Record<string, unknown> | undefined)?.PaperworkWatermark),
  }
}

async function mapConcurrent<T>(
  length: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
) {
  const result = new Array<T>(length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(length, concurrency) }, async () => {
    while (cursor < length) {
      const index = cursor++
      result[index] = await worker(index)
    }
  }))
  return result
}

// Inactive imports keep their export bytes either way. Park just the latest
// affordable worker briefly so opening its new tab doesn't reparse the file.
const MAX_PARKED_PDF_BYTES = 128 * 1024 * 1024
let parkedPdf: { source: PdfSource; timer: ReturnType<typeof setTimeout> } | undefined

function claimParkedPdf(source: PdfSource) {
  if (parkedPdf?.source !== source) return
  clearTimeout(parkedPdf.timer)
  parkedPdf = undefined
}

export function parkImportedPdf(source: PdfSource) {
  if (parkedPdf?.source === source || !documentCache.has(source)) return
  if (parkedPdf) releasePdfDocument(parkedPdf.source)
  if (source.bytes.byteLength > MAX_PARKED_PDF_BYTES) {
    releasePdfDocument(source)
  } else {
    parkedPdf = { source, timer: setTimeout(() => releasePdfDocument(source), 20_000) }
  }
}

// Keep one exportable original. Small files need just one worker transfer;
// for a large local file copy only the ranges the parser/visible pages ask for.
// Disk/native IPC may still deliver the original as one buffer.
function openPdfBytes(bytes: Uint8Array, password?: string) {
  const options = { password, cMapUrl: cmapsRelativeUrl, cMapPacked: true, standardFontDataUrl: standardFontsRelativeUrl }
  if (bytes.byteLength < 8 * 1024 ** 2) return getDocument({ ...options, data: new Uint8Array(bytes) })
  const rangeChunkSize = 256 * 1024
  const copyRange = (begin: number, end: number) => new Uint8Array(bytes.subarray(begin, end))
  const range = new PDFDataRangeTransport(bytes.byteLength, copyRange(0, rangeChunkSize), true)
  let closed = false
  range.abort = () => { closed = true }
  range.requestDataRange = (begin, end) => {
    // PDF.js registers its range reader *after* making this callback. Transfer
    // an owned chunk, never a subarray backed by the document's export bytes.
    queueMicrotask(() => { if (!closed) range.onDataRange(begin, copyRange(begin, end)) })
  }
  return getDocument({ ...options, range, rangeChunkSize, disableStream: true, disableAutoFetch: true })
}

export function getPdfDocument(source: PdfSource) {
  claimParkedPdf(source)
  let document = documentCache.get(source)
  if (!document) {
    document = openPdfBytes(watermarkBase(source) ?? source.bytes, documentPasswords.get(source)).promise
    documentCache.set(source, document)
  }
  return document
}

export function releasePdfDocument(source: PdfSource) {
  claimParkedPdf(source)
  const document = documentCache.get(source)
  releasePdfFrames(source)
  documentCache.delete(source)
  decryptedDocumentBytes.delete(source)
  textCache.delete(source)
  annotationCache.delete(source)
  const resources = pageResourceUse.get(source)
  if (resources) for (const entry of resources.values()) clearTimeout(entry.cleanup)
  pageResourceUse.delete(source)
  return document?.then((doc) => doc.destroy()).catch(() => undefined)
}

// Only an explicit in-memory transfer inherits the unlock. Keep the password
// off serializable sources and let each workspace own/release its own PDF.js worker.
export function inheritPdfUnlockSession(source: PdfSource, clone: PdfSource) {
  const password = documentPasswords.get(source)
  if (password !== undefined) documentPasswords.set(clone, password)
  // An explicit clone refers to the same read/grant, unlike an independent open
  // of the same path. Share its disk revision, not its working pages or overlays.
  if (source.bytes === clone.bytes) savedOriginals.set(clone, originalRevision(source))
  if (source.bytes === clone.bytes && watermarkBase(source)) {
    preparedMarks.set(clone, preparedMarks.get(source)!)
    editingMarks.add(clone)
  }
  return clone
}

export async function getPdfSourceEditableBytes(source: PdfSource) {
  if (!source.documentInfo?.encrypted && !documentPasswords.has(source)) return source.bytes
  let decrypted = decryptedDocumentBytes.get(source)
  if (!decrypted) {
    const password = documentPasswords.get(source)
    if (!password) throw new Error('缺少已打开 PDF 的密码，请重新打开文件')
    decrypted = decryptPdfBytes(source.bytes, password)
    decryptedDocumentBytes.set(source, decrypted)
    decrypted.catch(() => {
      if (decryptedDocumentBytes.get(source) === decrypted) decryptedDocumentBytes.delete(source)
    })
  }
  return decrypted
}

export async function removePdfPassword(source: PdfSource) {
  return (await getPdfSourceEditableBytes(source)).slice()
}

const pageSizeListeners = new WeakMap<PdfSource, Set<() => void>>()

export function onPdfPageSizeChange(source: PdfSource, changed: () => void) {
  let listeners = pageSizeListeners.get(source)
  if (!listeners) pageSizeListeners.set(source, listeners = new Set())
  listeners.add(changed)
  return () => { listeners.delete(changed) }
}

export async function getPdfPage(source: PdfSource, pageIndex: number): Promise<PDFPageProxy> {
  const page = await (await getPdfDocument(source)).getPage(pageIndex + 1)
  if (!source.pageSizeLoaded?.[pageIndex] && !source.pageSizesLoaded) {
    const { width, height } = page.getViewport({ scale: 1 })
    const old = source.pageSizes[pageIndex]
    source.pageSizes[pageIndex] = { width, height }
    ;(source.pageSizeLoaded ??= new Array<boolean>(source.pageCount))[pageIndex] = true
    if (old?.width !== width || old?.height !== height) {
      pageSizeListeners.get(source)?.forEach(changed => changed())
    }
  }
  return page
}

export async function getPdfFormFields(source: PdfSource, pageIndex: number, rotation = 0): Promise<PdfFormField[]> {
  let pages = annotationCache.get(source)
  if (!pages) {
    pages = new Map()
    annotationCache.set(source, pages)
  }
  let annotations = pages.get(pageIndex)
  if (!annotations) {
    annotations = getPdfPage(source, pageIndex).then((page) => page.getAnnotations({ intent: 'display' }))
    pages.set(pageIndex, annotations)
    while (pages.size > MAX_CACHED_TEXT_PAGES) pages.delete(pages.keys().next().value!)
    annotations.catch(() => {
      if (pages?.get(pageIndex) === annotations) pages.delete(pageIndex)
    })
  }
  const page = await getPdfPage(source, pageIndex)
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation + 360) % 360 })
  return (await annotations).flatMap((annotation, index) => {
    if (annotation.subtype !== 'Widget' || annotation.fieldType !== 'Tx' || !Array.isArray(annotation.rect) || annotation.rect.length < 4) return []
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect)
    const left = Math.min(x1, x2) / viewport.width
    const top = Math.min(y1, y2) / viewport.height
    const width = Math.abs(x2 - x1) / viewport.width
    const height = Math.abs(y2 - y1) / viewport.height
    if (!Number.isFinite(left + top + width + height) || width < 0.005 || height < 0.005) return []
    return [{
      id: String(annotation.id ?? `${annotation.fieldName ?? 'field'}-${index}`),
      name: typeof annotation.fieldName === 'string' ? annotation.fieldName : undefined,
      x: Math.max(0, Math.min(1, left)),
      y: Math.max(0, Math.min(1, top)),
      width: Math.max(0.005, Math.min(1 - left, width)),
      height: Math.max(0.005, Math.min(1 - top, height)),
      multiline: Boolean(annotation.multiLine),
      readOnly: Boolean(annotation.readOnly),
      required: Boolean(annotation.required),
      hidden: Boolean(annotation.hidden),
      value: typeof annotation.fieldValue === 'string' ? annotation.fieldValue : undefined,
      maxLength: Number.isFinite(annotation.maxLen) && Number(annotation.maxLen) > 0 ? Number(annotation.maxLen) : undefined,
      fontSize: Number.isFinite(annotation.defaultAppearanceData?.fontSize)
        ? Number(annotation.defaultAppearanceData.fontSize)
        : undefined,
      pdfRect: [Number(annotation.rect[0]), Number(annotation.rect[1]), Number(annotation.rect[2]), Number(annotation.rect[3])],
    }]
  })
}

export function retainPdfPageResources(source: PdfSource, pageIndex: number) {
  let pages = pageResourceUse.get(source)
  if (!pages) {
    pages = new Map()
    pageResourceUse.set(source, pages)
  }
  const entry = pages.get(pageIndex) ?? { count: 0 }
  clearTimeout(entry.cleanup)
  entry.cleanup = undefined
  entry.count += 1
  pages.set(pageIndex, entry)
}

export function releasePdfPageResources(source: PdfSource, pageIndex: number, ttl = PAGE_RESOURCE_TTL) {
  const pages = pageResourceUse.get(source)
  const entry = pages?.get(pageIndex)
  if (!pages || !entry) return
  entry.count = Math.max(0, entry.count - 1)
  if (entry.count || entry.cleanup) return
  // Keep recently viewed operator lists briefly for smooth back-scrolling, then
  // release them once no main page or thumbnail instance is using the page.
  entry.cleanup = setTimeout(() => {
    if (entry.count) return
    pages.delete(pageIndex)
    textCache.get(source)?.delete(pageIndex)
    annotationCache.get(source)?.delete(pageIndex)
    const document = documentCache.get(source)
    if (!document) return
    void document
      .then((doc) => doc.getPage(pageIndex + 1))
      .then((page) => { if (!pages.has(pageIndex)) page.cleanup() })
      .catch(() => undefined)
    // Keep the PDF.js document/worker alive for the lifetime of the open source.
    // Recreating it after a fast jump or back-scroll is much more expensive than
    // retaining the lightweight document shell; releasePdfDocument remains the
    // explicit memory boundary when a file is closed or replaced.
  }, ttl)
}

export function getPdfTextContent(source: PdfSource, pageIndex: number) {
  let pages = textCache.get(source)
  if (!pages) {
    pages = new Map()
    textCache.set(source, pages)
  }
  let content = pages.get(pageIndex)
  if (content) {
    // Refresh insertion order so recently viewed pages survive the LRU trim.
    pages.delete(pageIndex)
    pages.set(pageIndex, content)
    return content
  }
  content = getPdfPage(source, pageIndex).then((page) => page.getTextContent())
  pages.set(pageIndex, content)
  content.catch(() => {
    if (pages?.get(pageIndex) === content) pages.delete(pageIndex)
  })
  while (pages.size > MAX_CACHED_TEXT_PAGES) pages.delete(pages.keys().next().value!)
  return content
}

export async function indexPdfText(source: PdfSource) {
  if (source.textIndexed) return
  source.pageText = await mapConcurrent(source.pageCount, 3, async (index) => {
    const content = await getPdfTextContent(source, index)
    return content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
  })
  source.textIndexed = true
}

export async function inspectPdf(
  bytes: Uint8Array,
  name: string,
  path?: string,
  loadPageSizes = true,
  requestPassword?: PdfPasswordRequest,
  security: PdfOpenSecurity = {},
): Promise<PdfSource> {
  const loadingTask = openPdfBytes(bytes)
  let passwordCancelled = false
  let passwordAttempt = 0
  let acceptedPassword: string | undefined
  let acceptedFromHistory = false
  let promptedForPassword = false
  const passwordCandidates = [...new Set(security.passwordCandidates ?? [])]
    .filter((password) => typeof password === 'string' && password.length > 0)
  if (requestPassword || passwordCandidates.length) {
    loadingTask.onPassword = (updatePassword: (password: string) => void, code: number) => {
      passwordAttempt += 1
      const candidate = passwordCandidates.shift()
      if (candidate !== undefined) {
        acceptedPassword = candidate
        acceptedFromHistory = true
        updatePassword(candidate)
        return
      }
      if (!requestPassword) {
        passwordCancelled = true
        void loadingTask.destroy()
        return
      }
      void requestPassword({
        fileName: name,
        reason: code === PasswordResponses.INCORRECT_PASSWORD && promptedForPassword ? 'incorrect' : 'required',
        attempt: passwordAttempt,
      }).then((password) => {
        promptedForPassword = true
        if (password !== null) {
          acceptedPassword = password
          acceptedFromHistory = false
          updatePassword(password)
          return
        }
        passwordCancelled = true
        void loadingTask.destroy()
      }, () => {
        passwordCancelled = true
        void loadingTask.destroy()
      })
    }
  }
  const document = loadingTask.promise
  let doc: PDFDocumentProxy
  try {
    doc = await document
  } catch (error) {
    if (passwordCancelled) throw new PdfPasswordCancelledError(name)
    await loadingTask.destroy().catch(() => undefined)
    throw error
  }
  const source: PdfSource = {
    id: uid(),
    name,
    path,
    bytes,
    pageCount: doc.numPages,
    pageText: Array(doc.numPages).fill(''),
    // Unknown pages share one estimate; getPdfPage replaces individual entries.
    pageSizes: Array(doc.numPages).fill({ width: 612, height: 792 }),
    pageSizeLoaded: Array(doc.numPages).fill(false),
    textIndexed: false,
    documentInfo: await readPdfDocumentInfo(doc),
  }
  if (acceptedPassword !== undefined) {
    documentPasswords.set(source, acceptedPassword)
    void Promise.resolve(security.onPasswordAccepted?.({
      fileName: name,
      filePath: path,
      fingerprint: source.documentInfo?.fingerprint,
      password: acceptedPassword,
      fromHistory: acceptedFromHistory,
    })).catch(() => undefined)
  }
  documentCache.set(source, document)
  const hint = source.documentInfo?.paperworkWatermarkId
  if (hint && !source.documentInfo?.encrypted && !source.documentInfo?.hasSignatures && !source.documentInfo?.hasForms && acceptedPassword === undefined) {
    const { readOwnedWatermark } = await import('./pdfWatermarkPersistence')
    const restored = await readOwnedWatermark(bytes, hint, async candidate => !await guardedGraph(candidate, true))
    if (restored) preparedMarks.set(source, { original: bytes, ...restored })
  }
  if (loadPageSizes) {
    try { await loadPdfPageSizes(source) }
    catch (error) { await releasePdfDocument(source); throw error }
  }
  return source
}

export async function loadPdfPageSizes(source: PdfSource, pageIndices?: number[]) {
  if (source.pageSizesLoaded) return
  const indices = pageIndices && [...new Set(pageIndices)].filter(i => i >= 0 && i < source.pageCount)
  const count = indices?.length ?? source.pageCount
  await mapConcurrent(count, 4, async i => {
    const index = indices?.[i] ?? i
    if (!source.pageSizeLoaded?.[index]) await getPdfPage(source, index)
  })
  if (count === source.pageCount) source.pageSizesLoaded = true
}

export async function imageToPdf(file: DesktopFile) {
  // PDF editing is intentionally loaded only when an image is imported or a
  // document is exported; ordinary reading should not parse the editor engine.
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const image = /\.png$/i.test(file.name)
    ? await doc.embedPng(file.bytes)
    : await doc.embedJpg(file.bytes)
  const scale = Math.min(1, 760 / image.width, 1080 / image.height)
  const width = image.width * scale
  const height = image.height * scale
  const page = doc.addPage([width, height])
  page.drawImage(image, { x: 0, y: 0, width, height })
  return doc.save()
}

/** Optimize the original object graph; never substitute a rendered page. */
export async function compressPdf(
  source: PdfSource,
  options: PdfCompressionOptions,
  onProgress?: CompressionProgressCallback,
): Promise<PdfCompressionResult> {
  const bytes = savedOriginalBytes(source)
  const { compressSource } = await import('./pdfCompression')
  return compressSource({ bytes, documentInfo: source.documentInfo }, options, onProgress)
}

export function pagesForSource(source: PdfSource): WorkspacePage[] {
  return Array.from({ length: source.pageCount }, (_, sourcePage) => ({
    id: uid(),
    sourceId: source.id,
    groupId: source.id,
    sourcePage,
    rotation: 0,
    annotations: [],
  }))
}

export async function readOutline(source: PdfSource): Promise<OutlineNode[]> {
  const doc = await getPdfDocument(source)
  const outline = await doc.getOutline()
  if (!outline) return []

  const resolve = async (items: typeof outline): Promise<OutlineNode[]> =>
    Promise.all(items.map(async (item) => {
      let pageIndex: number | undefined
      try {
        const destination = typeof item.dest === 'string'
          ? await doc.getDestination(item.dest)
          : item.dest
        if (destination?.[0]) pageIndex = await doc.getPageIndex(destination[0])
      } catch {
        // Some PDFs contain stale outline targets; retain the heading itself.
      }
      return {
        title: item.title,
        pageIndex,
        children: item.items?.length ? await resolve(item.items) : [],
      }
    }))
  return resolve(outline)
}

const pdfDate = (value?: string) => {
  const date = value ? new Date(value) : new Date()
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
  const part = (number: number) => number.toString().padStart(2, '0')
  return `D:${safeDate.getUTCFullYear()}${part(safeDate.getUTCMonth() + 1)}${part(safeDate.getUTCDate())}${part(safeDate.getUTCHours())}${part(safeDate.getUTCMinutes())}${part(safeDate.getUTCSeconds())}Z`
}

export function displayPointToPdf(x: number, y: number, width: number, height: number, rotation: number) {
  switch ((rotation % 360 + 360) % 360) {
    case 90: return { x: y * width, y: x * height }
    case 180: return { x: (1 - x) * width, y: y * height }
    case 270: return { x: (1 - y) * width, y: (1 - x) * height }
    default: return { x: x * width, y: (1 - y) * height }
  }
}

export function displayBoxToPdf(
  box: Pick<Markup, 'x' | 'y' | 'width' | 'height'>,
  pageWidth: number,
  pageHeight: number,
  rotation: number,
) {
  const normalizedRotation = (rotation % 360 + 360) % 360
  const corners = [
    displayPointToPdf(box.x, box.y, pageWidth, pageHeight, normalizedRotation),
    displayPointToPdf(box.x + box.width, box.y, pageWidth, pageHeight, normalizedRotation),
    displayPointToPdf(box.x, box.y + box.height, pageWidth, pageHeight, normalizedRotation),
    displayPointToPdf(box.x + box.width, box.y + box.height, pageWidth, pageHeight, normalizedRotation),
  ]
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const displayWidth = normalizedRotation % 180 ? pageHeight : pageWidth
  const displayHeight = normalizedRotation % 180 ? pageWidth : pageHeight
  const drawWidth = box.width * displayWidth
  const drawHeight = box.height * displayHeight
  const drawOrigin = normalizedRotation === 90
    ? { x: (box.y + box.height) * pageWidth, y: box.x * pageHeight }
    : normalizedRotation === 180
      ? { x: (1 - box.x) * pageWidth, y: (box.y + box.height) * pageHeight }
      : normalizedRotation === 270
        ? { x: (1 - box.y - box.height) * pageWidth, y: (1 - box.x) * pageHeight }
        : { x: box.x * pageWidth, y: (1 - box.y - box.height) * pageHeight }
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    drawX: drawOrigin.x,
    drawY: drawOrigin.y,
    drawWidth,
    drawHeight,
    drawRotation: normalizedRotation,
  }
}

export type CropSelection = NonNullable<WorkspacePage['crop']>

/** Clip display-space selections to the page; reject empty/non-finite input. */
export function normalizeCropSelection(box: CropSelection): CropSelection {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new Error('请选择有效的页面区域')
  }
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const right = Math.min(1, box.x + box.width)
  const bottom = Math.min(1, box.y + box.height)
  if (right <= x || bottom <= y) throw new Error('选区必须位于页面内')
  return { x, y, width: right - x, height: bottom - y }
}

/** Copy the selected content, not a screen capture. The original page is untouched.
 * Like ordinary PDF cropping, this clips vector streams; it is not secure redaction.
 */
export async function extractPdfSelection(item: WorkspacePage, sources: PdfSource[], selection: CropSelection) {
  if (item.sourceId !== 'blank' && !sources.some((source) => source.id === item.sourceId)) {
    throw new Error('原页面来源已关闭')
  }
  const crop = normalizeCropSelection(selection)
  const bytes = await composePdf([{
    ...item,
    // Source-backed pages are selected in original display geometry, not the
    // optional paper size used only by ordinary export. Blank pages use that size.
    pageSize: item.sourceId === 'blank' ? item.pageSize : undefined,
    crop,
    // Extraction itself never opts into the screenshot/flatten export path.
    annotations: item.annotations.map((annotation) => annotation.imageExportMode === 'flatten-page'
      ? { ...annotation, imageExportMode: 'object' as const }
      : annotation),
  }], sources)
  const { PDFDocument } = await import('pdf-lib')
  const output = await PDFDocument.load(bytes)
  const page = output.getPage(0)
  const bounds = page.getCropBox()
  page.setMediaBox(bounds.x, bounds.y, bounds.width, bounds.height)
  page.setTrimBox(bounds.x, bounds.y, bounds.width, bounds.height)
  page.setBleedBox(bounds.x, bounds.y, bounds.width, bounds.height)
  page.setArtBox(bounds.x, bounds.y, bounds.width, bounds.height)
  return output.save({ useObjectStreams: true })
}

export function rasterMergePageIndices(pages: WorkspacePage[]) {
  return pages.flatMap((page, index) => page.annotations.some((annotation) =>
    ['image', 'signature', 'stamp'].includes(annotation.type)
    && annotation.imageExportMode === 'flatten-page',
  ) ? [index] : [])
}

async function rasterMergePdfPages(bytes: Uint8Array, pageIndices: number[], afterRaster?: (page: import('pdf-lib').PDFPage, index: number) => void) {
  if (!pageIndices.length) return bytes
  if (typeof document === 'undefined') throw new Error('整页合成功能需要桌面或浏览器画布环境')
  const { PDFDocument, PDFName } = await import('pdf-lib')
  const source = await getDocument({ data: bytes.slice() }).promise
  const output = await PDFDocument.load(bytes)
  try {
    for (const pageIndex of pageIndices) {
      const sourcePage = await source.getPage(pageIndex + 1)
      const natural = sourcePage.getViewport({ scale: 1, rotation: 0 })
      const targetScale = Math.min(
        240 / 72,
        Math.sqrt(12_000_000 / Math.max(1, natural.width * natural.height)),
        8192 / Math.max(1, natural.width, natural.height),
      )
      const viewport = sourcePage.getViewport({ scale: Math.max(1, targetScale), rotation: 0 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('无法创建整页合成画布')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      // Notes, links and form widgets stay as native annotations. Only the
      // final page content is baked, preventing duplicate annotation visuals.
      await sourcePage.render({ canvasContext: context, viewport, annotationMode: 0, background: '#ffffff' }).promise
      const png = await new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('无法生成整页合成图像'))
          return
        }
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
      }, 'image/png'))
      canvas.width = 1
      canvas.height = 1
      sourcePage.cleanup()

      const page = output.getPage(pageIndex)
      const crop = page.getCropBox()
      const background = await output.embedPng(png)
      page.node.set(PDFName.of('Resources'), output.context.obj({}))
      page.node.set(PDFName.of('Contents'), output.context.obj([]))
      page.drawImage(background, {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
      })
      // The bake replaced every content stream. Only now add requested OCR,
      // never an extra bitmap/visible mark or a second native text layer.
      afterRaster?.(page, pageIndex)
    }
    return output.save({ useObjectStreams: true })
  } finally {
    await source.destroy()
  }
}

export interface PrintPageImage {
  /** Page size in PDF points, in visual (post-rotation) orientation. */
  widthPt: number
  heightPt: number
  /** White-composited PNG of the fully rendered page. */
  png: Uint8Array
}

/**
 * Rasterizes a composed PDF into per-page white-composited PNGs for printing.
 * Physical printing goes through this path instead of Chromium's PDF viewer:
 * PDFium re-encodes subset CJK fonts at print time (garbled glyphs on many GDI
 * drivers) and its plugin pipeline renders all-black in hidden windows. Plain
 * bitmap pages are immune to both. Pages are rendered and disposed one at a
 * time so memory stays bounded on long jobs.
 *
 * Default resolution is 300 DPI — the same target Chrome and mainstream PDF
 * readers print at — with a 24 Mpx ceiling so A3/ledger pages also keep 300 DPI.
 */
export async function rasterizePdfForPrint(
  bytes: Uint8Array,
  options: { grayscale?: boolean; dpi?: number; maxEncodedBytes?: number; onProgress?: (page: number, total: number) => void } = {},
): Promise<PrintPageImage[]> {
  if (typeof document === 'undefined') throw new Error('打印光栅化需要桌面或浏览器画布环境')
  const dpi = options.dpi ?? 300
  const source = await getDocument({ ...pdfPrintAssets, data: bytes.slice() }).promise
  const pages: PrintPageImage[] = []
  let encodedBytes = 0
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      const page = await source.getPage(index)
      options.onProgress?.(index, source.numPages)
      // Default rotation: the printed image must match what the reader sees.
      const natural = page.getViewport({ scale: 1 })
      const renderAt = async (targetDpi: number) => {
        const scale = Math.min(
          targetDpi / 72,
          Math.sqrt(24_000_000 / Math.max(1, natural.width * natural.height)),
          8192 / Math.max(1, natural.width, natural.height),
        )
        const viewport = page.getViewport({ scale }) // Respect pixel caps even on an oversized drawing.
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('无法创建打印光栅化画布')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        // Print intent matches pdf.js's own print pipeline (printer-tuned paths,
        // no interactive elements); annotations stay baked in by composePdf.
        await page.render({ canvasContext: context, viewport, annotationMode: 1, background: '#ffffff', intent: 'print' }).promise
        if (options.grayscale) {
          const image = context.getImageData(0, 0, canvas.width, canvas.height)
          const data = image.data
          for (let offset = 0; offset < data.length; offset += 4) {
            const gray = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
            data[offset] = data[offset + 1] = data[offset + 2] = gray
          }
          context.putImageData(image, 0, 0)
        }
        const rendered = await new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('无法生成打印页面图像'))
            return
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
        }, 'image/png'))
        canvas.width = 1
        canvas.height = 1
        return rendered
      }
      let png = await renderAt(dpi)
      // A noisy full-page scan at 600 DPI can compress to more than the main
      // process's 64MB per-page validation accepts; retry once at half
      // resolution instead of failing the whole job.
      if (png.length > 48 * 1024 * 1024 && dpi > 150) png = await renderAt(dpi / 2)
      page.cleanup()
      encodedBytes += png.byteLength
      if (options.maxEncodedBytes && encodedBytes > options.maxEncodedBytes) {
        throw new Error(`处理到第 ${index} 页时超过单次打印数据上限，请降低 DPI 或分批打印。未提交任何页面。`)
      }
      pages.push({ widthPt: natural.width, heightPt: natural.height, png })
    }
    return pages
  } finally {
    await source.destroy()
  }
}

// Preflight the original bytes, not the reconstructed output or a possibly
// not-yet-loaded outline/signature panel. Cache only the verdict, not a parser.
async function guardedGraph(doc: import('pdf-lib').PDFDocument, forViewing = false) {
  const { PDFArray, PDFDict, PDFName, PDFStream } = await import('pdf-lib')
  // Read-only base hydration can retain ordinary outlines. A composed save
  // still requires a new file for ANY nontrivial catalog, just as before.
  const allowed = new Set([PDFName.Type, PDFName.of('Pages'), ...(forViewing ? [PDFName.of('Outlines'), PDFName.of('PageMode')] : [])])
  if (doc.context.trailerInfo.Encrypt || doc.catalog.keys().some(key => !allowed.has(key))) return true
  const markers = ['ByteRange','SigFlags','DocMDP','FieldMDP','UR3'].map(key=>PDFName.of(key))
  const sig = PDFName.of('Sig'), timestamp = PDFName.of('DocTimeStamp'), ft = PDFName.of('FT')
  // Each indirect object is inspected once; also walk directly embedded objects.
  const pending = doc.context.enumerateIndirectObjects().map(([,object]) => object)
  while (pending.length) {
    const object = pending.pop()!
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined
    if (dict) {
      const type = dict.lookup(PDFName.Type)
      if (type === sig || type === timestamp || dict.lookup(ft) === sig || markers.some(key=>dict.has(key))) return true
    }
    const children = dict?.values() ?? (object instanceof PDFArray ? object.asArray() : [])
    for (const child of children) if (child instanceof PDFDict || child instanceof PDFArray) pending.push(child)
  }
  return false
}

const copyOnlyByBytes = new WeakMap<Uint8Array, boolean>()
export async function compositionNeedsNewFile(source: PdfSource): Promise<boolean> {
  if (source.fileInfo?.ofdSignature || documentPasswords.has(source) || source.documentInfo?.encrypted || source.documentInfo?.hasSignatures || source.documentInfo?.hasForms) return true
  const bytes = savedOriginalBytes(source)
  const cached = copyOnlyByBytes.get(bytes)
  if (cached !== undefined) return cached
  let copyOnly = true
  try {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true })
    copyOnly = await guardedGraph(doc)
  } catch { copyOnly = true } // A failed inspection is not evidence of a safe overwrite.
  copyOnlyByBytes.set(bytes, copyOnly)
  return copyOnly
}

export async function composePdf(
  pages: WorkspacePage[],
  sourceList: PdfSource[],
  options: ExportOptions & { groupWatermarks?: ReadonlyMap<string, ExportOptions['watermark']> } = {},
) {
  const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import('pdf-lib')
  const hexComponents = (hex = '#2563eb'): [number, number, number] => {
    const value = hex.replace('#', '')
    const number = Number.parseInt(value, 16)
    return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255]
  }
  const hexToRgb = (hex = '#2563eb') => rgb(...hexComponents(hex))
  const output = await PDFDocument.create()
  const sourceDocs = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>()
  const outputPagesByWorkspaceId = new Map<string, ReturnType<typeof output.addPage>>()
  const sourceMap = new Map(sourceList.map((source) => [source.id, source]))
  const remainingSourcePages = new Map<string, number>()
  const copyIndices = new Map<string, Set<number>>()
  const firstCopies = new Map<string, Map<number, ReturnType<typeof output.addPage>>>()
  for (const item of pages) {
    if (item.sourceId === 'blank') continue
    remainingSourcePages.set(item.sourceId, (remainingSourcePages.get(item.sourceId) ?? 0) + 1)
    if (item.pageSize) continue // Resized pages use embedPage, not copyPages.
    const indices = copyIndices.get(item.sourceId) ?? new Set<number>()
    indices.add(item.sourcePage)
    copyIndices.set(item.sourceId, indices)
  }
  const font = await output.embedFont(StandardFonts.Helvetica)
  const watermarkImages = new Map<string, Awaited<ReturnType<typeof output.embedPng>>>()
  const { visiblePdfBox, writeSearchableOcr } = await import('./pdfOcrPersistence')
  const { knownOcrEdition, rememberOcrEdition } = await import('./ocrEditionReceipt')
  const sourceTags = new Map<string, Awaited<ReturnType<typeof knownOcrEdition>>>()
  const outputTags = new Map<number, readonly string[]>()
  const flattened = new Set(rasterMergePageIndices(pages))
  const afterRasterOcr = new Map<number, OcrPlacement>()
  const markFor = (item: WorkspacePage) => !options.watermarkPageIds || options.watermarkPageIds.has(item.id)
    ? options.groupWatermarks ? options.groupWatermarks.get(item.groupId ?? item.sourceId) : options.watermark : undefined
  const candidate = pages.length ? markFor(pages[0]) : undefined
  const crop = pages[0]?.crop
  const uniformMark = candidate && !flattened.size && pages.every(p => markFor(p) === candidate &&
    p.crop?.x === crop?.x && p.crop?.y === crop?.y && p.crop?.width === crop?.width && p.crop?.height === crop?.height)
  const owned = uniformMark ? await import('./pdfWatermarkPersistence') : undefined
  let layer: ReturnType<NonNullable<typeof owned>['beginOwnedWatermark']>
  const ink = new Map<DocumentWatermark, DocumentWatermark>()

  for (const [index, item] of pages.entries()) {
    const documentMark = markFor(item)
    let ocrPlacement: OcrPlacement | undefined
    let page
    let pageAnnotations = item.annotations
    if (item.sourceId === 'blank') {
      page = output.addPage(item.pageSize ? [item.pageSize.width, item.pageSize.height] : [595.28, 841.89])
    } else {
      const source = sourceMap.get(item.sourceId)
      if (!source) throw new Error('原页面来源已关闭，未导出不完整的文档')
      if (!flattened.has(index)) {
        if (!sourceTags.has(source.id)) sourceTags.set(source.id, await knownOcrEdition(source.bytes))
        const previous = sourceTags.get(source.id)?.get(item.sourcePage)
        if (previous?.length) outputTags.set(index, previous)
      }
      let document = sourceDocs.get(source.id)
      if (!document) {
        document = await PDFDocument.load(watermarkBase(source) ?? await getPdfSourceEditableBytes(source))
        sourceDocs.set(source.id, document)
        // One copier per source shares bitmap/font streams across distinct pages.
        // Repeat occurrences get fresh copies below, never the same editable leaf.
        const indices = [...(copyIndices.get(source.id) ?? [])]
        const copies = await output.copyPages(document, indices)
        firstCopies.set(source.id, new Map(indices.map((index, i) => [index, copies[i]])))
      }
      if (item.pageSize) {
        const sourcePage = document.getPage(item.sourcePage)
        const sourceSize = sourcePage.getSize()
        const target = item.pageSize
        const scale = Math.min(target.width / sourceSize.width, target.height / sourceSize.height)
        const drawnWidth = sourceSize.width * scale
        const drawnHeight = sourceSize.height * scale
        const offsetX = (target.width - drawnWidth) / 2
        const offsetTop = (target.height - drawnHeight) / 2
        if (item.ocr?.words.length) ocrPlacement = { sourceBox: visiblePdfBox(sourcePage), scale, dx: offsetX, dy: offsetTop }
        page = output.addPage([target.width, target.height])
        if (sourcePage.node.Contents()) {
          const embedded = await output.embedPage(sourcePage)
          page.drawPage(embedded, { x: offsetX, y: offsetTop, width: drawnWidth, height: drawnHeight })
        }
        pageAnnotations = item.annotations.map((annotation) => ({
          ...annotation,
          x: (offsetX + annotation.x * drawnWidth) / target.width,
          y: (offsetTop + annotation.y * drawnHeight) / target.height,
          width: annotation.width * drawnWidth / target.width,
          height: annotation.height * drawnHeight / target.height,
          formFieldRect: undefined,
        }))
      } else {
        const batch = firstCopies.get(source.id)!
        page = batch.get(item.sourcePage) ?? (await output.copyPages(document, [item.sourcePage]))[0]
        batch.delete(item.sourcePage)
        // Even distinct leaves can share indirect arrays/resource dictionaries.
        // Detach the containers pdf-lib mutates, not their image/font/stream data.
        if (pageAnnotations.length || documentMark || item.inheritedWatermarks?.length || item.ocr?.words.length) {
          for (const key of [PDFName.Contents, PDFName.Annots]) {
            const value = page.node.lookup(key)
            if (value instanceof PDFArray) page.node.set(key, value.clone())
          }
          const resources = page.node.Resources()?.clone()
          if (resources) {
            for (const key of [PDFName.Font, PDFName.XObject, PDFName.ExtGState]) {
              const dict = resources.lookupMaybe(key, PDFDict)
              if (dict) resources.set(key, dict.clone())
            }
            page.node.set(PDFName.Resources, resources)
          }
        }
        output.addPage(page)
      }
      const remaining = (remainingSourcePages.get(source.id) ?? 1) - 1
      remainingSourcePages.set(source.id, remaining)
      if (!remaining) {
        sourceDocs.delete(source.id)
        firstCopies.delete(source.id)
      }
    }

    const originalRotation = page.getRotation().angle
    outputPagesByWorkspaceId.set(item.id, page)
    const pageRotation = (originalRotation + item.rotation + 360) % 360
    page.setRotation(degrees(pageRotation))
    // Match PDF.js's visible page: the nonempty MediaBox/CropBox intersection,
    // falling back to MediaBox when the boxes do not overlap.
    const displayBox = visiblePdfBox(page)
    const displayOffset = <T extends { x: number; y: number }>(point: T): T => ({
      ...point,
      x: point.x + displayBox.x,
      y: point.y + displayBox.y,
    })

    if (item.crop) {
      const crop = displayBoxToPdf(normalizeCropSelection(item.crop), displayBox.width, displayBox.height, pageRotation)
      page.setCropBox(displayBox.x + crop.x, displayBox.y + crop.y, crop.width, crop.height)
    }

    if (item.ocr?.words.length) {
      ocrPlacement ??= { sourceBox: displayBox, scale: 1, dx: 0, dy: 0 }
      if (flattened.has(index)) afterRasterOcr.set(index, ocrPlacement)
      else {
        const source = sourceMap.get(item.sourceId)
        const native = source && await getPdfTextContent(source, item.sourcePage)
        const tag = writeSearchableOcr(page, item.ocr.words, ocrPlacement, native)
        if (tag) outputTags.set(index, [...outputTags.get(index) ?? [], tag])
      }
    }

    const filledFields = pageAnnotations.filter((annotation) => annotation.type === 'text' && (annotation.formFieldRect || annotation.formFieldName))
    const filledFieldRects = filledFields.flatMap((annotation) => annotation.formFieldRect ? [annotation.formFieldRect] : [])
    const filledFieldNames = new Set(filledFields
      .filter((annotation) => !annotation.formFieldRect && annotation.formFieldName)
      .map((annotation) => annotation.formFieldName!))
    if (filledFieldRects.length || filledFieldNames.size) {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      for (let index = (annots?.size() ?? 0) - 1; index >= 0; index -= 1) {
        const widget = annots?.lookup(index, PDFDict)
        if (widget?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Widget') continue
        const rect = widget.lookupMaybe(PDFName.of('Rect'), PDFArray)
        const rectValues = rect && rect.size() >= 4
          ? Array.from({ length: 4 }, (_, rectIndex) => rect.lookup(rectIndex, PDFNumber).asNumber())
          : undefined
        const matchesRect = rectValues && filledFieldRects.some((expected) =>
          expected.every((value, rectIndex) => Math.abs(value - rectValues[rectIndex]) < 0.5),
        )
        const parent = widget.lookupMaybe(PDFName.of('Parent'), PDFDict)
        const rawName = widget.get(PDFName.of('T')) ?? parent?.get(PDFName.of('T'))
        const fieldName = rawName instanceof PDFHexString || rawName instanceof PDFString ? rawName.decodeText() : undefined
        if (matchesRect || (fieldName && filledFieldNames.has(fieldName))) annots?.remove(index)
      }
    }

    const exportedHighlightGroups = new Set<string>()
    for (const annotation of pageAnnotations) {
      const rawBox = displayBoxToPdf(annotation, displayBox.width, displayBox.height, pageRotation)
      const box = {
        ...rawBox,
        x: rawBox.x + displayBox.x,
        y: rawBox.y + displayBox.y,
        drawX: rawBox.drawX + displayBox.x,
        drawY: rawBox.drawY + displayBox.y,
      }
      const { x, y } = box
      const rotatedVector=Boolean(annotation.rotation && ['ink','rectangle','ellipse'].includes(annotation.type))
      if(rotatedVector){const theta=-(annotation.rotation??0)*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),cx=x+box.width/2,cy=y+box.height/2
        page.pushOperators(pushGraphicsState(),concatTransformationMatrix(c,s,-s,c,cx-c*cx+s*cy,cy-s*cx-c*cy))}
      if (annotation.type === 'highlight') {
        const groupId = annotation.highlightGroupId ?? annotation.id
        if (exportedHighlightGroups.has(groupId)) continue
        exportedHighlightGroups.add(groupId)
        const group = pageAnnotations.filter((candidate) =>
          candidate.type === 'highlight'
          && (candidate.highlightGroupId ?? candidate.id) === groupId,
        )
        const groupBoxes = group.map((candidate) => {
          const raw = displayBoxToPdf(candidate, displayBox.width, displayBox.height, pageRotation)
          const quad = [
            displayPointToPdf(candidate.x, candidate.y, displayBox.width, displayBox.height, pageRotation),
            displayPointToPdf(candidate.x + candidate.width, candidate.y, displayBox.width, displayBox.height, pageRotation),
            displayPointToPdf(candidate.x, candidate.y + candidate.height, displayBox.width, displayBox.height, pageRotation),
            displayPointToPdf(candidate.x + candidate.width, candidate.y + candidate.height, displayBox.width, displayBox.height, pageRotation),
          ].flatMap((point) => [point.x + displayBox.x, point.y + displayBox.y])
          return { x: raw.x + displayBox.x, y: raw.y + displayBox.y, width: raw.width, height: raw.height, quad }
        })
        const left = Math.min(...groupBoxes.map((candidate) => candidate.x))
        const bottom = Math.min(...groupBoxes.map((candidate) => candidate.y))
        const right = Math.max(...groupBoxes.map((candidate) => candidate.x + candidate.width))
        const top = Math.max(...groupBoxes.map((candidate) => candidate.y + candidate.height))
        // Native Highlight annotations remain recognizable/editable in Adobe,
        // Edge and other conventional readers instead of being baked into page art.
        const color = hexComponents(annotation.color ?? '#facc15')
        const highlight = output.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Highlight'),
          Rect: [left, bottom, right, top],
          QuadPoints: groupBoxes.flatMap((candidate) => candidate.quad),
          Contents: PDFHexString.fromText(group.find((candidate) => candidate.text)?.text ?? ''),
          T: PDFHexString.fromText('Paperwork'),
          Subj: PDFHexString.fromText('高亮'),
          NM: PDFHexString.fromText(groupId),
          P: page.ref,
          C: color,
          CA: Math.max(0.05, Math.min(1, annotation.opacity ?? 0.48)),
          F: 4,
        })
        const highlightRef = output.context.register(highlight)
        let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
        if (!annots) {
          annots = output.context.obj([])
          page.node.set(PDFName.of('Annots'), annots)
        }
        annots.push(highlightRef)
      } else if (annotation.type === 'ink') {
        const points = annotation.points ?? []
        const strokeColor = hexToRgb(annotation.color)
        const thickness = Math.max(0.25, annotation.strokeWidth ?? 2)
        // Ink points are stored relative to the top-left of their normalized
        // annotation box; PDF coordinates instead start at the bottom-left.
        for (let index = 1; index < points.length; index += 1) {
          const previous = points[index - 1]
          const current = points[index]
          const start = displayOffset(displayPointToPdf(
            annotation.x + previous.x * annotation.width,
            annotation.y + previous.y * annotation.height,
            displayBox.width,
            displayBox.height,
            pageRotation,
          ))
          const end = displayOffset(displayPointToPdf(
            annotation.x + current.x * annotation.width,
            annotation.y + current.y * annotation.height,
            displayBox.width,
            displayBox.height,
            pageRotation,
          ))
          page.drawLine({
            start,
            end,
            color: strokeColor,
            thickness,
            opacity: annotation.opacity ?? 1,
          })
        }
      } else if (annotation.type === 'rectangle' || annotation.type === 'ellipse') {
        const shapeWidth = box.width
        const shapeHeight = box.height
        const shapeColor = hexToRgb(annotation.color)
        const shapeOptions = {
          x,
          y,
          width: shapeWidth,
          height: shapeHeight,
          borderColor: shapeColor,
          borderWidth: Math.max(0.25, annotation.strokeWidth ?? 2),
          borderOpacity: annotation.opacity ?? 1,
          ...(annotation.filled ? { color: shapeColor, opacity: 0.22 } : {}),
        }
        if (annotation.type === 'rectangle') page.drawRectangle(shapeOptions)
        else page.drawEllipse({
          x: x + shapeWidth / 2,
          y: y + shapeHeight / 2,
          xScale: shapeWidth / 2,
          yScale: shapeHeight / 2,
          borderColor: shapeOptions.borderColor,
          borderWidth: shapeOptions.borderWidth,
          borderOpacity: shapeOptions.borderOpacity,
          ...(annotation.filled ? { color: shapeColor, opacity: 0.22 } : {}),
        })
      } else if (annotation.type === 'text' && annotation.text) {
        const placed = centredPdfImage(box,annotation.rotation)
        if (annotation.imageData) {
          // Text entered in the renderer is rasterized to a transparent PNG.
          // This preserves CJK text without shipping a large licensed font.
          const raw = Uint8Array.from(atob(annotation.imageData.split(',')[1]), (char) => char.charCodeAt(0))
          const image = await output.embedPng(raw)
          page.drawImage(image, {
            x: placed.x,
            y: placed.y,
            width: box.drawWidth,
            height: box.drawHeight,
            rotate: degrees(placed.rotation),
          })
        } else {
          const safeText = annotation.text.replace(/[^\x20-\x7E]/g, '?')
          page.drawText(safeText, {
            x: placed.x,
            y: placed.y,
            size: annotation.fontSize ?? 16,
            font,
            color: hexToRgb(annotation.color),
            maxWidth: box.drawWidth,
            rotate: degrees(placed.rotation),
          })
        }
      } else if (['image', 'signature', 'stamp'].includes(annotation.type) && annotation.imageData) {
        const raw = Uint8Array.from(atob(annotation.imageData.split(',')[1]), (char) => char.charCodeAt(0))
        const image = annotation.imageData.startsWith('data:image/png')
          ? await output.embedPng(raw)
          : await output.embedJpg(raw)
        const placed=centredPdfImage(box,annotation.rotation)
        page.drawImage(image, {
          x: placed.x,
          y: placed.y,
          width: box.drawWidth,
          height: box.drawHeight,
          opacity: annotation.opacity ?? 1,
          rotate: degrees(placed.rotation),
        })
      } else if (annotation.type === 'note') {
        const noteSize = 18
        const createdAt = PDFHexString.fromText(pdfDate(annotation.createdAt))
        const note = output.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Text'),
          Rect: [x, y, x + noteSize, y + noteSize],
          Contents: PDFHexString.fromText(annotation.text ?? ''),
          T: PDFHexString.fromText(annotation.author || 'Paperwork'),
          Subj: PDFHexString.fromText('备注'),
          NM: PDFHexString.fromText(annotation.id),
          P: page.ref,
          CreationDate: createdAt,
          M: createdAt,
          Name: PDFName.of('Comment'),
          C: [1, 0.78, 0.15],
          Open: false,
          F: 4,
        })
        const noteRef = output.context.register(note)
        let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
        if (!annots) {
          annots = output.context.obj([])
          page.node.set(PDFName.of('Annots'), annots)
        }
        annots.push(noteRef)
        for (const reply of annotation.replies ?? []) {
          const replyCreatedAt = PDFHexString.fromText(pdfDate(reply.createdAt))
          const replyModifiedAt = PDFHexString.fromText(pdfDate(reply.updatedAt ?? reply.createdAt))
          const replyNote = output.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Text'),
            Rect: [x, y, x + noteSize, y + noteSize],
            Contents: PDFHexString.fromText(reply.text),
            T: PDFHexString.fromText(reply.author || 'Paperwork'),
            Subj: PDFHexString.fromText('备注回复'),
            NM: PDFHexString.fromText(reply.id),
            P: page.ref,
            CreationDate: replyCreatedAt,
            M: replyModifiedAt,
            IRT: noteRef,
            RT: PDFName.of('R'),
            Name: PDFName.of('Comment'),
            C: [1, 0.78, 0.15],
            Open: false,
            F: 4,
          })
          annots.push(output.context.register(replyNote))
        }
      }
      if(rotatedVector)page.pushOperators(popGraphicsState())
    }

    // Page artwork first; only the top, uniform document overlay can claim a
    // removable layer. Removing it on reopen must leave the transferred ink alone.
    const inherited = item.inheritedWatermarks ?? []
    for (let i = 0; i < inherited.length + (documentMark ? 1 : 0); i++) {
      const top = i === inherited.length, mark = top ? documentMark! : inherited[i]
      let watermark = ink.get(mark)
      if (!watermark) {
        watermark = snapshotWatermark(mark, sourceMap.get(item.groupId ?? item.sourceId))
        ink.set(mark, watermark)
      }
      const data = watermark.imageData
      if (!data) continue
      let watermarkImage = watermarkImages.get(data)
      if (!watermarkImage) {
        const raw = Uint8Array.from(atob(data.split(',')[1]), char => char.charCodeAt(0))
        watermarkImage = data.startsWith('data:image/png') ? await output.embedPng(raw) : await output.embedJpg(raw)
        watermarkImages.set(data, watermarkImage)
      }
      if (top && owned && index === 0) {
        const wm = item.crop ? owned.watermarkInCrop(watermark, normalizeCropSelection(item.crop)) : watermark
        if (wm) layer = owned.beginOwnedWatermark(output, wm, watermarkImage.ref)
      }
      if (top && layer) { layer.draw(page); continue }
      for (const box of watermarkTileBoxes(watermark)) {
        if (box.x >= 1 || box.y >= 1 || box.x + box.width <= 0 || box.y + box.height <= 0) continue
        const local=displayBoxToPdf(box,displayBox.width,displayBox.height,pageRotation)
        const placement=centredPdfImage(displayOffset(local),watermark.rotation)
        page.drawImage(watermarkImage, {
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
          opacity: watermark.opacity,
          rotate: degrees(placement.rotation),
        })
      }
    }
  }

  const bookmarks = options.bookmarks?.filter((bookmark) => outputPagesByWorkspaceId.has(bookmark.pageId)) ?? []
  if (bookmarks.length) {
    const outlines = output.context.obj({ Type: PDFName.of('Outlines'), Count: bookmarks.length })
    const outlinesRef = output.context.register(outlines)
    const items = bookmarks.map((bookmark) => {
      const target = outputPagesByWorkspaceId.get(bookmark.pageId)!
      const dictionary = output.context.obj({
        Title: PDFHexString.fromText(bookmark.title),
        Parent: outlinesRef,
        Dest: [target.ref, PDFName.of('Fit')],
      })
      return { dictionary, ref: output.context.register(dictionary) }
    })
    items.forEach((item, index) => {
      if (items[index - 1]) item.dictionary.set(PDFName.of('Prev'), items[index - 1].ref)
      if (items[index + 1]) item.dictionary.set(PDFName.of('Next'), items[index + 1].ref)
    })
    outlines.set(PDFName.of('First'), items[0].ref)
    outlines.set(PDFName.of('Last'), items.at(-1)!.ref)
    output.catalog.set(PDFName.of('Outlines'), outlinesRef)
    output.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
  }

  if (options.removeMetadata) {
    output.setTitle('')
    output.setAuthor('')
    output.setSubject('')
    output.setKeywords([])
    output.setProducer('Paperwork PDF Studio')
  }
  const bytes = await output.save({ useObjectStreams: true })
  if (layer && owned) await owned.sealOwnedWatermark(bytes, layer.id)
  const result = await rasterMergePdfPages(bytes, [...flattened], (page, index) => {
    const placement = afterRasterOcr.get(index)
    // Flattening can bake an opaque edit over earlier OCR. Keep the existing
    // PDF search behavior, but do not attest those words as visible for export.
    if (placement) writeSearchableOcr(page, pages[index].ocr!.words, placement)
  })
  await rememberOcrEdition(result, outputTags)
  return result
}

/**
 * Places several already-composed PDF pages on each output sheet. Composing
 * first preserves workspace order, rotations, crops and annotations; the
 * imposition pass then only scales complete pages and stays source-agnostic.
 */
export async function imposePdfPages(
  inputBytes: Uint8Array,
  pagesPerSheet: 2 | 4 | 6 | 8 | 9,
) {
  const { PDFDocument, PDFName } = await import('pdf-lib')
  const input = await PDFDocument.load(inputBytes, { ignoreEncryption: true })
  const output = await PDFDocument.create()
  const indices = input.getPageIndices()
  if (!indices.length) return output.save({ useObjectStreams: true })
  // pdf-lib cannot embed a structurally blank page without a Contents entry.
  // Normalize those pages to an empty stream so blank inserted pages work too.
  let normalizedInput = inputBytes
  if (input.getPages().some((page) => !page.node.has(PDFName.of('Contents')))) {
    input.getPages().forEach((page) => {
      if (!page.node.has(PDFName.of('Contents'))) {
        page.node.set(PDFName.of('Contents'), input.context.register(input.context.stream(new Uint8Array())))
      }
    })
    normalizedInput = await input.save({ useObjectStreams: true })
  }
  const embedded = await output.embedPdf(normalizedInput, indices)
  const landscape = pagesPerSheet === 2 || pagesPerSheet === 6 || pagesPerSheet === 8
  const sheetWidth = landscape ? 841.89 : 595.28
  const sheetHeight = landscape ? 595.28 : 841.89
  const columns = pagesPerSheet === 2 ? 2 : pagesPerSheet === 4 ? 2 : pagesPerSheet === 6 ? 3 : pagesPerSheet === 8 ? 4 : 3
  const rows = Math.ceil(pagesPerSheet / columns)
  const margin = 18
  const gap = 10
  const cellWidth = (sheetWidth - margin * 2 - gap * (columns - 1)) / columns
  const cellHeight = (sheetHeight - margin * 2 - gap * (rows - 1)) / rows

  for (let offset = 0; offset < embedded.length; offset += pagesPerSheet) {
    const sheet = output.addPage([sheetWidth, sheetHeight])
    embedded.slice(offset, offset + pagesPerSheet).forEach((page, slot) => {
      const column = slot % columns
      const row = Math.floor(slot / columns)
      const scale = Math.min(cellWidth / page.width, cellHeight / page.height)
      const width = page.width * scale
      const height = page.height * scale
      const x = margin + column * (cellWidth + gap) + (cellWidth - width) / 2
      const y = sheetHeight - margin - (row + 1) * cellHeight - row * gap + (cellHeight - height) / 2
      sheet.drawPage(page, { x, y, width, height })
    })
  }
  return output.save({ useObjectStreams: true })
}

export function parsePageRanges(input: string, total: number) {
  const tokens = input.split(',').map((part) => part.trim()).filter(Boolean)
  if (!tokens.length) throw new Error('请输入页码，例如 1-3,5,8-10')
  const result = new Set<number>()
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token)
    const start = Number(match?.[1])
    const end = Number(match?.[2] ?? match?.[1])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > total || start > end) {
      throw new Error(`页码超出范围或格式不正确，请输入 1-${total} 之间的页码`)
    }
    for (let page = start; page <= end; page += 1) result.add(page - 1)
  }
  return [...result].sort((a, b) => a - b)
}

/** Resolve a displayed range against the current, possibly edited page order. */
export function resolvePageRangeIds(
  input: string,
  total: number,
  pages: readonly { id: string; pageNumber: number }[],
) {
  const byNumber = new Map(pages.map((page) => [page.pageNumber, page.id]))
  return parsePageRanges(input, total).map((index) => {
    const id = byNumber.get(index + 1)
    if (!id) throw new Error(`第 ${index + 1} 页已被移除，请重新选择页码范围`)
    return id
  })
}

/** Inverse of parsePageRanges: 0-based page indexes → compact "1-3,5,8-10". */
export function serializePageRanges(pages: Iterable<number>) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const tokens: string[] = []
  let start = -1
  let previous = -1
  const flush = () => tokens.push(start === previous ? `${start + 1}` : `${start + 1}-${previous + 1}`)
  for (const page of sorted) {
    if (start < 0) { start = previous = page; continue }
    if (page === previous + 1) { previous = page; continue }
    flush()
    start = previous = page
  }
  if (start >= 0) flush()
  return tokens.join(',')
}

/**
 * Combine a typed page range with print-preview exclusions (both in merged
 * queue order): start from the range (or all pages when blank), drop the
 * excluded 0-based indexes, and return the compact range string.
 */
export function excludeFromPageRange(range: string, total: number, excludedIndexes: Iterable<number>) {
  const base = new Set(range.trim()
    ? parsePageRanges(range, total)
    : Array.from({ length: total }, (_, index) => index))
  for (const index of excludedIndexes) base.delete(index)
  if (!base.size) throw new Error('预览中已排除全部页面，没有可打印的内容。')
  return serializePageRanges(base)
}
