// OFD locations are package paths, never OS paths or URLs. A leading slash in
// XML means the root of THIS archive; relative references may not escape it.
import { OFD_MAX_INPUT } from './ofdLimits'
const MiB = 1024 * 1024
const XML_LIMIT = 3 * MiB
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function ofdError(message: string): never { throw new Error(`OFD：${message}`) }

export function ofdLocation(directory: string, reference: string) {
  const raw = reference.trim()
  if (!raw || raw.length > 1024 || /[\\:%?#\u0000-\u001f]/.test(raw) || raw.startsWith('//')) ofdError('文件引用不是有效的包内路径')
  const parts = directory && !raw.startsWith('/') ? directory.split('/') : []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) ofdError('文件引用越过了包根目录')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0)
  return n >>> 0
})
function crc32(bytes: Uint8Array) {
  let crc = -1
  for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255]
  return (crc ^ -1) >>> 0
}

// Index first, decompress only referenced members. Checking actual streamed
// output against a pre-sized buffer also bounds dishonest ZIP size headers.
export function openOfdArchive(bytes: Uint8Array) {
  const corrupt = () => ofdError('压缩包损坏或不是有效的 OFD 文件')
  if (bytes.length > OFD_MAX_INPUT) ofdError('文件超过 96 MiB 导入上限')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (offset: number) => view.getUint16(offset, true)
  const u32 = (offset: number) => view.getUint32(offset, true)
  let end = bytes.length - 22
  const minEnd = Math.max(0, end - 65535)
  while (end >= minEnd && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--
  if (end < minEnd) return corrupt()
  const count = u16(end + 10), central = u32(end + 16)
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8) || count === 65535 || central === 0xffffffff) ofdError('暂不支持分卷或 ZIP64 格式')
  if (!count || count > 4096) ofdError('压缩条目数量无效或超过 4096 项上限')
  if (central + u32(end + 12) !== end) return corrupt()
  let cursor = central, declaredTotal = 0
  const entries = new Map<string, { offset: number; packed: number; size: number; crc: number; method: number }>()
  const signatureLists:string[]=[]
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) return corrupt()
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16)
    const packed = u32(cursor + 20), size = u32(cursor + 24), nameLength = u16(cursor + 28), local = u32(cursor + 42)
    if (flags & 0x2041) ofdError('暂不支持加密 OFD')
    if (method !== 0 && method !== 8) ofdError('不支持此 ZIP 压缩方法')
    declaredTotal += size
    if (nameLength > 1024 || size > 32 * MiB || declaredTotal > 160 * MiB) ofdError('压缩条目超过导入容量上限')
    const next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32)
    if (next > end || local + 30 > central || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength || u16(cursor + 34) !== 0) return corrupt()
    const offset = local + 30 + nameLength + u16(local + 28)
    if (offset + packed > central || (!method && size !== packed)) return corrupt()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    if (nameBytes.some((b, j) => b !== bytes[local + 30 + j])) return corrupt()
    let name: string
    try { name = utf8.decode(nameBytes) } catch { return ofdError('不支持压缩条目的文件名编码') }
    const canonical = ofdLocation('', name)
    if (!canonical || canonical !== name.replace(/\/$/, '') || entries.has(canonical)) ofdError('压缩包内的文件路径无效或重复')
    if (/\.xml$/i.test(name) && size > XML_LIMIT) ofdError('单个 XML 文件超过 3 MiB 上限')
    if (/(^|\/)(encryptions|encryptloc)\.xml$/i.test(name)) ofdError('暂不支持加密 OFD')
    if (/(^|\/)Signatures\.xml$/i.test(canonical)) signatureLists.push(canonical)
    entries.set(canonical, { offset, packed, size, crc, method })
    cursor = next
  }
  if (cursor !== end) return corrupt()
  let readTotal = 0, xmlNodes = 0
  async function read(path: string, limit = 32 * MiB) {
    const ent = entries.get(path) ?? ofdError(`缺少包内文件：${path}`)
    if (ent.size > limit || (readTotal += ent.size) > 256 * MiB) ofdError('解压数据超过导入上限')
    const input = bytes.subarray(ent.offset, ent.offset + ent.packed)
    let output = input
    if (ent.method) {
      output = new Uint8Array(ent.size)
      const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
      let pos = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value.length > ent.size - pos) { await reader.cancel(); return corrupt() }
          output.set(value, pos); pos += value.length
        }
      } catch { return corrupt() }
      if (pos !== ent.size) return corrupt()
    }
    if (crc32(output) !== ent.crc) return corrupt()
    return output
  }
  async function xml(path: string, rootName: string) {
    const data = await read(path, XML_LIMIT)
    let text: string
    try { text = utf8.decode(data) } catch { return ofdError('XML 不是有效的 UTF-8 文本') }
    if (/<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet/i.test(text)) ofdError('不允许 XML 实体、DTD 或外部样式表')
    let tags = 0
    for (let i = text.indexOf('<'); i >= 0; i = text.indexOf('<', i + 1)) if (++tags > 64000 || ++xmlNodes > 500000) ofdError('XML 节点数量超过上限')
    let doc: Document
    try { doc = new DOMParser().parseFromString(text, 'application/xml') } catch { return ofdError(`XML 损坏：${path}`) }
    const root = doc.documentElement
    if (!root || root.localName !== rootName || (root.namespaceURI && root.namespaceURI !== 'http://www.ofdspec.org/2016') || doc.getElementsByTagName('parsererror').length) ofdError(`XML 根节点无效：${path}`)
    return root
  }
  return { read, xml, signatureLists, hasSignatureList:signatureLists.length>0 }
}
