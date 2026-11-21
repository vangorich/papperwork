import { describe, expect, it } from 'vitest'
import { preprocessOcrImage, type RgbaImage } from './ocrPreprocess'

function image(width: number, height: number, value = 255): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
    data[offset + 3] = 255
  }
  return { width, height, data }
}

function ink(input: RgbaImage, left: number, top: number, right: number, bottom: number) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * input.width + x) * 4
      input.data[offset] = input.data[offset + 1] = input.data[offset + 2] = 20
    }
  }
}

describe('OCR preprocessing', () => {
  it('does not mistake sparse upright title strokes for sideways text', () => {
    const source = image(400, 600)
    for (let x = 40; x < 296; x += 16) ink(source, x, 180, x + 3, 200)
    const result = preprocessOcrImage(source, {
      deskew: false, normalizeBackground: false, crop: false, sharpen: false,
    })
    const orientation = result.diagnostics[0]
    expect(orientation.metrics?.foreground).toBeGreaterThanOrEqual(40)
    expect(orientation.metrics?.columnScore).toBeGreaterThan(0.08)
    expect(orientation.metrics?.ratio).toBeGreaterThan(1.75)
    expect(orientation.metrics?.concentrationRatio).toBeLessThan(1)
    expect(orientation.status).toBe('skipped')
    expect([result.image.width, result.image.height]).toEqual([400, 600])
    expect(Buffer.from(result.image.data).equals(Buffer.from(source.data))).toBe(true)
    expect(result.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  })

  it('still auto-rotates strongly column-aligned text', () => {
    const source = image(600, 400)
    for (let x = 100; x < 260; x += 16) ink(source, x, 40, x + 4, 340)
    const result = preprocessOcrImage(source, {
      deskew: false, normalizeBackground: false, crop: false, sharpen: false,
    })
    expect(result.diagnostics[0].status).toBe('applied')
    expect(result.diagnostics[0].metrics?.concentrationRatio).toBeGreaterThan(1)
    expect([result.image.width, result.image.height]).toEqual([400, 600])
    const point = { x: 120, y: 80 }
    expect(result.mapping.processedToOriginal(result.mapping.originalToProcessed(point))).toEqual(point)
  })

  it('rotates without losing the coordinate mapping', () => {
    const source = image(8, 5)
    const result = preprocessOcrImage(source, {
      orientation: 'clockwise', deskew: false, normalizeBackground: false, crop: false, sharpen: false,
    })
    expect([result.image.width, result.image.height]).toEqual([5, 8])
    const processed = result.mapping.originalToProcessed({ x: 2, y: 3 })
    expect(processed).toEqual({ x: 2, y: 2 })
    expect(result.mapping.processedToOriginal(processed)).toEqual({ x: 2, y: 3 })
  })

  it('crops conservatively and maps OCR boxes back to the source', () => {
    const source = image(20, 20)
    ink(source, 5, 4, 15, 16)
    const result = preprocessOcrImage(source, {
      orientation: 'none', deskew: false, normalizeBackground: false, sharpen: false,
      cropMargin: 0, maxCropFraction: 0.45,
    })
    expect([result.image.width, result.image.height]).toEqual([10, 12])
    const mapped = result.mapping.boxToOriginal({ x: 0, y: 0, width: 10, height: 12 })
    expect(mapped).toMatchObject({ x: 5, y: 4, width: 10, height: 12 })
  })

  it('normalizes uneven paper while preserving darker ink', () => {
    const source = image(128, 64, 175)
    ink(source, 28, 20, 100, 44)
    const result = preprocessOcrImage(source, {
      orientation: 'none', deskew: false, crop: false, sharpen: false,
    })
    expect(result.image.data[0]).toBeGreaterThan(245)
    expect(result.image.data[(30 * source.width + 50) * 4]).toBeLessThan(100)
  })
})
