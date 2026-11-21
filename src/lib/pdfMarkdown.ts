import { Util, type PDFPageProxy } from 'pdfjs-dist'
import type { Markup, OcrTable, OcrWord, PdfSource, WorkspacePage } from '../types/pdf'
import type { Box } from './objectTransform'
import { getPdfPage, getPdfTextContent, normalizeCropSelection, releasePdfPageResources, retainPdfPageResources } from './pdf'
import { joinOcrWordsText, ocrDisplayWord, ocrReadingOrder, reconstructOcrTables, rotateNormalizedOcrBox } from './ocr'
import { reconstructNativeTextLayerTables } from './textLayerSelection'
import { glyphKey, inside, inspectMarkdownPaint, intersection, renderMarkdownFigure, wholePage, type MarkdownPaint } from './pdfMarkdownFigures'

import { matchesCapturedOcr } from './captureMarkdownSelection'
import { literalMarkdown as literal, pageHighlightFragments, scopedExcerpts, type GlyphSlices } from './markdownExcerpts'
import { knownOcrEdition } from './ocrEditionReceipt'
import type { MarkdownScope } from './markdownScopeTypes'

export interface PdfMarkdownOptions {
  scope?: MarkdownScope
  /** A tool reading one cited page needs its body, not the export's page label. */
  omitPageHeadings?: boolean
  includeImages: boolean
  /** Relative to the Markdown file. Asset names in the result are basenames. */
  assetDirectory: string
  signal?: AbortSignal
  onPage?: (n: number, total: number) => void
}
export interface PdfMarkdownResult {
  markdown: string
  assets: { name: string; bytes: Uint8Array }[]
  warnings: string[]
}

