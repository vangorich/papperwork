import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib'

export type SignatureEvidenceStatus = 'valid-structure' | 'invalid-structure' | 'not-present'
export type VerificationStatus = 'verified' | 'failed' | 'unknown' | 'not-performed'

export interface EmbeddedCertificateInfo {
  subject: string
  issuer: string
  serialNumber: string
  validFrom: string
  validTo: string
  fingerprint256: string
}

export interface PdfSignatureInfo {
  id: string
  fieldName?: string
  pageNumber?: number
  signerName?: string
  reason?: string
  location?: string
  contactInfo?: string
  signingTime?: string
  filter?: string
  subFilter?: string
  byteRange?: number[]
  signedRevisionLength?: number
  coversCurrentFile: boolean
  hasLaterIncrementalUpdates: boolean
  contentsPresent: boolean
  certificate?: EmbeddedCertificateInfo
  structure: SignatureEvidenceStatus
  cryptographicSignature: VerificationStatus
  certificateTrust: VerificationStatus
  revocationStatus: VerificationStatus
  trustedTimestamp: VerificationStatus
  warnings: string[]
}

export interface PdfSignatureInspection {
  documentSha256: string
  fileSize: number
  hasSignatures: boolean
  signatures: PdfSignatureInfo[]
  /** True only when every required trust check was actually performed and passed. */
  fullyVerified: boolean
  limitations: string[]
}

const N = (value: string) => PDFName.of(value)

function textValue(dict: PDFDict, key: string) {
  const value = dict.lookupMaybe(N(key), PDFString, PDFHexString)
  if (!value) return undefined
  try { return value.decodeText() } catch { return undefined }
}

function nameValue(dict: PDFDict, key: string) {
  return dict.lookupMaybe(N(key), PDFName)?.asString().replace(/^\//, '')
}

function signatureDate(dict: PDFDict) {
  const value = dict.lookupMaybe(N('M'), PDFString, PDFHexString)
  if (!value) return undefined
  try { return value.decodeDate().toISOString() } catch { return textValue(dict, 'M') }
}

function byteRange(dict: PDFDict) {
  const range = dict.lookupMaybe(N('ByteRange'), PDFArray)
  if (!range) return undefined
  const values: number[] = []
  for (let index = 0; index < range.size(); index += 1) {
    const number = range.lookupMaybe(index, PDFNumber)
    if (!number) return undefined
    values.push(number.asNumber())
  }
  return values
}

function signatureContents(dict: PDFDict) {
  return dict.lookupMaybe(N('Contents'), PDFString, PDFHexString)?.asBytes()
}

function embeddedCertificate(dict: PDFDict): EmbeddedCertificateInfo | undefined {
  let value = dict.lookupMaybe(N('Cert'), PDFString, PDFHexString)
  if (!value) {
    const certificates = dict.lookupMaybe(N('Cert'), PDFArray)
    value = certificates?.lookupMaybe(0, PDFString, PDFHexString)
  }
  if (!value) return undefined
  try {
    const certificate = new X509Certificate(Buffer.from(value.asBytes()))
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      fingerprint256: certificate.fingerprint256,
    }
  } catch {
    return undefined
  }
}

function inspectRange(range: number[] | undefined, fileSize: number) {
  if (!range || range.length !== 4 || range.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return { structure: 'invalid-structure' as const, revisionLength: undefined, coversCurrentFile: false, later: false }
  }
  const [firstOffset, firstLength, secondOffset, secondLength] = range
  const revisionLength = secondOffset + secondLength
  const valid = firstOffset === 0
    && firstLength <= secondOffset
    && firstLength <= fileSize
    && secondOffset <= fileSize
    && revisionLength <= fileSize
  return {
    structure: valid ? 'valid-structure' as const : 'invalid-structure' as const,
    revisionLength,
    coversCurrentFile: valid && revisionLength === fileSize,
    later: valid && revisionLength < fileSize,
  }
}

/**
 * Reads signature evidence without claiming PKI trust. pdf-lib can expose the
 * PDF dictionaries and ByteRange, but it does not validate CMS/PAdES, OCSP or
 * CRLs. A future verifier may promote the explicit `unknown` states only after
 * it validates those proofs against a configured trust store.
 */
