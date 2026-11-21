import { GlobalWorkerOptions, getDocument, Util } from 'pdfjs-dist'
import type { OcrTable, OcrWord } from '../types/pdf'
import { reconstructOcrTables } from './ocr'

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const pdfJsRuntimeUrl = typeof document === 'undefined'
  ? 'file:///pdfjs/'
  : new URL('./pdfjs/', document.baseURI).toString()
const pdfJsDocumentOptions = (data: Uint8Array) => ({
  data: data.slice(),
  cMapUrl: `${pdfJsRuntimeUrl}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${pdfJsRuntimeUrl}standard_fonts/`,
})

export type PageImageFormat = 'png' | 'jpeg'

export interface RenderedPageImage {
  name: string
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  pageWidthPoints: number
  pageHeightPoints: number
}

export interface PageImageRenderOptions {
  format?: PageImageFormat
  dpi?: number
  jpegQuality?: number
  pageIndices?: number[]
  maxPixels?: number
  maxDimension?: number
  signal?: AbortSignal
  onProgress?: (current: number, total: number) => void
}

const abortError = () => new DOMException('页面导出已取消', 'AbortError')

export function calculatePageRasterScale(
  widthPoints: number,
  heightPoints: number,
  dpi = 180,
  maxPixels = 16_000_000,
  maxDimension = 8192,
) {
  const width = Math.max(1, widthPoints)
  const height = Math.max(1, heightPoints)
  return Math.max(0.01, Math.min(
    Math.max(36, Math.min(600, dpi)) / 72,
    Math.sqrt(Math.max(1, maxPixels) / (width * height)),
    Math.max(1, maxDimension) / Math.max(width, height),
  ))
}

const canvasBytes = (canvas: HTMLCanvasElement, format: PageImageFormat, quality: number) =>
  new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error('无法编码页面图像'))
      return
    }
    void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
  }, format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? quality : undefined))

/**
 * Rasterize PDF pages sequentially. Sequential rendering and hard pixel caps
 * keep a large export from allocating several full-resolution canvases at once.
 * Pass composed workspace PDF bytes so edits, crops and watermarks are included.
 */
export async function renderPdfPagesToImages(
  pdfBytes: Uint8Array,
  options: PageImageRenderOptions = {},
): Promise<RenderedPageImage[]> {
  if (typeof document === 'undefined') throw new Error('页面图片导出需要桌面或浏览器画布环境')
  if (options.signal?.aborted) throw abortError()
  const format = options.format ?? 'png'
  const quality = Math.max(0.35, Math.min(1, options.jpegQuality ?? 0.9))
  const pdf = await getDocument(pdfJsDocumentOptions(pdfBytes)).promise
  try {
    const indices = options.pageIndices
      ? [...new Set(options.pageIndices)].filter((index) => Number.isInteger(index) && index >= 0 && index < pdf.numPages)
      : Array.from({ length: pdf.numPages }, (_, index) => index)
    const digits = Math.max(2, String(indices.length).length)
    const images: RenderedPageImage[] = []
    options.onProgress?.(0, indices.length)
    for (let outputIndex = 0; outputIndex < indices.length; outputIndex += 1) {
      if (options.signal?.aborted) throw abortError()
      const page = await pdf.getPage(indices[outputIndex] + 1)
      let canvas: HTMLCanvasElement | undefined
      try {
        const natural = page.getViewport({ scale: 1 })
        const scale = calculatePageRasterScale(
          natural.width,
          natural.height,
          options.dpi,
          options.maxPixels,
          options.maxDimension,
        )
        const viewport = page.getViewport({ scale })
        canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('无法创建页面导出画布')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        const task = page.render({ canvasContext: context, viewport, annotationMode: 1, background: '#ffffff' })
        const cancel = () => task.cancel()
        options.signal?.addEventListener('abort', cancel, { once: true })
        try {
          await task.promise
        } catch (error) {
          if (options.signal?.aborted) throw abortError()
          throw error
        } finally {
          options.signal?.removeEventListener('abort', cancel)
        }
        if (options.signal?.aborted) throw abortError()
        images.push({
          name: `page-${String(outputIndex + 1).padStart(digits, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`,
          bytes: await canvasBytes(canvas, format, quality),
          mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          width: canvas.width,
          height: canvas.height,
          pageWidthPoints: natural.width,
          pageHeightPoints: natural.height,
        })
      } finally {
        if (canvas) {
          canvas.width = 1
          canvas.height = 1
        }
        page.cleanup()
      }
      options.onProgress?.(outputIndex + 1, indices.length)
    }
    return images
  } finally {
    await pdf.destroy()
  }
}

