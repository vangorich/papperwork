import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import type { Box, OrtModule, PaddleOcrModelPresetName, PaddleOcrService as PaddleOcrServiceType } from 'paddleocr'
import { preprocessOcrImage, type OcrImageBox } from './ocrPreprocess'
import { recognizeExternalOcr, type OcrConnectionSettings, type ExternalOcrImage } from './ocrConnections'

export type OcrMode = 'auto' | 'printed' | 'handwriting'

export interface OcrPageInput {
  width: number
  height: number
  /** Raw RGBA pixels in row-major order. */
  data: Uint8Array
  mode?: OcrMode
  documentType?: 'complex'
  pipeline?: {
    preprocess?: boolean
    handwritingProvider?: 'local' | 'tencent' | 'custom'
    lowConfidenceProvider?: 'local' | 'tencent' | 'custom'
    lowConfidenceThreshold?: number
    contextualCorrection?: boolean
    tencent?: { secretId?: string; secretKey?: string; region?: string }
    custom?: { endpoint?: string; apiKey?: string }
  }
}

export interface OcrTextItem {
  text: string
  confidence: number
  box: Box & { rotation?: number }
  rawText?: string
  correctedText?: string
  candidates?: Array<{ text: string; confidence: number }>
  requiresReview?: boolean
}

export interface OcrRecognitionResult {
  text: string
  confidence: number
  items: OcrTextItem[]
  mode: OcrMode
  elapsedMs: number
  rawText: string
  correctedText: string
  engine: string
  model: string
  documentType: 'printed' | 'handwriting' | 'complex'
  warnings: string[]
}

const MODEL_NAME = 'PP-OCRv6_small'
const MAX_PIXELS = 20_000_000
const MAX_BYTES = MAX_PIXELS * 4
const modelFiles = {
  detection: 'PP-OCRv6_small_det_infer.onnx',
  recognition: 'PP-OCRv6_small_rec_infer.onnx',
  dictionary: 'ppocrv6_dict.txt',
} as const

type LocalProfileId = 'small' | 'medium' | 'handwriting'
const localProfiles: Record<LocalProfileId, {
  label: string
  preset: PaddleOcrModelPresetName
  detection: string
  recognition: string
  dictionary: string
}> = {
  small: {
    label: 'PP-OCRv6 Small', preset: 'PP-OCRv6_small',
    detection: modelFiles.detection, recognition: modelFiles.recognition, dictionary: modelFiles.dictionary,
  },
  medium: {
    label: 'PP-OCRv6 Medium', preset: 'PP-OCRv6_medium',
    detection: 'PP-OCRv6_medium_det_infer.onnx', recognition: 'PP-OCRv6_medium_rec_infer.onnx', dictionary: 'ppocrv6_dict.txt',
  },
  handwriting: {
    label: 'PP-OCRv5 Server Rec', preset: 'PP-OCRv5_server',
    detection: modelFiles.detection, recognition: 'PP-OCRv5_server_rec_infer.onnx', dictionary: 'ppocrv5_dict.txt',
  },
}

const services = new Map<LocalProfileId, PaddleOcrServiceType>()
const initializers = new Map<LocalProfileId, Promise<PaddleOcrServiceType>>()
let lastError: string | undefined
let recognitionQueue: Promise<unknown> = Promise.resolve()

let configuredModelDirectory: string | undefined

/** Allows the dedicated OCR worker to receive the exact packaged model path
 * without importing Electron APIs on its worker thread. */
export function configureOcrModelDirectory(directory: string) {
  configuredModelDirectory = directory
}

function modelDirectory() {
  if (configuredModelDirectory) return configuredModelDirectory
  const packaged = typeof process.resourcesPath === 'string'
    ? path.join(process.resourcesPath, 'ocr')
    : undefined
  return packaged && existsSync(packaged)
    ? packaged
    : path.join(process.cwd(), 'resources', 'ocr')
}

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

