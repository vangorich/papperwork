import { OPS, Util, type PDFPageProxy } from 'pdfjs-dist'
import type { PdfSource } from '../types/pdf'
import type { Box } from './objectTransform'
import { getPdfDocument } from './pdf'
import { markerInk, matchesMarkerQuads, visibleHighlight } from './markdownHighlightInk'

export const wholePage: Box = { x: 0, y: 0, width: 1, height: 1 }
export function inside(a: Box, b: Box) {
  // Permit floating point roundoff only, not a partially visible word.
  return a.width > 0 && a.height > 0 && a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9
    && a.x + a.width <= b.x + b.width + 1e-9 && a.y + a.height <= b.y + b.height + 1e-9
}
export function intersection(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

function bounds(rect: number[], matrix: number[]): Box {
  const [x, y, r, b] = Util.getAxialAlignedBoundingBox(rect, matrix)
  return { x, y, width: r - x, height: b - y }
}
const axisAligned = ([a, b, c, d]: number[]) => (a === 0 && d === 0) || (b === 0 && c === 0)
const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
export const glyphKey = (text: string) => text.normalize('NFKC').replace(/[\s­​-‏﻿]/gu, '')

interface Figure { box: Box; op: number; density: number }
interface Cover { box: Box; op: number; color?: string; marker?: 'tint' | 'multiply' }
interface TextPaint { key: string; end: number; clip?: Box; op: number; color?: string; glyphs?: { text: string; width: number }[] }

/** getTextContent doesn't say whether glyphs actually paint. Inspect the display list
 * (not the resource dictionary): unused XObjects, hidden OC groups and unpainted
 * glyphs aren't figures/text. Work in the same unrotated CropBox space as stored OCR. */
export async function inspectMarkdownPaint(page: PDFPageProxy, source: PdfSource, crop: Box, includeImages: boolean, signal?: AbortSignal, options?: { ocrTags: readonly string[]; glyphMetrics: boolean }) {
  const list = await page.getOperatorList({ intent: 'display' })
  signal?.throwIfAborted()
  if (list.fnArray.length > 200_000) throw new Error('页面绘制指令过多，未导出不完整的 Markdown')
  const oc = list.fnArray.includes(OPS.beginMarkedContentProps)
    ? await (await getPdfDocument(source)).getOptionalContentConfig({ intent: 'display' }) : undefined
  const v = page.getViewport({ scale: 1, rotation: 0 })
  const base = Util.transform([1 / v.width, 0, 0, 1 / v.height, 0, 0], v.transform)
  const text: TextPaint[] = [], covers: Cover[] = [], figures: Figure[] = []
  const annotationIds = new Map(list.fnArray.includes(OPS.beginAnnotation) ? (await page.getAnnotations({ intent:'display' })).filter(visibleHighlight).map(a => [a.id, a]) : [])
  const confirmedMarkers = new Set<string>()
  const ocrIds = new Set(options?.ocrTags)
  let s = { m: base, clip: crop as Box | undefined, mode: 0, fill: 1, stroke: 1, fillColor: '0,0,0', strokeColor: '0,0,0', lineWidth: 1, masked: false, charSpacing: 0, wordSpacing: 0 }
  const stack: typeof s[] = [], marked: {visible: boolean; ocr: boolean}[] = []
  let inOcr = false
  let visible = true, annotation = false, textClip = false, end = 0, op = 0, oversizeImage = false, skippedFigures = false
  let path: Box | undefined, rectangular = false, placements = 0, glyphCount = 0
  const save = () => {
    if (stack.length >= 4096) throw new Error('页面绘制嵌套过深，已停止 Markdown 导出')
    stack.push({ ...s })
  }
  const restore = () => { s = stack.pop() ?? s }
  const cover = (b?: Box, color?: string, marker?: Cover['marker']) => {
    // If the clip is nonrectangular we cannot admit text in it. Its paint can
    // nevertheless hide earlier text, so overestimate rather than ignore it.
    const box = b && intersection(b, s.clip ?? crop)
    if (visible && box) covers.push({ box, op, color, marker })
  }
  const strokePath = () => {
    if (!path || s.stroke <= 0 || !s.strokeColor) return
    const dx = Math.hypot(s.m[0], s.m[2]) * s.lineWidth / 2, dy = Math.hypot(s.m[1], s.m[3]) * s.lineWidth / 2
    // Treat a wide marker stroke (or a simple straight rule) as possible overpaint,
    // not the entire interior of an ordinary thin stroked rectangle/table outline.
    if (!path.width || !path.height || Math.max(dx * v.width, dy * v.height) >= 2) {
      cover({ x: path.x - dx, y: path.y - dy, width: path.width + 2 * dx, height: path.height + 2 * dy }, s.strokeColor)
    }
  }
  const image = (m: number[], iw: number, ih: number, illustration: boolean) => {
    if (++placements > 16_384) throw new Error('页面图像放置次数过多，已停止 Markdown 导出')
    if (iw * ih > 16_000_000) oversizeImage = true
    if (!visible || s.fill <= 0) return
    const original = bounds([0, 0, 1, 1], m)
    cover(original)
    const box = s.clip && intersection(original, s.clip)
    if (!box || !includeImages || !illustration || s.masked || annotation) return
    if (figures.length >= 32) { skippedFigures = true; return }
    // Use the intrinsic pixel density so reuse at a different display size can still deduplicate.
    const xPixels = Math.hypot(m[0] * v.width, m[1] * v.height)
    const yPixels = Math.hypot(m[2] * v.width, m[3] * v.height)
    const density = iw && ih ? Math.min(iw / xPixels, ih / yPixels) : 1.5
    figures.push({ box, op, density })
  }
  for (; op < list.fnArray.length; op++) {
    const fn = list.fnArray[op], a = list.argsArray[op] ?? []
    if (fn === OPS.beginAnnotation) {
      const candidate = annotationIds.get(a[0]), marker = candidate && markerInk(list, op)
      if (marker && candidate && matchesMarkerQuads(list, op, candidate)) confirmedMarkers.add(a[0])
      cover(bounds(a[1] ?? page.view, base), undefined, marker); annotation = true; continue
    }
    if (fn === OPS.endAnnotation) { annotation = false; continue }
    if (annotation) continue // Appearance text and comments never become body text.
    if (fn === OPS.beginMarkedContent || fn === OPS.beginMarkedContentProps) {
      marked.push({visible, ocr:inOcr})
      const tag = typeof a[0] === 'string' ? a[0] : a[0]?.name
      visible = visible && (tag !== 'OC' || !!oc?.isVisible(a[1]))
      inOcr = inOcr || ocrIds.has(tag); continue
    }
    if (fn === OPS.endMarkedContent) { const last=marked.pop(); visible=last?.visible ?? true; inOcr=last?.ocr ?? false; continue }
    switch (fn) {
      case OPS.save: save(); break
      case OPS.restore: restore(); break
      case OPS.transform: s.m = Util.transform(s.m, a); break
      case OPS.paintFormXObjectBegin:
        save(); if (a[0]) s.m = Util.transform(s.m, a[0])
        if (a[1] && s.clip) s.clip = axisAligned(s.m) ? intersection(s.clip, bounds(a[1], s.m)) : undefined
        break
      case OPS.paintFormXObjectEnd: case OPS.endGroup: restore(); break
      case OPS.beginGroup: {
        save(); const group = a[0]
        if (group?.smask) s.masked = true
        if (group?.bbox && s.clip) {
          const m = group.matrix ? Util.transform(s.m, group.matrix) : s.m
          s.clip = axisAligned(m) ? intersection(s.clip, bounds(group.bbox, m)) : undefined
        }
        break
      }
      case OPS.constructPath: {
        const next = a[2] && bounds(a[2], s.m)
        rectangular = !path && a[0]?.length === 1 && a[0][0] === OPS.rectangle && axisAligned(s.m)
        if (!path) path = next
        else if (next) {
          const x = Math.min(path.x, next.x), y = Math.min(path.y, next.y)
          path = { x, y, width: Math.max(path.x + path.width, next.x + next.width) - x, height: Math.max(path.y + path.height, next.y + next.height) - y }
        }
        break
      }
      case OPS.clip: case OPS.eoClip:
        s.clip = rectangular && s.clip && path ? intersection(s.clip, path) : undefined; break
      case OPS.endPath: path = undefined; break
      case OPS.stroke: case OPS.closeStroke: strokePath(); path = undefined; break
      case OPS.setLineWidth: s.lineWidth = Math.abs(a[0]); break
      case OPS.shadingFill: cover(s.clip ?? crop); break
      case OPS.setGState:
        for (const [key, value] of a[0] ?? []) {
          if (key === 'LW') s.lineWidth = Math.abs(value)
          if (key === 'ca') s.fill = value
          if (key === 'CA') s.stroke = value
          if (key === 'SMask') s.masked = !!value
        }
        break
      case OPS.setFillRGBColor: s.fillColor = a.join(','); break
      case OPS.setStrokeRGBColor: s.strokeColor = a.join(','); break
      case OPS.setFillColorN: s.fillColor = 'pattern'; break
      case OPS.setStrokeColorN: s.strokeColor = 'pattern'; break
      case OPS.setFillTransparent: s.fillColor = ''; break
      case OPS.setStrokeTransparent: s.strokeColor = ''; break
      case OPS.setCharSpacing: s.charSpacing = a[0]; break
      case OPS.setWordSpacing: s.wordSpacing = a[0]; break
      case OPS.setTextRenderingMode: s.mode = a[0]; break
      case OPS.endText: if (textClip) s.clip = undefined; textClip = false; break
      case OPS.showText: case OPS.showSpacedText: case OPS.nextLineShowText: case OPS.nextLineSetSpacingShowText: {
        const glyphs = a.at(-1) ?? []
        glyphCount += glyphs.length
        if (glyphCount > 1_000_000) throw new Error('单页字形过多，已停止 Markdown 导出')
        const key = glyphKey(glyphs.map((g: { unicode?: string } | number) => typeof g === 'number' ? '' : g.unicode ?? '').join(''))
        if (s.mode & 4) textClip = true
        if (!key) break
        end += key.length
        if (end > 2_000_000) throw new Error('单页文字过多，已停止 Markdown 导出')
        const mode = s.mode & 3
        const fill = (mode === 0 || mode === 2) && s.fill > 0 && s.fillColor
        const stroke = (mode === 1 || mode === 2) && s.stroke > 0 && s.strokeColor
        const color = fill && stroke && fill !== stroke ? undefined : fill || stroke || undefined
        // The exception to invisible-text filtering is a specific local OCR tag,
        // verified for these exact file bytes and this source page, never a font name.
        const verifiedOcr = inOcr && s.mode === 3
        const metrics = options?.glyphMetrics && !s.charSpacing && !s.wordSpacing && glyphs.every((g: {unicode?:string;width?:number} | number) => typeof g !== 'number' && g.unicode && Number.isFinite(g.width) && g.width! > 0)
          ? glyphs.map((g: {unicode:string;width:number}) => ({text:g.unicode,width:g.width})) : undefined
        text.push({ key, end, op, color, glyphs:metrics, clip: visible && !s.masked && (fill || stroke || verifiedOcr) ? s.clip : undefined })
        break
      }
      case OPS.paintImageXObject: image(s.m, a[1], a[2], true); break
      case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject:
        image(s.m, a[0]?.width, a[0]?.height, fn === OPS.paintInlineImageXObject); break
      case OPS.paintImageXObjectRepeat: {
        const pos = a[3]
        if (pos.length > 8192) throw new Error('页面重复图像过多，已停止 Markdown 导出')
        for (let i = 0; i < pos.length; i += 2) image(Util.transform(s.m, [a[1], 0, 0, a[2], pos[i], pos[i + 1]]), 0, 0, true)
        break
      }
      case OPS.paintInlineImageXObjectGroup:
        if (a[1].length > 4096) throw new Error('页面图像组过大，已停止 Markdown 导出')
        for (const entry of a[1]) image(Util.transform(s.m, entry.transform), entry.w, entry.h, true)
        break
      case OPS.paintImageMaskXObjectRepeat: case OPS.paintImageMaskXObjectGroup: cover(s.clip); break
      case OPS.paintSolidColorImageMask: cover(bounds([0, 0, 1, 1], s.m)); break
      default:
        if (fillOps.has(fn)) {
          if (s.fill > 0 && s.fillColor) cover(path ?? s.clip ?? crop, s.fillColor)
          if (fn !== OPS.fill && fn !== OPS.eoFill) strokePath()
          path = undefined
        }
    }
  }
  signal?.throwIfAborted()
  return { text, covers, figures, confirmedMarkers, oversizeImage, skippedFigures }
}
export type MarkdownPaint = Awaited<ReturnType<typeof inspectMarkdownPaint>>

/** Render only final, visible pixels. Never return an original XObject, a JPEG's
 * EXIF data, or the pixels on the far side of a workspace crop. */
export async function renderMarkdownFigure(page: PDFPageProxy, rotation: number, box: Box, density: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const viewport = page.getViewport({ scale: 1, rotation }), w = box.width * viewport.width, h = box.height * viewport.height
  const scale = Math.min(density, 1536 / Math.max(w, h), Math.sqrt(1_500_000 / (w * h)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale))
  try {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法创建插图画布')
    const sx = canvas.width / w, sy = canvas.height / h
    const task = page.render({ viewport, canvasContext: ctx, background: '#ffffff',
      transform: [sx, 0, 0, sy, -box.x * viewport.width * sx, -box.y * viewport.height * sy] })
    const cancel = () => task.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try { await task.promise } finally { signal?.removeEventListener('abort', cancel); signal?.throwIfAborted() }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('无法编码插图')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal?.throwIfAborted()
    return bytes
  } finally { canvas.width = canvas.height = 1 }
}