export interface EditableDocxRun {
  text: string
  fontFamily?: string
  fontSizePoints: number
  bold?: boolean
  italic?: boolean
}

export interface EditableDocxLine {
  xPoints: number
  yPoints: number
  heightPoints: number
  runs: EditableDocxRun[]
}

export interface EditableDocxPage {
  widthPoints: number
  heightPoints: number
  lines: EditableDocxLine[]
  tables: OcrTable[]
}

export interface EditableDocxExtractOptions {
  tablesByPage?: readonly (readonly OcrTable[] | undefined)[]
  ocrWordsByPage?: readonly (readonly OcrWord[] | undefined)[]
  signal?: AbortSignal
  onProgress?: (current: number, total: number) => void
}

type PositionedTextRun = EditableDocxRun & {
  x: number
  y: number
  width: number
  height: number
}

const fontTraits = (fontName: string) => ({
  bold: /(?:^|[-, ])(?:bold|black|heavy|semibold|demibold)/i.test(fontName),
  italic: /(?:^|[-, ])(?:italic|oblique)/i.test(fontName),
})

function textItemWords(
  text: string,
  box: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): OcrWord[] {
  const matches = [...text.matchAll(/\S+/g)]
  const units = Math.max(1, [...text].length)
  return matches.map((match) => {
    const prefix = [...text.slice(0, match.index ?? 0)].length
    const length = [...match[0]].length
    return {
      text: match[0],
      confidence: 1,
      x: Math.max(0, Math.min(1, (box.x + box.width * prefix / units) / page.width)),
      y: Math.max(0, Math.min(1, box.y / page.height)),
      width: Math.max(0.0001, Math.min(1, box.width * length / units / page.width)),
      height: Math.max(0.0001, Math.min(1, box.height / page.height)),
    }
  })
}

function groupEditableLines(runs: PositionedTextRun[]) {
  const rows: Array<{
    baseline: number
    height: number
    runs: PositionedTextRun[]
  }> = []
  for (const run of [...runs].sort((left, right) => left.y - right.y || left.x - right.x)) {
    const baseline = run.y + run.height * 0.82
    const row = rows.find((candidate) =>
      Math.abs(candidate.baseline - baseline)
        <= Math.max(2, Math.min(candidate.height, run.height) * 0.42))
    if (row) {
      const count = row.runs.length
      row.baseline = (row.baseline * count + baseline) / (count + 1)
      row.height = Math.max(row.height, run.height)
      row.runs.push(run)
    } else {
      rows.push({ baseline, height: run.height, runs: [run] })
    }
  }

  return rows
    .sort((left, right) => left.baseline - right.baseline)
    .map((row) => {
      row.runs.sort((left, right) => left.x - right.x)
      const first = row.runs[0]
      let previousRight = first.x
      const output: EditableDocxRun[] = []
      for (const run of row.runs) {
        const gap = run.x - previousRight
        if (output.length && gap > Math.max(1.25, run.fontSizePoints * 0.18)) {
          const spaces = Math.max(1, Math.min(16, Math.round(gap / Math.max(2.5, run.fontSizePoints * 0.34))))
          output.push({ text: ' '.repeat(spaces), fontSizePoints: run.fontSizePoints, fontFamily: run.fontFamily })
        }
        output.push({
          text: run.text,
          fontFamily: run.fontFamily,
          fontSizePoints: run.fontSizePoints,
          bold: run.bold,
          italic: run.italic,
        })
        previousRight = Math.max(previousRight, run.x + run.width)
      }
      return {
        xPoints: first.x,
        yPoints: Math.max(0, row.baseline - row.height * 0.82),
        heightPoints: row.height,
        runs: output,
      }
    })
}

