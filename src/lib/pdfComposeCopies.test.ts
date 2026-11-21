import { describe, expect, it } from 'vitest'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib'
import { composePdf, pagesForSource } from './pdf'
import type { PdfSource, WorkspacePage } from '../types/pdf'

// A real PDF object graph: one bitmap, resource dictionary, content-stream array
// and annotation array shared by all pages (all four can legally be indirect).
async function sharedImageSource(count: number): Promise<PdfSource> {
  const pdf = await PDFDocument.create()
  const { context } = pdf
  const pixels = Uint8Array.from({ length: 256 * 256 * 3 }, (_, i) => i % 251)
  const tile = context.register(context.stream(pixels, {
    Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceRGB', Width: 256, Height: 256, BitsPerComponent: 8,
  }))
  const resources = context.register(context.obj({ XObject: { Tile: tile } }))
  const stream = context.register(context.stream('q 64 0 0 64 0 0 cm /Tile Do Q\n'))
  const contents = context.register(context.obj([stream]))
  const annots = context.register(context.obj([]))
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage([200 + i, 300])
    page.node.set(PDFName.Resources, resources)
    page.node.set(PDFName.Contents, contents)
    page.node.set(PDFName.Annots, annots)
  }
  return { id: 'bitmap', name: 'synthetic.pdf', bytes: await pdf.save(), pageCount: count, pageSizes: [], pageText: [], textIndexed: false }
}

const note = (id: string) => ({ id, type: 'note' as const, text: id, x: 0.2, y: 0.2, width: 0.1, height: 0.1 })

describe('composition copy boundaries', () => {
  it('does not write 24 copies of a 192 KiB bitmap when 24 pages share it', async () => {
    const source = await sharedImageSource(24)
    const bytes = await composePdf(pagesForSource(source).reverse(), [source])
    const pdf = await PDFDocument.load(bytes)
    const images = pdf.context.enumerateIndirectObjects().filter(([, obj]) =>
      obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    expect(bytes.length, `${source.bytes.length} input bytes → ${bytes.length} output bytes`).toBeLessThan(source.bytes.length * 1.2)
    expect(images).toHaveLength(1)
    expect(pdf.getPages().map(p => p.getWidth())).toEqual(Array.from({ length: 24 }, (_, i) => 223 - i))
  })

  it('keeps repeated source pages, edited shared arrays, crops and intervening pages independent', async () => {
    const source = await sharedImageSource(2)
    const [a, b] = pagesForSource(source)
    const pages: WorkspacePage[] = [
      { ...b, annotations: [note('B'), { ...note('text'), type: 'text', text: 'only-B' }] },
      { ...a, id: 'first-A', rotation: 90, crop: { x: 0, y: 0, width: 0.5, height: 1 }, annotations: [note('A1')] },
      { id: 'blank', sourceId: 'blank', sourcePage: 0, rotation: 0, annotations: [], pageSize: { width: 40, height: 60 } },
      { ...a, id: 'second-A', rotation: 270, annotations: [note('A2')] },
    ]
    const pdf = await PDFDocument.load(await composePdf(pages, [source]))
    const out = pdf.getPages()
    expect(out.map(p => [p.getWidth(), p.getRotation().angle])).toEqual([[201, 0], [200, 90], [40, 0], [200, 270]])
    expect(out[1].ref).not.toEqual(out[3].ref)
    expect(out[1].getCropBox().height).toBe(150)
    expect(out[3].getCropBox()).toEqual(out[3].getMediaBox())
    expect(out.map(p => p.node.Annots()?.asArray().map(ref =>
      pdf.context.lookup(ref, PDFDict).lookup(PDFName.of('Contents'), PDFHexString).decodeText()) ?? [])).toEqual([['B'], ['A1'], [], ['A2']])
    expect(out.map(p => p.node.lookupMaybe(PDFName.Contents, PDFArray)?.asArray().some(ref => {
      const stream = pdf.context.lookup(ref)
      return stream instanceof PDFRawStream && new TextDecoder().decode(decodePDFRawStream(stream).decode()).includes(' Tj')
    }) ?? false)).toEqual([true, false, false, false])
  })
})