async function modelsAvailable() {
  try {
    await Promise.all(Object.values(modelFiles).map((file) => fs.access(path.join(modelDirectory(), file))))
    return true
  } catch {
    return false
  }
}

async function filesAvailable(files: string[]) {
  try {
    await Promise.all(files.map((file) => fs.access(path.join(modelDirectory(), file))))
    return true
  } catch {
    return false
  }
}

async function resolveLocalProfile(documentType: OcrRecognitionResult['documentType']): Promise<LocalProfileId> {
  if (documentType === 'handwriting' && await filesAvailable([
    localProfiles.handwriting.detection, localProfiles.handwriting.recognition, localProfiles.handwriting.dictionary,
  ])) return 'handwriting'
  if (await filesAvailable([
    localProfiles.medium.detection, localProfiles.medium.recognition, localProfiles.medium.dictionary,
  ])) return 'medium'
  return 'small'
}

async function resolveSecondaryLocalProfile(primary: LocalProfileId): Promise<LocalProfileId | undefined> {
  if (primary !== 'medium' && await filesAvailable([
    localProfiles.medium.detection, localProfiles.medium.recognition, localProfiles.medium.dictionary,
  ])) return 'medium'
  if (primary !== 'small' && await modelsAvailable()) return 'small'
  return undefined
}

async function getService(profileId: LocalProfileId): Promise<PaddleOcrServiceType> {
  const existing = services.get(profileId)
  if (existing) return existing
  const active = initializers.get(profileId)
  if (active) return active

  const profile = localProfiles[profileId]
  const initializing: Promise<PaddleOcrServiceType> = (async () => {
    const directory = modelDirectory()
    const paddlePackage = 'paddleocr'
    const ortPackage = 'onnxruntime-node'
    const [paddle, ort, detection, recognition, dictionary] = await Promise.all([
      import(/* @vite-ignore */ paddlePackage),
      import(/* @vite-ignore */ ortPackage),
      fs.readFile(path.join(directory, profile.detection)),
      fs.readFile(path.join(directory, profile.recognition)),
      fs.readFile(path.join(directory, profile.dictionary), 'utf8'),
    ])

    const instance = await paddle.PaddleOcrService.createInstance({
      ort: ort as unknown as OrtModule,
      modelPreset: profile.preset,
      detection: { modelBuffer: asArrayBuffer(detection) },
      recognition: {
        modelBuffer: asArrayBuffer(recognition),
        // PP-OCRv6 uses a trailing space class in addition to the CTC blank.
        // trimEnd() removes that model class from the shipped text dictionary,
        // so append it explicitly or every non-empty recognition fails with a
        // 18709/18710 dictionary length mismatch.
        charactersDictionary: [...dictionary.trimEnd().split(/\r?\n/), ' '],
      },
    }) as PaddleOcrServiceType
    // The sessions have copied/compiled the models; keeping the source buffers
    // in service.options would otherwise retain another ~31 MB for app lifetime.
    if (instance.options.detection) instance.options.detection.modelBuffer = undefined
    if (instance.options.recognition) instance.options.recognition.modelBuffer = undefined
    services.set(profileId, instance)
    lastError = undefined
    return instance
  })().catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error)
    throw error
  }).finally(() => {
    initializers.delete(profileId)
  })
  initializers.set(profileId, initializing)
  return initializing
}

function validateInput(payload: unknown): OcrPageInput & { mode: OcrMode } {
  if (!payload || typeof payload !== 'object') throw new Error('OCR input is required')
  const input = payload as Partial<OcrPageInput>
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height)
    || (input.width ?? 0) <= 0 || (input.height ?? 0) <= 0) {
    throw new Error('OCR width and height must be positive integers')
  }
  const pixels = input.width! * input.height!
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error(`OCR page exceeds the ${MAX_PIXELS.toLocaleString()} pixel limit`)
  }
  if (!ArrayBuffer.isView(input.data)) throw new Error('OCR data must be RGBA pixels')
  const data = new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength)
  if (data.byteLength !== pixels * 4 || data.byteLength > MAX_BYTES) {
    throw new Error('OCR RGBA byte length does not match the page dimensions')
  }
  if (input.mode !== undefined && input.mode !== 'auto' && input.mode !== 'printed' && input.mode !== 'handwriting') {
    throw new Error('Unsupported OCR mode')
  }
  return {
    width: input.width!, height: input.height!, data, mode: input.mode ?? 'auto',
    documentType: input.documentType,
    pipeline: input.pipeline,
  }
}

