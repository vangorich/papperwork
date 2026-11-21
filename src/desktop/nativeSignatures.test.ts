import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { nativeInspectPdfSignatures } from './nativeSignatures'

const N = PDFName.of

describe('native desktop signature evidence (no network / Node)', () => {
  it('hashes the exact input slice and never treats absence of signatures as verified', async () => {
    const doc = await PDFDocument.create(); doc.addPage()
    const pdf = await doc.save(), storage = new Uint8Array(pdf.length + 22)
    storage.set(pdf, 11)
    const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(pdf))
    expect(await nativeInspectPdfSignatures(storage.subarray(11, 11 + pdf.length))).toMatchObject({
      documentSha256: Buffer.from(hash).toString('hex'), fileSize: pdf.length, hasSignatures: false, fullyVerified: false,
    })
  })
  it('resolves widget parent/indirect signatures in object streams without promoting them to verified', async () => {
    const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context
    const sig = ctx.register(ctx.obj({ Type: N('Sig'), Filter: N('Adobe.PPKLite'), ByteRange: [0, 12, 21, 7], Contents: PDFHexString.of('1234'), Name: PDFHexString.fromText('签发人') }))
    const field = ctx.register(ctx.obj({ FT: N('Sig'), T: PDFString.of('approval'), V: sig }))
    page.node.set(N('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: N('Annot'), Subtype: N('Widget'), Parent: field }))]))
    const result = await nativeInspectPdfSignatures(await doc.save())
    expect(result.signatures).toHaveLength(1)
    expect(result.signatures[0]).toMatchObject({ fieldName: 'approval', pageNumber: 1, signerName: '签发人',
      structure: 'valid-structure', cryptographicSignature: 'not-performed', certificateTrust: 'unknown', hasLaterIncrementalUpdates: true, contentsPresent: true, signedRevisionLength: 28 })
    expect(result.fullyVerified).toBe(false)
  })
  it('reports corrupt byte ranges and empty contents as invalid evidence', async () => {
    const doc = await PDFDocument.create(); doc.addPage()
    doc.context.register(doc.context.obj({ Type: N('DocTimeStamp'), ByteRange: [0, 50, 20, 100], Contents: PDFHexString.of('0000') }))
    const result = await nativeInspectPdfSignatures(await doc.save())
    expect(result.signatures[0]).toMatchObject({ contentsPresent: false, structure: 'invalid-structure', coversCurrentFile: false })
  })
})
