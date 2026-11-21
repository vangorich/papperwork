import { readFileSync } from 'node:fs'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareStandalonePdfExport, saveWorkspacePdf } from './workspacePdfSave'
import { pagesForSource } from './pdf'
import type { DocumentWatermark, PdfSource } from '../types/pdf'

const desktop = { overwritePdf: vi.fn(), savePdf: vi.fn(), savePdfCopy: vi.fn() }
const confirm = vi.fn()
const compose = vi.fn(async () => new Uint8Array([1]))
async function sourceOf(init?: (pdf: PDFDocument) => void): Promise<PdfSource> {
  const pdf = await PDFDocument.create()
  pdf.addPage([150, 300])
  init?.(pdf)
  return { id: 'source', name: 'fixture.pdf', path: 'X:/synthetic/fixture.pdf', desktopGrant: 'read-revision',
    bytes: await pdf.save(), pageCount: 1, pageSizes: [], pageText: [], textIndexed: false }
}
const save = (target: PdfSource, dirty = true, saveAs = false, sources = [target]) =>
  saveWorkspacePdf({ target, dirty, saveAs, sources, suggested: target.name, compose })

beforeEach(() => {
  vi.clearAllMocks()
  confirm.mockReturnValue(true)
  desktop.savePdfCopy.mockResolvedValue('fresh-copy.pdf')
  desktop.overwritePdf.mockResolvedValue('fixture.pdf')
  vi.stubGlobal('window', { desktop, confirm })
})
afterEach(() => vi.unstubAllGlobals())

describe('PDF save decisions before writing', () => {
  it('does not even compose or display a dialog for ordinary Ctrl+S on an unchanged actual PDF', async () => {
    const source = await sourceOf()
    source.bytes = new Uint8Array(readFileSync(new URL('../../tests/fixtures/save-protected.pdf', import.meta.url)))
    expect(await save(source, false)).toBe('unchanged')
    expect(compose).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(desktop.overwritePdf).not.toHaveBeenCalled()
    expect(desktop.savePdf).not.toHaveBeenCalled()
    expect(desktop.savePdfCopy).not.toHaveBeenCalled()
  })
  it('only saves signature-bearing OFD previews as explicit new copies; cancelling writes nothing', async () => {
    const base=await sourceOf(),source:PdfSource={...base,name:'reference.ofd',originalPath:'X:/synthetic/original.ofd',path:undefined,desktopGrant:undefined,fileInfo:{extension:'OFD',size:70,ofdSignature:'unverified'}}
    confirm.mockReturnValue(false);expect(await save(source)).toBeNull();expect(confirm.mock.calls[0][0]).toContain('未验签');expect(compose).not.toHaveBeenCalled()
    confirm.mockReturnValue(true);expect(await save(source)).toBe('copy');expect(desktop.savePdfCopy).toHaveBeenCalledOnce();expect(desktop.overwritePdf).not.toHaveBeenCalled();expect(desktop.savePdf).not.toHaveBeenCalled()
  })
  it('keeps normal authorized overwrite for an edited simple PDF', async () => {
    const source = await sourceOf()
    expect(await save(source)).toBe('original')
    expect(desktop.overwritePdf).toHaveBeenCalledWith(new Uint8Array([1]), source.path, 'read-revision')
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each(['Outlines', 'Perms', 'SigFlags', 'direct-signature', 'detached-timestamp', 'Encrypt', 'unknown'])('guards %s even without native metadata', async (kind) => {
    const source = await sourceOf(pdf => {
      const { context } = pdf
      if (kind === 'Outlines' || kind === 'Perms') pdf.catalog.set(PDFName.of(kind), context.register(context.obj({})))
      if (kind === 'SigFlags') pdf.catalog.set(PDFName.of('AcroForm'), context.obj({ SigFlags: 3, Fields: [] }))
      if (kind === 'direct-signature') pdf.getPage(0).node.set(PDFName.Annots, context.obj([{ Subtype: 'Widget', FT: 'Sig', V: { ByteRange: [0, 4, 8, 4] } }]))
      if (kind === 'detached-timestamp') context.register(context.obj({ Type: 'DocTimeStamp' }))
    })
    if (kind === 'Encrypt') source.bytes = new Uint8Array(readFileSync(new URL('../../tests/fixtures/save-protected.pdf', import.meta.url)))
    if (kind === 'unknown') source.bytes = new Uint8Array([0])
    confirm.mockReturnValue(false)
    expect(await save(source)).toBeNull()
    expect(confirm.mock.calls[0][0]).toMatch(/未加密/)
    expect(confirm.mock.calls[0][0]).toMatch(/签名/)
    expect(confirm.mock.calls[0][0]).toMatch(/另存为/)
    expect(compose).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    expect(await save(source, false, true)).toBe('copy')
    expect(desktop.savePdfCopy).toHaveBeenCalledWith(new Uint8Array([1]), expect.stringMatching(/副本\.pdf$/))
    expect(desktop.overwritePdf).not.toHaveBeenCalled()
    expect(desktop.savePdf).not.toHaveBeenCalled()
  })
  it('discloses known protection on a pasted input, respects picker cancellation, and fails closed without a safe picker', async () => {
    const target = await sourceOf()
    const imported = { ...target, id: 'imported', documentInfo: { encrypted: true } }
    desktop.savePdfCopy.mockResolvedValue(null)
    expect(await save(target, true, false, [target, imported])).toBeNull()
    vi.stubGlobal('window', { desktop: { ...desktop, savePdfCopy: undefined }, confirm })
    await expect(save(target, true, false, [target, imported])).rejects.toThrow(/副本/)
    expect(desktop.overwritePdf).not.toHaveBeenCalled()
    expect(desktop.savePdf).not.toHaveBeenCalled()
  })
})

it('includes the correct workspace watermark in single, split, mixed-order and merged PDF exports', async () => {
  const source = await sourceOf()
  const [first] = pagesForSource(source)
  const other = { ...first, id: 'other', groupId: 'other' }
  const watermark: DocumentWatermark = { kind: 'image', opacity: 0.4, rotation: 0, tiled: false, x: 0.1, y: 0.2, width: 0.3, height: 0.1, gapX: 0, gapY: 0,
    imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }
  const resolve = vi.fn((id?: string) => id === 'other' ? undefined : watermark)
  const exportPages = prepareStandalonePdfExport([other, first], [source], true, resolve)
  const isMarked = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map(p => {
    const objects = p.node.Resources()?.lookupMaybe(PDFName.XObject, PDFDict)
    return Boolean(objects?.keys().length && p.node.lookupMaybe(PDFName.Contents, PDFArray)?.size())
  })
  expect(await isMarked(await exportPages([first]))).toEqual([true])
  expect(await isMarked(await exportPages([other]))).toEqual([false])
  expect(await isMarked(await exportPages())).toEqual([false, true])
  expect(resolve.mock.calls).toEqual([['other'], ['source']])
  const merged = prepareStandalonePdfExport([other, first], [source], false, resolve)
  expect(await isMarked(await merged())).toEqual([true, true])
})
