/** Production OCR routing and review contracts. Image/model execution stays in Electron. */

export type OcrDocumentType = 'printed' | 'handwriting' | 'complex'
export type OcrDocumentHint = 'auto' | OcrDocumentType
export type OcrEngineProvider = 'paddle-local' | 'tencent-handwriting' | 'custom-http'
export type OcrCorrectionSource = 'secondary-engine' | 'dictionary' | 'terminology' | 'context-model' | 'human'

export interface OcrEngineConfig {
  id: string
  label: string
  provider: OcrEngineProvider
  model?: string
  /** Remote engines only. Credentials are referenced by name and never stored here. */
  endpoint?: string
  credentialRef?: string
  enabled: boolean
}

export interface OcrPreprocessConfig {
  orientationDetection: boolean
  perspectiveCorrection: boolean
  shadowRemoval: boolean
  autoCrop: boolean
  clarityEnhancement: boolean
}

export interface OcrPipelineConfig {
  documentHint: OcrDocumentHint
  preprocess: OcrPreprocessConfig
  routes: Record<OcrDocumentType, OcrEngineConfig>
  /** Optional second engine used only for low-confidence regions. */
  fallbackEngine?: OcrEngineConfig
  fallbackConfidence: number
  reviewConfidence: number
  language: string
  dictionaries: string[]
}

export const LOCAL_OCR_ENGINES: Record<OcrDocumentType, OcrEngineConfig> = {
  printed: {
    id: 'pp-ocr-v6-medium',
    label: 'PP-OCRv6 Medium',
    provider: 'paddle-local',
    model: 'PP-OCRv6_medium',
    enabled: true,
  },
  handwriting: {
    id: 'pp-ocr-v5-server-rec',
    label: 'PP-OCRv5 Server 手写识别',
    provider: 'paddle-local',
    model: 'PP-OCRv5_server_rec',
    enabled: true,
  },
  complex: {
    id: 'paddleocr-vl-1.6',
    label: 'PaddleOCR-VL 1.6',
    provider: 'paddle-local',
    model: 'PaddleOCR-VL-1.6',
    enabled: true,
  },
}

export const DEFAULT_OCR_PIPELINE_CONFIG: OcrPipelineConfig = {
  documentHint: 'auto',
  preprocess: {
    orientationDetection: true,
    perspectiveCorrection: true,
    shadowRemoval: true,
    autoCrop: true,
    clarityEnhancement: true,
  },
  routes: {
    printed: { ...LOCAL_OCR_ENGINES.printed },
    handwriting: { ...LOCAL_OCR_ENGINES.handwriting },
    complex: { ...LOCAL_OCR_ENGINES.complex },
  },
  fallbackConfidence: 0.78,
  reviewConfidence: 0.62,
  language: 'zh-Hans',
  dictionaries: ['common-zh'],
}

export interface OcrDocumentSignals {
  handwritingScore?: number
  complexLayoutScore?: number
  columnCount?: number
  hasTable?: boolean
  hasFormula?: boolean
}

export type OcrPreprocessStage =
  | 'orientation-detection'
  | 'perspective-correction'
  | 'shadow-removal'
  | 'auto-crop'
  | 'clarity-enhancement'

export interface OcrExecutionPlan {
  documentType: OcrDocumentType
  preprocess: OcrPreprocessStage[]
  primaryEngine: OcrEngineConfig
  fallbackEngine?: OcrEngineConfig
  fallbackConfidence: number
  reviewConfidence: number
}

export type OcrPreprocessHandler<T> = (input: T, signal?: AbortSignal) => T | Promise<T>

/** Runs only enabled stages in the production order; CV implementations are injected by Electron. */
export async function runOcrPreprocessPlan<T>(
  input: T,
  stages: readonly OcrPreprocessStage[],
  handlers: Partial<Record<OcrPreprocessStage, OcrPreprocessHandler<T>>>,
  signal?: AbortSignal,
): Promise<T> {
  let output = input
  for (const stage of stages) {
    if (signal?.aborted) throw new DOMException('OCR preprocessing cancelled', 'AbortError')
    const handler = handlers[stage]
    if (handler) output = await handler(output, signal)
  }
  return output
}

