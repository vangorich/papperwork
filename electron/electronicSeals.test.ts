import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { ElectronicSealInventory, inspectPdfSignatures } from './electronicSeals'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

describe('electronic seal inventory', () => {
  it('stores image assets separately, deduplicates them and supports metadata changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'paperwork-seals-'))
    temporaryDirectories.push(directory)
    const inventory = new ElectronicSealInventory(directory)
    const bytes = pngHeader(320, 180)

    const created = await inventory.import({ bytes, fileName: 'company.png', name: '合同章' })
    const duplicate = await inventory.import({ bytes, fileName: 'copy.png', name: '重复章' })
    expect(duplicate.id).toBe(created.id)
    expect(created).toMatchObject({ width: 320, height: 180, trustStatus: 'not-a-digital-signature' })
    expect((await inventory.read(created.id))?.bytes).toEqual(bytes)

    expect(await inventory.update(created.id, { name: '财务专用章', notes: '仅限内部模板' }))
      .toMatchObject({ name: '财务专用章', notes: '仅限内部模板' })
    expect(await inventory.list()).toHaveLength(1)
    expect(await inventory.remove(created.id)).toBe(true)
    expect(await inventory.read(created.id)).toBeNull()
  })

  it('rejects files that only pretend to be an image', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'paperwork-seals-'))
    temporaryDirectories.push(directory)
    await expect(new ElectronicSealInventory(directory).import({ bytes: new TextEncoder().encode('not an image') }))
      .rejects.toThrow(/PNG|JPEG/)
  })
})

describe('PDF signature evidence', () => {
  it('does not label an unsigned document as verified', async () => {
    const document = await PDFDocument.create()
    document.addPage()
    const result = await inspectPdfSignatures(await document.save())
    expect(result).toMatchObject({ hasSignatures: false, fullyVerified: false, signatures: [] })
  })

  it('reports signature dictionaries and keeps trust verification explicitly unknown', async () => {
    const document = await PDFDocument.create()
    const page = document.addPage()
    const context = document.context
    const signature = context.obj({
      Type: PDFName.of('Sig'),
      Filter: PDFName.of('Adobe.PPKLite'),
      SubFilter: PDFName.of('adbe.pkcs7.detached'),
      ByteRange: [0, 10, 20, 30],
      Contents: PDFHexString.of('010203'),
      Name: PDFHexString.fromText('测试签署人'),
      Reason: PDFHexString.fromText('审批'),
      M: PDFString.of("D:20260730120000+08'00'"),
    })
    const signatureRef = context.register(signature)
    const field = context.obj({
      FT: PDFName.of('Sig'),
      T: PDFString.of('approval-signature'),
      Subtype: PDFName.of('Widget'),
      Rect: [0, 0, 100, 40],
      V: signatureRef,
    })
    const fieldRef = context.register(field)
    page.node.set(PDFName.of('Annots'), context.obj([fieldRef]))
    document.catalog.set(PDFName.of('AcroForm'), context.obj({ Fields: [fieldRef] }))

    const result = await inspectPdfSignatures(await document.save({ useObjectStreams: false }))
    expect(result.hasSignatures).toBe(true)
    expect(result.fullyVerified).toBe(false)
    expect(result.signatures[0]).toMatchObject({
      fieldName: 'approval-signature',
      pageNumber: 1,
      signerName: '测试签署人',
      reason: '审批',
      structure: 'valid-structure',
      contentsPresent: true,
      hasLaterIncrementalUpdates: true,
      cryptographicSignature: 'not-performed',
      certificateTrust: 'unknown',
      revocationStatus: 'unknown',
    })
    expect(result.signatures[0]?.warnings.join(' ')).toMatch(/CMS\/PAdES/)
  })
})