function cropOcrImage(image: ExternalOcrImage, box: { x: number; y: number; width: number; height: number }) {
  const margin = Math.max(4, Math.round(Math.max(box.width, box.height) * 0.18))
  const x = Math.max(0, Math.floor(box.x - margin))
  const y = Math.max(0, Math.floor(box.y - margin))
  const right = Math.min(image.width, Math.ceil(box.x + box.width + margin))
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height + margin))
  const width = Math.max(1, right - x)
  const height = Math.max(1, bottom - y)
  const data = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    data.set(image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4), row * width * 4)
  }
  return { image: { width, height, data }, x, y }
}

type ClassifiableOcrItem = Pick<OcrTextItem, 'text' | 'confidence' | 'box'>

/**
 * Conservative post-detection routing. Printed text stays the default: a page is
 * only promoted when the first local pass contains strong multi-column/formula
 * signals, or several low-confidence, irregular handwritten lines.
 */
export function classifyDetectedDocument(
  items: readonly ClassifiableOcrItem[],
  pageWidth: number,
): OcrRecognitionResult['documentType'] {
  const valid = items.filter((item) => item.text.trim() && item.box.width > 0 && item.box.height > 0)
  if (valid.length < 3 || pageWidth <= 0) return 'printed'

  const joined = valid.map((item) => item.text).join('')
  const mathSymbols = joined.match(/[=+×÷∑∫√≈≠≤≥{}^_]/g)?.length ?? 0
  if (mathSymbols >= 3 && mathSymbols / Math.max(1, joined.length) >= 0.035) return 'complex'

  const centers = valid
    .map((item) => item.box.x + item.box.width / 2)
    .sort((left, right) => left - right)
  let split = -1
  let largestGap = 0
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index] - centers[index - 1]
    if (gap > largestGap) {
      largestGap = gap
      split = (centers[index] + centers[index - 1]) / 2
    }
  }
  if (split > 0 && largestGap >= pageWidth * 0.16) {
    const left = valid.filter((item) => item.box.x + item.box.width / 2 < split)
    const right = valid.filter((item) => item.box.x + item.box.width / 2 >= split)
    const verticalSpan = (group: typeof valid) => ({
      top: Math.min(...group.map((item) => item.box.y)),
      bottom: Math.max(...group.map((item) => item.box.y + item.box.height)),
    })
    if (left.length >= 3 && right.length >= 3) {
      const leftSpan = verticalSpan(left)
      const rightSpan = verticalSpan(right)
      const overlap = Math.max(0, Math.min(leftSpan.bottom, rightSpan.bottom) - Math.max(leftSpan.top, rightSpan.top))
      const shorterSpan = Math.max(1, Math.min(leftSpan.bottom - leftSpan.top, rightSpan.bottom - rightSpan.top))
      const crossing = valid.filter((item) => item.box.x < split && item.box.x + item.box.width > split).length
      if (overlap / shorterSpan >= 0.55 && crossing / valid.length <= 0.2) return 'complex'
    }
  }

  const averageConfidence = valid.reduce((sum, item) => sum + item.confidence, 0) / valid.length
  const heights = valid.map((item) => item.box.height)
  const averageHeight = heights.reduce((sum, height) => sum + height, 0) / heights.length
  const heightDeviation = Math.sqrt(heights.reduce((sum, height) => sum + (height - averageHeight) ** 2, 0) / heights.length)
  const irregularAngles = valid.filter((item) => {
    const points = item.box.points
    if (!points || points.length < 2) return false
    const angle = Math.abs(Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x) * 180 / Math.PI)
    return angle >= 2.5
  }).length
  if (valid.length >= 5 && averageConfidence < 0.48
    && heightDeviation / Math.max(1, averageHeight) >= 0.32
    && irregularAngles / valid.length >= 0.3) return 'handwriting'
  return 'printed'
}