/** Extract selectable PDF text into editable page/line/run geometry. Native
 * text is preferred; positioned OCR tables can replace inferred native tables
 * on pages where OCR already supplied stronger structure. */
export async function extractEditableDocxPages(
  pdfBytes: Uint8Array,
  options: EditableDocxExtractOptions = {},
): Promise<EditableDocxPage[]> {
  if (options.signal?.aborted) throw abortError()
  const pdf = await getDocument(pdfJsDocumentOptions(pdfBytes)).promise
  try {
    const pages: EditableDocxPage[] = []
    options.onProgress?.(0, pdf.numPages)
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      if (options.signal?.aborted) throw abortError()
      const page = await pdf.getPage(pageIndex + 1)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const runs: PositionedTextRun[] = []
        let words: OcrWord[] = []
        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue
          const transform = Util.transform(viewport.transform, item.transform)
          const height = Math.max(1, Math.hypot(transform[2], transform[3]))
          const style = content.styles[item.fontName]
          const ascent = typeof style?.ascent === 'number'
            ? style.ascent
            : typeof style?.descent === 'number'
              ? 1 + style.descent
              : 0.8
          const x = transform[4]
          const y = transform[5] - height * ascent
          const width = Math.max(0.5, Math.abs(item.width * viewport.scale))
          const fontFamily = style?.fontFamily || item.fontName
          const traits = fontTraits(`${item.fontName} ${fontFamily}`)
          runs.push({
            text: item.str,
            x,
            y,
            width,
            height,
            fontFamily,
            fontSizePoints: height,
            ...traits,
          })
          words.push(...textItemWords(
            item.str,
            { x, y, width, height },
            { width: viewport.width, height: viewport.height },
          ))
        }
        const ocrWords = options.ocrWordsByPage?.[pageIndex] ?? []
        if (!runs.length && ocrWords.length) {
          words = ocrWords.map((word) => ({ ...word }))
          for (const word of words) {
            const height = Math.max(1, word.height * viewport.height)
            runs.push({
              text: word.text,
              x: word.x * viewport.width,
              y: word.y * viewport.height,
              width: Math.max(0.5, word.width * viewport.width),
              height,
              fontFamily: 'Microsoft YaHei',
              fontSizePoints: height,
            })
          }
        }
        const explicitTables = options.tablesByPage?.[pageIndex]
        pages.push({
          widthPoints: viewport.width,
          heightPoints: viewport.height,
          lines: groupEditableLines(runs),
          tables: explicitTables?.length
            ? explicitTables.map((table) => ({ ...table, rows: table.rows.map((row) => [...row]) }))
            : reconstructOcrTables(words),
        })
      } finally {
        page.cleanup()
      }
      options.onProgress?.(pageIndex + 1, pdf.numPages)
    }
    return pages
  } finally {
    await pdf.destroy()
  }
}

const encoder = new TextEncoder()
const xml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

let crcTable: Uint32Array | undefined
function crc32(bytes: Uint8Array) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let current = value
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    return current >>> 0
  })
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

type ZipEntry = { name: string; bytes: Uint8Array }

/** Minimal deterministic ZIP writer. DOCX media is already compressed, so the
 * store method avoids a large compression dependency and a second image copy. */
