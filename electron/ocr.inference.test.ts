import { beforeAll, describe, expect, it, vi } from 'vitest'

// OCR only needs these Electron app properties to locate development models.
// Mocking them keeps this a normal Node/Vitest test instead of launching Electron.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}))

const GLYPHS: Record<string, readonly string[]> = {
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
}

/** Draw deterministic black text without Canvas or an image decoder. */
function makeOcrFixture(text = 'OCR TEST 123') {
  const scale = 12
  const margin = 30
  const characterWidth = 6 * scale
  const width = margin * 2 + text.length * characterWidth
  const height = margin * 2 + 7 * scale
  const data = new Uint8Array(width * height * 4)
  data.fill(255)

  for (const [characterIndex, character] of [...text].entries()) {
    const rows = GLYPHS[character]
    if (!rows) continue
    for (const [rowIndex, row] of rows.entries()) {
      for (const [columnIndex, pixel] of [...row].entries()) {
        if (pixel !== '1') continue
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const pixelIndex = (
              (margin + rowIndex * scale + y) * width
              + margin + characterIndex * characterWidth + columnIndex * scale + x
            ) * 4
            data[pixelIndex] = 0
            data[pixelIndex + 1] = 0
            data[pixelIndex + 2] = 0
          }
        }
      }
    }
  }

  return { width, height, data }
}

describe('local OCR inference', () => {
  let recognizeOcrPage: typeof import('./ocr').recognizeOcrPage

  beforeAll(async () => {
    ;({ recognizeOcrPage } = await import('./ocr'))
  })

  it('loads the shipped models and recognizes a non-empty page', async () => {
    const result = await recognizeOcrPage({ ...makeOcrFixture(), mode: 'printed' })

    expect(result.text).toBe('OCR TEST 123')
    expect(result.items.map(({ text }) => text)).toEqual(['OCR', 'TEST', '123'])
    expect(result.confidence).toBeGreaterThan(0.99)
  }, 30_000)
})
