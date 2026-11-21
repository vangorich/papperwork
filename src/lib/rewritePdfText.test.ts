import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createCanvas, DOMMatrix, Path2D } from '@napi-rs/canvas'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { rewritePdfText } from './rewritePdfText'

const previousWorker = GlobalWorkerOptions.workerSrc
const standardFontDataUrl = fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url))
beforeAll(() => {
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
})
afterAll(() => { GlobalWorkerOptions.workerSrc = previousWorker })

async function readPages(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), isEvalSupported: false, stopAtErrors: true, standardFontDataUrl })
  try {
    const doc = await task.promise
    return await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => {
      const page = await doc.getPage(i + 1)
      const text = await page.getTextContent()
      return text.items.flatMap(item => 'str' in item && item.str ? [{
        str: item.str, matrix: item.transform, width: item.width,
      }] : [])
    }))
  } finally { await task.destroy() }
}

it('rewrites one native text operand on the zero-based page, without adding a text layer or moving its neighbors', async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([300, 200])
    page.drawText('Page 12', { font, x: 20, y: 130, size: 16 })
    page.drawText('Footer', { font, x: 20, y: 40, size: 12 })
  }
  const input = await doc.save(), original = input.slice()
  const before = await readPages(input)
  const after = await readPages(await rewritePdfText(input, 1, '12', '34'))
  expect(after).toEqual([before[0], [{ ...before[1][0], str: 'Page 34' }, before[1][1]]])
  expect(input).toEqual(original)
})

const name = PDFName.of
const line = 'BT /F 16 Tf 20 100 Td (OLD) Tj ET\n'
async function fixture(program: string | string[], setup?: (doc: PDFDocument, font: PDFDict) => void) {
  const doc = await PDFDocument.create(), page = doc.addPage([300, 200]), ctx = doc.context
  const font = ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })
  page.node.set(PDFName.Resources, ctx.obj({ Font: { F: ctx.register(font) } }))
  const stream = (s: string) => ctx.register(ctx.stream(s))
  page.node.set(PDFName.Contents, typeof program === 'string' ? stream(program) : ctx.register(ctx.obj(program.map(stream))))
  setup?.(doc, font)
  return doc.save()
}

it('leaves the shared /Contents array, its original stream, other streams, metadata and comment bytes alone', async () => {
  const comment = '% OLD and (OLD) Tj are only a comment: \x81\xff\n'
  const drawing = '0.75 g 0 0 30 30 re f\n0 g\n'
  const target = comment + String.raw`BT /F 16 Tf 20 100 Td (\117LD) Tj ET` + '\n'
  const input = await fixture([drawing, target], (doc, font) => {
    font.set(name('BaseFont'), name('Courier'))
    const a = doc.getPage(0), b = doc.addPage([300, 200])
    for (const key of [PDFName.Contents, PDFName.Resources]) b.node.set(key, a.node.get(key)!)
    doc.setTitle('OLD')
  })
  const out = await rewritePdfText(input, 0, 'OLD', 'NEW')
  const [first, other] = await readPages(out)
  expect(first.map(i => i.str)).toEqual(['NEW']); expect(other.map(i => i.str)).toEqual(['OLD'])
  const saved = await PDFDocument.load(out), [a, b] = saved.getPages()
  const edited = a.node.lookup(PDFName.Contents, PDFArray), original = b.node.lookup(PDFName.Contents, PDFArray)
  const content = (array: PDFArray, i: number) => Buffer.from(decodePDFRawStream(array.lookup(i, PDFRawStream)).decode()).toString('latin1')
  expect(edited.get(0)).toBe(original.get(0)); expect(edited.get(1)).not.toBe(original.get(1))
  expect(content(edited, 0)).toBe(drawing); expect(content(original, 1)).toBe(target)
  expect(content(edited, 1)).toBe(target.replace(String.raw`(\117LD)`, '<4E4557>'))
  expect(saved.getTitle()).toBe('OLD')
})

