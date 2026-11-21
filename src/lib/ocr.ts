import type { OcrTable, OcrWord } from '../types/pdf'

export interface OcrPageBounds {
  width: number
  height: number
}

export interface OcrBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

export interface NativeTextProbeItem {
  str?: string
  width?: number
  height?: number
  transform?: readonly number[]
}

/**
 * Decide whether an existing PDF text layer is complete enough to skip OCR.
 * A single hidden/accessibility fragment must not suppress recognition for an
 * otherwise scanned page, so this requires meaningful text across several
 * baselines instead of treating any non-empty `str` as a complete layer.
 */
export function hasSufficientNativeTextLayer(
  items: readonly NativeTextProbeItem[],
  bounds: OcrPageBounds,
) {
  const fragments = items.flatMap((item) => {
    const text = item.str?.replace(/\s+/g, ' ').trim() ?? ''
    if (!text) return []
    const transform = item.transform
    const y = transform?.[5]
    const transformHeight = transform && transform.length >= 4
      ? Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
      : 0
    const height = Math.max(0, item.height ?? transformHeight)
    return [{ text, y: Number.isFinite(y) ? y! : undefined, height }]
  })
  const characterCount = fragments.reduce((sum, item) => sum + [...item.text].length, 0)
  const replacementCount = fragments.reduce(
    (sum, item) => sum + [...item.text].filter((character) => character === '�').length,
    0,
  )
  if (fragments.length < 3 || characterCount < 40) return false
  // A large share of replacement glyphs usually means a broken /ToUnicode map;
  // treating that layer as complete would preserve unsearchable gibberish.
  if (replacementCount >= 3 && replacementCount / characterCount >= 0.08) return false

  // Ignore page-edge-only text (page numbers, scanner stamps, repeated headers)
  // when deciding whether the central document body already has a useful layer.
  // Unknown baselines stay eligible so unusual PDF.js text items do not force OCR.
  // A 7.5% margin keeps ordinary A4 body text around 10-12 mm from the edge;
  // the larger 12.5% margin used by batch OCR tools rejected valid first lines
  // in our editor-sized page samples.
  const interiorMargin = Math.max(1, bounds.height * 0.075)
  const interiorFragments = fragments.filter((item) => (
    item.y === undefined
    || (item.y >= interiorMargin && item.y <= bounds.height - interiorMargin)
  ))
  const interiorCharacterCount = interiorFragments.reduce((sum, item) => sum + [...item.text].length, 0)
  if (interiorFragments.length < 3 || interiorCharacterCount < 40) return false
  if (characterCount >= 240 && fragments.length >= 6 && interiorCharacterCount >= 80) return true

  const heights = interiorFragments.map((item) => item.height).filter((height) => height > 0)
  const typicalHeight = median(heights) || Math.max(1, bounds.height * 0.012)
  const baselines: number[] = []
  for (const fragment of interiorFragments) {
    if (fragment.y === undefined) continue
    const line = baselines.findIndex((baseline) => Math.abs(baseline - fragment.y!) <= typicalHeight * 0.65)
    if (line < 0) baselines.push(fragment.y)
    else baselines[line] = (baselines[line] + fragment.y) / 2
  }
  return baselines.length >= 3 && interiorCharacterCount >= 56
}