export async function inspectPdfSignatures(input: Uint8Array): Promise<PdfSignatureInspection> {
  const bytes = input
  const documentSha256 = createHash('sha256').update(bytes).digest('hex')
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const objects = document.context.enumerateIndirectObjects()
  const refsByObject = new Map<PDFObject, string>()
  for (const [ref, object] of objects) refsByObject.set(object, ref.toString())

  type Candidate = { id: string; dict: PDFDict; fieldName?: string; pageNumber?: number }
  const candidates = new Map<string, Candidate>()
  const addCandidate = (dict: PDFDict, ref?: PDFRef, fieldName?: string, pageNumber?: number) => {
    const id = ref?.toString() ?? refsByObject.get(dict) ?? `direct-${candidates.size + 1}`
    const current = candidates.get(id)
    candidates.set(id, {
      id,
      dict,
      fieldName: fieldName ?? current?.fieldName,
      pageNumber: pageNumber ?? current?.pageNumber,
    })
  }

  for (const [ref, object] of objects) {
    if (!(object instanceof PDFDict)) continue
    const isSignature = nameValue(object, 'Type') === 'Sig'
      || (object.has(N('ByteRange')) && object.has(N('Contents')))
    if (isSignature) addCandidate(object, ref)
  }

  for (const [pageIndex, page] of document.getPages().entries()) {
    const annotations = page.node.lookupMaybe(N('Annots'), PDFArray)
    if (!annotations) continue
    for (let index = 0; index < annotations.size(); index += 1) {
      const widget = annotations.lookupMaybe(index, PDFDict)
      if (!widget) continue
      const parent = widget.lookupMaybe(N('Parent'), PDFDict)
      const field = parent ?? widget
      if (nameValue(field, 'FT') !== 'Sig') continue
      const valueObject = field.get(N('V'))
      const value = valueObject ? document.context.lookupMaybe(valueObject, PDFDict) : undefined
      if (!value) continue
      addCandidate(value, valueObject instanceof PDFRef ? valueObject : undefined, textValue(field, 'T'), pageIndex + 1)
    }
  }

  const signatures = [...candidates.values()].map<PdfSignatureInfo>((candidate) => {
    const range = byteRange(candidate.dict)
    const rangeResult = inspectRange(range, bytes.length)
    const contents = signatureContents(candidate.dict)
    const certificate = embeddedCertificate(candidate.dict)
    const warnings: string[] = []
    if (rangeResult.structure === 'invalid-structure') warnings.push('签名 ByteRange 缺失或超出文件边界。')
    if (rangeResult.later) warnings.push('签名版本之后存在增量更新；这不等同于篡改，需由签名验证器判断更新是否被允许。')
    if (!contents?.some((byte) => byte !== 0)) warnings.push('签名字典没有可用的签名内容。')
    if (!certificate) warnings.push('当前解析器未从签名字典中取得可直接解析的 X.509 证书；证书可能封装在 CMS/PAdES 容器中。')
    warnings.push('尚未执行 CMS/PAdES 密码学验证、可信证书链、可信时间戳及 OCSP/CRL 吊销检查。')
    return {
      id: candidate.id,
      fieldName: candidate.fieldName,
      pageNumber: candidate.pageNumber,
      signerName: textValue(candidate.dict, 'Name'),
      reason: textValue(candidate.dict, 'Reason'),
      location: textValue(candidate.dict, 'Location'),
      contactInfo: textValue(candidate.dict, 'ContactInfo'),
      signingTime: signatureDate(candidate.dict),
      filter: nameValue(candidate.dict, 'Filter'),
      subFilter: nameValue(candidate.dict, 'SubFilter'),
      byteRange: range,
      signedRevisionLength: rangeResult.revisionLength,
      coversCurrentFile: rangeResult.coversCurrentFile,
      hasLaterIncrementalUpdates: rangeResult.later,
      contentsPresent: Boolean(contents?.some((byte) => byte !== 0)),
      certificate,
      structure: rangeResult.structure,
      cryptographicSignature: 'not-performed',
      certificateTrust: 'unknown',
      revocationStatus: 'unknown',
      trustedTimestamp: 'unknown',
      warnings,
    }
  })

  return {
    documentSha256,
    fileSize: bytes.length,
    hasSignatures: signatures.length > 0,
    signatures,
    fullyVerified: false,
    limitations: [
      '本地读取仅提供 PDF 签名字典和字节覆盖范围证据，不等于签名有效。',
      '完整验证需要 CMS/PAdES/国密验证器、可信根证书库，以及可用的 OCSP/CRL 与时间戳服务。',
      '普通 PNG/JPEG 电子章仅是外观图片，不具有数字签名法律验证结果。',
    ],
  }
}

export interface ElectronicSealRecord {
  id: string
  name: string
  kind: 'appearance-image'
  mimeType: 'image/png' | 'image/jpeg'
  fileName: string
  sourcePath?: string
  byteLength: number
  sha256: string
  width: number
  height: number
  notes?: string
  createdAt: string
  updatedAt: string
  trustStatus: 'not-a-digital-signature'
}

export interface ElectronicSealAsset extends ElectronicSealRecord {
  bytes: Uint8Array
}

interface InventoryFile { version: 1; seals: ElectronicSealRecord[] }

