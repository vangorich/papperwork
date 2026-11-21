// A search layer paints no ink. A name or a PDF-supplied checksum alone cannot
// distinguish text we recognized from unrelated invisible PDF content. Keep only
// hashes and random run tags for recent local editions, never paths or quotations.
export type OcrTagsByPage = Map<number, readonly string[]>
const storageKey = 'paperwork-ocr-editions-v1'
const limit = 512 * 1024, maxBytes = 128 * 1024 * 1024, maxEditions = 48
const tagPattern = /^PwOcr[0-9a-f]{32}$/
export const newOcrTag = () => 'PwOcr' + crypto.randomUUID().replaceAll('-', '')
type Receipt = { length: number; hash: string; pages: [number, string[]][] }
function recent(): Receipt[] {
  const raw = globalThis.localStorage?.getItem(storageKey)
  if (!raw || raw.length > limit) return []
  const v = JSON.parse(raw)
  if (!Array.isArray(v)) return []
  return v.slice(0, maxEditions).filter(r => r && Number.isSafeInteger(r.length) && /^[0-9a-f]{64}$/.test(r.hash) && Array.isArray(r.pages))
}
async function digest(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
}
export async function knownOcrEdition(bytes: Uint8Array): Promise<OcrTagsByPage> {
  try {
    if (bytes.length <= maxBytes) {
      const candidates = recent().filter(r => r.length === bytes.length)
      if (candidates.length) {
        const hash = await digest(bytes), receipt = candidates.find(r => r.hash === hash)
        if (receipt) return new Map(receipt.pages.filter(([p,tags]) => Number.isSafeInteger(p) && p >= 0 && Array.isArray(tags) && tags.length <= 16 && tags.every(t => typeof t === 'string' && tagPattern.test(t))))
      }
    }
  } catch { /* Missing storage, private mode, or invalid receipt: do not trust hidden text. */ }
  return new Map()
}
export async function rememberOcrEdition(bytes: Uint8Array, tags: OcrTagsByPage) {
  if (!tags.size || bytes.length > maxBytes) return
  try {
    const pages: Receipt['pages'] = []
    for (const [p, runs] of tags) if (runs.length && runs.length <= 16) pages.push([p, [...new Set(runs)]])
    if (!pages.length) return
    const hash = await digest(bytes), entry = { length: bytes.length, hash, pages }
    const list = [entry, ...recent().filter(r => r.hash !== hash)].slice(0, maxEditions)
    let json = JSON.stringify(list)
    while (json.length > limit && list.length > 1) { list.pop(); json = JSON.stringify(list) }
    if (json.length <= limit) globalThis.localStorage?.setItem(storageKey, json)
  } catch { /* Search/copy and the PDF save itself never depend on this optional cache. */ }
}