const confidence = (value: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback

/** Classifies conservatively: structured layouts take priority over handwriting. */
export function classifyOcrDocument(signals: OcrDocumentSignals = {}): OcrDocumentType {
  if (signals.hasTable || signals.hasFormula || (signals.columnCount ?? 1) > 1
    || confidence(signals.complexLayoutScore ?? 0, 0) >= 0.55) return 'complex'
  if (confidence(signals.handwritingScore ?? 0, 0) >= 0.55) return 'handwriting'
  return 'printed'
}

export function createOcrExecutionPlan(
  signals: OcrDocumentSignals = {},
  config: OcrPipelineConfig = DEFAULT_OCR_PIPELINE_CONFIG,
): OcrExecutionPlan {
  const documentType = config.documentHint === 'auto'
    ? classifyOcrDocument(signals)
    : config.documentHint
  const stageMap: Array<[keyof OcrPreprocessConfig, OcrPreprocessStage]> = [
    ['orientationDetection', 'orientation-detection'],
    ['perspectiveCorrection', 'perspective-correction'],
    ['shadowRemoval', 'shadow-removal'],
    ['autoCrop', 'auto-crop'],
    ['clarityEnhancement', 'clarity-enhancement'],
  ]
  const primaryEngine = config.routes[documentType]
  if (!primaryEngine?.enabled) throw new Error(`OCR engine is disabled for ${documentType}`)
  return {
    documentType,
    preprocess: stageMap.flatMap(([key, stage]) => config.preprocess[key] ? [stage] : []),
    primaryEngine,
    fallbackEngine: config.fallbackEngine?.enabled ? config.fallbackEngine : undefined,
    fallbackConfidence: confidence(config.fallbackConfidence, DEFAULT_OCR_PIPELINE_CONFIG.fallbackConfidence),
    reviewConfidence: confidence(config.reviewConfidence, DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence),
  }
}

export interface OcrTokenBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OcrRawToken {
  id: string
  text: string
  confidence: number
  box?: OcrTokenBox
  /** Exact whitespace/newline emitted after this token by the OCR engine. */
  separatorAfter?: string
  candidates?: Array<{ text: string; confidence: number }>
}

export interface OcrCorrection {
  tokenId: string
  replacement: string
  source: OcrCorrectionSource
  confidence?: number
  note?: string
}

export interface OcrResolvedToken extends OcrRawToken {
  rawText: string
  correctedText: string
  correctedConfidence: number
  correction?: OcrCorrection
}

export interface OcrReviewCandidate {
  tokenId: string
  rawText: string
  confidence: number
  box?: OcrTokenBox
  candidates: Array<{ text: string; confidence: number }>
  /** Deliberately local context; never a whole-page or whole-document rewrite request. */
  context: { before: string; after: string }
}

export interface OcrPipelineResult {
  rawText: string
  correctedText: string
  confidence: number
  tokens: OcrResolvedToken[]
  reviewQueue: OcrReviewCandidate[]
  documentType: OcrDocumentType
  enginesUsed: string[]
  createdAt: string
}

export function createOcrReviewQueue(
  tokens: readonly OcrRawToken[],
  threshold = DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence,
): OcrReviewCandidate[] {
  const limit = confidence(threshold, DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence)
  return tokens.flatMap((token, index) => confidence(token.confidence, 0) < limit ? [{
    tokenId: token.id,
    rawText: token.text,
    confidence: confidence(token.confidence, 0),
    box: token.box,
    candidates: (token.candidates ?? []).map((candidate) => ({
      text: candidate.text,
      confidence: confidence(candidate.confidence, 0),
    })),
    context: {
      before: tokens[index - 1]?.text ?? '',
      after: tokens[index + 1]?.text ?? '',
    },
  }] : [])
}

/** Regions safe to send to a second OCR engine; callers crop images from these boxes. */
export function createOcrFallbackQueue(
  tokens: readonly OcrRawToken[],
  threshold = DEFAULT_OCR_PIPELINE_CONFIG.fallbackConfidence,
): OcrReviewCandidate[] {
  return createOcrReviewQueue(tokens, threshold)
}

/**
 * Applies token-level corrections only. Automated sources cannot alter tokens
 * above the review threshold; human review may intentionally override any token.
 */
export function applyOcrCorrections(
  tokens: readonly OcrRawToken[],
  corrections: readonly OcrCorrection[],
  reviewThreshold = DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence,
  fallbackThreshold = DEFAULT_OCR_PIPELINE_CONFIG.fallbackConfidence,
): OcrResolvedToken[] {
  const byId = new Map(tokens.map((token) => [token.id, token]))
  const accepted = new Map<string, OcrCorrection>()
  const reviewLimit = confidence(reviewThreshold, DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence)
  const fallbackLimit = confidence(fallbackThreshold, DEFAULT_OCR_PIPELINE_CONFIG.fallbackConfidence)
  for (const correction of corrections) {
    const token = byId.get(correction.tokenId)
    if (!token) throw new Error(`Unknown OCR token: ${correction.tokenId}`)
    if (!correction.replacement.trim()) throw new Error(`OCR correction cannot be empty: ${correction.tokenId}`)
    const automaticLimit = correction.source === 'secondary-engine' ? fallbackLimit : reviewLimit
    if (correction.source !== 'human' && confidence(token.confidence, 0) >= automaticLimit) {
      throw new Error(`Automated correction rejected for high-confidence token: ${correction.tokenId}`)
    }
    accepted.set(correction.tokenId, correction)
  }
  return tokens.map((token) => {
    const correction = accepted.get(token.id)
    return {
      ...token,
      confidence: confidence(token.confidence, 0),
      rawText: token.text,
      correctedText: correction?.replacement ?? token.text,
      correctedConfidence: correction
        ? confidence(correction.confidence ?? token.confidence, confidence(token.confidence, 0))
        : confidence(token.confidence, 0),
      correction,
    }
  })
}

const joinTokens = (tokens: readonly OcrResolvedToken[], key: 'rawText' | 'correctedText') =>
  tokens.map((token) => token[key] + (token.separatorAfter ?? '')).join('')

export function createOcrPipelineResult(options: {
  tokens: readonly OcrRawToken[]
  corrections?: readonly OcrCorrection[]
  documentType: OcrDocumentType
  enginesUsed: string[]
  reviewThreshold?: number
  fallbackThreshold?: number
  createdAt?: string
}): OcrPipelineResult {
  const reviewThreshold = options.reviewThreshold ?? DEFAULT_OCR_PIPELINE_CONFIG.reviewConfidence
  const tokens = applyOcrCorrections(
    options.tokens,
    options.corrections ?? [],
    reviewThreshold,
    options.fallbackThreshold,
  )
  const averageConfidence = tokens.length
    ? tokens.reduce((sum, token) => sum + token.correctedConfidence, 0) / tokens.length
    : 0
  return {
    rawText: joinTokens(tokens, 'rawText'),
    correctedText: joinTokens(tokens, 'correctedText'),
    confidence: averageConfidence,
    tokens,
    reviewQueue: createOcrReviewQueue(options.tokens, reviewThreshold),
    documentType: options.documentType,
    enginesUsed: [...new Set(options.enginesUsed)],
    createdAt: options.createdAt ?? new Date().toISOString(),
  }
}
