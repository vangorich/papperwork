/**
 * Removes only a uniform, light background connected to the image edges.
 * Existing alpha is multiplied rather than replaced, so transparent seals
 * and antialiased artwork keep their original transparency.
 */
export function removeWatermarkBackground(
  input: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const pixels = new Uint8ClampedArray(input)
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) return pixels

  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
    .map((offset) => offset * 4)
    .filter((offset) => pixels[offset + 3] > 220)
    .map((offset) => [pixels[offset], pixels[offset + 1], pixels[offset + 2]] as const)
  if (corners.length < 3) return pixels

  const median = (channel: number) => [...corners].sort((a, b) => a[channel] - b[channel])[Math.floor(corners.length / 2)][channel]
  const background = [median(0), median(1), median(2)] as const
  if (Math.min(...background) < 175 || Math.max(...background) - Math.min(...background) > 28) return pixels
  if (corners.filter((color) => Math.hypot(...color.map((value, channel) => value - background[channel])) < 22).length < 3) return pixels

  const connected = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  const visit = (index: number) => {
    if (connected[index]) return
    const offset = index * 4
    const distance = Math.hypot(
      pixels[offset] - background[0],
      pixels[offset + 1] - background[1],
      pixels[offset + 2] - background[2],
    )
    if (distance > 54) return
    connected[index] = 1
    queue[tail++] = index
    // Keep antialiased edges while fading the uniform matte to transparent.
    pixels[offset + 3] = Math.round(pixels[offset + 3] * Math.max(0, (distance - 12) / 42))
  }
  for (let x = 0; x < width; x += 1) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(y * width)
    visit(y * width + width - 1)
  }
  while (head < tail) {
    const index = queue[head++]
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) visit(index - 1)
    if (x + 1 < width) visit(index + 1)
    if (y > 0) visit(index - width)
    if (y + 1 < height) visit(index + width)
  }
  return pixels
}