it('fits different-width glyphs to their original advance, then restores the scale before the next relative Tj', async () => {
  const input = await fixture('BT /F 12 Tf 80 Tz 20 100 Td <4 1 5 6> Tj /F 20 Tf (TAIL) Tj ET')
  const [before] = await readPages(input)
  const out = await rewritePdfText(input, 0, 'AV', 'WWW')
  const [after] = await readPages(out)
  expect(before.map(i => i.str)).toEqual(['AV', 'TAIL']); expect(after.map(i => i.str)).toEqual(['WWW', 'TAIL'])
  expect(after[0].width).toBeCloseTo(before[0].width, 6)
  expect(after[0].matrix.slice(4)).toEqual(before[0].matrix.slice(4))
  before[1].matrix.forEach((v, i) => expect(after[1].matrix[i]).toBeCloseTo(v, 6))
  expect(after[1].width).toBe(before[1].width)
  const [again] = await readPages(await rewritePdfText(out, 0, 'WWW', 'AV'))
  expect(again.map(i => i.str)).toEqual(['AV', 'TAIL'])
})

it('does not interpret replacement punctuation as PDF operators', async () => {
  const replacement = String.raw`X) Tj (Y\Z%[]<>`
  const [page] = await readPages(await rewritePdfText(await fixture(line), 0, 'OLD', replacement))
  expect(page.map(i => i.str).join('')).toBe(replacement)
})

it.each([
  ['two occurrences', line + line, 'OLD', /多处/],
  ['overlapping occurrences', line.replace('OLD', 'AAAA'), 'AAA', /多处/],
  ['split occurrence', line.replace('(OLD)', '(O) Tj (LD)'), 'OLD', /跨越/],
  ['missing', line, 'OOPS', /未找到/],
  ['hidden text', line.replace('(OLD)', '3 Tr (OLD)'), 'OLD', /隐藏/],
  ['clip', '0 0 10 10 re W n\n' + line, 'OLD', /不支持/],
  ['complex TJ even after a supported match', line + line.replace('(OLD) Tj', '[(O) -25 (LD)] TJ'), 'OLD', /不支持/],
  ['ActualText', '/Span << /ActualText (OTHER) >> BDC\n' + line + 'EMC', 'OLD', /不支持/],
  ['unbalanced text object', line.slice(0, -3), 'OLD', /完整/],
] as const)('refuses %s instead of editing the first plausible bytes', async (_, program, search, error) => {
  await expect(rewritePdfText(await fixture(program), 0, search, 'NEW')).rejects.toThrow(error)
})

it.each(['Type0', 'ToUnicode', 'Differences', 'FontDescriptor', 'Widths'] as const)('refuses an unproven font mapping or width (%s)', async kind => {
  const input = await fixture(line, (doc, font) => {
    if (kind === 'Type0') font.set(name('Subtype'), name('Type0'))
    else if (kind === 'Differences') font.set(name('Encoding'), doc.context.obj({ Differences: [79, 'A'] }))
    else font.set(name(kind), kind === 'Widths' ? doc.context.obj([200]) : doc.context.register(doc.context.obj({})))
  })
  await expect(rewritePdfText(input, 0, 'OLD', 'NEW')).rejects.toThrow(/字体|字形/)
})

it('refuses signed sources even for a nested, indirect signature on another page', async () => {
  const bytes = await fixture(line, doc => {
    const sig = doc.context.obj({ Type: 'DocTimeStamp', ByteRange: [0, 32, 128, 64] })
    doc.addPage().node.set(PDFName.Annots, doc.context.obj([doc.context.register(doc.context.obj({ Subtype: 'Widget', V: sig }))]))
  })
  await expect(rewritePdfText(bytes, 0, 'OLD', 'NEW')).rejects.toThrow(/未签名/)
})