/** Applies token corrections in reading order without changing an earlier duplicate token. */
export function applyTokenCorrections(rawText: string, items: readonly OcrTextItem[]) {
  let output = rawText
  let cursor = 0
  for (const item of items) {
    const raw = item.rawText ?? item.text
    if (!raw) continue
    const index = output.indexOf(raw, cursor)
    if (index < 0) continue
    const corrected = item.correctedText || raw
    if (corrected !== raw) output = `${output.slice(0, index)}${corrected}${output.slice(index + raw.length)}`
    cursor = index + corrected.length
  }
  return output
}

export async function getOcrCapabilities() {
  const [small, medium, handwriting] = await Promise.all([
    modelsAvailable(),
    filesAvailable(['PP-OCRv6_medium_det_infer.onnx', 'PP-OCRv6_medium_rec_infer.onnx', 'ppocrv6_dict.txt']),
    filesAvailable(['PP-OCRv5_server_rec_infer.onnx', 'ppocrv5_dict.txt']),
  ])
  return {
    engine: 'PaddleOCR + ONNX Runtime',
    model: MODEL_NAME,
    local: true,
    languages: ['zh-Hans', 'zh-Hant', 'en', 'multilingual'],
    modes: ['auto', 'printed', 'handwriting'] as OcrMode[],
    input: 'rgba' as const,
    maxPixels: MAX_PIXELS,
    models: [
      { id: 'pp-ocr-v6-small', label: 'PP-OCRv6 Small', role: 'fallback', available: small },
      { id: 'pp-ocr-v6-medium', label: 'PP-OCRv6 Medium', role: 'printed', available: medium },
      { id: 'pp-ocr-v5-server-rec', label: 'PP-OCRv5 Server Rec', role: 'handwriting', available: handwriting },
      { id: 'paddleocr-vl-1.6', label: 'PaddleOCR-VL 1.6', role: 'complex', available: false },
    ],
  }
}

export async function getOcrStatus() {
  return {
    available: await modelsAvailable(),
    ready: services.size > 0,
    loading: initializers.size > 0,
    engine: 'PaddleOCR + ONNX Runtime',
    model: MODEL_NAME,
    error: lastError,
  }
}

