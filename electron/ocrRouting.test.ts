import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { applyTokenCorrections, classifyDetectedDocument, type OcrTextItem } from './ocr'

const item = (text: string, confidence: number, x: number, y: number, width = 120, height = 24): OcrTextItem => ({
  text,
  confidence,
  box: { x, y, width, height, points: [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ] },
})

describe('OCR production routing', () => {
  it('detects a two-column layout but keeps ordinary text on the printed route', () => {
    const columns = [0, 1, 2].flatMap((row) => [
      item(`左${row}`, 0.95, 80, 80 + row * 50),
      item(`右${row}`, 0.95, 620, 80 + row * 50),
    ])
    expect(classifyDetectedDocument(columns, 900)).toBe('complex')
    expect(classifyDetectedDocument([
      item('标题', 0.98, 80, 60, 400), item('正文一', 0.96, 80, 110, 500), item('正文二', 0.97, 80, 160, 480),
    ], 900)).toBe('printed')
  })

  it('changes only the intended duplicate low-confidence token', () => {
    const items = [
      { ...item('金额', 0.99, 0, 0), rawText: '金额', correctedText: '金额' },
      { ...item('金额', 0.42, 0, 30), rawText: '金额', correctedText: '金額' },
    ]
    expect(applyTokenCorrections('金额 金额', items)).toBe('金额 金額')
  })
})