export function createStoredZip(entries: ZipEntry[]) {
  if (entries.length > 0xffff) throw new Error('Word 图片文档包含过多文件')
  const records = entries.map((entry) => ({
    ...entry,
    nameBytes: encoder.encode(entry.name),
    crc: crc32(entry.bytes),
    offset: 0,
  }))
  const localSize = records.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length, 0)
  const centralSize = records.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0)
  const total = localSize + centralSize + 22
  if (total > 0xffffffff) throw new Error('Word 图片文档超过 4 GB ZIP 限制')
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  let cursor = 0
  const u16 = (value: number) => { view.setUint16(cursor, value, true); cursor += 2 }
  const u32 = (value: number) => { view.setUint32(cursor, value >>> 0, true); cursor += 4 }
  for (const entry of records) {
    entry.offset = cursor
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0)
    u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length)
    u16(entry.nameBytes.length); u16(0)
    output.set(entry.nameBytes, cursor); cursor += entry.nameBytes.length
    output.set(entry.bytes, cursor); cursor += entry.bytes.length
  }
  const centralOffset = cursor
  for (const entry of records) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0)
    u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length)
    u16(entry.nameBytes.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset)
    output.set(entry.nameBytes, cursor); cursor += entry.nameBytes.length
  }
  u32(0x06054b50); u16(0); u16(0); u16(records.length); u16(records.length)
  u32(centralSize); u32(centralOffset); u16(0)
  return output
}