export async function prepareWatermarkImage(dataUrl: string) {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  // Watermarks are drawn at at most 280 PDF points; 2048 px avoids a large
  // temporary RGBA/queue allocation without reducing visible export quality.
  const scale = Math.min(1, 2048 / image.naturalWidth, 2048 / image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法创建水印处理画布')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  imageData.data.set(removeWatermarkBackground(imageData.data, canvas.width, canvas.height))
  context.putImageData(imageData, 0, 0)
  const result = canvas.toDataURL('image/png')
  canvas.width = 1
  canvas.height = 1
  return result
}

// ---------------------------------------------------------------------------
// Interactive document watermark: shared geometry used by both the on-page
// editing layer and the pdf-lib export burn-in, so what you see is exported.
// ---------------------------------------------------------------------------

import type { DocumentWatermark } from '../types/pdf'

export interface WatermarkBox {
  x: number
  y: number
  width: number
  height: number
}

const MAX_TILES = 240

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export function clampWatermarkBox(box: WatermarkBox): WatermarkBox {
  const width = Math.max(0.02, Math.min(1, box.width))
  const height = Math.max(0.015, Math.min(1, box.height))
  return {
    width,
    height,
    x: Math.max(0, Math.min(1 - width, box.x)),
    y: Math.max(0, Math.min(1 - height, box.y)),
  }
}

/**
 * Canonical template anchor for a tiled watermark, phase-wrapped into
 * (−step, 0]. watermarkTileBoxes wraps x/y modulo the grid step for display,
 * so remapping a drifted anchor (e.g. after dragging the pattern a full page)
 * to this range changes nothing on screen — and keeps resize clamps sane.
 */
export function wrapTiledWatermarkAnchor(watermark: Pick<DocumentWatermark, 'x' | 'y' | 'width' | 'height' | 'gapX' | 'gapY'>) {
  const stepX = Math.max(0.03, watermark.width + (watermark.gapX ?? 0.09))
  const stepY = Math.max(0.025, watermark.height + (watermark.gapY ?? 0.11))
  return {
    x: ((watermark.x % stepX) + stepX) % stepX - stepX,
    y: ((watermark.y % stepY) + stepY) % stepY - stepY,
  }
}

/**
 * Screen boxes for every watermark instance, normalized to the page.
 * Tiled watermarks repeat one box across the page; the anchor (x, y) is taken
 * modulo the grid step so dragging any tile shifts the whole pattern.
 */
export function watermarkTileBoxes(watermark: Pick<DocumentWatermark, 'tiled' | 'x' | 'y' | 'width' | 'height' | 'gapX' | 'gapY'>): WatermarkBox[] {
  if (!watermark.tiled) return [clampWatermarkBox(watermark)]
  const stepX = Math.max(0.03, watermark.width + (watermark.gapX ?? 0.09))
  const stepY = Math.max(0.025, watermark.height + (watermark.gapY ?? 0.11))
  // Anchor phase in (-step, 0] so the grid always covers the top-left corner.
  const { x: phaseX, y: phaseY } = wrapTiledWatermarkAnchor(watermark)
  const boxes: WatermarkBox[] = []
  for (let row = 0; phaseY + row * stepY < 1 && boxes.length <= MAX_TILES; row += 1) {
    for (let column = 0; phaseX + column * stepX < 1 && boxes.length <= MAX_TILES; column += 1) {
      boxes.push({
        x: phaseX + column * stepX,
        y: phaseY + row * stepY,
        width: watermark.width,
        height: watermark.height,
      })
    }
  }
  return boxes
}

export interface WatermarkPdfPlacement {
  x: number
  y: number
  width: number
  height: number
  /** Degrees for pdf-lib (counterclockwise positive). */
  rotateDeg: number
}

/**
 * Converts a normalized screen box (top-left origin, y-down, CSS rotation
 * about the box center) into pdf-lib draw arguments (bottom-left origin,
 * y-up). pdf-lib rotates the image about the (x, y) anchor, so the anchor is
 * chosen such that the rotated box is centered exactly where the editor
 * showed it. CSS clockwise degrees become counterclockwise PDF degrees
 * because the y axis flips.
 */
export function watermarkPdfPlacement(
  box: WatermarkBox,
  pageWidth: number,
  pageHeight: number,
  rotationDeg: number,
): WatermarkPdfPlacement {
  const width = box.width * pageWidth
  const height = box.height * pageHeight
  const centerX = (box.x + box.width / 2) * pageWidth
  const centerY = (1 - box.y - box.height / 2) * pageHeight
  const rotateDeg = -rotationDeg
  const rad = (rotateDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: centerX - (cos * width / 2 - sin * height / 2),
    y: centerY - (sin * width / 2 + cos * height / 2),
    width,
    height,
    rotateDeg,
  }
}

/**
 * Rasterizes watermark text to a transparent PNG for CJK-safe pdf-lib export
 * (pdf-lib's built-in fonts are WinAnsi-only). The returned image's aspect
 * ratio matches the text so export can stretch it into any tile box exactly
 * like the editor's CSS transform does.
 */
export function watermarkFont(px:number, options:{fontFamily?:string;bold?:boolean;italic?:boolean}={}) {
  const family=(options.fontFamily || 'Microsoft YaHei').replace(/["\\\n\r]/g,'').slice(0,96)
  return `${options.italic?'italic ':''}${options.bold===false?400:700} ${px}px "${family}", "PingFang SC", sans-serif`
}
export function rasterizeWatermarkText(text: string, options: { color?: string; bold?: boolean;italic?:boolean;fontFamily?:string } = {}) {
  const font = watermarkFont(96,options)
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const metrics = measure.measureText(text || '水印')
  const padX = 28
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(64, Math.ceil(metrics.width + padX * 2))
  canvas.height = Math.max(48, Math.ceil(96 * 1.45))
  const context = canvas.getContext('2d')!
  context.font = font
  context.fillStyle = options.color ?? '#263d4d'
  context.textBaseline = 'middle'
  context.fillText(text || '水印', padX, canvas.height / 2)
  const result = canvas.toDataURL('image/png')
  canvas.width = 1
  canvas.height = 1
  return result
}

/** Natural (unstretched) text box in points, for initial placement sizing. */
export function measureWatermarkText(text: string, fontSize: number, bold = true,fontFamily?:string,italic?:boolean) {
  const font = watermarkFont(fontSize*2,{bold,fontFamily,italic})
  const context = document.createElement('canvas').getContext('2d')!
  context.font = font
  const width = Math.max(24, context.measureText(text || '水印').width / 2 + fontSize * 0.5833)
  return { width, height: fontSize * 1.45 }
}
