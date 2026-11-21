import { createHash, createHmac } from 'node:crypto'
import { deflateSync } from 'node:zlib'

export interface OcrConnectionSettings {
  tencent?: { secretId?: string; secretKey?: string; region?: string }
  custom?: { endpoint?: string; apiKey?: string }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const MAX_IMAGE_PIXELS = 20_000_000

export interface ExternalOcrImage { width: number; height: number; data: Uint8Array }
export interface ExternalOcrItem {
  text: string
  confidence: number
  box: { x: number; y: number; width: number; height: number; points?: Array<{ x: number; y: number }> }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
const pngChunk = (type: string, data: Uint8Array) => {
  const name = Buffer.from(type, 'ascii')
  const payload = Buffer.concat([name, Buffer.from(data)])
  let crc = 0xffffffff
  for (const value of payload) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  const output = Buffer.alloc(data.byteLength + 12)
  output.writeUInt32BE(data.byteLength, 0)
  name.copy(output, 4)
  Buffer.from(data).copy(output, 8)
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}

export function rgbaToPng(image: ExternalOcrImage) {
  const pixels = image.width * image.height
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width <= 0 || image.height <= 0 || !Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`OCR image dimensions must contain at most ${MAX_IMAGE_PIXELS.toLocaleString()} pixels`)
  }
  if (!ArrayBuffer.isView(image.data) || image.data.byteLength !== pixels * 4) {
    throw new Error('OCR image data must exactly match its RGBA dimensions')
  }
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    const row = y * (image.width * 4 + 1)
    rows[row] = 0
    Buffer.from(image.data.buffer, image.data.byteOffset + y * image.width * 4, image.width * 4).copy(rows, row + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows, { level: 6 })), pngChunk('IEND', new Uint8Array()),
  ])
}

export function validateOcrEndpoint(raw: string) {
  const url = new URL(raw)
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('远程 OCR 服务必须使用 HTTPS；localhost 可使用 HTTP')
  }
  return url
}

export function signTencentRequest(
  secretId: string,
  secretKey: string,
  action: string,
  payload: string,
  timestamp: number,
) {
  const service = 'ocr'
  const host = 'ocr.tencentcloudapi.com'
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex')
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

async function callTencent(settings: OcrConnectionSettings, action: string, payload: string) {
  const secretId = settings.tencent?.secretId?.trim()
  const secretKey = settings.tencent?.secretKey?.trim()
  if (!secretId || !secretKey) throw new Error('请先填写腾讯云 SecretId 和 SecretKey')
  const host = 'ocr.tencentcloudapi.com'
  const timestamp = Math.floor(Date.now() / 1000)
  const authorization = signTencentRequest(secretId, secretKey, action, payload, timestamp)
  const response = await fetch(`https://${host}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8', Host: host,
      'X-TC-Action': action, 'X-TC-Timestamp': String(timestamp), 'X-TC-Version': '2018-11-19',
      'X-TC-Region': settings.tencent?.region || 'ap-guangzhou',
    },
    body: payload,
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json() as { Response?: { Error?: { Code?: string; Message?: string }; TextDetections?: Array<{ DetectedText?: string; Confidence?: number; Polygon?: Array<{ X?: number; Y?: number }> }> } }
  if (result.Response?.Error) throw new Error(result.Response.Error.Message || result.Response.Error.Code || '腾讯云 OCR 失败')
  return { response, result }
}

async function testTencent(settings: OcrConnectionSettings) {
  const secretId = settings.tencent?.secretId?.trim()
  const secretKey = settings.tencent?.secretKey?.trim()
  if (!secretId || !secretKey) return { ok: false, message: '请先填写腾讯云 SecretId 和 SecretKey' }
  const action = 'GeneralBasicOCR'
  const payload = JSON.stringify({ ImageBase64: ONE_PIXEL_PNG })
  const { response } = await callTencent(settings, action, payload)
  return { ok: response.ok, message: response.ok ? '腾讯云 OCR 凭据验证成功' : `腾讯云返回 HTTP ${response.status}` }
}

async function testCustom(settings: OcrConnectionSettings) {
  const raw = settings.custom?.endpoint?.trim()
  if (!raw) return { ok: false, message: '请先填写自定义 OCR 服务地址' }
  const url = validateOcrEndpoint(raw)
  const local = true
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, message: '远程服务必须使用 HTTPS；本机端点可使用 HTTP' }
  }
  const response = await fetch(url, {
    method: 'OPTIONS',
    redirect: 'error',
    headers: settings.custom?.apiKey ? { Authorization: `Bearer ${settings.custom.apiKey}` } : undefined,
    signal: AbortSignal.timeout(8_000),
  })
  return {
    ok: response.status < 500,
    message: response.status < 500 ? `端点可访问（HTTP ${response.status}）` : `服务返回 HTTP ${response.status}`,
  }
}

export async function testOcrConnection(provider: 'tencent' | 'custom', settings: OcrConnectionSettings) {
  try {
    return provider === 'tencent' ? await testTencent(settings) : await testCustom(settings)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'OCR 连接失败' }
  }
}

export async function recognizeExternalOcr(
  provider: 'tencent' | 'custom',
  settings: OcrConnectionSettings,
  image: ExternalOcrImage,
  handwriting = false,
): Promise<{ text: string; confidence: number; items: ExternalOcrItem[]; engine: string }> {
  const imageBase64 = rgbaToPng(image).toString('base64')
  if (provider === 'tencent') {
    const { result } = await callTencent(settings, handwriting ? 'HandwritingOCR' : 'GeneralBasicOCR', JSON.stringify({ ImageBase64: imageBase64 }))
    const items = (result.Response?.TextDetections ?? []).flatMap((item) => {
      const text = item.DetectedText?.trim()
      const polygon = item.Polygon?.map((point) => ({ x: point.X ?? 0, y: point.Y ?? 0 })) ?? []
      if (!text || polygon.length < 2) return []
      const xs = polygon.map((point) => point.x)
      const ys = polygon.map((point) => point.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return [{ text, confidence: Math.max(0, Math.min(1, (item.Confidence ?? 0) / 100)), box: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, points: polygon } }]
    })
    return {
      text: items.map((item) => item.text).join('\n'),
      confidence: items.length ? items.reduce((sum, item) => sum + item.confidence, 0) / items.length : 0,
      items,
      engine: '腾讯云 OCR',
    }
  }

  const raw = settings.custom?.endpoint?.trim()
  if (!raw) throw new Error('未配置自定义 OCR 服务地址')
  const url = validateOcrEndpoint(raw)
  const local = true
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('OCR 端点必须使用 HTTPS；本机端点可使用 HTTP')
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.custom?.apiKey ? { Authorization: `Bearer ${settings.custom.apiKey}` } : {}),
    },
    body: JSON.stringify({ imageBase64, format: 'png', width: image.width, height: image.height, mode: handwriting ? 'handwriting' : 'document' }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`自定义 OCR 返回 HTTP ${response.status}`)
  const result = await response.json() as { text?: string; confidence?: number; items?: ExternalOcrItem[] }
  const items = (result.items ?? []).filter((item) => item.text && item.box && Number.isFinite(item.confidence))
  return {
    text: result.text ?? items.map((item) => item.text).join('\n'),
    confidence: Math.max(0, Math.min(1, result.confidence ?? (items.length ? items.reduce((sum, item) => sum + item.confidence, 0) / items.length : 0))),
    items,
    engine: '自定义 OCR 端点',
  }
}