function imageInfo(bytes: Uint8Array): { mimeType: ElectronicSealRecord['mimeType']; extension: string; width: number; height: number } {
  if (bytes.length >= 24
    && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && Buffer.from(bytes.subarray(12, 16)).toString('ascii') === 'IHDR') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { mimeType: 'image/png', extension: '.png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2 || offset + length + 2 > bytes.length) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          mimeType: 'image/jpeg',
          extension: '.jpg',
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        }
      }
      offset += length + 2
    }
  }
  throw new Error('仅支持有效的 PNG 或 JPEG 电子章图片')
}

function cleanText(value: unknown, fallback = '', max = 200) {
  return (typeof value === 'string' ? value : fallback).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

export class ElectronicSealInventory {
  readonly root: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string) { this.root = path.resolve(root) }

  private get indexPath() { return path.join(this.root, 'index.json') }
  private get assetsPath() { return path.join(this.root, 'assets') }

  private async readIndex(): Promise<InventoryFile> {
    try {
      const value = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) as InventoryFile
      return value?.version === 1 && Array.isArray(value.seals) ? value : { version: 1, seals: [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, seals: [] }
      throw error
    }
  }

  private async writeIndex(index: InventoryFile) {
    await fs.mkdir(this.root, { recursive: true })
    const temporary = path.join(this.root, `index-${randomUUID()}.tmp`)
    await fs.writeFile(temporary, JSON.stringify(index, null, 2), { mode: 0o600 })
    await fs.rename(temporary, this.indexPath)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async list() {
    return (await this.readIndex()).seals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async import(input: { bytes: Uint8Array; name?: string; fileName?: string; sourcePath?: string; notes?: string }) {
    return this.exclusive(async () => {
      const bytes = Uint8Array.from(input.bytes)
      if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('电子章图片必须小于 25 MB')
      const image = imageInfo(bytes)
      if (!image.width || !image.height || image.width > 20_000 || image.height > 20_000) throw new Error('电子章图片尺寸无效')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const index = await this.readIndex()
      const duplicate = index.seals.find((seal) => seal.sha256 === sha256)
      if (duplicate) return duplicate
      const now = new Date().toISOString()
      const id = randomUUID()
      const fileName = cleanText(input.fileName, `seal${image.extension}`, 180) || `seal${image.extension}`
      const record: ElectronicSealRecord = {
        id,
        name: cleanText(input.name, path.basename(fileName, path.extname(fileName)), 80) || '未命名电子章',
        kind: 'appearance-image',
        mimeType: image.mimeType,
        fileName,
        sourcePath: input.sourcePath ? path.resolve(input.sourcePath) : undefined,
        byteLength: bytes.length,
        sha256,
        width: image.width,
        height: image.height,
        notes: cleanText(input.notes, '', 1_000) || undefined,
        createdAt: now,
        updatedAt: now,
        trustStatus: 'not-a-digital-signature',
      }
      await fs.mkdir(this.assetsPath, { recursive: true })
      await fs.writeFile(path.join(this.assetsPath, `${id}${image.extension}`), bytes, { flag: 'wx', mode: 0o600 })
      index.seals.push(record)
      try { await this.writeIndex(index) } catch (error) {
        await fs.rm(path.join(this.assetsPath, `${id}${image.extension}`), { force: true })
        throw error
      }
      return record
    })
  }

  async read(id: string): Promise<ElectronicSealAsset | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const record = (await this.readIndex()).seals.find((seal) => seal.id === id)
    if (!record) return null
    const extension = record.mimeType === 'image/png' ? '.png' : '.jpg'
    try {
      return { ...record, bytes: new Uint8Array(await fs.readFile(path.join(this.assetsPath, `${id}${extension}`))) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async update(id: string, patch: { name?: string; notes?: string }) {
    return this.exclusive(async () => {
      const index = await this.readIndex()
      const record = index.seals.find((seal) => seal.id === id)
      if (!record) return null
      if (patch.name !== undefined) record.name = cleanText(patch.name, record.name, 80) || record.name
      if (patch.notes !== undefined) record.notes = cleanText(patch.notes, '', 1_000) || undefined
      record.updatedAt = new Date().toISOString()
      await this.writeIndex(index)
      return record
    })
  }

  async remove(id: string) {
    return this.exclusive(async () => {
      const index = await this.readIndex()
      const record = index.seals.find((seal) => seal.id === id)
      if (!record) return false
      index.seals = index.seals.filter((seal) => seal.id !== id)
      await this.writeIndex(index)
      const extension = record.mimeType === 'image/png' ? '.png' : '.jpg'
      await fs.rm(path.join(this.assetsPath, `${id}${extension}`), { force: true })
      return true
    })
  }
}
