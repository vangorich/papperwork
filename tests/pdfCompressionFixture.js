// Browser-side fixture: no uploaded PDFs, OS screenshots, external fonts or network assets.
import { PDFDocument, PDFName, PDFHexString, PDFArray, PDFDict, PDFRawStream, StandardFonts, rgb } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { zlibSync } from 'fflate'
import { compressSource } from '../src/lib/pdfCompression'
GlobalWorkerOptions.workerSrc = pdfWorker
const enc = new TextEncoder(), name = PDFName.of
const W = 480, H = 640, cjk = '中文小字'
const check = (ok, message) => { if (!ok) throw Error(message) }
const count = (s, marker) => s.split(marker).length - 1
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
async function jpeg(c, quality) { const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality)); return new Uint8Array(await blob.arrayBuffer()) }

// A self-contained subset Type3 font: four native glyphs, explicit ToUnicode, visible CJK strokes.
function tinyFont(doc) {
  const ctx = doc.context, g = {}, widths = [], differences = [65]
  const strokes = [
    '100 340 530 460 re S 365 98 m 365 950 l S',
    '350 920 m 420 800 l S 60 740 m 690 740 l S 190 700 m 280 410 530 200 680 125 c S 557 700 m 510 485 380 240 70 130 c S',
    '385 920 m 385 130 l 290 120 l S 240 640 m 210 450 125 310 65 260 c S 510 640 m 600 510 665 355 710 290 c S',
    '345 940 m 415 850 l S 90 680 m 90 810 l 660 810 l 660 680 l S 175 635 m 567 635 l 365 475 l 365 130 l 255 125 l S 50 432 m 680 432 l S',
  ]
  for (let i = 0; i < 4; i++) {
    g['G' + i] = ctx.register(ctx.flateStream(enc.encode('800 0 0 0 800 1000 d1 50 w ' + strokes[i])))
    widths.push(800); differences.push('G' + i)
  }
  const map = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Bench) /Ordering (UCS) /Supplement 0 >> def /CMapName /Bench def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 4 beginbfchar\n${[...cjk].map((c, i) => `<${(65 + i).toString(16)}> <${c.charCodeAt(0).toString(16)}>`).join('\n')}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`
  return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', Name: 'TinyCJK', FontBBox: [0, 0, 800, 1000],
    FontMatrix: [.001, 0, 0, .001, 0, 0], CharProcs: g, Encoding: { Type: 'Encoding', Differences: differences },
    FirstChar: 65, LastChar: 68, Widths: widths, Resources: {}, ToUnicode: ctx.register(ctx.flateStream(enc.encode(map))) }))
}
function native(page, doc, font, cjkFont, mixed) {
  page.node.setFontDictionary(name('TinyCJK'), cjkFont)
  page.node.setFontDictionary(name('BenchLatin'), font.ref)
  const ops = ['0 g', '0 G', '0.24 w']
  const rows = mixed ? 19 : 42
  for (let i = 0; i < rows; i++) {
    const y = H - 31 - 13.4 * i
    ops.push(`BT /TinyCJK 7.3 Tf 1 0 0 1 19 ${y} Tm <41424344> Tj ET`,
      `BT /BenchLatin 7.3 Tf 1 0 0 1 49 ${y} Tm (NATIVE-${String(i + 1).padStart(2, '0')}    Table ${i + 1}     ${i * 17}.25     ${i % 3 ? 'accepted' : 'review'}    0.24 pt rule) Tj ET`,
      `19 ${y - 3} m 458 ${y - 3} l S`)
  }
  for (let x = 20; x < 450; x += 60) ops.push(`${x} ${H - 35 - rows * 13.4} m ${x} 623 l S`)
  ops.push('BT /BenchLatin 6 Tf 3 Tr 1 0 0 1 21 16 Tm (OCR-HIDDEN-721) Tj ET')
  // Real drawing operators, not white padding or random orphan bytes.
  page.node.addContentStream(doc.context.register(doc.context.stream(enc.encode(ops.join('\n')))))
}
function addImage(doc, page, data, dict, draw) {
  const ref = doc.context.register(doc.context.stream(data, { Type: 'XObject', Subtype: 'Image', ...dict }))
  page.node.setXObject(name('BenchImg'), ref)
  page.node.addContentStream(doc.context.register(doc.context.flateStream(enc.encode(`q ${draw[2]} 0 0 ${draw[3]} ${draw[0]} ${draw[1]} cm /BenchImg Do Q`))))
}
function fineScan() {
  const w = 1441, h = 1919, bytes = new Uint8Array(w * h).fill(255)
  const dot = (x, y) => { if (x >= 0 && x < w && y >= 0 && y < h) bytes[y * w + x] = 0 }
  for (let row = 0; row < 92; row++) {
    const y = row * 20 + 32
    for (let x = 48; x < w - 40; x++) dot(x, y + 12)
    for (let col = 0; col < 86; col++) {
      const x = 53 + col * 15
      for (let t = 0; t < 10; t++) { dot(x + 4, y + t); dot(x + t, y + 4); if ((row + col) % 3) dot(x + t, y + (t >> 1)); else dot(x + 8, y + t) }
    }
  }
  return { w, h, bytes }
}
function photo() {
  const w = 1920, h = 1110, c = canvas(w, h), ctx = c.getContext('2d'), im = ctx.createImageData(w, h)
  let state = 123456
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const grain = ((state >>> 25) - 64) * .18, u = x / w, v = y / h
    const ridge = .51 + .12 * Math.sin(u * 10) + .055 * Math.sin(u * 29.4) + .02 * Math.cos(u * 86.8)
    const sun = Math.exp(-((u - .34) ** 2 + (v - .28) ** 2) * 52), tex = 14 * Math.sin(47 * u + 19 * v) + 11 * Math.cos(89 * v - 23 * u)
    const sky = v < ridge
    im.data[p] = (sky ? 57 + 110 * v + 93 * sun : 32 + 125 * v + tex) + grain
    im.data[p + 1] = (sky ? 100 + 115 * v + 57 * sun : 44 + 90 * v + 1.45 * tex) + grain
    im.data[p + 2] = (sky ? 170 + 35 * v + 43 * sun : 45 + 16 * v + tex) + grain
    im.data[p + 3] = 255
  }
  ctx.putImageData(im, 0, 0); return c
}
async function fixture(kind) {
  const doc = await PDFDocument.create({ updateMetadata: false }), p = doc.addPage([W, H])
  const f = await doc.embedFont(StandardFonts.Helvetica), subset = tinyFont(doc)
  if (kind === 'scan') {
    const { w, h, bytes } = fineScan()
    addImage(doc, p, zlibSync(bytes, { level: 6 }), { Width: w, Height: h, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Filter: 'FlateDecode' }, [0, 0, W, H])
    p.node.setFontDictionary(name('BenchLatin'), f.ref)
    p.node.addContentStream(doc.context.register(doc.context.flateStream(enc.encode('BT /BenchLatin 8 Tf 3 Tr 20 20 Td (OCR-HIDDEN-721) Tj ET'))))
  } else {
    if (kind !== 'text') {
      const c = photo(), img = await doc.embedJpg(await jpeg(c, .98))
      p.drawImage(img, kind === 'photo' ? { x: 0, y: 0, width: W, height: H } : { x: 20, y: 27, width: 440, height: 255 })
      c.width = c.height = 1
    }
    if (kind !== 'photo') native(p, doc, f, subset, kind === 'mixed')
  }
  if (kind === 'text') {
    const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [15, 9, 80, 19], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFHexString.fromText('https://example.invalid/offline-no-navigation') } }))
    p.node.addAnnot(link)
    const field = doc.getForm().createTextField('Review'); field.setText('editable'); field.addToPage(p, { x: 340, y: 12, width: 108, height: 18, font: f, borderWidth: .35, textColor: rgb(.2, .2, .2) })
    const outline = doc.context.register(doc.context.obj({ Type: 'Outlines', Count: 1 })), tree = doc.context.lookup(outline, PDFDict)
    const item = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Review'), Parent: outline, Dest: [p.ref, 'Fit'] }))
    tree.set(name('First'), item); tree.set(name('Last'), item); doc.catalog.set(name('Outlines'), outline)
    p.setTrimBox(3, 4, W - 6, H - 8); p.setBleedBox(1, 2, W - 2, H - 4)
  }
  return doc.save({ useObjectStreams: false })
}
async function render(bytes, dpi, smoothing = 'high', pageNumber = 1) {
  const doc = await getDocument({ data: bytes.slice(), standardFontDataUrl: '/node_modules/pdfjs-dist/standard_fonts/',
    cMapUrl: '/node_modules/pdfjs-dist/cmaps/', cMapPacked: true, useSystemFonts: false, isEvalSupported: false }).promise
  try {
    const p = await doc.getPage(pageNumber), viewport = p.getViewport({ scale: dpi / 72 }), c = canvas(Math.round(viewport.width), Math.round(viewport.height)), ctx = c.getContext('2d', { alpha: false })
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.imageSmoothingQuality = smoothing
    await p.render({ canvasContext: ctx, viewport, annotationMode: 1, intent: 'print' }).promise
    const txt = (await p.getTextContent()).items.map(i => i.str || '').join('')
    return { c, txt, pixels: ctx.getImageData(0, 0, c.width, c.height).data }
  } finally { await doc.destroy() }
}
async function legacy(bytes, mode) {
  const balanced = mode === 'balanced', { c } = await render(bytes, balanced ? 150 : 110, balanced ? 'high' : 'medium')
  const out = await PDFDocument.create({ updateMetadata: false }), img = await out.embedJpg(await jpeg(c, balanced ? .82 : .68))
  out.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H }); c.width = c.height = 1
  return out.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false })
}
function diff(a, b, w) {
  check(a.length === b.length, 'render sizes differ')
  const luma = (s, i) => (77 * s[i] + 150 * s[i + 1] + 29 * s[i + 2]) / 256
  let sq = 0, edge = 0, ne = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) sq += (a[i + k] - b[i + k]) ** 2
    if (i >= w * 4 && (i / 4) % w) {
      const l = luma(a, i)
      if (Math.max(Math.abs(l - luma(a, i - 4)), Math.abs(l - luma(a, i - w * 4))) >= 20) { edge += Math.abs(l - luma(b, i)); ne++ }
    }
  }
  const mse = sq / (a.length / 4 * 3)
  return { psnr: mse ? +(10 * Math.log10(255 ** 2 / mse)).toFixed(2) : 'exact', edge: ne ? +(edge / ne).toFixed(3) : 0 }
}
function source(bytes) { return { bytes, id: 'bench', name: 'fixture.pdf', pageCount: 1, pageText: [], pageSizes: [], textIndexed: false } }
// The checker must follow the soft mask, not the order in which qpdf enumerates the shared JPEGs.
// Identical JPEG bytes in an unrelated fourth page are a positive control for the real lossy codec.
async function maskGroups() {
  const doc = await PDFDocument.create({ updateMetadata: false }), ctx = doc.context
  const pages = Array.from({ length: 4 }, () => doc.addPage([W, H])), photoCanvas = photo(), jpg = await jpeg(photoCanvas, .98)
  photoCanvas.width = photoCanvas.height = 1
  const image = () => ctx.register(ctx.stream(jpg, { Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Width: 1920, Height: 1110, Filter: 'DCTDecode' }))
  const form = (ops, resources, group = false) => ctx.register(ctx.flateStream(enc.encode(ops), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1],
    ...(resources && { Resources: resources }), ...(group && { Group: { S: 'Transparency', CS: 'DeviceRGB', I: true } }) }))
  const direct = image(), deep = image(), inherited = image(), ordinary = image(), indirect = o => ctx.register(ctx.obj(o))
  const inner = form('/Deep Do'), outer = form('/Inner Do', indirect({ XObject: indirect({ Inner: inner, Deep: deep }) }))
  const group = form('q .5 0 0 1 0 0 cm /Direct Do Q q .5 0 0 1 .5 0 cm /Outer Do Q', { XObject: { Direct: direct, Outer: outer } }, true)
  const state = g => ({ Type: 'ExtGState', SMask: { S: 'Luminosity', G: g } })
  const draw = (p, ops) => p.node.addContentStream(ctx.register(ctx.flateStream(enc.encode(`q ${W} 0 0 ${H} 0 0 cm ${ops} Q`))))
  const red = '/Opacity gs 1 0 0 rg 0 0 1 1 re f'
  pages[0].node.set(name('Resources'), indirect({ ExtGState: indirect({ Opacity: indirect({ SMask: indirect(state(group).SMask) }) }) })); draw(pages[0], red)
  pages[1].node.set(name('Resources'), ctx.obj({ XObject: { Direct: direct, Deep: deep } })); draw(pages[1], 'q .5 0 0 1 0 0 cm /Deep Do Q q .5 0 0 1 .5 0 cm /Direct Do Q')
  // /Resources is optional on forms. This soft-mask group uses its calling page's resources.
  pages[2].node.set(name('Resources'), ctx.obj({ ExtGState: { Opacity: state(form('/FromPage Do', undefined, true)) }, XObject: { FromPage: inherited } })); draw(pages[2], red)
  pages[3].node.setXObject(name('Control'), ordinary); draw(pages[3], '/Control Do')
  const bytes = await doc.save({ useObjectStreams: false }), original = await Promise.all([1, 2, 3].map(n => render(bytes, 144, 'high', n)))
  for (const n of [0, 2]) {
    const p = original[n].pixels; let min = 255, max = 0
    for (let i = 0; i < p.length; i += 4) { check(p[i] === 255, 'unexpected soft-mask backdrop'); min = Math.min(min, p[i+1]); max = Math.max(max, p[i+1]) }
    check(max - min > 80, `fixture page ${n+1} did not paint varying opacity`)
  }
  const rows = []
  for (const mode of ['balanced', 'strong', 'compact']) {
    const result = await compressSource(source(bytes), { mode }), copy = await PDFDocument.load(result.bytes)
    const psnr = []
    for (const n of [1, 2, 3]) { const rendered = await render(result.bytes, 144, 'high', n); psnr.push(diff(original[n-1].pixels, rendered.pixels, rendered.c.width).psnr); rendered.c.width = rendered.c.height = 1 }
    check(psnr.every(v => v === 'exact'), `${mode}: masked / page-shared / inherited image renders changed (PSNR ${psnr.join(', ')})`)
    const img = (page, key) => copy.getPage(page-1).node.Resources().lookup(name('XObject'), PDFDict).lookup(name(key), PDFRawStream)
    for (const [page, key] of [[2,'Direct'],[2,'Deep'],[3,'FromPage']]) {
      const stream = img(page,key); check(stream.contents.length === jpg.length && stream.contents.every((b,i) => b === jpg[i]), `${mode}: ${key} original DCT data changed`)
    }
    const control = img(4,'Control').contents.length
    check(control < jpg.length && result.hasGain, `${mode}: unrelated control JPEG was not compressed`)
    rows.push({ kind: 'mask', mode, rendered144dpi: psnr, protectedJpegBytes: jpg.length, controlJpegBytes: control })
  }
  for (const r of original) r.c.width = r.c.height = 1
  return rows
}
export async function bench(kind) {
  if (kind === 'mask') return maskGroups()
  const bytes = await fixture(kind), before = await crypto.subtle.digest('SHA-256', bytes), orig = await render(bytes, 216), rows = []
  for (const mode of ['lossless', 'balanced', 'strong', 'compact']) {
    const old = (mode === 'balanced' || mode === 'strong') && await legacy(bytes, mode), oldView = old && await render(old, 216)
    const result = await compressSource(source(bytes), { mode }), after = await render(result.bytes, 216)
    const m = diff(orig.pixels, after.pixels, orig.c.width), om = old && diff(orig.pixels, oldView.pixels, orig.c.width)
    check(after.txt === orig.txt, `${kind}/${mode}: selectable text changed`)
    check(!old || oldView.txt === '', 'legacy retained text unexpectedly')
    if (kind === 'text' || kind === 'scan' || mode === 'lossless') check(m.psnr === 'exact', `${kind}/${mode} expected identical pixels, got ${JSON.stringify(m)}`)
    if (kind !== 'photo' && old) check(result.bytes.length < old.length && (m.psnr === 'exact' || m.psnr > om.psnr), `${kind}/${mode}: missing size/clarity gain: ${result.bytes.length}/${old.length}, ${m.psnr}/${om.psnr}`)
    if (kind === 'text') {
      const pdf = await PDFDocument.load(result.bytes), p = pdf.getPage(0)
      check(pdf.catalog.has(name('Outlines')) && p.node.lookup(name('Annots'), PDFArray).size() === 2 && pdf.getForm().getTextField('Review').getText() === 'editable' && p.getTrimBox().x === 3 && p.getBleedBox().y === 2, 'interactive structure lost')
    }
    const out = await PDFDocument.load(result.bytes)
    const imgs = out.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(name('Subtype')) === name('Image')).map(([, o]) => `${o.dict.get(name('Width'))}x${o.dict.get(name('Height'))}${o.dict.get(name('Filter'))}`)
    rows.push({ kind, mode, before: bytes.length, legacy: old ? old.length : null, after: result.bytes.length, gain: result.hasGain,
      legacyPsnr: om ? om.psnr : null, psnr: m.psnr, legacyEdge: om ? om.edge : null, edge: m.edge,
      native: count(after.txt, 'NATIVE-'), cjk: count(after.txt, cjk), ocr: count(after.txt, 'OCR-HIDDEN-721'), imgs })
    after.c.width = after.c.height = 1; if (old) oldView.c.width = oldView.c.height = 1
  }
  check([...new Uint8Array(before)].join() === [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(), 'source mutated')
  if (kind !== 'photo') check(orig.txt.includes('OCR-HIDDEN-721') && (kind === 'scan' || orig.txt.includes(cjk)), 'fixture text missing')
  orig.c.width = orig.c.height = 1
  return rows
}