export function recognizeOcrPage(payload: unknown): Promise<OcrRecognitionResult> {
  const input = validateInput(payload)
  const recognize = async () => {
    const startedAt = Date.now()
    const prepared = input.pipeline?.preprocess === false
      ? undefined
      : preprocessOcrImage(input, {
          orientation: 'auto', deskew: true, normalizeBackground: true, crop: false, sharpen: true,
          // Preserve faint line endings and table borders. Content-bound cropping
          // can cut low-contrast edge glyphs before the detector sees them.
        })
    const recognitionInput = prepared?.image ?? input
    let documentType: OcrRecognitionResult['documentType'] = input.documentType
      ?? (input.mode === 'handwriting' ? 'handwriting' : 'printed')
    const connectionSettings: OcrConnectionSettings = {
      tencent: input.pipeline?.tencent,
      custom: input.pipeline?.custom,
    }
    const primaryProvider = documentType === 'handwriting'
      ? input.pipeline?.handwritingProvider
      : documentType === 'complex' && input.pipeline?.custom?.endpoint ? 'custom' : 'local'
    const preprocessWarnings = prepared?.diagnostics
      .filter((item) => item.status === 'skipped' && item.stage === 'perspective')
      .map((item) => item.message) ?? []

    const recognizeExternal = async (provider: 'tencent' | 'custom', type: OcrRecognitionResult['documentType']) => {
      const external = await recognizeExternalOcr(provider, connectionSettings, recognitionInput, type === 'handwriting')
      const threshold = Math.max(0.5, Math.min(0.95, input.pipeline?.lowConfidenceThreshold ?? 0.62))
      const items: OcrTextItem[] = external.items.map((item) => {
        const mappedBox = prepared
          ? prepared.mapping.boxToOriginal(item.box as OcrImageBox) as unknown as Box
          : item.box as unknown as Box
        return {
          text: item.text, rawText: item.text, correctedText: item.text,
          confidence: item.confidence, requiresReview: item.confidence < threshold, candidates: [],
          box: mappedBox,
        }
      })
      return {
        text: external.text, rawText: external.text, correctedText: external.text,
        confidence: external.confidence, items, mode: input.mode,
        engine: external.engine, model: provider === 'tencent' ? 'HandwritingOCR' : '自定义端点',
        documentType: type, warnings: preprocessWarnings, elapsedMs: Date.now() - startedAt,
      }
    }

    if (primaryProvider === 'tencent' || primaryProvider === 'custom') {
      return recognizeExternal(primaryProvider, documentType)
    }

    let localProfileId = await resolveLocalProfile(documentType)
    let ocr = await getService(localProfileId)
    let results = await ocr.recognize(recognitionInput, {
      detection: input.mode === 'handwriting'
        ? {
            maxSideLength: 3000,
            maxSideLimit: 4000,
            textPixelThreshold: 0.18,
            boxScoreThreshold: 0.38,
            unclipRatio: 1.9,
            paddingBoxHorizontal: 0.8,
            minimumAreaThreshold: 6,
          }
        : input.mode === 'printed' ? {
            maxSideLength: 3400,
            maxSideLimit: 4000,
            textPixelThreshold: 0.25,
            boxScoreThreshold: 0.5,
            unclipRatio: 1.75,
            paddingBoxHorizontal: 0.8,
            minimumAreaThreshold: 12,
          } : {
            maxSideLength: 3200,
            maxSideLimit: 4000,
            textPixelThreshold: 0.2,
            boxScoreThreshold: 0.42,
            unclipRatio: 1.8,
            paddingBoxHorizontal: 0.8,
            minimumAreaThreshold: 8,
          },
      ordering: { sortByReadingOrder: true },
    })
    let processed = ocr.processRecognition(results)
    if (!input.documentType && input.mode === 'auto') {
      const detectedType = classifyDetectedDocument(results, recognitionInput.width)
      if (detectedType !== 'printed') {
        const routedProvider = detectedType === 'handwriting'
          ? input.pipeline?.handwritingProvider
          : input.pipeline?.custom?.endpoint ? 'custom' : 'local'
        if (routedProvider === 'tencent' || routedProvider === 'custom') {
          return recognizeExternal(routedProvider, detectedType)
        }
        const routedProfileId = await resolveLocalProfile(detectedType)
        if (routedProfileId !== localProfileId) {
          localProfileId = routedProfileId
          ocr = await getService(localProfileId)
          results = await ocr.recognize(recognitionInput, {
            detection: {
              maxSideLength: detectedType === 'handwriting' ? 3000 : 3200,
              maxSideLimit: 4000,
              textPixelThreshold: detectedType === 'handwriting' ? 0.18 : 0.2,
              boxScoreThreshold: detectedType === 'handwriting' ? 0.38 : 0.42,
              unclipRatio: detectedType === 'handwriting' ? 1.9 : 1.8,
              minimumAreaThreshold: detectedType === 'handwriting' ? 6 : 8,
            },
            ordering: { sortByReadingOrder: true },
          })
          processed = ocr.processRecognition(results)
        }
        documentType = detectedType
      }
    }
    const threshold = Math.max(0.5, Math.min(0.95, input.pipeline?.lowConfidenceThreshold ?? 0.62))
    const mappedItems: OcrTextItem[] = results.map(({ text, confidence, box }) => {
      const mappedBox = prepared
        ? prepared.mapping.boxToOriginal(box as unknown as OcrImageBox) as unknown as Box
        : box
      return {
        text,
        rawText: text,
        correctedText: text,
        confidence,
        requiresReview: confidence < threshold,
        candidates: [],
        box: {
          ...mappedBox,
          rotation: mappedBox.points
            ? Math.atan2(mappedBox.points[1].y - mappedBox.points[0].y, mappedBox.points[1].x - mappedBox.points[0].x) * 180 / Math.PI
            : undefined,
        },
      }
    })
    const warnings = [...preprocessWarnings]
    let correctedText = processed.text
    const fallback = input.pipeline?.lowConfidenceProvider
    if (fallback && results.length) {
      const lowConfidence = results
        .map((result, index) => ({ result, index }))
        .filter(({ result }) => result.confidence < threshold)
        .slice(0, fallback === 'local' ? 12 : 24)
      const secondaryLocalProfile = fallback === 'local'
        ? await resolveSecondaryLocalProfile(localProfileId)
        : undefined
      const secondaryLocalOcr = secondaryLocalProfile ? await getService(secondaryLocalProfile) : undefined
      if (fallback === 'local' && lowConfidence.length && !secondaryLocalOcr) {
        warnings.push('低置信度本地复核需要第二个模型；安装 PP-OCRv6 Medium 后可自动启用。')
      }
      for (const { result, index } of lowConfidence) {
        try {
          const crop = cropOcrImage(recognitionInput, result.box)
          const candidate = secondaryLocalOcr
            ? (await secondaryLocalOcr.recognize(crop.image, {
                detection: { maxSideLength: 1200, maxSideLimit: 1600, minimumAreaThreshold: 4 },
                ordering: { sortByReadingOrder: true },
              })).sort((left, right) => right.confidence - left.confidence)[0]
            : fallback === 'tencent' || fallback === 'custom'
              ? (await recognizeExternalOcr(fallback, connectionSettings, crop.image, documentType === 'handwriting'))
                  .items.sort((left, right) => right.confidence - left.confidence)[0]
              : undefined
          if (!candidate?.text || candidate.confidence <= result.confidence + 0.05) continue
          mappedItems[index].candidates = [{ text: candidate.text, confidence: candidate.confidence }]
          mappedItems[index].correctedText = candidate.text
          mappedItems[index].requiresReview = candidate.confidence < threshold
        } catch (error) {
          if (!warnings.some((message) => message.startsWith('低置信度备用引擎'))) {
            warnings.push(`低置信度备用引擎不可用：${error instanceof Error ? error.message : '未知错误'}`)
          }
        }
      }
      correctedText = applyTokenCorrections(processed.text, mappedItems)
    }
    if (documentType === 'complex' && !input.pipeline?.custom?.endpoint) {
      warnings.push('PaddleOCR-VL 1.6 本地端点未配置，本页暂由内置文本模型降级识别。')
    }
    if (documentType === 'printed' && localProfileId === 'small') warnings.push('PP-OCRv6 Medium 模型未安装，本页使用 PP-OCRv6 Small 兼容回退。')
    if (documentType === 'handwriting' && localProfileId !== 'handwriting') warnings.push('PP-OCRv5 Server Rec 模型未安装，本页使用内置模型兼容回退。')
    return {
      text: processed.text,
      rawText: processed.text,
      correctedText,
      confidence: processed.confidence,
      items: mappedItems,
      mode: input.mode,
      engine: 'PaddleOCR + ONNX Runtime',
      model: localProfiles[localProfileId].label,
      documentType,
      warnings,
      elapsedMs: Date.now() - startedAt,
    }
  }

  // ponytail: one global queue avoids ONNX session re-entrancy and memory spikes;
  // split into a small worker pool only after profiling shows OCR throughput is a bottleneck.
  const task = recognitionQueue.then(recognize, recognize).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error)
    throw error
  })
  recognitionQueue = task.then(() => undefined, () => undefined)
  return task
}