it.each(['Image', 'Form'])('never edits an image-only page or text nested in a %s XObject', async subtype => {
  const bytes = await fixture('q 100 0 0 100 20 20 cm /X Do Q', doc => {
    const resources = doc.getPage(0).node.Resources()!, ctx = doc.context
    const x = subtype === 'Image' ? ctx.stream(Uint8Array.of(32), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })
      : ctx.stream(line, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: ctx.obj({ Font: resources.get(PDFName.Font) }) })
    resources.set(PDFName.XObject, ctx.obj({ X: ctx.register(x) }))
  })
  await expect(rewritePdfText(bytes, 0, 'OLD', 'NEW')).rejects.toThrow(/扫描页.*表单/)
})

it('refuses real AES-256 encrypted bytes before editing, even with an empty opening password', async () => {
  const { openEngine } = await import('virtual:paperwork-qpdf')
  const engine = await openEngine(await readFile(createRequire(import.meta.url).resolve('qpdf-run/qpdf.wasm')))
  const input = await fixture(line)
  const { locked } = engine.run({ input }, ['--object-streams=disable', '--encrypt', '', 'fixture-owner', '256', '--', 'input', 'locked'], ['locked'])
  await expect(rewritePdfText(locked, 0, 'OLD', 'NEW')).rejects.toThrow(/已加密/)
})

it('renders exactly like an independently authored replacement over the original colored vector background', async () => {
  async function pixels(data: Uint8Array) {
    const task = getDocument({ data, standardFontDataUrl, disableFontFace: true, useSystemFonts: false, isEvalSupported: false })
    try {
      const pdf = await task.promise, page = await pdf.getPage(1), viewport = page.getViewport({ scale: 2 })
      const canvas = createCanvas(viewport.width, viewport.height), context = canvas.getContext('2d')
      await page.render({ viewport, canvasContext: context as unknown as CanvasRenderingContext2D }).promise
      return Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
    } finally { await task.destroy() }
  }
  vi.stubGlobal('DOMMatrix', DOMMatrix); vi.stubGlobal('Path2D', Path2D)
  try {
    const program = '0.85 0.75 0.5 rg 0 0 300 200 re f\n0 g\n' + line.replace('OLD', '112')
    const source = await fixture(program), expected = await fixture(program.replace('112', '334'))
    const actual = await pixels(await rewritePdfText(source, 0, '112', '334'))
    expect(actual.equals(await pixels(source))).toBe(false)
    expect(actual.equals(await pixels(expected))).toBe(true)
  } finally { vi.unstubAllGlobals() }
})

it.each([
  ['overpainted', line + '1 g 0 0 300 200 re f'],
  ['white on white', '1 g\n' + line],
  ['outside the crop', line.replace('20 100 Td', '-999 100 Td')],
])('refuses a painted but invisible span (%s), not just text with Tr=3', async (_, program) => {
  await expect(rewritePdfText(await fixture(program), 0, 'OLD', 'NEW')).rejects.toThrow(/不可见|可见|页外/)
})

it('does not flatten incremental revisions or repair a truncated trailer', async () => {
  const input = await fixture(line), text = Buffer.from(input).toString('latin1')
  const prev = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]
  const doc = await PDFDocument.load(input)
  const size = /\/Size\s+(\d+)/.exec(text.slice(Number(prev)))![1]
  const revision = `\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${size} /Root ${doc.context.trailerInfo.Root} /Prev ${prev} >>\nstartxref\n${input.length + 1}\n%%EOF\n`
  await expect(rewritePdfText(Buffer.concat([input, Buffer.from(revision)]), 0, 'OLD', 'NEW')).rejects.toThrow(/修订/)
  await expect(rewritePdfText(input.subarray(0, -5), 0, 'OLD', 'NEW')).rejects.toThrow(/结尾/)
})

it('provides actionable errors for unrepresentable text and invalid page indices', async () => {
  const bytes = await fixture(line)
  for (const replacement of ['中文', 'line\nbreak', '']) await expect(rewritePdfText(bytes, 0, 'OLD', replacement)).rejects.toThrow(/ASCII/)
  for (const i of [-1, 0.5, 1]) await expect(rewritePdfText(bytes, i, 'OLD', 'NEW')).rejects.toThrow(/页码/)
})
