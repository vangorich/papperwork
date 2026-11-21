import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream, degrees } from 'pdf-lib'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { composePdf, extractPdfSelection, normalizeCropSelection, compressPdf, displayBoxToPdf, excludeFromPageRange, imposePdfPages, normalizeSourceDisplayName, parsePageRanges, rasterMergePageIndices, readPdfDocumentInfo, releasePdfDocument, resolvePageRangeIds, serializePageRanges, sourceLabel } from './pdf'
import { watermarkTileBoxes } from './watermark'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import { PDF_CSS_UNITS, pdfRenderScale } from './cn'

describe('PDF operations', () => {
  it('clips crop selections and rejects invalid or empty areas', () => {
    const clipped = normalizeCropSelection({ x: -0.2, y: 0.5, width: 0.6, height: 0.8 })
    expect(clipped).toMatchObject({ x: 0, y: 0.5, height: 0.5 })
    expect(clipped.width).toBeCloseTo(0.4)
    for (const box of [
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 2, y: 0, width: 1, height: 1 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
    ]) expect(() => normalizeCropSelection(box)).toThrow()
  })

  it.each([0, 90, 180, 270])('extracts vector content within offset CropBoxes at rotation %s without changing the original', async (rotation) => {
    const input = await PDFDocument.create()
    const originalPage = input.addPage([600, 800])
    originalPage.setCropBox(40, 60, 400, 600)
    originalPage.setRotation(degrees(90))
    originalPage.drawText('VECTOR CONTENT', { x: 100, y: 200, size: 16 })
    const bytes = await input.save()
    const before = bytes.slice()
    const source: PdfSource = {
      id: 'crop-source', name: 'original.pdf', bytes, pageCount: 1,
      pageText: ['VECTOR CONTENT'], pageSizes: [{ width: 600, height: 400 }], textIndexed: true,
    }
    const selection = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }
    const item: WorkspacePage = { id: 'original', sourceId: source.id, sourcePage: 0, rotation, annotations: [] }
    const result = await PDFDocument.load(await extractPdfSelection(item, [source], selection))
    expect(result.getPageCount()).toBe(1)
    const page = result.getPage(0)
    const totalRotation = (90 + rotation) % 360
    const mapped = displayBoxToPdf(selection, 400, 600, totalRotation)
    const bounds = page.getMediaBox()
    expect(bounds.x).toBeCloseTo(40 + mapped.x)
    expect(bounds.y).toBeCloseTo(60 + mapped.y)
    expect(bounds.width).toBeCloseTo(mapped.width)
    expect(bounds.height).toBeCloseTo(mapped.height)
    expect(page.getCropBox()).toEqual(bounds)
    expect(page.getRotation().angle).toBe(totalRotation)
    const contents = page.node.lookup(PDFName.of('Contents'), PDFArray)
    const operators = Array.from({ length: contents.size() }, (_, index) =>
      new TextDecoder().decode(decodePDFRawStream(contents.lookup(index, PDFRawStream)).decode()),
    ).join('\n')
    expect(operators).toContain('BT')
    expect(operators).toContain('Tj')
    expect(page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length ?? 0).toBe(0)
    expect(source.bytes).toEqual(before)
    expect(originalPage.getCropBox()).toEqual({ x: 40, y: 60, width: 400, height: 600 })
    expect(item.crop).toBeUndefined()
  })

  it('extracts against original source geometry despite a mismatched output paper size, while retaining blank sizing', async () => {
    const input = await PDFDocument.create()
    input.addPage([400, 200]).drawText('SOURCE GEOMETRY', { x: 10, y: 100 })
    const source: PdfSource = {
      id: 'sized-source', name: 'wide.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 400, height: 200 }], textIndexed: true,
    }
    const crop = { x: 0, y: 0, width: 0.5, height: 1 }
    const item: WorkspacePage = {
      id: 'sized-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      pageSize: { width: 200, height: 600 }, annotations: [{
        id: 'highlight', type: 'highlight', x: 0.1, y: 0.2, width: 0.3, height: 0.1,
      }],
    }
    const extracted = (await PDFDocument.load(await extractPdfSelection(item, [source], crop))).getPage(0)
    expect(extracted.getMediaBox()).toEqual({ x: 0, y: 0, width: 200, height: 200 })
    const rect = extracted.node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('Rect'), PDFArray)
    const values = Array.from({ length: 4 }, (_, index) => rect.lookup(index, PDFNumber).asNumber())
    ;[40, 140, 160, 160].forEach((value, index) => expect(values[index]).toBeCloseTo(value))
    expect(item.pageSize).toEqual({ width: 200, height: 600 })
    const blank = (await PDFDocument.load(await extractPdfSelection({ ...item, sourceId: 'blank', annotations: [] }, [], crop))).getPage(0)
    expect(blank.getMediaBox()).toEqual({ x: 0, y: 0, width: 100, height: 600 })
  })

  it.each([
    { x: -100, y: 0, width: 300, height: 200 },
    { x: 200, y: 0, width: 100, height: 200 },
    { x: 300, y: 300, width: 100, height: 100 },
  ])('uses effective visible bounds for crop and annotation mapping with CropBox %j', async (cropBox) => {
    const input = await PDFDocument.create()
    const page = input.addPage([200, 200])
    page.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height)
    const source: PdfSource = {
      id: 'effective-source', name: 'bounds.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 200, height: 200 }], textIndexed: true,
    }
    const item: WorkspacePage = {
      id: 'effective-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
      annotations: [{ id: 'visible-highlight', type: 'highlight', x: 0, y: 0, width: 0.5, height: 1 }],
    }
    const result = (await PDFDocument.load(await composePdf([item], [source]))).getPage(0)
    expect(result.getCropBox()).toEqual({ x: 0, y: 0, width: 100, height: 200 })
    const rect = result.node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('Rect'), PDFArray)
    expect(Array.from({ length: 4 }, (_, index) => rect.lookup(index, PDFNumber).asNumber())).toEqual([0, 0, 100, 200])
    const extracted = (await PDFDocument.load(await extractPdfSelection(item, [source], item.crop!))).getPage(0)
    expect(extracted.getMediaBox()).toEqual({ x: 0, y: 0, width: 100, height: 200 })
  })

  it('normalizes workspace-only source display names', () => {
    expect(normalizeSourceDisplayName('  项目\u0000扫描件  ')).toBe('项目扫描件')
    expect(normalizeSourceDisplayName('x'.repeat(140))).toHaveLength(128)
    expect(sourceLabel({ name: 'original.pdf', displayName: '  审阅版  ' } as PdfSource)).toBe('审阅版')
    expect(sourceLabel({ name: 'original.pdf', displayName: '   ' } as PdfSource)).toBe('original.pdf')
  })

  it('renders at the exact CSS width and high-DPI density', () => {
    expect(144 * PDF_CSS_UNITS).toBe(192)
    expect(595.28 * PDF_CSS_UNITS).toBeCloseTo(793.71, 2)
    expect(pdfRenderScale(900, 1200, 600, 2)).toEqual({ display: 1.5, output: 2 })
    expect(pdfRenderScale(600, 800, 600, 4).output).toBe(2)
    expect(pdfRenderScale(600, 800, 600, 2, 1.25).output).toBe(1.25)
    expect(pdfRenderScale(4000, 5000, 600, 3).output).toBeLessThan(1.1)
    expect(pdfRenderScale(900, 1200, 600, 4, 4, 48_000_000, 12_288).output).toBe(4)
    expect(pdfRenderScale(900, 1200, 600, 4, 2, 14_000_000, 6144).output).toBe(2)
    expect(pdfRenderScale(6000, 8000, 600, 4, 4, 48_000_000, 12_288).output).toBe(1)
    const oversized = pdfRenderScale(12_000, 16_000, 600, 3, 3, 16_000_000, 8192)
    expect(oversized.output).toBeLessThan(1)
    expect(12_000 * 16_000 * oversized.output ** 2).toBeLessThanOrEqual(16_000_000)
    expect(Math.max(12_000, 16_000) * oversized.output).toBeLessThanOrEqual(8192)
  })
  it('parses ranges without duplicates', () => {
    expect(parsePageRanges('1-3,2,5', 5)).toEqual([0, 1, 2, 4])
    expect(parsePageRanges('4,1-2', 5)).toEqual([0, 1, 3])
    expect(() => parsePageRanges('', 5)).toThrow()
    expect(() => parsePageRanges('1-2-3', 5)).toThrow()
    expect(() => parsePageRanges('6', 5)).toThrow()
  })

  it('resolves OCR ranges against the current edited page order', () => {
    const pages = [
      { id: 'source-page-4', pageNumber: 1 },
      { id: 'source-page-2', pageNumber: 2 },
      { id: 'source-page-9', pageNumber: 3 },
    ]
    expect(resolvePageRangeIds('1,3', 3, pages)).toEqual(['source-page-4', 'source-page-9'])
    expect(resolvePageRangeIds('2-3', 3, pages)).toEqual(['source-page-2', 'source-page-9'])
    expect(() => resolvePageRangeIds('2', 3, pages.filter((page) => page.pageNumber !== 2)))
      .toThrow('第 2 页已被移除')
  })

  it('serializes ranges back to the compact string form', () => {
    expect(serializePageRanges([0, 1, 2, 4])).toBe('1-3,5')
    expect(serializePageRanges([3, 0, 1])).toBe('1-2,4')
    expect(serializePageRanges([4])).toBe('5')
    expect(serializePageRanges([])).toBe('')
    // Round-trip: parse(serialize(x)) === sorted unique x
    const pages = [0, 2, 3, 4, 7, 9, 10]
    expect(parsePageRanges(serializePageRanges(pages), 11)).toEqual(pages)
  })

  it('combines a typed range with preview exclusions', () => {
    // Blank range starts from all pages; exclusions punch holes.
    expect(excludeFromPageRange('', 5, [1, 3])).toBe('1,3,5')
    // Exclusions only remove pages that survive the typed range.
    expect(excludeFromPageRange('1-4', 6, [0, 4])).toBe('2-4')
    expect(excludeFromPageRange('2-3', 6, [])).toBe('2-3')
    // Excluding every page leaves nothing to print.
    expect(() => excludeFromPageRange('', 3, [0, 1, 2])).toThrow('没有可打印的内容')
    expect(() => excludeFromPageRange('2', 4, [1])).toThrow('没有可打印的内容')
    // Invalid typed ranges still surface their own error.
    expect(() => excludeFromPageRange('9', 4, [])).toThrow('页码超出范围')
  })

  it('maps display-space boxes back to rotated PDF coordinates', () => {
    const box = displayBoxToPdf({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, 600, 800, 90)
    expect(box.x).toBeCloseTo(120)
    expect(box.y).toBeCloseTo(80)
    expect(box.width).toBeCloseTo(60)
    expect(box.height).toBeCloseTo(240)
    expect(box.drawX).toBeCloseTo(180)
    expect(box.drawY).toBeCloseTo(80)
    expect(box.drawWidth).toBeCloseTo(240)
    expect(box.drawHeight).toBeCloseTo(60)
    expect(box.drawRotation).toBe(90)
  })

  it('collects document metadata while inspecting a PDF', async () => {
    const info = await readPdfDocumentInfo({
      getMetadata: async () => ({
        info: {
          PDFFormatVersion: '1.7', Title: ' Product manual ', Author: 'Paperwork',
          Subject: 'Document properties', Keywords: 'pdf, editor', Creator: 'Metadata test',
          Producer: 'PDF engine', CreationDate: "D:20260730123045+08'00'",
          IsLinearized: true, IsAcroFormPresent: true, IsSignaturesPresent: false,
        },
        metadata: null,
      }),
      fingerprints: ['primary-id', 'modified-id'],
    } as unknown as PDFDocumentProxy)

    expect(info).toMatchObject({
      pdfVersion: '1.7',
      title: 'Product manual',
      author: 'Paperwork',
      subject: 'Document properties',
      keywords: 'pdf, editor',
      creator: 'Metadata test',
      producer: 'PDF engine',
      encrypted: false,
      linearized: true,
      hasForms: true,
      hasSignatures: false,
      fingerprint: 'primary-id',
      modifiedFingerprint: 'modified-id',
    })
    expect(info.createdAt).toBe('2026-07-30T04:30:45.000Z')
  })

  it('losslessly compresses unfiltered streams and reports monotonic progress', async () => {
    const input = await PDFDocument.create({ updateMetadata: false })
    const page = input.addPage([200, 300])
    const raw = input.context.stream(new TextEncoder().encode('0 0 m 100 100 l S\n'.repeat(5000)))
    page.node.set(PDFName.of('Contents'), input.context.register(raw))
    const bytes = await input.save({ useObjectStreams: false })
    const source: PdfSource = {
      id: 'compression-source', name: 'large.pdf', bytes, pageCount: 1,
      pageText: [''], pageSizes: [{ width: 200, height: 300 }], textIndexed: true,
    }
    const progress: { stage: string; current: number; total: number }[] = []
    const { withCompressionWorker } = await import('../../tests/pdfCompressionWorker')
    const result = await withCompressionWorker(() => compressPdf(source, { mode: 'lossless' }, value => progress.push(value)))

    expect(result.hasGain).toBe(true)
    expect(result.bytes.byteLength).toBeLessThan(bytes.byteLength)
    expect(result.savedBytes).toBe(bytes.byteLength - result.bytes.byteLength)
    expect(result.savingsRatio).toBeCloseTo(result.savedBytes / bytes.byteLength)
    expect(progress.at(-1)?.stage).toBe('complete')
    for (const stage of new Set(progress.map((value) => value.stage))) {
      const values = progress.filter((value) => value.stage === stage)
      expect(values.every((value, index) => index === 0 || value.current >= values[index - 1].current)).toBe(true)
    }

    const compressed = await PDFDocument.load(result.bytes, { updateMetadata: false })
    expect(compressed.getPageCount()).toBe(1)
    expect(compressed.getPage(0).getSize()).toEqual({ width: 200, height: 300 })
    const contents = compressed.context.lookup(
      compressed.getPage(0).node.get(PDFName.of('Contents')),
    ) as PDFRawStream
    expect(contents.dict.lookup(PDFName.of('Filter'), PDFName).asString()).toBe('/FlateDecode')
  })

  it('rejects encrypted and signed sources and pre-aborted compression', async () => {
    const input = await PDFDocument.create({ updateMetadata: false })
    input.addPage()
    const source: PdfSource = {
      id: 'guarded-source', name: 'guarded.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 612, height: 792 }], textIndexed: true,
    }
    for (const mode of ['lossless', 'compact'] as const) await expect(compressPdf({
      ...source,
      documentInfo: { encrypted: true },
    }, { mode })).rejects.toThrow('加密 PDF')
    input.catalog.set(PDFName.of('Perms'), input.context.obj({ DocMDP: input.context.register(input.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30] })) }))
    const { withCompressionWorker } = await import('../../tests/pdfCompressionWorker')
    const signed = { ...source, bytes: await input.save() }
    await expect(withCompressionWorker(() => compressPdf(signed, { mode: 'compact' }))).rejects.toThrow('数字签名')

    const controller = new AbortController()
    controller.abort()
    await expect(compressPdf(source, { mode: 'lossless', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps soft masks and their parent images unchanged in compact compression', async () => {
    const { withCompressionWorker } = await import('../../tests/pdfCompressionWorker')
    const input = await PDFDocument.create(), page = input.addPage([64, 64]), name = PDFName.of
    const imageDict = { Type: 'XObject', Subtype: 'Image', Width: 64, Height: 64, BitsPerComponent: 8 }
    const alpha = Uint8Array.from({ length: 4096 }, (_, p) => p % 256)
    const gray = input.context.register(input.context.stream(alpha, { ...imageDict, ColorSpace: 'DeviceGray' }))
    const rgb = new Uint8Array(4096 * 3).fill(128)
    const parent = input.context.register(input.context.stream(rgb, { ...imageDict, ColorSpace: 'DeviceRGB', SMask: gray }))
    // Also reachable from /XObject: the mask itself must not be mistaken for a standalone scan.
    page.node.setXObject(name('Parent'), parent); page.node.setXObject(name('Alpha'), gray)
    page.node.set(name('Contents'), input.context.register(input.context.stream('q 64 0 0 64 0 0 cm /Parent Do Q\n')))
    const bytes = await input.save({ useObjectStreams: false })
    const source: PdfSource = { id: 'masked', name: 'mask.pdf', bytes, pageCount: 1, pageText: [], pageSizes: [], textIndexed: false }
    const result = await withCompressionWorker(() => compressPdf(source, { mode: 'compact' }))
    expect(result.hasGain).toBe(true)
    const output = await PDFDocument.load(result.bytes), xo = output.getPage(0).node.Resources()!.lookup(name('XObject'), PDFDict)
    const image = xo.lookup(name('Parent')), mask = xo.lookup(name('Alpha'))
    if (!(image instanceof PDFRawStream) || !(mask instanceof PDFRawStream)) throw new Error('Missing image or soft mask')
    expect(image.dict.get(name('SMask'))).toEqual(xo.get(name('Alpha')))
    expect(mask.dict.get(name('BitsPerComponent'))?.toString()).toBe('8')
    expect(decodePDFRawStream(mask).decode()).toEqual(alpha)
    expect(decodePDFRawStream(image).decode()).toEqual(rgb)
  })

  it('counts oversized image objects once, across aliases and pages, without counting the inclusive limits', async () => {
    const { withCompressionWorker } = await import('../../tests/pdfCompressionWorker')
    const input = await PDFDocument.create(), a = input.addPage([120, 100]), b = input.addPage([120, 100]), name = PDFName.of
    const mono = (w: number, h: number) => input.context.register(input.context.flateStream(new Uint8Array(Math.ceil(w / 8) * h),
      { Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceGray', BitsPerComponent: 1, Width: w, Height: h }))
    const big = mono(4001, 2500), long = mono(10001, 1), atBothLimits = mono(10000, 1000)
    a.node.setXObject(name('Large'), big); a.node.setXObject(name('Alias'), big); b.node.setXObject(name('Shared'), big)
    a.node.setXObject(name('Long'), long); b.node.setXObject(name('ExactLimit'), atBothLimits)
    const source: PdfSource = { id: 'limit', name: 'limits.pdf', bytes: await input.save(), pageCount: 2, pageText: [], pageSizes: [], textIndexed: false }
    const result = await withCompressionWorker(() => compressPdf(source, { mode: 'compact' }))
    expect(result.skippedLargeImages).toBe(2)
    const out = await PDFDocument.load(result.bytes), images = out.getPage(0).node.Resources()!.lookup(name('XObject'), PDFDict)
    expect(images.get(name('Large'))).toEqual(images.get(name('Alias')))
    for (const [key, ref] of [['Large', big], ['Long', long]] as const) {
      const stream = images.lookup(name(key)), original = input.context.lookup(ref)
      if (!(stream instanceof PDFRawStream) || !(original instanceof PDFRawStream)) throw Error('missing oversized image')
      expect(stream.contents).toEqual(original.contents)
    }
  })

  it.each(['balanced', 'strong', 'compact'] as const)('keeps native page geometry and vector content in %s mode', async mode => {
    const { withCompressionWorker } = await import('../../tests/pdfCompressionWorker')
    const input = await PDFDocument.create({ updateMetadata: false })
    const page = input.addPage([320, 180])
    page.setCropBox(5, 8, 300, 160)
    page.setRotation(degrees(90))
    const vector = new TextEncoder().encode('0.92 g 0 0 320 180 re f\n' + '0 0 m 1 1 l S\n'.repeat(1000))
    page.node.set(PDFName.of('Contents'), input.context.register(input.context.stream(vector)))
    const bytes = await input.save({ useObjectStreams: false }), before = bytes.slice()
    const source: PdfSource = { id: 'native', name: 'native.pdf', bytes, pageCount: 1, pageText: [''], pageSizes: [], textIndexed: false }
    const stages: string[] = []
    const result = await withCompressionWorker(() => compressPdf(source, { mode }, p => stages.push(p.stage)))
    expect(result.hasGain).toBe(true)
    expect(bytes).toEqual(before)
    expect(stages).not.toContain('rendering')
    const output = await PDFDocument.load(result.bytes), p = output.getPage(0)
    expect(p.getCropBox()).toEqual(page.getCropBox())
    expect(p.getRotation().angle).toBe(90)
    const stream = p.node.lookup(PDFName.of('Contents')) as PDFRawStream
    expect(decodePDFRawStream(stream).decode()).toEqual(vector)
    releasePdfDocument(source)
  })

  it('composes reordered and rotated pages', async () => {
    const input = await PDFDocument.create()
    input.addPage([100, 200])
    input.addPage([300, 400])
    const source: PdfSource = {
      id: 'source',
      name: 'sample.pdf',
      bytes: await input.save(),
      pageCount: 2,
      pageText: ['', ''],
      pageSizes: [{ width: 100, height: 200 }, { width: 300, height: 400 }],
      textIndexed: true,
    }
    const pages: WorkspacePage[] = [
      {
        id: '2', sourceId: 'source', sourcePage: 1, rotation: 90,
        annotations: [{
          id: 'note', type: 'note', x: 0.2, y: 0.2, width: 0.05, height: 0.05,
          text: '', author: '审阅人', createdAt: '2026-07-30T08:09:10.000Z',
          replies: [{
            id: 'reply', author: '回复人', text: '已处理',
            createdAt: '2026-07-30T09:10:11.000Z',
          }],
        }],
      },
      { id: '1', sourceId: 'source', sourcePage: 0, rotation: 0, annotations: [] },
    ]
    const result = await PDFDocument.load(await composePdf(pages, [source]))
    expect(result.getPageCount()).toBe(2)
    expect(result.getPage(0).getWidth()).toBe(300)
    expect(result.getPage(0).getRotation().angle).toBe(90)
    const annotations = result.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    expect(annotations.size()).toBe(2)
    const parentRef = annotations.get(0)
    const parent = annotations.lookup(0, PDFDict)
    const reply = annotations.lookup(1, PDFDict)
    expect(parent.lookup(PDFName.of('T'), PDFHexString).decodeText()).toBe('审阅人')
    expect(parent.lookup(PDFName.of('NM'), PDFHexString).decodeText()).toBe('note')
    expect(parent.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('')
    expect(parent.get(PDFName.of('P'))).toEqual(result.getPage(0).ref)
    expect(reply.get(PDFName.of('IRT'))).toBe(parentRef)
    expect(reply.lookup(PDFName.of('RT'), PDFName).asString()).toBe('/R')
    expect(reply.lookup(PDFName.of('T'), PDFHexString).decodeText()).toBe('回复人')
    expect(reply.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('已处理')
  })

  it('exports selected text highlights as native PDF annotations', async () => {
    const input = await PDFDocument.create()
    input.addPage([200, 300])
    const source: PdfSource = {
      id: 'highlight-source', name: 'recognized.pdf', bytes: await input.save(), pageCount: 1,
      pageText: ['recognized text'], pageSizes: [{ width: 200, height: 300 }], textIndexed: true,
    }
    const bytes = await composePdf([{
      id: 'highlight-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      annotations: [{
        id: 'selected-highlight', type: 'highlight', x: 0.1, y: 0.2, width: 0.3, height: 0.05,
        highlightGroupId: 'selection-1', color: '#f4c84a', opacity: 0.48, text: 'recognized text',
      }, {
        id: 'selected-highlight-line-2', type: 'highlight', x: 0.1, y: 0.3, width: 0.3, height: 0.05,
        highlightGroupId: 'selection-1', color: '#f4c84a', opacity: 0.48,
      }],
    }], [source])
    const output = await PDFDocument.load(bytes)
    const annots = output.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    expect(annots.size()).toBe(1)
    const highlight = annots.lookup(0, PDFDict)
    expect(highlight.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Highlight')
    expect(highlight.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('recognized text')
    const quadPoints = highlight.lookup(PDFName.of('QuadPoints'), PDFArray)
    expect(quadPoints.size()).toBe(16)
    expect(Array.from({ length: 16 }, (_, index) => quadPoints.lookup(index, PDFNumber).asNumber()))
      .toEqual([20, 240, 80, 240, 20, 225, 80, 225, 20, 210, 80, 210, 20, 195, 80, 195])
  })

  it('keeps native highlight quad orientation on a rotated recognized page', async () => {
    const input = await PDFDocument.create()
    input.addPage([200, 300])
    const source: PdfSource = {
      id: 'rotated-highlight-source', name: 'rotated-scan.pdf', bytes: await input.save(), pageCount: 1,
      pageText: ['OCR'], pageSizes: [{ width: 200, height: 300 }], textIndexed: true,
    }
    const output = await PDFDocument.load(await composePdf([{
      id: 'rotated-page', sourceId: source.id, sourcePage: 0, rotation: 90,
      annotations: [{
        id: 'rotated-highlight', type: 'highlight', x: 0.1, y: 0.2, width: 0.3, height: 0.05,
        text: 'OCR', color: '#f4c84a',
      }],
    }], [source]))
    const annots = output.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    const quadPoints = annots.lookup(0, PDFDict).lookup(PDFName.of('QuadPoints'), PDFArray)
    expect(Array.from({ length: 8 }, (_, index) => quadPoints.lookup(index, PDFNumber).asNumber()))
      .toEqual([40, 30, 40, 120, 50, 30, 50, 120])
  })

  it('exports ink, rectangle, and ellipse markups', async () => {
    const input = await PDFDocument.create()
    input.addPage([600, 800])
    const source: PdfSource = {
      id: 'drawing-source',
      name: 'drawing.pdf',
      bytes: await input.save(),
      pageCount: 1,
      pageText: [''],
      pageSizes: [{ width: 600, height: 800 }],
      textIndexed: true,
    }
    const pages: WorkspacePage[] = [{
      id: 'drawing-page',
      sourceId: source.id,
      sourcePage: 0,
      rotation: 0,
      annotations: [
        {
          id: 'ink', type: 'ink', x: 0.1, y: 0.1, width: 0.4, height: 0.2,
          color: '#ef4444', strokeWidth: 3,
          points: [{ x: 0, y: 0.5 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }],
        },
        {
          id: 'rectangle', type: 'rectangle', x: 0.2, y: 0.4, width: 0.3, height: 0.15,
          color: '#2563eb', strokeWidth: 4, filled: false,
        },
        {
          id: 'ellipse', type: 'ellipse', x: 0.55, y: 0.55, width: 0.25, height: 0.2,
          color: '#16a34a', strokeWidth: 2, filled: true,
        },
      ],
    }]

    const bytes = await composePdf(pages, [source])
    const result = await PDFDocument.load(bytes)
    expect(result.getPageCount()).toBe(1)
    // Drawing the three markups creates a non-empty content stream in addition
    // to the copied source page contents.
    expect(bytes.byteLength).toBeGreaterThan(source.bytes.byteLength)
  })

  it('marks only pages requesting a complete raster merge', () => {
    const base = { sourceId: 'source', sourcePage: 0, rotation: 0, annotations: [] }
    expect(rasterMergePageIndices([
      { ...base, id: 'normal', annotations: [{ id: 'image-1', type: 'image', x: 0, y: 0, width: 1, height: 1, imageExportMode: 'object' }] },
      { ...base, id: 'flattened', annotations: [{ id: 'image-2', type: 'image', x: 0, y: 0, width: 1, height: 1, imageExportMode: 'flatten-page' }] },
      { ...base, id: 'text', annotations: [{ id: 'text-1', type: 'text', x: 0, y: 0, width: 1, height: 1, imageExportMode: 'flatten-page' }] },
    ] satisfies WorkspacePage[])).toEqual([1])
  })

  it('writes ordinary inserted images into page content, not PDF annotations', async () => {
    const input = await PDFDocument.create()
    input.addPage([100, 100])
    const source: PdfSource = {
      id: 'image-source', name: 'image.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 100, height: 100 }], textIndexed: true,
    }
    const bytes = await composePdf([{
      id: 'image-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      annotations: [{
        id: 'inserted-image', type: 'image', x: 0.1, y: 0.1, width: 0.4, height: 0.4,
        imageExportMode: 'object',
        imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      }],
    }], [source])
    const result = await PDFDocument.load(bytes)
    expect(result.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0).toBe(0)
    expect(result.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).has(PDFName.of('XObject'))).toBe(true)
  })

  it('replaces a requested page with one complete raster image', async () => {
    GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    const { DOMMatrix, ImageData, Path2D, createCanvas } = await import('@napi-rs/canvas')
    const previous = {
      document: globalThis.document,
      DOMMatrix: globalThis.DOMMatrix,
      ImageData: globalThis.ImageData,
      Path2D: globalThis.Path2D,
    }
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const canvas = createCanvas(1, 1)
          const browserCanvas = canvas as unknown as HTMLCanvasElement
          browserCanvas.toBlob = (callback) => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }))
          return browserCanvas
        },
      },
    })
    try {
      const input = await PDFDocument.create()
      const page = input.addPage([120, 160])
      page.drawRectangle({ x: 10, y: 120, width: 80, height: 20 })
      const source: PdfSource = {
        id: 'flatten-source', name: 'flatten.pdf', bytes: await input.save(), pageCount: 1,
        pageText: [''], pageSizes: [{ width: 120, height: 160 }], textIndexed: true,
      }
      const bytes = await composePdf([{
        id: 'flatten-page', sourceId: source.id, sourcePage: 0, rotation: 0,
        annotations: [
          {
            id: 'flatten-image', type: 'image', x: 0.1, y: 0.1, width: 0.4, height: 0.4,
            imageExportMode: 'flatten-page',
            imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
          {
            id: 'kept-note', type: 'note', x: 0.8, y: 0.1, width: 0.05, height: 0.05,
            author: 'Reviewer', text: 'Keep this note', replies: [{
              id: 'kept-reply', author: 'Author', text: 'Reply', createdAt: '2026-07-30T00:00:00Z',
            }],
          },
        ],
      }], [source])
      const result = await PDFDocument.load(bytes)
      const resources = result.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict)
      expect(resources.lookup(PDFName.of('XObject'), PDFDict).keys()).toHaveLength(1)
      expect(result.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).size()).toBe(2)
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previous.document })
      Object.assign(globalThis, { DOMMatrix: previous.DOMMatrix, ImageData: previous.ImageData, Path2D: previous.Path2D })
    }
  })

  it('keeps annotations aligned to a non-zero source CropBox', async () => {
    const input = await PDFDocument.create()
    const inputPage = input.addPage([600, 800])
    inputPage.setCropBox(50, 100, 400, 500)
    const source: PdfSource = {
      id: 'crop-source', name: 'cropped.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 400, height: 500 }], textIndexed: true,
    }
    const bytes = await composePdf([{
      id: 'crop-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      annotations: [{
        id: 'crop-note', type: 'note', x: 0.1, y: 0.2, width: 0.05, height: 0.05,
        text: 'CropBox anchor', author: 'Paperwork',
      }],
    }], [source])
    const result = await PDFDocument.load(bytes)
    const annots = result.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    const rect = annots.lookup(0, PDFDict).lookup(PDFName.of('Rect'), PDFArray)
    const values = Array.from({ length: 4 }, (_, index) => rect.lookup(index, PDFNumber).asNumber())
    expect(values[0]).toBeCloseTo(90)
    expect(values[1]).toBeCloseTo(475)
  })

  it('removes a filled widget appearance so exported form text stays visible', async () => {
    const input = await PDFDocument.create()
    const page = input.addPage([600, 800])
    const field = input.getForm().createTextField('customer.name')
    field.setText('Old value')
    field.addToPage(page, { x: 90, y: 650, width: 240, height: 32 })
    const source: PdfSource = {
      id: 'form-source', name: 'form.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 600, height: 800 }], textIndexed: true,
    }
    const bytes = await composePdf([{
      id: 'form-page', sourceId: source.id, sourcePage: 0, rotation: 0,
      annotations: [{
        id: 'filled-name', type: 'text', x: 0.15, y: 0.1475, width: 0.4, height: 0.04,
        text: 'New value', fontSize: 14, formFieldName: 'customer.name', formFieldRect: [90, 650, 330, 682], autoFit: true,
      }],
    }], [source])
    const result = await PDFDocument.load(bytes)
    const annots = result.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    const names = Array.from({ length: annots?.size() ?? 0 }, (_, index) => {
      const widget = annots?.lookup(index, PDFDict)
      const parent = widget?.lookupMaybe(PDFName.of('Parent'), PDFDict)
      const raw = widget?.get(PDFName.of('T')) ?? parent?.get(PDFName.of('T'))
      return raw instanceof PDFHexString || raw instanceof PDFString ? raw.decodeText() : undefined
    })
    expect(names).not.toContain('customer.name')
  })

  it('writes user bookmarks and fits a resized source page without rasterizing it', async () => {
    const input = await PDFDocument.create()
    input.addPage([400, 200]).drawRectangle({ x: 20, y: 20, width: 100, height: 80 })
    const source: PdfSource = {
      id: 'resize-source', name: 'wide.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 400, height: 200 }], textIndexed: true,
    }
    const page: WorkspacePage = {
      id: 'resized-page', sourceId: source.id, sourcePage: 0, rotation: 0, annotations: [],
      pageSize: { width: 595.28, height: 841.89 },
    }
    const bytes = await composePdf([page], [source], {
      bookmarks: [{ title: '封面', pageId: page.id }],
    })
    const result = await PDFDocument.load(bytes)
    expect(result.getPage(0).getSize().width).toBeCloseTo(595.28)
    expect(result.getPage(0).getSize().height).toBeCloseTo(841.89)
    expect(result.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(1)
  })

  it('burns the interactive document watermark into every composed page', async () => {
    const input = await PDFDocument.create()
    input.addPage([600, 800])
    input.addPage([300, 300])
    const source: PdfSource = {
      id: 'watermark-source', name: 'plain.pdf', bytes: await input.save(), pageCount: 2,
      pageText: ['', ''], pageSizes: [{ width: 600, height: 800 }, { width: 300, height: 300 }], textIndexed: true,
    }
    const pages: WorkspacePage[] = [
      { id: 'wm-1', sourceId: 'source', sourcePage: 0, rotation: 0, annotations: [] },
      { id: 'wm-2', sourceId: 'source', sourcePage: 1, rotation: 0, annotations: [] },
    ].map((page) => ({ ...page, sourceId: source.id }))
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const tiled = { kind: 'image' as const, imageData, opacity: 0.2, rotation: -28, tiled: true, x: 0.05, y: 0.05, width: 0.2, height: 0.1, gapX: 0.1, gapY: 0.1 }

    const countDraws = (result: Awaited<ReturnType<typeof PDFDocument.load>>, pageIndex: number) => {
      const contents = result.getPage(pageIndex).node.lookup(PDFName.of('Contents'))
      const entries = contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
        : [contents]
      const text = entries
        .map((entry) => result.context.lookup(entry))
        .map((stream) => stream instanceof PDFRawStream
          ? new TextDecoder().decode(decodePDFRawStream(stream).decode())
          : '')
        .join('\n')
      return (text.match(/ Do/g) ?? []).length
    }

    const tiledResult = await PDFDocument.load(await composePdf(pages, [source], { watermark: tiled }))
    // The editor clips off-page tiles with CSS; export skips drawing them.
    const expectedTiles = watermarkTileBoxes(tiled)
      .filter((box) => box.x < 1 && box.y < 1 && box.x + box.width > 0 && box.y + box.height > 0)
      .length
    expect(expectedTiles).toBeGreaterThan(12)
    expect(countDraws(tiledResult, 0)).toBe(expectedTiles)
    // Tile geometry is normalized, so the small second page draws the same count.
    expect(countDraws(tiledResult, 1)).toBe(expectedTiles)

    const singleResult = await PDFDocument.load(await composePdf(pages, [source], {
      watermark: { ...tiled, tiled: false, x: 0.3, y: 0.45 },
    }))
    expect(countDraws(singleResult, 0)).toBe(1)
    expect(countDraws(singleResult, 1)).toBe(1)
    const mixed = await PDFDocument.load(await composePdf([pages[1], pages[0]], [source], {
      watermark: { ...tiled, tiled: false }, watermarkPageIds: new Set([pages[0].id]),
    }))
    expect([countDraws(mixed, 0), countDraws(mixed, 1)]).toEqual([0, 1])
    // The watermark is page content, not an annotation.
    expect(singleResult.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0).toBe(0)
  })

  it('imposes composed pages onto multi-up sheets', async () => {
    const input = await PDFDocument.create()
    for (let index = 0; index < 5; index += 1) input.addPage([200, 300])
    const output = await PDFDocument.load(await imposePdfPages(await input.save(), 4))
    expect(output.getPageCount()).toBe(2)
    expect(output.getPage(0).getSize().width).toBeCloseTo(595.28)
    expect(output.getPage(0).getSize().height).toBeCloseTo(841.89)
  })
})
