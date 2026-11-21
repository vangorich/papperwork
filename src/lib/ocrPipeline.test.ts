import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OCR_PIPELINE_CONFIG,
  applyOcrCorrections,
  classifyOcrDocument,
  createOcrExecutionPlan,
  createOcrPipelineResult,
  createOcrReviewQueue,
  runOcrPreprocessPlan,
  type OcrRawToken,
} from './ocrPipeline'

const tokens: OcrRawToken[] = [
  { id: 'a', text: '合同', confidence: 0.98, separatorAfter: '' },
  { id: 'b', text: '全额', confidence: 0.41, separatorAfter: '，', candidates: [{ text: '金额', confidence: 0.8 }] },
  { id: 'c', text: '100.00', confidence: 0.99 },
]

describe('OCR production routing', () => {
  it('routes complex pages before handwriting and keeps preprocessing order', () => {
    expect(classifyOcrDocument({ handwritingScore: 0.9, hasTable: true })).toBe('complex')
    expect(classifyOcrDocument({ handwritingScore: 0.8 })).toBe('handwriting')
    expect(classifyOcrDocument()).toBe('printed')
    const plan = createOcrExecutionPlan({ columnCount: 2 })
    expect(plan.primaryEngine.model).toBe('PaddleOCR-VL-1.6')
    expect(plan.preprocess).toEqual([
      'orientation-detection',
      'perspective-correction',
      'shadow-removal',
      'auto-crop',
      'clarity-enhancement',
    ])
  })

  it('supports a configured Tencent handwriting route without storing credentials', () => {
    const plan = createOcrExecutionPlan({}, {
      ...DEFAULT_OCR_PIPELINE_CONFIG,
      documentHint: 'handwriting',
      routes: {
        ...DEFAULT_OCR_PIPELINE_CONFIG.routes,
        handwriting: {
          id: 'tencent-handwriting',
          label: '腾讯手写 OCR',
          provider: 'tencent-handwriting',
          endpoint: 'https://example.invalid/ocr',
          credentialRef: 'windows-credential:tencent-ocr',
          enabled: true,
        },
      },
    })
    expect(plan.primaryEngine.provider).toBe('tencent-handwriting')
    expect(plan.primaryEngine).not.toHaveProperty('secretId')
  })

  it('runs injected image preprocessors in production order', async () => {
    const plan = createOcrExecutionPlan()
    const visited: string[] = []
    const result = await runOcrPreprocessPlan('pixels', plan.preprocess, {
      'orientation-detection': (value) => { visited.push('orientation'); return `${value}:rotated` },
      'auto-crop': (value) => { visited.push('crop'); return `${value}:cropped` },
    })
    expect(visited).toEqual(['orientation', 'crop'])
    expect(result).toBe('pixels:rotated:cropped')
  })
})

describe('OCR review safety', () => {
  it('shares only the low-confidence token and adjacent local context', () => {
    expect(createOcrReviewQueue(tokens, 0.62)).toEqual([expect.objectContaining({
      tokenId: 'b',
      rawText: '全额',
      context: { before: '合同', after: '100.00' },
    })])
  })

  it('rejects automated changes to high-confidence content', () => {
    expect(() => applyOcrCorrections(tokens, [{
      tokenId: 'c', replacement: '900.00', source: 'context-model',
    }], 0.62)).toThrow('high-confidence token')
  })

  it('allows a secondary engine to resolve the wider fallback confidence band', () => {
    const mediumConfidence = [{ id: 'm', text: '未', confidence: 0.7 }]
    expect(applyOcrCorrections(mediumConfidence, [{
      tokenId: 'm', replacement: '末', source: 'secondary-engine', confidence: 0.91,
    }], 0.62, 0.78)[0].correctedText).toBe('末')
  })

  it('preserves raw and corrected text, confidence, and review candidates', () => {
    const result = createOcrPipelineResult({
      tokens,
      corrections: [{ tokenId: 'b', replacement: '金额', source: 'human', confidence: 0.96 }],
      documentType: 'printed',
      enginesUsed: ['pp-ocr-v6-medium', 'pp-ocr-v6-medium'],
      createdAt: '2026-07-30T00:00:00.000Z',
    })
    expect(result.rawText).toBe('合同全额，100.00')
    expect(result.correctedText).toBe('合同金额，100.00')
    expect(result.tokens[1]).toMatchObject({ rawText: '全额', correctedText: '金额', correctedConfidence: 0.96 })
    expect(result.reviewQueue.map(({ tokenId }) => tokenId)).toEqual(['b'])
    expect(result.enginesUsed).toEqual(['pp-ocr-v6-medium'])
  })
})