type Block = Box & { md: string; line?: boolean }
const rotate = (b: Box, q: number) => rotateNormalizedOcrBox({ ...b, text: '', confidence: 1 }, q)
const median = (values: number[]) => values.length ? values.sort((a, b) => a - b)[(values.length - 1) >> 1] : 0
const overlaps = (a: Box, b: Box) => !!intersection(a, b)
const area = (b: Box) => b.width * b.height
function envelope(boxes: readonly Box[]): Box {
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity
  for (const box of boxes) { x = Math.min(x, box.x); y = Math.min(y, box.y); r = Math.max(r, box.x + box.width); b = Math.max(b, box.y + box.height) }
  return { x, y, width: r - x, height: b - y }
}
function assetLinkDirectory(path: string) {
  const parts = path.split('/')
  if (path.length > 240 || parts.some(p => !p || p.startsWith('.') || /[. ]$|^[ ]|[\\:%<>"|?*\u0000-\u001f\u007f]/u.test(p)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(p))) throw new Error('插图目录必须是安全的相对路径')
  return parts.map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join('/')
}
function tableMarkdown(rows: string[][]) {
  const n = Math.max(0, ...rows.map(row => row.length))
  if (rows.length > 2048 || n > 64 || rows.length * n > 32_768) throw new Error('单个表格超出 Markdown 排版上限')
  if (n < 2 || rows.length < 2) return ''
  const line = (cells: string[]) => `| ${Array.from({ length: n }, (_, i) => cells[i] ?? '').join(' | ')} |`
  return [line(rows[0].map(literal)), line(Array<string>(n).fill('---')), ...rows.slice(1).map(row => line(row.map(literal)))].join('\n')
}
function boundsOfMarkup(a: Markup, w: number, h: number) {
  const angle = (a.rotation ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle))
  const width = a.width * c + a.height * h / w * s, height = a.height * c + a.width * w / h * s
  return { x: a.x + (a.width - width) / 2, y: a.y + (a.height - height) / 2, width, height }
}

function nativeWords(content: Awaited<ReturnType<typeof getPdfTextContent>>, page: PDFPageProxy, paint: MarkdownPaint, crop: Box, warn: (s: string) => void, slices?: GlyphSlices) {
  const v = page.getViewport({ scale: 1, rotation: 0 })
  const items = content.items.filter(item => 'str' in item && !!item.str.trim())
  if (items.length > 8_000 || items.reduce((n, i) => n + ('str' in i ? i.str.length : 0), 0) > 1_000_000) throw new Error('单页文字超出 Markdown 排版上限')
  // Only align the two PDF.js streams if an item's paint state could change the answer.
  // Do not guess through a mismatch (e.g. bidi reordering in an optional-content group).
  const white = '255,255,255', backgroundColors = new Set(paint.covers.map(p => p.color).filter(Boolean))
  const guarded = !paint.text.length || paint.text.some(t => !t.clip || !inside(crop, t.clip) || t.color === white || backgroundColors.has(t.color))
    || paint.covers.some(c => c.op > (paint.text[0]?.op ?? Infinity))
  const aligned = (guarded || slices) && paint.text.map(t => t.key).join('') === items.map(i => 'str' in i ? glyphKey(i.str) : '').join('')
  if (guarded && ((items.length + paint.text.length) * paint.covers.length > 8_000_000 || !aligned)) {
    warn('无法可靠区分部分原生文字的可见性，已略过本页原生文字。'); return []
  }
  const words: OcrWord[] = []
  let offset = 0, cursor = 0
  for (const item of items) {
    if (!('str' in item)) continue
    const style = content.styles[item.fontName], t = Util.transform(v.transform, item.transform)
    const angle = Math.atan2(t[1], t[0]) + (style?.vertical ? Math.PI / 2 : 0), c = Math.cos(angle), s = Math.sin(angle)
    const em = Math.hypot(t[2], t[3]), advance = Math.abs(style?.vertical ? item.height : item.width) * page.userUnit
    const asc = Math.max(0, Number.isFinite(style?.ascent) ? style.ascent : .8), desc = Math.min(0, Number.isFinite(style?.descent) ? style.descent : -.2)
    const upX = style?.vertical ? s * em : t[2], upY = style?.vertical ? -c * em : t[3]
    const [x, y, r, b] = Util.getAxialAlignedBoundingBox([0, desc, advance, asc], [c, s, upX, upY, t[4], t[5]])
    const box = { x: x / v.width, y: y / v.height, width: (r - x) / v.width, height: (b - y) / v.height }
    let ok = inside(box, crop)
    const end = offset + glyphKey(item.str).length
    if (aligned) while (cursor < paint.text.length && paint.text[cursor].end <= offset) cursor++
    if (guarded) {
      for (let j = cursor; ok && j < paint.text.length && (j === 0 || paint.text[j - 1].end < end); j++) {
        const run = paint.text[j]
        if (!run.clip || !inside(box, run.clip)) { ok = false; break }
        let backdrop: string | undefined = white
        for (let k = paint.covers.length - 1; k >= 0; k--) {
          const cover = paint.covers[k]
          if (!overlaps(box, cover.box)) continue
          if (cover.marker === 'tint' || (cover.marker === 'multiply' && run.color === '0,0,0' && cover.op > run.op)) continue
          if (cover.op > run.op) ok = false
          backdrop = cover.color; break
        }
        if (run.color && run.color === backdrop) ok = false
      }
    }
    if (ok) {
      const w = { ...box, text: item.str.trim(), confidence: 1, rotation: angle * 180 / Math.PI }
      words.push(w)
      // Subdivide one exactly matched LTR text-show by its actual PDF glyph
      // advances. Ligatures stay indivisible. Never use an equal-width guess.
      const run = paint.text[cursor], glyphs = run?.glyphs
      if (slices && aligned && item.dir === 'ltr' && !style?.vertical && glyphs && run.end === end && (paint.text[cursor-1]?.end ?? 0) === offset && glyphs.map(g=>g.text).join('') === item.str) {
        const sum=glyphs.reduce((n,g)=>n+g.width,0)
        let pos=0
        slices.set(w,glyphs.map(g=>{
          const from=pos; pos += advance*g.width/sum
          const [left,top,right,bottom]=Util.getAxialAlignedBoundingBox([from,desc,pos,asc],[c,s,upX,upY,t[4],t[5]])
          return {text:g.text,x:left/v.width,y:top/v.height,width:(right-left)/v.width,height:(bottom-top)/v.height}
        }))
      }
    }
    offset = end
  }
  return words
}

function looksLikeProse(cells: string[]) {
  return !cells.some(t => /^[-+¥￥$€£]?[\d,.]+%?$/.test(t.trim()))
    && median(cells.map(t => t.length)) >= 14 && cells.some(t => /\s|[，。；！？]/u.test(t))
}

/** Logical lines first; a wide recurring gutter between prose runs reads down the
 * left column before the right. Tables, headings and spanning figures break a band. */
function layout(words: OcrWord[], fixed: Block[], heightPt: number, ratio: number) {
  const used = new Set<OcrWord>(), blocks = [...fixed]
  for (const table of reconstructNativeTextLayerTables(words)) {
    if (!table.bounds || !table.cells || (table.columnCount === 2 && looksLikeProse(table.rows.flat()))) continue
    blocks.push({ ...table.bounds, md: tableMarkdown(table.rows) })
    for (const row of table.cells) for (const cell of row) for (const i of cell.wordIndexes) used.add(words[i])
  }
  const rest = words.filter(w => !used.has(w)), typical = median(words.map(w => w.height))
  const reading = ocrReadingOrder(rest), lines: OcrWord[][] = []
  for (const w of reading.ordered) (lines[reading.lineIndex.get(w)!] ??= []).push(w)
  const gaps: [number, number][] = []
  for (const line of lines) {
    const emit = (part: OcrWord[]) => {
      const box = envelope(part), text = joinOcrWordsText(part, reading.lineIndex), md = literal(text)
      const heading = text.length <= 110 && (box.height >= typical * 1.38 || (lines.length === 1 && box.height * heightPt >= 21))
      blocks.push({ ...box, md: heading ? `### ${md}` : md, line: !heading })
    }
    let first = 0
    for (let i = 1; i < line.length; i++) {
      const l = line[i - 1].x + line[i - 1].width, r = line[i].x
      if (r - l > Math.max(.045, Math.min(line[i].height, line[i - 1].height) * ratio * 2)) {
        gaps.push([l, r]); emit(line.slice(first, i)); first = i
      }
    }
    emit(line.slice(first))
  }
  // ponytail: two prose columns only; don't invent a newspaper layout on weak evidence.
  let cut = 0, support = 1
  for (let i = 3; i < 22; i++) {
    const at = i / 24, votes = gaps.filter(([l, r]) => l < at && at < r).length
    if (votes > support) { cut = at; support = votes }
  }
  const byPosition = (a: Block, b: Block) => a.y - b.y || a.x - b.x
  const ordered: Block[] = [], band: Block[] = []
  const flush = () => {
    const left = band.filter(b => b.x + b.width <= cut), right = band.filter(b => b.x >= cut)
    if (left.length >= 2 && right.length >= 2 && looksLikeProse(band.map(b => b.md))) ordered.push(...left, ...right)
    else ordered.push(...band)
    band.length = 0
  }
  for (const block of blocks.sort(byPosition)) {
    if (!cut || !block.line || block.x < cut && block.x + block.width > cut) { flush(); ordered.push(block) }
    else band.push(block)
  }
  flush()
  let result = '', previous: Block | undefined
  for (const b of ordered) {
    const sameParagraph = b.line && previous?.line && b.y > previous.y && b.y - previous.y < 1.7 * Math.max(b.height, previous.height) && Math.abs(b.x - previous.x) < .035
    result += (previous ? sameParagraph ? '\n' : '\n\n' : '') + b.md; previous = b
  }
  return result
}

function checkLayerLimits(item: WorkspacePage) {
  const layer = item.ocr
  if (item.annotations.length > 2000 || (layer?.words.length ?? 0) > 8000 || (layer?.tables?.length ?? 0) > 128) throw new Error('单页对象超出 Markdown 排版上限')
  let chars = (layer?.text.length ?? 0) + item.annotations.reduce((n, a) => n + (a.type === 'text' ? a.text?.length ?? 0 : 0), 0)
  for (const w of layer?.words ?? []) chars += w.text.length
  for (const t of layer?.tables ?? []) {
    if (t.rows.length > 2048 || t.rows.some(row => row.length > 64)) throw new Error('OCR 表格超出排版上限')
    for (const row of t.rows) for (const cell of row) chars += cell.length + 1
  }
  if (chars > 2_000_000) throw new Error('单页文字超出 Markdown 排版上限')
}

/** Old engine-only tables have no box. Claim them only if every cell matches a
 * complete contiguous sequence of positioned OCR words, never by page-wide string replacement. */
function locateTable(table: OcrTable, ordered: OcrWord[]) {
  const needle = glyphKey(table.rows.flat().join('')), pieces = ordered.map(w => glyphKey(w.text)), text = pieces.join('')
  if (!needle) return
  const start = text.indexOf(needle)
  if (start < 0 || text.indexOf(needle, start + 1) >= 0) return
  const end = start + needle.length, selected: OcrWord[] = []; let pos = 0
  for (let i = 0; i < pieces.length && pos < end; i++) {
    const next = pos + pieces[i].length
    if ((pos < start && start < next) || (pos < end && end < next)) return
    if (pos >= start && next <= end) selected.push(ordered[i]); pos = next
  }
  return selected.length ? envelope(selected) : undefined
}

/** Engine text without boxes may only be used on an unobstructed, uncropped page. */
function unpositionedOcr(text: string, tables: OcrTable[]) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), out: string[] = []
  const rowKey = (v: string) => glyphKey(v.replace(/\\\|/g, '').replace(/\|/g, ''))
  if (lines.length > 8_000) throw new Error('单页 OCR 行数超出排版上限')
  if (!tables.length && /\|\s*:?-{3}/.test(text) && !lines.some(line => line.split('|', 66).length > 65)) tables = reconstructOcrTables([], text)
  const known = tables.map(t => ({ md: tableMarkdown(t.rows), keys: t.rows.map(row => rowKey(row.join(''))), used: false })).filter(t => t.md)
  for (let i = 0; i < lines.length; i++) {
    const at = rowKey(lines[i]), table = known.find(t => t.keys[0] === at && at)
    if (table) {
      let j = i + 1
      if (/^[\s|:\-]+$/.test(lines[j] ?? '') && lines[j]?.includes('---')) j++
      if (table.keys.slice(1).every((k, idx) => k === rowKey(lines[j + idx] ?? ''))) {
        out.push(table.md); table.used = true; i = j + table.keys.length - 2; continue
      }
    }
    if (lines[i].trim()) out.push(literal(lines[i]))
  }
  const plain = rowKey(text)
  // Some engines return prose and a separate structured table, others repeat
  // the same cells in plaintext. Append only tables not already represented.
  for (const t of known) if (!t.used && (!plain || !t.keys.some(k => k && plain.includes(k)))) out.push(t.md)
  return out.join('\n\n')
}

