import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { nativeInspectPdfSignatures } from './nativeSignatures'

type Desktop = NonNullable<Window['desktop']>
type Feature = Pick<Desktop, 'parseOutlookMsg' | 'getPrinters' | 'printPages' | 'getOcrStatus' | 'getOcrCapabilities' | 'recognizeOcrPage' | 'testOcrConnection' | 'loadOcrSecrets' | 'saveOcrSecrets' | 'loadPdfPasswordHistory' | 'rememberPdfPassword' | 'removePdfPasswordHistoryEntry' | 'clearPdfPasswordHistory' | 'listElectronicSeals' | 'importElectronicSeal' | 'readElectronicSeal' | 'updateElectronicSeal' | 'deleteElectronicSeal' | 'inspectPdfSignatures' | 'getVirtualPrinterStatus' | 'takeVirtualPrintJobs' | 'acknowledgeVirtualPrintJobs' | 'onVirtualPrintJob'>

// Tauri rejects with a string; desktop callers rely on Error.message to show the real reason.
function rethrow(reason: unknown): never { throw reason instanceof Error ? reason : new Error(String(reason)) }
const call = <T,>(action: string, payload: unknown = null) => invoke<T>('native_feature', { action, payload }).catch(rethrow)
const binary = (action: string, meta = '', data: Uint8Array = new Uint8Array()) => invoke<ArrayBuffer>('native_binary', data, { headers: { 'x-native-action': action, 'x-native-meta': meta } }).then(b => new Uint8Array(b)).catch(rethrow)
const MAX_PACKET = 128 * 1024 * 1024
const decoder = new TextDecoder()

/** A short manifest followed by PNG bodies; do not expand each byte to a JSON number. */
function printPacket(pages: PrintPageImageInput[], options: PrintOptions): Uint8Array {
  if (!pages.length || pages.length > 2000) throw new Error('请将打印任务分为每组 1–2000 页。')
  const { copies, duplex, landscape, collate, pagesPerSheet, scaleFactor, sizing, color, deviceName, margins, paperSize, pageBorder } = options
  const header = new TextEncoder().encode(JSON.stringify({
    options: { copies, duplex, landscape, collate, pagesPerSheet, scaleFactor, sizing, color, deviceName, margins, paperSize, pageBorder },
    pages: pages.map(({ widthPt, heightPt, png }) => ({ widthPt, heightPt, size: png.byteLength })),
  }))
  const size = pages.reduce((n, p) => n + p.png.byteLength, header.length + 4)
  if (size > MAX_PACKET || pages.some(p => !p.png.byteLength || p.png.byteLength > 64 * 1024 * 1024)) throw new Error('打印光栅数据超过上限。请降低 DPI 或分批打印（每批 128 MiB）。')
  const data = new Uint8Array(size)
  new DataView(data.buffer).setUint32(0, header.byteLength, true)
  data.set(header, 4)
  let offset = 4 + header.length
  for (const { png } of pages) { data.set(png, offset); offset += png.byteLength }
  return data
}

type Secrets = Awaited<ReturnType<Desktop['loadOcrSecrets']>>
// The React settings screen hydrates asynchronously. Its initial debounced save must never
// replace pre-existing DPAPI keys with the all-empty initial form during a cold start.
let initialSecrets: Promise<Secrets> | undefined
let hydratedSecrets = false