/** Convert a pixel bbox into a safe normalized, top-left-origin bbox. */
export function normalizeOcrBoundingBox(
  box: OcrBoundingBox,
  bounds: OcrPageBounds,
): OcrBoundingBox {
  const pageWidth = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 1
  const pageHeight = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 1
  const x = clamp((Number.isFinite(box.x) ? box.x : 0) / pageWidth)
  const y = clamp((Number.isFinite(box.y) ? box.y : 0) / pageHeight)
  const right = clamp(((Number.isFinite(box.x) ? box.x : 0) + Math.max(0, Number.isFinite(box.width) ? box.width : 0)) / pageWidth)
  const bottom = clamp(((Number.isFinite(box.y) ? box.y : 0) + Math.max(0, Number.isFinite(box.height) ? box.height : 0)) / pageHeight)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/**
 * Converts OCR engine output into the normalized contract stored in a page.
 * Empty words and boxes outside the page are discarded early to keep large
 * scanned documents cheap to render.
 */
export function normalizeOcrWords(
  words: OcrWord[],
  bounds: OcrPageBounds,
): OcrWord[] {
  const pageWidth = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 1
  const pageHeight = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 1
  return words.flatMap((word) => {
    const text = word.text.trim()
    if (!text) return []
    const box = normalizeOcrBoundingBox(word, bounds)
    if (box.width <= 0 || box.height <= 0) return []
    return [{
      ...word,
      ...box,
      pageAspect: validAspect(bounds.width) && validAspect(bounds.height) ? pageHeight / pageWidth : undefined,
      points: word.points?.length === 4
        ? word.points.map((point) => ({
          x: clamp((Number.isFinite(point.x) ? point.x : 0) / pageWidth),
          y: clamp((Number.isFinite(point.y) ? point.y : 0) / pageHeight),
        })) as OcrWord['points']
        : undefined,
      text,
      confidence: clamp(Number.isFinite(word.confidence) ? word.confidence : 0),
    }]
  })
}

type Point = { x: number; y: number }
type Quad = NonNullable<OcrWord['points']>
type TextBox = OcrBoundingBox & { text: string }
type LayoutWord = TextBox & { index: number; logicalLine?: number; joinsPrevious?: LayoutWord }
type Run = { words: LayoutWord[]; l: number; r: number }
type Row = { words: LayoutWord[]; parts: Run[]; y: number; height: number; prose?: boolean }

function quadBounds(points: Quad): OcrBoundingBox {
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

const midY = (w: OcrBoundingBox) => w.y + w.height / 2
const validAspect = (v?: number): v is number => v !== undefined && Number.isFinite(v) && v > 0

/** Layout uses page widths on BOTH axes. The inverse takes grid corners, not their centres,
 * back to the source page; the same quad contract as a glyph drives the cell hit target. */
function layoutFrame(words: OcrWord[], sourceAspect?: number) {
  const stored = words[0]?.pageAspect
  const aspect = validAspect(stored) ? stored : validAspect(sourceAspect) ? sourceAspect : 1
  const angles = words.map(w => {
    const edge = w.points
    if (edge && (edge[1].x !== edge[0].x || edge[1].y !== edge[0].y)) {
      return Math.atan2((edge[1].y - edge[0].y) * aspect, edge[1].x - edge[0].x) * 180 / Math.PI
    }
    return w.rotation ?? 0
  })
  const angle = median(angles.filter(Number.isFinite))
  const offAxis = Math.abs(angle) >= .3
  const consistent = angles.filter(a => Math.abs(a - angle) < 3).length > words.length / 2
  const tilted = offAxis && consistent && (validAspect(stored) || validAspect(sourceAspect))
  const rad = tilted ? angle * Math.PI / 180 : 0, c = Math.cos(rad), s = Math.sin(rad)
  const project = ({ x, y }: Point) => ({ x: x * c + y * aspect * s, y: y * aspect * c - x * s })
  const unproject = (x: number, y: number) => ({ x: x * c - y * s, y: (x * s + y * c) / aspect })
  function sourceBounds(l: number, top: number, r: number, bottom: number): OcrBoundingBox & Pick<OcrWord, 'points'> {
    const points: Quad = [unproject(l, top), unproject(r, top), unproject(r, bottom), unproject(l, bottom)]
    return tilted ? { ...quadBounds(points), points } : { x: l, y: top / aspect, width: r - l, height: (bottom - top) / aspect }
  }
  const placed = words.map((w, index): LayoutWord => {
    let box: OcrBoundingBox = { x: w.x, y: w.y * aspect, width: w.width, height: w.height * aspect }
    if (w.points?.length === 4) {
      const quad = quadBounds(w.points.map(project) as Quad)
      if (quad.width > 0 && quad.height > 0) box = quad
    } else if (tilted) {
      // Rotating AABB corners back would inflate a long line by its skew a second time.
      const p = ocrWordSpanPlacement(w, 0, aspect), delta = p.angle * Math.PI / 180 - rad
      const cos = Math.abs(Math.cos(delta)), sin = Math.abs(Math.sin(delta))
      const width = p.width * cos + p.height * aspect * sin, height = p.width * sin + p.height * aspect * cos
      const center = project({ x: w.x + w.width / 2, y: midY(w) })
      box = { x: center.x - width / 2, y: center.y - height / 2, width, height }
    }
    return { ...box, index, text: w.text }
  })
  return { placed, sourceBounds, aspect, reliable: consistent && (!offAxis || tilted) }
}

function layoutRows(placed: LayoutWord[]): Row[] {
  const rows: Row[] = []
  for (const w of placed.sort((a,b) => midY(a) - midY(b) || a.x - b.x || a.index - b.index)) {
    const row = rows.at(-1), y = midY(w)
    if (!row || y - row.y > Math.max(w.height, row.height) * .65) {
      rows.push({ words: [w], y, height: w.height, parts: [] })
    } else {
      row.words.push(w)
      row.y += (y - row.y) / row.words.length
      row.height += (w.height - row.height) / row.words.length
    }
  }
  for (const row of rows) {
    const gap = clamp(row.height * .95, .012, .038)
    for (const w of row.words.sort((a,b) => a.x - b.x || a.index - b.index)) {
      const last = row.parts.at(-1)
      if (!last || w.x - last.r > gap) row.parts.push({ words: [w], l: w.x, r: w.x + w.width })
      else { last.words.push(w); last.r = Math.max(last.r, w.x + w.width) }
    }
    for (const part of row.parts) { foldNumericDots(part.words); joinLatinFragments(part.words) }
  }
  return rows
}

/** Stable, geometry-based reading order; the returned objects are the source words. */
export function sortOcrWordsReadingOrder(words: OcrWord[], sourceAspect?: number): OcrWord[] {
  return ocrReadingOrder(words, sourceAspect).ordered
}

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 'exam-' + 'ple' across a line wrap copies as 'exam-ple', not 'exam-\nple'. */
const HYPHEN_WRAP_EDGE = /-$/
const LOWERCASE_START = /^\p{Ll}/u

const DIGIT_END = /\p{Nd}$/u, DIGIT_START = /^\p{Nd}/u, DIGITS = /^\p{Nd}+$/u
const gapBetween = (a: OcrBoundingBox, b: OcrBoundingBox) => b.x - a.x - a.width
const numericNeighbors = (a: OcrBoundingBox, b: OcrBoundingBox) => {
  const gap = gapBetween(a, b), height = Math.max(a.height, b.height)
  return gap >= -.15 * height && gap <= .4 * height
}

/** Only fold U+FF0E with *both* adjacent digits present. This is a derived text
 * view of the same length as the original, including for partial DOM selections. */
function foldNumericDots(words: LayoutWord[]) {
  words.forEach((w, i) => {
    if (!w.text.includes('．')) return
    const prev = words[i-1], next = words[i+1]
    w.text = w.text.replace(/．/gu, (dot, at: number, text: string) => {
      const left = text.slice(0, at) || (prev && numericNeighbors(prev, w) ? prev.text : '')
      const right = text.slice(at+1) || (next && numericNeighbors(w, next) ? next.text : '')
      return DIGIT_END.test(left) && DIGIT_START.test(right) ? '.' : dot
    })
  })
}

function inlineSeparator(a: LayoutWord, b: LayoutWord) {
  if (b.joinsPrevious === a) return ''
  const gap = gapBetween(a,b)
  if (gap > 2.8 * Math.max(a.height, b.height)) return ' ' // A gutter, not a CJK word boundary.
  if (CJK_EDGE.test(a.text) && CJK_START.test(b.text) || /^[，。；：！？、,;:!?)\]】》％%．.]/u.test(b.text) || /[(\[【《￥¥$]$/u.test(a.text)) return ''
  if (/[，。；：！？、]$/u.test(a.text) && CJK_START.test(b.text)) return ''
  const mixedBoundary = CJK_EDGE.test(a.text) && /^[\p{Script=Latin}\p{Nd}]/u.test(b.text) ||
    /[\p{Script=Latin}\p{Nd}]$/u.test(a.text) && CJK_START.test(b.text)
  if (mixedBoundary && Math.abs(gap) <= .14 * Math.min(a.height,b.height)) return ''
  if (numericNeighbors(a,b) && (/\.$/u.test(a.text) && DIGIT_START.test(b.text) ||
    DIGITS.test(a.text) && DIGITS.test(b.text) && (a.text.length === 1 || b.text.length === 1 || gap <= .15 * Math.min(a.height,b.height)))) return ''
  return ' '
}

function mergeCellWords(words: LayoutWord[]) {
  return words.map((w,i) => (i ? inlineSeparator(words[i-1], w) : '') + w.text).join('')
}

function isProse(run: Run) {
  const text = mergeCellWords(run.words)
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  const words = text.match(/\p{L}+/gu) ?? []
  return cjk >= 10 || cjk >= 7 && /[，。；！？、]/u.test(text) ||
    text.length >= 14 && (words.length >= 4 || words.length >= 3 && /[.!?]$/u.test(text))
}

/** A fractional character gap alone isn't proof of a split English word. Also require
 * several visibly wider word spaces on this run. Only whitespace changes, never spelling. */
function joinLatinFragments(words: LayoutWord[]) {
  const pairs: { at: number; gap: number }[] = []
  const latin = /^[A-Za-z][A-Za-z0-9]*$/u
  for (let i = 1; i < words.length; i++) {
    const a = words[i-1], b = words[i]
    if (latin.test(a.text) && latin.test(b.text)) pairs.push({ at: i, gap: gapBetween(a,b) })
  }
  if (pairs.length < 4) return
  const space = median(pairs.map(p => p.gap))
  for (const {at,gap} of pairs) {
    const a = words[at-1], b = words[at]
    if (gap >= 0 && gap < space * .5 && gap <= .22 * Math.max(a.height,b.height) && /^[a-z]/.test(b.text) && !/^[aI]$/.test(a.text)) b.joinsPrevious = a
  }
}

/** Repeated lines of body text on *both* sides of uninterrupted white space.
 * No shared gutter, short field values, a spanning heading or an aligned header:
 * keep physical rows. No inferred lines or cells are added to the reading text. */
function readingLines(rows: Row[]): LayoutWord[][] {
  const lines: LayoutWord[][] = []
  const near = (a: Row, b: Row) => Math.abs(a.y - b.y) <= 3 * Math.max(a.height,b.height)
  const bodyRow = (row: Row) => row.parts.length <= 3 && !(row.parts.length === 1 && row.parts[0].r - row.parts[0].l > .55) && row.parts.every(isProse)
  for (let i = 0; i < rows.length;) {
    const start = i++
    if (!bodyRow(rows[start])) { lines.push(rows[start].words); continue }
    while (i < rows.length && near(rows[i-1],rows[i]) && bodyRow(rows[i])) i++
    const band = rows.slice(start,i), h = median(band.map(r => r.height))
    const columns: { l: number; r: number; runs: Run[] }[] = []
    const runs = band.flatMap(row => row.parts)
    for (const run of [...runs].sort((a,b) => a.l-b.l)) {
      const last = columns.at(-1)
      if (!last || run.l - last.r >= Math.max(.04, 1.8*h)) columns.push({ l: run.l, r: run.r, runs: [] })
      else last.r = Math.max(last.r,run.r)
    }
    if (columns.length < 2 || columns.length > 3) {
      for (const row of band) lines.push(row.words)
      continue
    }
    // A same-size heading/caption spanning the gutter is a boundary, not a third column.
    for (const run of runs) columns.find(col => run.l >= col.l && run.r <= col.r)!.runs.push(run)
    const alignedNeighbor = (row: Row | undefined, edge: Row) => row && near(row,edge) && row.parts.length === columns.length &&
      row.parts.every((p,k) => p.l < columns[k].r && p.r > columns[k].l)
    const sharedBand = columns.every(col => col.runs.length >= 2) &&
      Math.max(...columns.map(col => midY(col.runs[0].words[0]))) < Math.min(...columns.map(col => midY(col.runs.at(-1)!.words[0]))) &&
      !alignedNeighbor(rows[start-1], band[0]) && !alignedNeighbor(rows[i], band.at(-1)!)
    if (sharedBand) {
      for (const row of band) row.prose = true
      for (const col of columns) for (const run of col.runs) lines.push(run.words)
    } else for (const row of band) lines.push(row.words)
  }
  return lines
}

// Keep the public Map API used by selection subsets, plus the physical boxes for
// gap decisions. Neither the caller's array nor its source-word objects change.
class ReadingLineIndex extends Map<OcrWord, number> {
  readonly placed = new Map<OcrWord, LayoutWord>()
}

export function ocrPairSeparator(previous: OcrWord, next: OcrWord, lineIndex?: Map<OcrWord, number>): string {
  const placed = lineIndex instanceof ReadingLineIndex ? lineIndex.placed : undefined
  const first = placed?.get(previous), second = placed?.get(next)
  const [a,b] = first && second ? [first, second] : layoutFrame([previous,next]).placed
  const sameLine = first && second ? first.logicalLine === second.logicalLine
    : lineIndex ? lineIndex.has(previous) && lineIndex.get(previous) === lineIndex.get(next)
    : Math.abs(midY(a) - midY(b)) <= Math.max(a.height, b.height) * .65
  if (sameLine) return inlineSeparator(a,b)
  return midY(b) > midY(a) && b.x <= a.x + a.width && HYPHEN_WRAP_EDGE.test(a.text) && LOWERCASE_START.test(b.text) ? '' : '\n'
}

/** Separator used both for the stored full text and browser selection copying. */
export function ocrWordSeparator(previous: OcrWord, next: OcrWord): string {
  return ocrPairSeparator(previous, next)
}

export interface OcrReadingOrder {
  ordered: OcrWord[]
  /** Physical row numbers for geometry consumers. Pass the map itself to selection helpers
   * so distinct prose columns on that row remain distinct logical lines. */
  lineIndex: Map<OcrWord, number>
  /** Reading glyphs and following separator parallel to `ordered` (source objects). */
  texts: string[]
  separators: string[]
}

export function ocrReadingOrder(words: OcrWord[], sourceAspect?: number): OcrReadingOrder {
  const frame = layoutFrame(words, sourceAspect), rows = layoutRows(frame.placed)
  const lineIndex = new ReadingLineIndex(), ordered: OcrWord[] = [], texts: string[] = []
  rows.forEach((row,i) => row.words.forEach(w => lineIndex.set(words[w.index], i)))
  const lines = frame.reliable ? readingLines(rows) : rows.map(row => row.words)
  lines.forEach((line, i) => line.forEach(w => {
    const source = words[w.index]
    w.logicalLine = i; lineIndex.placed.set(source, w)
    ordered.push(source); texts.push(w.text)
  }))
  const separators = ordered.map((w,i) => i+1 < ordered.length ? ocrPairSeparator(w,ordered[i+1],lineIndex) : '')
  return { ordered, lineIndex, texts, separators }
}

/** Join already-ordered source words, including partial/non-contiguous selections. */
export function joinOcrWordsText(ordered: OcrWord[], lineIndex = ocrReadingOrder(ordered).lineIndex): string {
  const placed = lineIndex instanceof ReadingLineIndex ? lineIndex.placed : undefined
  return ordered.map((w,i) => (i ? ocrPairSeparator(ordered[i-1],w,lineIndex) : '') + (placed?.get(w)?.text ?? w.text)).join('')
}

export function buildOcrText(words: OcrWord[], sourceAspect?: number): string {
  const { texts, separators } = ocrReadingOrder(words, sourceAspect)
  return texts.map((text,i) => text + separators[i]).join('')
}

/** Map a normalized source bbox to the page after clockwise workspace rotation. */
export function rotateNormalizedOcrBox(word: OcrWord, rotation: number): OcrBoundingBox {
  const normalizedRotation = ((rotation % 360) + 360) % 360
  if (normalizedRotation === 90) {
    return { x: 1 - word.y - word.height, y: word.x, width: word.height, height: word.width }
  }
  if (normalizedRotation === 180) {
    return { x: 1 - word.x - word.width, y: 1 - word.y - word.height, width: word.width, height: word.height }
  }
  if (normalizedRotation === 270) {
    return { x: word.y, y: 1 - word.x - word.width, width: word.height, height: word.width }
  }
  return { x: word.x, y: word.y, width: word.width, height: word.height }
}

const QUARTER_POINT = {
  0: (x: number, y: number) => ({ x, y }),
  90: (x: number, y: number) => ({ x: 1 - y, y: x }),
  180: (x: number, y: number) => ({ x: 1 - x, y: 1 - y }),
  270: (x: number, y: number) => ({ x: y, y: 1 - x }),
} as const

const quarterTurnOf = (rotation: number) =>
  (((Math.round(rotation / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270

/**
 * A word mapped into display space: box becomes the (possibly quarter-turned)
 * AABB and the line angle is composed with the page rotation, so reading-order
 * grouping and separators match what the user sees on rotated pages.
 */
export function ocrDisplayWord(word: OcrWord, rotation: number): OcrWord {
  const quarter = quarterTurnOf(rotation)
  if (!quarter && !word.points) return word
  const mapPoint = QUARTER_POINT[quarter]
  const pageAspect = word.pageAspect && quarter % 180 ? 1 / word.pageAspect : word.pageAspect
  if (word.points?.length === 4) {
    const points = word.points.map(p => mapPoint(p.x,p.y)) as Quad
    return { ...word, ...quadBounds(points), points, pageAspect, rotation: (word.rotation ?? 0) + quarter }
  }
  return { ...word, ...rotateNormalizedOcrBox(word, quarter), pageAspect, rotation: (word.rotation ?? 0) + quarter }
}

/** Where one OCR line's transparent span goes (normalized page coordinates). */
export interface OcrSpanPlacement {
  /** Line origin (quad p0), the anchor for `transform-origin: left top`. */
  x: number
  y: number
  /** Line length along the reading direction (p0→p1 edge). */
  width: number
  /** Line side height, used for font size. */
  height: number
  /** CSS clockwise degrees of the p0→p1 edge, page rotation included. */
  angle: number
  /** AABB in display space, kept for highlight-annotation consumers. */
  box: OcrBoundingBox
}

/**
 * Span placement from the detection quad: exact origin, edge lengths and
 * direction — the AABB+rotate-about-corner path drifted several px on skewed
 * scans. Legacy layers persisted without quads fall back to de-rotating the
 * AABB around its centre, which still beats corner-anchored rotation.
 */
export function ocrWordSpanPlacement(word: OcrWord, rotation: number, displayAspect = 1): OcrSpanPlacement {
  const quarter = quarterTurnOf(rotation)
  const mapPoint = QUARTER_POINT[quarter]
  const aspect = Number.isFinite(displayAspect) && displayAspect > 0 ? displayAspect : 1
  if (word.points?.length === 4) {
    const mapped = word.points.map((point) => mapPoint(point.x, point.y))
    const [p0, p1, p2, p3] = mapped
    // CSS rotates in physical pixels; normalized x and y are different units.
    const width = Math.hypot(p1.x - p0.x, (p1.y - p0.y) * aspect)
    const height = (Math.hypot((p3.x - p0.x) / aspect, p3.y - p0.y) + Math.hypot((p2.x - p1.x) / aspect, p2.y - p1.y)) / 2
    if (width > 1e-6 && height > 1e-6) {
      const xs = mapped.map((point) => point.x)
      const ys = mapped.map((point) => point.y)
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return {
        x: p0.x,
        y: p0.y,
        width,
        height,
        angle: (Math.atan2((p1.y - p0.y) * aspect, p1.x - p0.x) * 180) / Math.PI,
        box: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
      }
    }
  }
  const box = rotateNormalizedOcrBox(word, quarter)
  const sourceW = quarter % 180 ? aspect : 1
  const sourceH = quarter % 180 ? 1 : aspect
  const bw = word.width * sourceW, bh = word.height * sourceH
  let deg = word.rotation ?? 0
  const theta = deg * Math.PI / 180
  const c = Math.abs(Math.cos(theta)), sn = Math.abs(Math.sin(theta)), det = c*c-sn*sn
  let w = bw, h = bh
  if (Math.abs(det) > .05 && (bw*c-bh*sn)/det > 0 && (bh*c-bw*sn)/det > 0) {
    w = (bw*c-bh*sn)/det; h = (bh*c-bw*sn)/det
  } else deg = 0 // Near 45° an AABB alone cannot recover the original side lengths.
  const rad = deg*Math.PI/180, cs=Math.cos(rad), ss=Math.sin(rad)
  const origin=mapPoint(word.x+word.width/2-(w*cs-h*ss)/(2*sourceW), word.y+word.height/2-(w*ss+h*cs)/(2*sourceH))
  return { ...origin, width:w, height:h/aspect, angle:quarter+deg, box }
}

const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered.length ? ordered[Math.floor(ordered.length / 2)] : 0
}

/** Convert a structured table to tab/newline text that pastes directly into Excel. */
export function tableToTsv(table: Pick<OcrTable, 'rows'>): string {
  return table.rows
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
    .join('\n')
}

export interface OcrTableClipboardPayload {
  tsv: string
  html: string
  tableId: string
  rowRange: [number, number]
  columnRange: [number, number]
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const rowsToHtmlTable = (rows: readonly (readonly string[])[]) =>
  `<table><tbody>${rows.map((row) => `<tr>${(row.length ? row : ['']).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`

/** Clipboard formats for copying one or more complete tables to spreadsheets. */
export function tablesClipboardPayload(tables: readonly Pick<OcrTable, 'rows'>[]) {
  const rows = tables.flatMap((table, index) => [
    ...(index ? [[]] : []),
    ...table.rows,
  ])
  return {
    tsv: tableToTsv({ rows }),
    html: rowsToHtmlTable(rows),
  }
}

/** Build spreadsheet clipboard formats for an explicit rectangular cell range. */
export function ocrTableRangeClipboard(
  table: OcrTable,
  rowRange: readonly [number, number],
  columnRange: readonly [number, number],
): OcrTableClipboardPayload | undefined {
  const rowStart = Math.max(0, Math.min(rowRange[0], rowRange[1]))
  const rowEnd = Math.min(table.rows.length - 1, Math.max(rowRange[0], rowRange[1]))
  const columnStart = Math.max(0, Math.min(columnRange[0], columnRange[1]))
  const columnEnd = Math.min(table.columnCount - 1, Math.max(columnRange[0], columnRange[1]))
  if (rowEnd < rowStart || columnEnd < columnStart) return undefined
  const rows = Array.from({ length: rowEnd - rowStart + 1 }, (_, rowOffset) =>
    Array.from({ length: columnEnd - columnStart + 1 }, (_, columnOffset) => {
      const row = rowStart + rowOffset
      const column = columnStart + columnOffset
      return table.rows[row]?.[column] ?? table.cells?.[row]?.[column]?.text ?? ''
    }))
  if (!rows.length || !rows[0]?.length) return undefined
  return {
    tsv: tableToTsv({ rows }),
    html: rowsToHtmlTable(rows),
    tableId: table.id,
    rowRange: [rowStart, rowEnd],
    columnRange: [columnStart, columnEnd],
  }
}

/**
 * Return a rectangular table fragment only when every selected OCR word belongs
 * to exactly one positioned table. Mixed/cross-table selections deliberately
 * return undefined so the browser's normal text copy remains untouched.
 */
export function ocrTableSelectionClipboard(
  tables: readonly OcrTable[],
  selectedWordIndexes: Iterable<number>,
): OcrTableClipboardPayload | undefined {
  const selected = new Set(selectedWordIndexes)
  if (!selected.size) return undefined
  const matches = tables.flatMap((table) => {
    if (!table.cells?.length) return []
    const positions: Array<{ row: number; column: number }> = []
    const tableWords = new Set<number>()
    table.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      cell.wordIndexes.forEach((index) => tableWords.add(index))
      if (cell.wordIndexes.some((index) => selected.has(index))) positions.push({ row: rowIndex, column: columnIndex })
    }))
    return positions.length ? [{ table, positions, tableWords }] : []
  })
  if (matches.length !== 1) return undefined
  const [{ table, positions, tableWords }] = matches
  if ([...selected].some((index) => !tableWords.has(index))) return undefined

  const rowStart = Math.min(...positions.map(({ row }) => row))
  const rowEnd = Math.max(...positions.map(({ row }) => row))
  const columnStart = Math.min(...positions.map(({ column }) => column))
  const columnEnd = Math.max(...positions.map(({ column }) => column))
  return ocrTableRangeClipboard(table, [rowStart, rowEnd], [columnStart, columnEnd])
}

function parseMarkdownTables(text: string): OcrTable[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const tables: OcrTable[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if (!/^\|?\s*:?-{3,}/.test(lines[index]) || !lines[index].includes('|')) continue
    const split = (line: string) => line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
    const header = split(lines[index - 1])
    const rows = [header]
    let cursor = index + 1
    while (cursor < lines.length && lines[cursor].includes('|')) rows.push(split(lines[cursor++]))
    const columnCount = Math.max(...rows.map((row) => row.length))
    if (rows.length >= 2 && columnCount >= 2) {
      tables.push({
        id: `engine-${tables.length + 1}`,
        rows: rows.map((row) => Array.from({ length: columnCount }, (_, column) => row[column] ?? '')),
        columnCount,
        confidence: 1,
        source: 'engine',
      })
    }
    index = cursor - 1
  }
  return tables
}

/**
 * Reconstruct rows and columns from aligned OCR boxes. The conservative
 * repeated-edge rule avoids turning ordinary paragraph lines into tables.
 */
export function reconstructOcrTables(words: OcrWord[], engineText = '', sourceAspect?: number): OcrTable[] {
  const engineTables = parseMarkdownTables(engineText)
  if (engineTables.length) {
    // PaddleOCR-VL supplies the better cell text, while its OCR words supply
    // the page positions needed for drag-selection. Attach positions only on
    // an unambiguous 1:1 shape match; otherwise ordinary text copy is safer.
    const geometryTables = words.length ? reconstructOcrTables(words, '', sourceAspect) : []
    if (engineTables.length === 1 && geometryTables.length === 1) {
      const engine = engineTables[0]
      const geometry = geometryTables[0]
      if (engine.rows.length === geometry.rows.length && engine.columnCount === geometry.columnCount) {
        return [{ ...engine, bounds: geometry.bounds, cells: geometry.cells }]
      }
    }
    return engineTables
  }
  if (words.length < 4 || words.length > 64_000) return []
  const frame = layoutFrame(words, sourceAspect)
  if (!frame.reliable) return [] // An arbitrary angle in the normalized square is not a grid.
  const allRows = layoutRows(frame.placed)
  const typicalHeight = median(frame.placed.map(w => w.height))
  readingLines(allRows) // Mark only confirmed body columns as ineligible for grids.
  const regions: Row[][] = []; let band: Row[] = []
  function flush() { if (band.length > 1) regions.push(band); band = [] }
  for (const row of allRows) {
    const last = band.at(-1), { parts } = row
    if (last && row.y-last.y > Math.max(.035*frame.aspect, 3*Math.max(typicalHeight, Math.min(last.height,row.height)))) flush()
    if (row.prose || parts.length > 48 || parts.length === 1 &&
        (parts[0].r-parts[0].l > .5 || isProse(parts[0]) || /[。！？.!?]$/u.test(mergeCellWords(parts[0].words)))) { flush(); continue }
    band.push(row)
  }
  flush()
  const out: OcrTable[] = []
  for (const region of regions) {
    const many = region.filter(row => row.parts.length >= 2)
    if (many.length < 2) continue
    const counts = new Map<number,number>()
    for (const row of many) counts.set(row.parts.length, 1+(counts.get(row.parts.length) ?? 0))
    const n = [...counts].sort((a,b) => b[1]-a[1] || b[0]-a[0])[0][0]
    const full = many.filter(row => row.parts.length === n)
    const cuts = Array.from({length: n-1}, (_,k) => (median(full.map(row => row.parts[k].r)) + median(full.map(row => row.parts[k+1].l))) / 2)
    if (cuts.some((v,i) => i > 0 && v <= cuts[i-1])) continue
    function column(part: Run) {
      let k = 0
      while (k < cuts.length && (part.l + part.r)/2 > cuts[k]) k++
      return k
    }
    function cellsFor(row: Row) {
      const cells: LayoutWord[][] = Array.from({length:n}, () => [])
      for (const part of row.parts) for (const w of part.words) cells[column(part)].push(w)
      return cells
    }
    let first = region.indexOf(many[0]), end = region.indexOf(many.at(-1)!) + 1
    let rows = region.slice(first,end), grid = rows.map(cellsFor)
    const tol = Math.max(.017, typicalHeight*.9)
    const numeric = (text: string) => /^[-+￥¥$€£]?[\p{Nd},.]+[%％]?$/u.test(text) && /\p{Nd}/u.test(text)
    const anchors = Array.from({length:n}, (_,k) => {
      const cells = grid.map(row => row[k]).filter(cell => cell.length)
      const ls = cells.map(cell => cell[0].x), rs = cells.map(cell => cell.at(-1)!.x + cell.at(-1)!.width)
      const l = median(ls), r = median(rs), support = Math.max(2, Math.ceil(cells.length*.6))
      return { l: ls.filter(v => Math.abs(v-l) <= tol).length >= support ? l : NaN,
        r: rs.filter(v => Math.abs(v-r) <= tol).length >= support ? r : NaN,
        numbers: cells.filter(cell => numeric(mergeCellWords(cell))).length }
    })
    if (anchors.some(a => !Number.isFinite(a.l) && !Number.isFinite(a.r))) continue

    // A missing outside cell does not move the next row into the header. Extend an
    // established grid only on its measured pitch, at a recurrent numeric column's
    // edge. A lone left-aligned caption or page number is not itself grid evidence.
    const pitch = median(rows.slice(1).map((row,i) => row.y-rows[i].y))
    function edgeRow(row: Row | undefined, neighbor: Row, leading: boolean) {
      if (!row || row.parts.length !== 1 || Math.abs(Math.abs(row.y-neighbor.y)-pitch) > .28*pitch ||
          row.height < neighbor.height*.6 || row.height > neighbor.height*1.6) return false
      const part = row.parts[0], k = column(part), anchor = anchors[k], text = mergeCellWords(part.words)
      // Do not prepend a note to an already observed textual header.
      if (leading && !numeric(mergeCellWords(cellsFor(neighbor)[k]))) return false
      return anchor.numbers >= 2 && (numeric(text) || leading && k > 0 && text.length <= 16 && /\p{L}/u.test(text)) &&
        (Math.abs(part.l-anchor.l) <= tol/2 || Math.abs(part.r-anchor.r) <= tol/2)
    }
    while (first > 0 && edgeRow(region[first-1],region[first],true)) first--
    while (end < region.length && edgeRow(region[end],region[end-1],false)) end++
    rows = region.slice(first,end); grid = rows.map(cellsFor)
    const values = grid.map(row => row.map(mergeCellWords)), occupied = values.flat().filter(Boolean)
    const compactHeader = rows[0].parts.length === n && rows[0].parts.every(p => !isProse(p) && mergeCellWords(p.words).length <= 16)
    if (n === 2 && !compactHeader && !occupied.some(numeric) && (occupied.filter(v => v.length >= 12 && /[。！？.!?]$/u.test(v)).length >= occupied.length*.5 || median(occupied.map(v => [...v].length)) > 32)) continue

    // Place dividers in actual whitespace, never through a ragged label or a
    // right-aligned amount. Every edge below is still in the deskewed frame.
    const lefts = Array(n).fill(Infinity) as number[], rights = Array(n).fill(-Infinity) as number[]
    const tops: number[] = [], bottoms: number[] = []
    let confidence = 0, count = 0
    grid.forEach((row,i) => {
      tops.push(Infinity); bottoms.push(-Infinity)
      row.forEach((cell,k) => { for (const w of cell) {
        lefts[k] = Math.min(lefts[k],w.x); rights[k] = Math.max(rights[k],w.x+w.width)
        tops[i] = Math.min(tops[i],w.y); bottoms[i] = Math.max(bottoms[i],w.y+w.height)
        confidence += words[w.index].confidence; count++
      } })
    })
    if (lefts.some((l,k) => k > 0 && l <= rights[k-1]) || tops.some((t,i) => i > 0 && t <= bottoms[i-1])) continue
    const xs = [lefts[0], ...lefts.slice(1).map((l,i) => (l+rights[i])/2), rights[n-1]]
    const ys = [tops[0], ...tops.slice(1).map((top,i) => (top+bottoms[i])/2), bottoms.at(-1)!]
    out.push({ id: `geometry-${out.length+1}`, source: 'geometry', columnCount: n, rows: values, confidence: confidence/count,
      bounds: frame.sourceBounds(xs[0],ys[0],xs[n],ys.at(-1)!),
      cells: grid.map((row,y) => row.map((cell,x) => ({ text: values[y][x], wordIndexes: cell.map(w => w.index),
        bounds: frame.sourceBounds(xs[x],ys[y],xs[x+1],ys[y+1]) }))) })
  }
  return out
}
