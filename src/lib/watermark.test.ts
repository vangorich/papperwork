import { describe, expect, it } from 'vitest'
import { clampWatermarkBox, removeWatermarkBackground, watermarkPdfPlacement, watermarkTileBoxes } from './watermark'

describe('watermark background removal', () => {
  it('removes only edge-connected gray matte and preserves artwork alpha', () => {
    const pixels = new Uint8ClampedArray([
      232, 232, 232, 255, 232, 232, 232, 255, 232, 232, 232, 255,
      232, 232, 232, 255, 190, 24, 32, 128, 232, 232, 232, 255,
      232, 232, 232, 255, 232, 232, 232, 255, 232, 232, 232, 255,
    ])

    const result = removeWatermarkBackground(pixels, 3, 3)

    expect([result[3], result[7], result[11], result[15], result[23]]).toEqual([0, 0, 0, 0, 0])
    expect(Array.from(result.slice(16, 20))).toEqual([190, 24, 32, 128])
  })

  it('does not erase a colored image or alter existing transparent pixels', () => {
    const colored = new Uint8ClampedArray([
      30, 80, 160, 90, 30, 80, 160, 255,
      30, 80, 160, 255, 30, 80, 160, 255,
    ])
    expect(removeWatermarkBackground(colored, 2, 2)).toEqual(colored)
  })
})

describe('clampWatermarkBox', () => {
  it('keeps a single watermark fully inside the page', () => {
    expect(clampWatermarkBox({ x: 0.9, y: -0.2, width: 0.3, height: 0.1 })).toEqual({ x: 0.7, y: 0, width: 0.3, height: 0.1 })
  })

  it('enforces a minimum tile size', () => {
    const clamped = clampWatermarkBox({ x: 0.4, y: 0.4, width: 0.001, height: 0.001 })
    expect(clamped.width).toBeGreaterThanOrEqual(0.02)
    expect(clamped.height).toBeGreaterThanOrEqual(0.015)
  })
})

describe('watermarkTileBoxes', () => {
  it('returns the clamped single box when not tiled', () => {
    expect(watermarkTileBoxes({ tiled: false, x: 0.3, y: 0.4, width: 0.2, height: 0.1 })).toEqual([
      { x: 0.3, y: 0.4, width: 0.2, height: 0.1 },
    ])
  })

  it('covers the whole page from a tiled anchor and shares one box size', () => {
    const boxes = watermarkTileBoxes({ tiled: true, x: 0.05, y: 0.05, width: 0.2, height: 0.1, gapX: 0.1, gapY: 0.1 })
    expect(boxes.length).toBeGreaterThanOrEqual(20) // step 0.3 x 0.2 over the page plus bleed
    expect(boxes.every((box) => box.width === 0.2 && box.height === 0.1)).toBe(true)
    expect(Math.min(...boxes.map((box) => box.x))).toBeLessThanOrEqual(0)
    expect(Math.min(...boxes.map((box) => box.y))).toBeLessThanOrEqual(0)
    expect(Math.max(...boxes.map((box) => box.x))).toBeLessThan(1)
    expect(Math.max(...boxes.map((box) => box.y))).toBeLessThan(1)
  })

  it('treats anchor shifts modulo the grid step, so dragging any tile shifts all', () => {
    const base = watermarkTileBoxes({ tiled: true, x: 0.05, y: 0.05, width: 0.2, height: 0.1, gapX: 0.1, gapY: 0.1 })
    const shifted = watermarkTileBoxes({ tiled: true, x: 0.35, y: 0.25, width: 0.2, height: 0.1, gapX: 0.1, gapY: 0.1 })
    expect(shifted.length).toBe(base.length)
    shifted.forEach((box, index) => {
      expect(box.x).toBeCloseTo(base[index].x, 9)
      expect(box.y).toBeCloseTo(base[index].y, 9)
    })
  })

  it('survives degenerate tile sizes without runaway loops', () => {
    const boxes = watermarkTileBoxes({ tiled: true, x: 0, y: 0, width: 0.0001, height: 0.0001 })
    expect(boxes.length).toBeLessThanOrEqual(241)
  })
})

describe('watermarkPdfPlacement', () => {
  it('maps an unrotated box to pdf-lib bottom-left coordinates', () => {
    expect(watermarkPdfPlacement({ x: 0.25, y: 0.2, width: 0.5, height: 0.1 }, 600, 800, 0)).toEqual({
      x: 150,
      y: 560, // 1 - 0.2 - 0.1 of 800
      width: 300,
      height: 80,
      rotateDeg: -0,
    })
  })

  it('keeps the rotated box centered on the editor position', () => {
    const box = { x: 0.2, y: 0.3, width: 0.4, height: 0.1 }
    const pageWidth = 600
    const pageHeight = 800
    const placement = watermarkPdfPlacement(box, pageWidth, pageHeight, -28)
    // CSS -28deg (counterclockwise on screen) becomes PDF +28deg.
    expect(placement.rotateDeg).toBeCloseTo(28)
    // The anchor rotated back by the same angle must land on the box center.
    const centerX = (box.x + box.width / 2) * pageWidth
    const centerY = (1 - box.y - box.height / 2) * pageHeight
    const rad = (placement.rotateDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const recoveredX = placement.x + (cos * placement.width / 2 - sin * placement.height / 2)
    const recoveredY = placement.y + (sin * placement.width / 2 + cos * placement.height / 2)
    expect(recoveredX).toBeCloseTo(centerX, 6)
    expect(recoveredY).toBeCloseTo(centerY, 6)
  })
})