export const nativeFeatures: Feature = {
  async parseOutlookMsg(bytes) {
    if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new Error('MSG 邮件为空或超过 32 MiB。')
    return JSON.parse(decoder.decode(await binary('parseOutlookMsg', '', bytes)))
  },
  getPrinters: () => call('getPrinters'),
  async printPages(pages, options) {
    const reply = await binary('print', '', printPacket(pages, options))
    if (decoder.decode(reply) !== 'true') throw new Error('打印任务未提交。')
    return true
  },
  getOcrStatus: () => call('getOcrStatus'),
  getOcrCapabilities: () => call('getOcrCapabilities'),
  async recognizeOcrPage({ width, height, data, mode = 'auto', documentType, pipeline }) {
    if (mode === 'handwriting' || documentType === 'complex') throw new Error('此版本仅支持 Windows 离线印刷体识别，未安装手写或复杂版式模型。请切换到印刷体。')
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 22_000_000 || data.byteLength !== width * height * 4) throw new Error('OCR 图像尺寸或 RGBA 数据长度无效。')
    const result: OcrRecognitionResult = JSON.parse(decoder.decode(await binary('ocr', JSON.stringify({ width, height, mode }), data)))
    // Do not transmit provider settings or secrets in the image request. Windows has no confidence scores.
    if (pipeline?.lowConfidenceProvider && pipeline.lowConfidenceProvider !== 'local') (result.warnings ??= []).push('本次仅使用 Windows 离线 OCR，未请求第二引擎。')
    return result
  },
  testOcrConnection: (provider) => call('testOcrConnection', { provider }),
  loadOcrSecrets() {
    if (!initialSecrets) initialSecrets = call<Secrets>('loadOcrSecrets').then(secrets => { hydratedSecrets = true; return secrets }).catch(e => { initialSecrets = undefined; throw e })
    return initialSecrets
  },
  async saveOcrSecrets(secrets) {
    if (!hydratedSecrets && !secrets.secretId && !secrets.secretKey && !secrets.apiKey) return false
    const saved = await call<boolean>('saveOcrSecrets', secrets)
    if (saved) initialSecrets = Promise.resolve({ tencent: { secretId: secrets.secretId, secretKey: secrets.secretKey }, custom: { apiKey: secrets.apiKey } })
    return saved
  },
  loadPdfPasswordHistory: () => call('loadPdfPasswordHistory'),
  rememberPdfPassword: entry => call('rememberPdfPassword', entry),
  removePdfPasswordHistoryEntry: id => call('removePdfPasswordHistoryEntry', { id }),
  clearPdfPasswordHistory: () => call('clearPdfPasswordHistory'),
  listElectronicSeals: () => call('listElectronicSeals'),
  importElectronicSeal: () => call('importElectronicSeal'),
  async readElectronicSeal(id) {
    const record = await call<ElectronicSealRecord | null>('readElectronicSeal', { id })
    return record ? { ...record, bytes: await binary('sealBytes', id) } : null
  },
  updateElectronicSeal: (id, patch) => call('updateElectronicSeal', { id, patch }),
  deleteElectronicSeal: id => call('deleteElectronicSeal', { id }),
  inspectPdfSignatures: nativeInspectPdfSignatures,
  getVirtualPrinterStatus: () => call('getVirtualPrinterStatus'),
  async takeVirtualPrintJobs(deferredIds = []) {
    const skip = new Set(deferredIds)
    let after: string | undefined
    for (;;) {
      const refs = await call<Omit<VirtualPrintJob, 'bytes'>[]>('takeVirtualPrintJobs', { after, limit: 32 })
      const job = refs.find(ref => !skip.has(ref.id))
      if (job) {
        try { return [{ ...job, bytes: await binary('jobBytes', job.id) }] }
        catch (reason) { throw Object.assign(new Error(reason instanceof Error ? reason.message : String(reason)), { printJobId: job.id }) }
      }
      const last = refs.at(-1)?.id
      if (refs.length < 32 || !last || (after && last <= after)) return []
      after = last
    }
  },
  acknowledgeVirtualPrintJobs: ids => call('acknowledgeVirtualPrintJobs', { ids }),
  onVirtualPrintJob(callback) {
    let active = true
    let retry: ReturnType<typeof setInterval> | undefined
    const unsub = listen('native-virtual-print-job', () => { if (active) callback() })
    // A spool file can land between the component's first drain and event registration.
    void unsub.then(() => { if (active) callback() }, () => { if (active) retry = setInterval(callback, 5000) })
    return () => { active = false; if (retry !== undefined) clearInterval(retry); void unsub.then(remove => remove()).catch(() => undefined) }
  },
}
