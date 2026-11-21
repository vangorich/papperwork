import type { PDFDict, PDFObject } from 'pdf-lib'

const trustNotice = '未执行 CMS/PAdES 验签、证书链、吊销或可信时间戳验证。'

/** Structural evidence only. Original bytes never leave the WebView and the PDF is never resaved. */
export async function nativeInspectPdfSignatures(bytes: Uint8Array): Promise<PdfSignatureInspection> {
  if (!bytes.byteLength || bytes.byteLength > 256 * 1024 * 1024) throw new Error('签名结构检查支持 256 MiB 以内的 PDF。')
  const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } = await import('pdf-lib')
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const get = (d: PDFDict, key: string) => pdf.context.lookup(d.get(PDFName.of(key)))
  const name = (v?: PDFObject) => v instanceof PDFName ? v.decodeText() : undefined
  const str = (v?: PDFObject) => v instanceof PDFHexString || v instanceof PDFString ? v : undefined
  const text = (v?: PDFObject) => { try { return str(v)?.decodeText() } catch { return undefined } }
  const signedAt = (d: PDFDict) => { const value = get(d, 'M'); try { return str(value)?.decodeDate().toISOString() } catch { return text(value) } }
  type Candidate = { id: string; fieldName?: string; pageNumber?: number }
  const candidates = new Map<PDFDict, Candidate>()
  const add = (d: PDFDict, ref?: PDFObject, fieldName?: string, pageNumber?: number) => {
    const found = candidates.get(d) ?? { id: ref instanceof PDFRef ? ref.toString() : `direct-${candidates.size + 1}` }
    if (fieldName) found.fieldName = fieldName
    if (pageNumber) found.pageNumber = pageNumber
    candidates.set(d, found)
    if (candidates.size > 4096) throw new Error('PDF 签名字典过多，已停止结构检查。')
  }
  // Signature fields may not have a visible widget, and /V may be a direct dictionary.
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue
    const type = name(get(object, 'Type'))
    if (type === 'Sig' || type === 'DocTimeStamp' || (object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents')))) add(object, ref)
    if (name(get(object, 'FT')) === 'Sig') {
      const value = get(object, 'V'); if (value instanceof PDFDict) add(value, object.get(PDFName.of('V')), text(get(object, 'T')))
    }
  }
  pdf.getPages().forEach(({ node }, index) => {
    const annots = get(node, 'Annots'); if (!(annots instanceof PDFArray)) return
    for (let i = 0; i < annots.size(); i++) {
      let field = annots.lookup(i)
      let type: string | undefined, title: string | undefined, valueRef: PDFObject | undefined
      const seen = new Set<PDFDict>()
      while (field instanceof PDFDict && !seen.has(field) && seen.size < 64) {
        seen.add(field)
        type ??= name(get(field, 'FT')); title ??= text(get(field, 'T')); valueRef ??= field.get(PDFName.of('V'))
        field = get(field, 'Parent')
      }
      const value = pdf.context.lookup(valueRef)
      if (type === 'Sig' && value instanceof PDFDict) add(value, valueRef, title, index + 1)
    }
  })
  const signatures = Array.from(candidates, ([dict, meta]): PdfSignatureInfo => {
    const range = get(dict, 'ByteRange')
    const n = range instanceof PDFArray ? range.size() : 0
    const offsets: number[] = []
    // Extra pairs are legal, e.g. additional regions excluded from the structural byte range.
    let valid = n >= 4 && n % 2 === 0 && n <= 64
    let end = 0
    if (valid && range instanceof PDFArray) for (let i = 0; i < n; i += 2) {
      const o = range.lookup(i), l = range.lookup(i + 1)
      if (!(o instanceof PDFNumber) || !(l instanceof PDFNumber)) { valid = false; break }
      const pos = o.asNumber(), len = l.asNumber()
      offsets.push(pos, len)
      if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(len) || len <= 0 || (i === 0 ? pos !== 0 : pos <= end) || pos + len > bytes.byteLength) valid = false
      end = pos + len
    }
    const contentsPresent = str(get(dict, 'Contents'))?.asBytes().some(b => b !== 0) ?? false
    const later = valid && end < bytes.byteLength
    const warnings = [trustNotice]
    if (!valid) warnings.unshift('ByteRange 缺失、重叠或超出文件边界。')
    if (!contentsPresent) warnings.unshift('签名字典中没有非空的签名数据。')
    if (later) warnings.unshift('文件包含签名版本后的数据；是否属于允许的增量更新尚未验证。')
    return { ...meta, signerName: text(get(dict, 'Name')), reason: text(get(dict, 'Reason')), location: text(get(dict, 'Location')),
      contactInfo: text(get(dict, 'ContactInfo')), signingTime: signedAt(dict), filter: name(get(dict, 'Filter')), subFilter: name(get(dict, 'SubFilter')),
      byteRange: offsets.length ? offsets : undefined, signedRevisionLength: valid ? end : undefined,
      coversCurrentFile: valid && end === bytes.byteLength, hasLaterIncrementalUpdates: later, contentsPresent,
      structure: valid && contentsPresent ? 'valid-structure' : 'invalid-structure', cryptographicSignature: 'not-performed', certificateTrust: 'unknown', revocationStatus: 'unknown', trustedTimestamp: 'unknown', warnings }
  })
  // DesktopFile.bytes normally owns an ArrayBuffer. Digest the view, not its entire backing buffer (possibly a subarray).
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes))
  return { documentSha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
    fileSize: bytes.byteLength, hasSignatures: signatures.length > 0, signatures, fullyVerified: false,
    limitations: ['仅检查 PDF 签名字典和字节覆盖范围；外观印章不是数字签名。', trustNotice, '不解析嵌入证书，不验证其中的签署人身份。'] }
}