/** Offline content export. Reads the caller's page occurrences, not source pageText,
 * document metadata or every page of each source. No filesystem or desktop bridge. */
export async function makePdfMarkdown(pages: readonly WorkspacePage[], sources: readonly PdfSource[], options: PdfMarkdownOptions): Promise<PdfMarkdownResult> {
  const { signal, onPage, includeImages, scope = { kind: 'full' } } = options
  signal?.throwIfAborted()
  if (!pages.length || (scope.kind !== 'selection' && pages.length > 2500)) throw new Error('请选择 1 至 2500 页导出 Markdown')
  const directory = includeImages ? assetLinkDirectory(options.assetDirectory) : ''
  const byId = new Map(sources.map(s => [s.id, s])), sections: string[] = [], warnings = new Set<string>()
  const assets: PdfMarkdownResult['assets'] = []
  let totalChars = 0, totalBytes = 0, renders = 0
  const editionTags = new Map<PdfSource, Awaited<ReturnType<typeof knownOcrEdition>>>()
  const selected = new Map<string, import('./markdownScopeTypes').MarkdownFragment[]>()
  const work: [number, WorkspacePage][] = []
  if (scope.kind === 'selection') {
    for (const f of scope.fragments) {
      const group=selected.get(f.pageId)
      if (group) group.push(f); else selected.set(f.pageId,[f])
    }
    if (selected.size > 2500) throw new Error('请选择 1 至 2500 页导出 Markdown')
    const found=new Set<string>()
    for (const entry of pages.entries()) if (selected.has(entry[1].id)) { work.push(entry); found.add(entry[1].id) }
    if (!work.length || found.size !== selected.size) throw new Error('没有当前文档的有效选区，请重新拉选文字。')
    if (work.length > 2500) throw new Error('请选择 1 至 2500 页导出 Markdown')
  } else {
    for (const entry of pages.entries()) work.push(entry)
  }
  onPage?.(0, work.length)
  for (const [step, [i, item]] of work.entries()) {
    signal?.throwIfAborted()
    checkLayerLimits(item)
    const warn = (s: string) => { warnings.add(`第 ${i + 1} 页：${s}`) }
    const source = item.sourceId === 'blank' ? undefined : byId.get(item.sourceId)
    if (!source && item.sourceId !== 'blank') throw new Error(`第 ${i + 1} 页的来源已关闭，未导出不完整的文档`)
    const idx = item.sourcePage
    if (source) retainPdfPageResources(source, idx)
    try {
      const page = source ? await getPdfPage(source, idx) : undefined
      const turn = ((item.rotation + (page?.rotate ?? 0)) % 360 + 360) % 360
      if (![0, 90, 180, 270].includes(turn)) throw new Error('不支持的页面旋转角度')
      let fragments = scope.kind === 'full' ? undefined : scope.kind === 'selection' ? selected.get(item.id)! : await pageHighlightFragments(item,page,turn)
      if (fragments && !fragments.length) { onPage?.(step + 1, work.length); continue }
      const base = page?.getViewport({ scale: 1, rotation: 0 }) ?? item.pageSize ?? { width: 595, height: 842 }
      const displayW = turn % 180 ? base.height : base.width, displayH = turn % 180 ? base.width : base.height
      const crop = item.crop ? rotate(normalizeCropSelection(item.crop), -turn) : wholePage
      const marks = item.annotations.filter(a => (a.opacity ?? 1) > 0).map((a, z) => ({ a, z, box: rotate(boundsOfMarkup(a, displayW, displayH), -turn) }))
      const covers = marks.filter(({ a }) => ['image', 'signature', 'stamp', 'text'].includes(a.type) || a.filled || a.type === 'ink')
      const visible = (b: Box) => inside(b, crop) && !covers.some(m => overlaps(m.box, b))
      const textContent = source ? await getPdfTextContent(source, idx) : undefined
      const hasNative = textContent?.items.some(item => 'str' in item && !!item.str.trim())
      signal?.throwIfAborted()
      // A text-only export of a scan need not ask the worker to decode its image operators at all.
      if (hasNative && source && !editionTags.has(source)) editionTags.set(source, await knownOcrEdition(source.bytes))
      const slices: GlyphSlices | undefined = fragments?.some(f=>!f.text) ? new WeakMap() : undefined
      const paint = source && page && (includeImages || hasNative || fragments?.some(f=>f.nativeHighlightId)) ? await inspectMarkdownPaint(page, source, crop, includeImages, signal, {
        ocrTags: editionTags.get(source)?.get(idx) ?? [], glyphMetrics: !!slices,
      }) : undefined
      signal?.throwIfAborted()
      if (fragments?.some(f=>f.nativeHighlightId)) {
        fragments = fragments.filter(f=>!f.nativeHighlightId || paint?.confirmedMarkers.has(f.nativeHighlightId))
        if (!fragments.length) { onPage?.(step + 1, work.length); continue }
      }
      const native = hasNative && textContent && page && paint ? nativeWords(textContent, page, paint, crop, warn, slices) : []
      const ocr = (item.ocr?.words ?? []).map(w => ocrDisplayWord(w, 0)).filter(w => w.text.trim() && visible(w))
      if (native.length * ocr.length > 8_000_000) throw new Error('原生与 OCR 文字过密，无法可靠去重')
      const words = [...ocr, ...native.filter(w => visible(w) && !ocr.some(o => {
        const clip = intersection(w, o); return clip && area(clip) >= .45 * Math.min(area(w), area(o))
      }))]
      // Ignore duplicate overprinted runs, not equal strings in different cells/paragraphs.
      const seen = new Set<string>(), unique = words.filter(w => {
        const key = [w.text, ...[w.x, w.y, w.width, w.height].map(n => Math.round(n * 2000))].join('\x00')
        if (seen.has(key)) return false
        seen.add(key); return true
      })
      // In a restricted mode only emit validated excerpts and figures inside an actual region.
      const visibleMarks = marks.filter(({a,box,z})=>a.type==='text' && a.text?.trim() && inside(box,crop) && !covers.some(m=>m.z>z&&overlaps(m.box,box)))
      const snippets = fragments && scopedExcerpts(fragments, [...unique, ...visibleMarks.map(({a,box})=>({...box,text:a.text!,confidence:1}))], crop, b=>rotate(b,-turn),
        f => matchesCapturedOcr(f, item, w => visible(ocrDisplayWord(w, 0))), slices)
      const fixed: Block[] = [], tables = snippets ? [] : item.ocr?.tables ?? [], tableBoxes: Box[] = []
      const hasLoose = !snippets && !unique.length && !item.ocr?.words.length && inside(wholePage, crop) && !covers.length
        && tables.every(t => !t.bounds || visible(t.bounds))
      const loose = hasLoose ? unpositionedOcr(item.ocr?.text ?? '', tables) : ''
      let ordered: OcrWord[] | undefined
      for (const t of loose ? [] : tables) {
        const box = t.bounds ?? (ocr.length ? locateTable(t, ordered ??= ocrReadingOrder(ocr).ordered) : undefined)
        if (box && visible(box) && !tableBoxes.some(b => inside(box, b))) {
          const md = tableMarkdown(t.rows)
          if (md) { fixed.push({ ...box, md }); tableBoxes.push(box) }
        } else if (!item.ocr?.words.length && t.cells) {
          // A cropped legacy table may have cell boxes, but no word layer. Only
          // disclose completely visible cells; never substitute the whole row.
          const cells = t.rows.flatMap((row, r) => row.flatMap((text, c) => {
            const cellBox = t.cells?.[r]?.[c]?.bounds
            return cellBox && visible(cellBox) ? [{ box: cellBox, r, c, text }] : []
          }))
          if (!cells.length) continue
          const columns = [...new Set(cells.map(v => v.c))].sort((a, b) => a - b)
          const grid = new Map<number, string[]>()
          for (const v of cells) {
            const row = grid.get(v.r) ?? Array<string>(columns.length).fill(''); row[columns.indexOf(v.c)] = v.text; grid.set(v.r, row)
          }
          const md = tableMarkdown([...grid.values()]) || cells.map(v => literal(v.text)).filter(Boolean).join('  \n')
          if (md) { const part = envelope(cells.map(v => v.box)); fixed.push({ ...part, md }); tableBoxes.push(part) }
        }
      }
      const body = snippets ? [] : unique.filter(w => !tableBoxes.some(b => inside(w, b)))
      const hasSourceText = !!(body.length || fixed.length || loose)
      for (const { a, box, z } of marks) {
        if (snippets || a.type !== 'text' || !a.text?.trim() || !inside(box, crop) || covers.some(m => m.z > z && overlaps(m.box, box))) continue
        const style = a.bold && a.italic ? '***' : a.bold ? '**' : a.italic ? '*' : ''
        const md = a.text.split(/\r\n?|\n/).filter(s => s.trim()).map(s => style + literal(s) + style).join('  \n')
        fixed.push({ ...box, md })
      }
      if (includeImages && paint && page) {
        if (paint.skippedFigures || paint.figures.length > 12) warn('部分插图超过单页数量上限，已略过。')
        for (const f of paint.figures.slice(0, 12)) {
          // Omit a partially selected figure, never export its outside pixels or metadata.
          if (snippets && !snippets.regions.some(region=>inside(f.box,region))) continue
          if (marks.some(m => m.a.type!=='highlight' && overlaps(m.box, f.box)) || paint.covers.some(p => p.op > f.op && inside(f.box, p.box))) continue
          if (paint.oversizeImage || renders >= 256 || totalBytes >= 32 * 1024 ** 2) { warn('插图超过导出资源上限，已保留文字。'); break }
          if (typeof document === 'undefined') { warn('当前环境没有画布，未导出插图。'); break }
          try {
            renders++
            const bytes = await renderMarkdownFigure(page, turn, rotate(f.box, turn), f.density, signal)
            let asset = assets.find(a => a.bytes.length === bytes.length && a.bytes.every((v, k) => v === bytes[k]))
            if (!asset) {
              if (totalBytes + bytes.length > 32 * 1024 ** 2) { warn('插图总大小超过 32 MiB，已略过此图。'); continue }
              asset = { name: `figure-${String(assets.length + 1).padStart(3, '0')}.png`, bytes }; assets.push(asset); totalBytes += bytes.length
            }
            fixed.push({ ...f.box, md: `![第 ${i + 1} 页插图](${directory}/${asset.name})` })
          } catch { signal?.throwIfAborted(); warn('插图无法绘制，已保留文字。') }
        }
      }
      // Undo a dominant sideways text baseline for reading, not for cropping or figure rendering.
      // Positioned table cells also carry the page baseline: all the words may
      // already have been claimed by tables, leaving no prose to orient them.
      const baselines = body.length ? body : unique
      const q = -Math.round(median(baselines.map(w => w.rotation ?? 0)) / 90) * 90
      const oriented = body.map(w => ({ ...ocrDisplayWord(w, q), rotation: (w.rotation ?? 0) + q }))
      const h = q % 180 ? base.width : base.height, w = q % 180 ? base.height : base.width
      const formatted = layout(oriented, fixed.map(b => ({ ...b, ...rotate(b, q) })), h, h / w)
      const content = snippets ? [snippets.text,formatted].filter(Boolean).join('\n\n') : formatted
      if (snippets && !content) { warn('选中区域没有可确认的可见文字或完整插图，未扩大范围。'); onPage?.(step + 1, work.length);continue }
      const notice = !snippets && !hasSourceText && source ? '当前可见区域没有可导出的文字层；可能是扫描页或空白页，未运行 OCR。' : ''
      if (notice) warn(notice)
      const section = options.omitPageHeadings ? [loose,content].filter(Boolean).join('\n\n')
        : [`## 第 ${i + 1} 页`, notice && `> ${notice}`, loose, content || (!source && !loose ? '> 空白页。' : '')].filter(Boolean).join('\n\n')
      totalChars += section.length
      if (totalChars > 16_000_000) throw new Error('Markdown 超出 1600 万字符上限，请分批导出')
      if (section) sections.push(section)
    } finally { if (source) releasePdfPageResources(source, idx, 0) }
    onPage?.(step + 1, work.length); signal?.throwIfAborted()
  }
  if (scope.kind !== 'full' && !sections.length) throw new Error(scope.kind === 'selection' ? '选区内没有可确认的可见文字；没有导出全文。' : '当前视图没有可导出的高亮内容；没有导出全文。')
  const markdown = options.omitPageHeadings ? sections.join('\n\n') : sections.join('\n\n---\n\n') + '\n'
  return { markdown, assets, warnings: [...warnings] }
}
