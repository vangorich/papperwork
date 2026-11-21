import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const getDocument = vi.hoisted(() => vi.fn())
vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions: {}, PasswordResponses: {} }))
import { getPdfDocument, inspectPdf, parkImportedPdf, releasePdfDocument } from './pdf'

const worker = () => ({ numPages: 1, fingerprints: [], getMetadata: async () => ({ info: {} }), destroy: vi.fn(async () => {}) })
async function inspect() {
  const doc = worker()
  getDocument.mockReturnValueOnce({ promise: Promise.resolve(doc) })
  const source = await inspectPdf(new Uint8Array([1]), 'test.pdf', undefined, false)
  return { doc, source }
}
beforeEach(() => { vi.useFakeTimers(); getDocument.mockReset() })
afterEach(() => vi.useRealTimers())

it('destroys a failed parser or an opened document whose page tree cannot be read', async () => {
  const destroy = vi.fn(async () => {})
  getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('invalid PDF')), destroy })
  await expect(inspectPdf(new Uint8Array([1]), 'bad.pdf')).rejects.toThrow('invalid PDF')
  expect(destroy).toHaveBeenCalledOnce()

  const doc = { ...worker(), getPage: async () => { throw new Error('bad page tree') } }
  getDocument.mockReturnValueOnce({ promise: Promise.resolve(doc) })
  await expect(inspectPdf(new Uint8Array([1]), 'bad-page.pdf')).rejects.toThrow('bad page tree')
  expect(doc.destroy).toHaveBeenCalledOnce()
})

it('keeps only one inactive import and never expires the worker after the reader adopts it', async () => {
  const first = await inspect(), second = await inspect()
  parkImportedPdf(first.source)
  parkImportedPdf(second.source)
  expect(await getPdfDocument(second.source)).toBe(second.doc)
  expect(first.doc.destroy).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(second.doc.destroy).not.toHaveBeenCalled()
  expect(getDocument).toHaveBeenCalledTimes(2)
  await releasePdfDocument(second.source)
  expect(second.doc.destroy).toHaveBeenCalledOnce()
})

it('expires an unused worker, skips oversized imports and disarms a closed source before undo', async () => {
  const unused = await inspect()
  parkImportedPdf(unused.source)
  await vi.advanceTimersByTimeAsync(20_001)
  expect(unused.doc.destroy).toHaveBeenCalledOnce()

  const huge = await inspect()
  // This policy reads byteLength only; no actual 129 MiB allocation in a unit test.
  Object.defineProperty(huge.source.bytes, 'byteLength', { value: 129 * 1024 ** 2 })
  parkImportedPdf(huge.source)
  await Promise.resolve()
  expect(huge.doc.destroy).toHaveBeenCalledOnce()

  const closed = await inspect()
  parkImportedPdf(closed.source)
  await releasePdfDocument(closed.source)
  const reopened = worker()
  getDocument.mockReturnValueOnce({ promise: Promise.resolve(reopened) })
  expect(await getPdfDocument(closed.source)).toBe(reopened)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(reopened.destroy).not.toHaveBeenCalled()
  await releasePdfDocument(closed.source)
})