const pageGeometry = (image: RenderedPageImage, marginPoints: number) => {
  const sourceWidth = Number.isFinite(image.pageWidthPoints) && image.pageWidthPoints > 0 ? image.pageWidthPoints : 595.28
  const sourceHeight = Number.isFinite(image.pageHeightPoints) && image.pageHeightPoints > 0 ? image.pageHeightPoints : 841.89
  const pageScale = Math.min(1, 1584 / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(72, sourceWidth * pageScale)
  const height = Math.max(72, sourceHeight * pageScale)
  const margin = Math.max(0, Math.min(marginPoints, Math.min(width, height) / 4))
  const availableWidth = Math.max(1, width - margin * 2)
  const availableHeight = Math.max(1, height - margin * 2)
  const imageRatio = Math.max(1, image.width) / Math.max(1, image.height)
  const drawWidth = Math.min(availableWidth, availableHeight * imageRatio)
  const drawHeight = drawWidth / imageRatio
  return {
    widthTwips: Math.round(width * 20),
    heightTwips: Math.round(height * 20),
    marginTwips: Math.round(margin * 20),
    widthEmu: Math.round(drawWidth * 12_700),
    heightEmu: Math.round(drawHeight * 12_700),
    landscape: width > height,
  }
}

const sectionXml = (geometry: {
  widthTwips: number
  heightTwips: number
  marginTwips: number
  landscape: boolean
}, nextPage: boolean) =>
  `<w:sectPr>${nextPage ? '<w:type w:val="nextPage"/>' : ''}<w:pgSz w:w="${geometry.widthTwips}" w:h="${geometry.heightTwips}" w:orient="${geometry.landscape ? 'landscape' : 'portrait'}"/><w:pgMar w:top="${geometry.marginTwips}" w:right="${geometry.marginTwips}" w:bottom="${geometry.marginTwips}" w:left="${geometry.marginTwips}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`

export function buildImageDocx(
  images: RenderedPageImage[],
  options: { title?: string; creator?: string; marginPoints?: number } = {},
) {
  if (!images.length) throw new Error('没有可写入 Word 的页面图像')
  const margin = options.marginPoints ?? 18
  const geometries = images.map((image) => pageGeometry(image, margin))
  const relationships = images.map((image, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}"/>`,
  ).join('')
  const paragraphs = images.map((image, index) => {
    const geometry = geometries[index]
    const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${geometry.widthEmu}" cy="${geometry.heightEmu}"/><wp:docPr id="${index + 1}" name="PDF page ${index + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index + 1}" name="${xml(image.name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${geometry.widthEmu}" cy="${geometry.heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    const intermediateSection = index < images.length - 1 ? sectionXml(geometry, true) : ''
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/>${intermediateSection}</w:pPr>${drawing}</w:p>`
  }).join('')
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${paragraphs}${sectionXml(geometries.at(-1)!, false)}</w:body></w:document>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
  const now = new Date().toISOString()
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(options.title ?? 'PDF 图片文档')}</dc:title><dc:creator>${xml(options.creator ?? 'Paperwork PDF Studio')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Paperwork PDF Studio</Application><Pages>${images.length}</Pages></Properties>`
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes) },
    { name: '_rels/.rels', bytes: encoder.encode(rootRels) },
    { name: 'word/document.xml', bytes: encoder.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', bytes: encoder.encode(documentRels) },
    { name: 'docProps/core.xml', bytes: encoder.encode(core) },
    { name: 'docProps/app.xml', bytes: encoder.encode(appXml) },
    ...images.map((image, index) => ({
      name: `word/media/page-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
      bytes: image.bytes,
    })),
  ]
  return createStoredZip(entries)
}

const editablePageGeometry = (page: EditableDocxPage, marginPoints: number) => {
  const width = Math.max(72, page.widthPoints)
  const height = Math.max(72, page.heightPoints)
  const scale = Math.min(1, 1584 / Math.max(width, height))
  const scaledWidth = width * scale
  const scaledHeight = height * scale
  const margin = Math.max(0, Math.min(marginPoints, Math.min(scaledWidth, scaledHeight) / 4))
  return {
    scale,
    margin,
    widthTwips: Math.round(scaledWidth * 20),
    heightTwips: Math.round(scaledHeight * 20),
    marginTwips: Math.round(margin * 20),
    landscape: scaledWidth > scaledHeight,
    contentWidthTwips: Math.max(20, Math.round((scaledWidth - margin * 2) * 20)),
  }
}

const validXmlText = (value: string) => [...value]
  .filter((character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32
  })
  .join('')

function editableRunXml(run: EditableDocxRun) {
  const family = (run.fontFamily ?? 'Arial')
    .split(',')[0]
    .replace(/["']/g, '')
    .trim() || 'Arial'
  const size = Math.max(8, Math.min(144, Math.round(run.fontSizePoints * 2)))
  const properties = `<w:rPr><w:rFonts w:ascii="${xml(family)}" w:hAnsi="${xml(family)}" w:eastAsia="${xml(family)}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}</w:rPr>`
  return `<w:r>${properties}<w:t xml:space="preserve">${xml(validXmlText(run.text))}</w:t></w:r>`
}

function editableTableXml(
  table: OcrTable,
  geometry: ReturnType<typeof editablePageGeometry>,
) {
  const columnCount = Math.max(1, table.columnCount, ...table.rows.map((row) => row.length))
  const widthTwips = table.bounds
    ? Math.max(20, Math.round(table.bounds.width * geometry.widthTwips))
    : geometry.contentWidthTwips
  const indentTwips = table.bounds
    ? Math.max(0, Math.round(table.bounds.x * geometry.widthTwips) - geometry.marginTwips)
    : 0
  const cellWidth = Math.max(20, Math.floor(widthTwips / columnCount))
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${cellWidth}"/>`).join('')
  const rows = table.rows.map((row) => {
    const cells = Array.from({ length: columnCount }, (_, column) => row[column] ?? '')
      .map((text) => `<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/><w:tcMar><w:top w:w="45" w:type="dxa"/><w:left w:w="70" w:type="dxa"/><w:bottom w:w="45" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${editableRunXml({ text, fontSizePoints: 10, fontFamily: 'Microsoft YaHei' })}</w:p></w:tc>`)
      .join('')
    return `<w:tr>${cells}</w:tr>`
  }).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="${widthTwips}" w:type="dxa"/><w:tblInd w:w="${indentTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7BEC8"/><w:left w:val="single" w:sz="4" w:color="B7BEC8"/><w:bottom w:val="single" w:sz="4" w:color="B7BEC8"/><w:right w:val="single" w:sz="4" w:color="B7BEC8"/><w:insideH w:val="single" w:sz="4" w:color="D4D8DE"/><w:insideV w:val="single" w:sz="4" w:color="D4D8DE"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
}

/** Build a flow-editable DOCX. Text remains regular Word runs with inferred
 * font family/size, while positioned OCR/native tables become real Word tables.
 * Paragraph indentation and exact line spacing approximate the source page
 * without turning the page into one large image. */
export function buildEditableDocx(
  pages: EditableDocxPage[],
  options: { title?: string; creator?: string; marginPoints?: number } = {},
) {
  if (!pages.length) throw new Error('没有可写入 Word 的页面内容')
  const marginPoints = options.marginPoints ?? 18
  const pageXml = pages.map((page, pageIndex) => {
    const geometry = editablePageGeometry(page, marginPoints)
    const positionedTables = page.tables.filter((table) => table.rows.length && table.columnCount > 0 && table.bounds)
    const unpositionedTables = page.tables.filter((table) => table.rows.length && table.columnCount > 0 && !table.bounds)
    const lines = page.lines.filter((line) => !positionedTables.some((table) => {
      const centerX = line.xPoints / Math.max(1, page.widthPoints)
      const centerY = (line.yPoints + line.heightPoints / 2) / Math.max(1, page.heightPoints)
      const bounds = table.bounds!
      return centerX >= bounds.x && centerX <= bounds.x + bounds.width
        && centerY >= bounds.y && centerY <= bounds.y + bounds.height
    }))
    const blocks: Array<
      | { kind: 'line'; top: number; line: EditableDocxLine }
      | { kind: 'table'; top: number; table: OcrTable }
    > = [
      ...lines.map((line) => ({ kind: 'line' as const, top: line.yPoints * geometry.scale, line })),
      ...positionedTables.map((table) => ({ kind: 'table' as const, top: table.bounds!.y * geometry.heightTwips / 20, table })),
    ].sort((left, right) => left.top - right.top)

    let cursorPoints = geometry.margin
    const content: string[] = []
    for (const block of blocks) {
      const beforeTwips = Math.max(0, Math.round((block.top - cursorPoints) * 20))
      if (block.kind === 'table') {
        if (beforeTwips) content.push(`<w:p><w:pPr><w:spacing w:before="${beforeTwips}" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>`)
        content.push(editableTableXml(block.table, geometry))
        cursorPoints = block.top + Math.max(12, (block.table.bounds?.height ?? 0) * geometry.heightTwips / 20)
        continue
      }
      const lineHeight = Math.max(5, block.line.heightPoints * geometry.scale)
      const leftTwips = Math.max(0, Math.round((block.line.xPoints * geometry.scale - geometry.margin) * 20))
      content.push(`<w:p><w:pPr><w:ind w:left="${leftTwips}"/><w:spacing w:before="${beforeTwips}" w:after="0" w:line="${Math.max(20, Math.round(lineHeight * 20))}" w:lineRule="exact"/></w:pPr>${block.line.runs.map(editableRunXml).join('')}</w:p>`)
      cursorPoints = block.top + lineHeight
    }
    for (const table of unpositionedTables) content.push(editableTableXml(table, geometry))
    if (pageIndex < pages.length - 1) {
      content.push(`<w:p><w:pPr>${sectionXml(geometry, true)}</w:pPr></w:p>`)
    }
    return content.join('')
  }).join('')

  const finalGeometry = editablePageGeometry(pages.at(-1)!, marginPoints)
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pageXml}${sectionXml(finalGeometry, false)}</w:body></w:document>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const now = new Date().toISOString()
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(options.title ?? 'PDF 可编辑文档')}</dc:title><dc:creator>${xml(options.creator ?? 'Paperwork PDF Studio')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Paperwork PDF Studio</Application><Pages>${pages.length}</Pages></Properties>`
  return createStoredZip([
    { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes) },
    { name: '_rels/.rels', bytes: encoder.encode(rootRels) },
    { name: 'word/document.xml', bytes: encoder.encode(documentXml) },
    { name: 'word/styles.xml', bytes: encoder.encode(stylesXml) },
    { name: 'word/_rels/document.xml.rels', bytes: encoder.encode(documentRels) },
    { name: 'docProps/core.xml', bytes: encoder.encode(core) },
    { name: 'docProps/app.xml', bytes: encoder.encode(appXml) },
  ])
}
