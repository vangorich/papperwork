import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFDataRangeTransport } from 'pdfjs-dist'

const open = vi.hoisted(() => vi.fn())
vi.mock('pdfjs-dist', async original => ({ ...(await original<typeof import('pdfjs-dist')>()), getDocument: open }))
import { getPdfDocument, getPdfPage, inspectPdf, loadPdfPageSizes, onPdfPageSizeChange, releasePdfDocument } from './pdf'

const getPage = vi.fn(async (number: number) => ({ getViewport: () => ({ width: number % 2 ? 400 : 612, height: 792 }) }))
const doc = { numPages: 300, fingerprints: ['synthetic'], getMetadata: async () => ({ info: {} }), getPage, destroy: vi.fn() }
beforeEach(() => { open.mockReset().mockReturnValue({ promise: Promise.resolve(doc) }); getPage.mockClear() })

describe('demand-loaded PDF sources', () => {
  it('loads only requested geometry and only notifies when the estimate actually changes', async () => {
    const source = await inspectPdf(new Uint8Array(16), 'synthetic.pdf', undefined, false)
    const changed = vi.fn(), unsubscribe = onPdfPageSizeChange(source, changed)
    expect(getPage).not.toHaveBeenCalled()
    await loadPdfPageSizes(source, [0, 1, 1]); await loadPdfPageSizes(source, [0])
    await getPdfPage(source, 2) // a page already read for text/OCR refines layout too
    expect(source.pageSizes[2]).toEqual({ width: 400, height: 792 })
    expect(source.pageSizeLoaded?.[298]).toBe(false)
    expect(getPage.mock.calls.map(([p]) => p)).toEqual([1, 2, 3])
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe(); await loadPdfPageSizes(source, [4]); expect(changed).toHaveBeenCalledTimes(2)
    releasePdfDocument(source)
  })

  it('serves owned transferable ranges on first open and reopen, never detaching export bytes', async () => {
    const bytes = new Uint8Array(12 * 1024 ** 2)
    bytes[270001] = 137
    const source = await inspectPdf(bytes, 'large.pdf', undefined, false)
    expect(source.bytes === bytes).toBe(true)
    const params = open.mock.calls[0][0]
    expect(params.data).toBeUndefined()
    expect(params.disableAutoFetch).toBe(true)
    expect(params.disableStream).toBe(true)
    const range: PDFDataRangeTransport = params.range
    expect(range.length).toBe(bytes.byteLength)
    expect(range.initialData!.byteLength).toBeLessThan(bytes.byteLength)
    const chunks: Array<[number, Uint8Array]> = []
    range.addRangeListener((begin: number, chunk: Uint8Array) => chunks.push([begin, structuredClone(chunk, { transfer: [chunk.buffer] })]))
    range.requestDataRange(270000, 270004)
    expect(chunks).toHaveLength(0) // PDF.js registers its range reader after requesting the range.
    await Promise.resolve()
    expect(chunks).toEqual([[270000, new Uint8Array([0, 137, 0, 0])]])
    expect(bytes[270001]).toBe(137)
    range.requestDataRange(270000, 270004); range.abort(); await Promise.resolve()
    expect(chunks).toHaveLength(1)
    releasePdfDocument(source); await getPdfDocument(source)
    expect(open.mock.calls[1][0].range).not.toBe(range)
    expect(open.mock.calls[1][0].data).toBeUndefined()
    releasePdfDocument(source)
  })
})
