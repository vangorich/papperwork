import { PageSizes, PDFDocument } from 'pdf-lib'
import type { MemoMessage } from '../types/outlookMail'
import { createOfdFonts, ofdFontStyle } from './ofdFont'

const [W, H] = PageSizes.A4
const MARGIN = 57, VALUE_X = MARGIN + 73, LAST_BASELINE = 71
const MAX_UNITS = 1_000_000, MAX_ENTRIES = 4096, MAX_PAGES = 256
const regular = ofdFontStyle('Microsoft YaHei', false, false, false)
const bold = ofdFontStyle('Microsoft YaHei', true, false, false)
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' })
type Glyph = ReturnType<ReturnType<typeof createOfdFonts>['glyph']>
// Match the rounded advance in the embedded font's Widths array, not a CSS estimate.
const units = (g: Glyph) => Math.round(g.advance * 1000)
const lineUnits = (line: Glyph[]) => line.reduce((n, g) => n + units(g), 0)
const fail = (reason: string): never => { throw new Error(`MSG 备忘录：${reason}`) }

function checkSize(mail: MemoMessage) {
  if (!mail || typeof mail !== 'object') fail('邮件字段无效')
  let total = 0, entries = 0
  const count = (s: string) => {
    if (typeof s !== 'string') fail('邮件字段不是文本')
    if ((total += s.length) > MAX_UNITS) fail(`邮件文本超过 ${MAX_UNITS} 个 UTF-16 单元`)
  }
  for (const s of [mail.from, mail.subject, mail.sentAt ?? '', mail.body]) count(s)
  for (const list of [mail.to, mail.cc, mail.bcc ?? [], mail.attachments]) {
    if (!Array.isArray(list)) fail('收件人或附件列表无效')
    if ((entries += list.length) > MAX_ENTRIES) fail(`地址和附件超过 ${MAX_ENTRIES} 项`)
    for (const s of list) count(s)
  }
}

const clean = (s: string) => s.replace(/\r\n|[\r\v\f\u0085\p{Zl}\p{Zp}]/gu, '\n')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ')
const field = (s: string) => clean(s).replace(/\s+/gu, ' ').trim()
function sentTime(raw = '') {
  const date = new Date(raw)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'long' }).format(date) : raw
}

async function typeset(mail: MemoMessage): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle('邮件备忘录')
  const fonts = createOfdFonts(pdf)
  const glyph = (s: string, style: string) => {
    if (s.length > 64) fail('单个组合字符超过 64 个 UTF-16 单元')
    return fonts.glyph(style, s)
  }
  const literal = (s: string, style: string) => Array.from(s, c => glyph(c, style))

  // Prefer a break after whitespace, address separators or CJK characters. A
  // single overlong word/address still wraps, without splitting a grapheme.
  function* wrap(paragraph: string, width: number, size: number): Generator<Glyph[]> {
    const limit = Math.floor(width * 1000 / size), line: Glyph[] = []
    let used = 0, breakAt = 0
    for (const { segment } of graphemes.segment(paragraph)) {
      const g = glyph(segment, regular), advance = units(g)
      while (line.length && (used + advance > limit || line.length >= 1024)) {
        yield line.splice(0, breakAt || line.length)
        used = lineUnits(line); breakAt = 0
      }
      line.push(g); used += advance
      if (/[\s/@;.,，。；、\-\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(segment)) breakAt = line.length
    }
    yield line
  }

  let page = pdf.addPage(PageSizes.A4), y = H - MARGIN - 16, ops: string[] = []
  const flush = () => {
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(ops.join('\n'))))
    ops = []
  }
  function draw(line: Glyph[], x: number, baseline: number, size: number, gray = 0.09) {
    if (!line.length) return
    ops.push(`BT ${gray} g 1 0 0 1 ${x.toFixed(3)} ${baseline.toFixed(3)} Tm`)
    // Only hex glyph codes (never mail strings) enter a content stream. Keep
    // a whole text run together so PDF.js can select/index words as words.
    for (let i = 0; i < line.length;) {
      const { font, ref } = line[i]
      let hex = ''
      do { hex += line[i++].code.asString() } while (i < line.length && line[i].font === font)
      page.node.setFontDictionary(font, ref)
      ops.push(`${font} ${size} Tf <${hex}> Tj`)
    }
    ops.push('ET')
  }
  let lastYield = performance.now()
  async function ensureLine() {
    if (y < LAST_BASELINE) {
      if (pdf.getPageCount() >= MAX_PAGES) fail(`打印页数超过 ${MAX_PAGES} 页`)
      flush(); page = pdf.addPage(PageSizes.A4); y = H - MARGIN - 10
    }
    if (performance.now() - lastYield > 24) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now()
    }
  }

  draw(literal('备忘录', bold), MARGIN, y, 21)
  y -= 12
  ops.push(`q 0.18 G 1 w ${MARGIN} ${y} m ${W - MARGIN} ${y} l S Q`)
  y -= 25
  const fields = [
    ['发件人', mail.from], ['发送时间', sentTime(mail.sentAt)], ['收件人', mail.to.join('; ')],
    ['抄送', mail.cc.join('; ')], ...(mail.bcc?.length ? [['密送', mail.bcc.join('; ')]] : []),
    ['主题', mail.subject], ...(mail.attachments.length ? [['附件', mail.attachments.join('; ')]] : []),
  ]
  for (const [label, value] of fields) {
    let first = true
    for (const line of wrap(field(value) || '—', W - MARGIN - VALUE_X, 10.5)) {
      await ensureLine()
      if (first) draw(literal(label + '：', bold), MARGIN, y, 10.5)
      draw(line, VALUE_X, y, 10.5); first = false; y -= 16
    }
    y -= 2
  }
  y -= 12
  const body = clean(mail.body).trimEnd()
  if (body) for (const paragraph of body.split('\n')) {
    for (const line of wrap(paragraph, W - 2 * MARGIN, 11)) {
      await ensureLine(); draw(line, MARGIN, y, 11); y -= 17
    }
  }
  flush()
  const pages = pdf.getPages()
  pages.forEach((p, i) => {
    page = p
    const footer = literal(`第 ${i + 1} / ${pages.length} 页`, regular)
    draw(footer, (W - lineUnits(footer) * 9 / 1000) / 2, 43, 9, 0.35); flush()
  })
  fonts.finish()
  return pdf.save()
}

/** Lay out an already parsed message locally. The shared Type 3 subsetter embeds
 * visible glyphs and their Unicode mapping, not a page image or an OCR overlay. */
export async function renderOutlookMemo(mail: MemoMessage): Promise<Uint8Array> {
  checkSize(mail)
  try { return await typeset(mail) }
  catch (err) {
    if (err instanceof Error && err.message.startsWith('OFD：')) fail(err.message.slice(4))
    throw err
  }
}
