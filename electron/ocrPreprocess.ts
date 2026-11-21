export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

export interface ImagePoint {
  x: number
  y: number
}

export interface OcrImageBox {
  x: number
  y: number
  width: number
  height: number
  points?: [ImagePoint, ImagePoint, ImagePoint, ImagePoint]
  polygon?: ImagePoint[]
  [key: string]: unknown
}

export type OrientationMode = 'auto' | 'none' | 'clockwise' | 'counterclockwise'

export interface OcrPreprocessOptions {
  orientation?: OrientationMode
  deskew?: boolean
  normalizeBackground?: boolean
  crop?: boolean
  sharpen?: boolean
  /** Small-angle correction ceiling. Values above 6 degrees are intentionally rejected. */
  maxDeskewDegrees?: number
  /** Extra pixels retained around detected content. Defaults to 2% of the shortest side. */
  cropMargin?: number
  /** Prevents content-only cropping from consuming large, intentional page margins. */
  maxCropFraction?: number
}

export interface PreprocessDiagnostic {
  stage: 'orientation' | 'perspective' | 'background' | 'crop' | 'sharpen'
  status: 'applied' | 'skipped'
  message: string
  metrics?: Record<string, number | string | boolean>
}

export interface AffineTransform {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface GeometryMapping {
  /** Original-image coordinates to the preprocessed OCR bitmap. */
  originalToProcessed(point: ImagePoint): ImagePoint
  /** OCR bitmap coordinates back to the unmodified source image. */
  processedToOriginal(point: ImagePoint): ImagePoint
  /** Maps a PaddleOCR-style box back and recomputes its axis-aligned bounds. */
  boxToOriginal<T extends OcrImageBox>(box: T): T
}

export interface OcrPreprocessResult {
  image: RgbaImage
  mapping: GeometryMapping
  /** Original-to-processed matrix, useful when crossing an IPC boundary. */
  transform: AffineTransform
  inverseTransform: AffineTransform
  diagnostics: PreprocessDiagnostic[]
}

const IDENTITY: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const MAX_PIXELS = 20_000_000
const ORIENTATION_SAMPLE_PIXELS = 500_000
const DESKEW_SAMPLE_PIXELS = 160_000

function validateImage(input: RgbaImage) {
  if (!input || !Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width <= 0 || input.height <= 0) {
    throw new Error('OCR preprocessing requires positive integer dimensions')
  }
  const pixels = input.width * input.height
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new Error(`OCR preprocessing exceeds the ${MAX_PIXELS.toLocaleString()} pixel limit`)
  }
  if (!ArrayBuffer.isView(input.data) || input.data.byteLength !== pixels * 4) {
    throw new Error('OCR preprocessing requires exact RGBA pixel data')
  }
}

function luminance(data: Uint8Array, offset: number) {
  const opaque = (77 * data[offset] + 150 * data[offset + 1] + 29 * data[offset + 2]) >>> 8
  const alpha = data[offset + 3]
  return alpha === 255 ? opaque : Math.round((opaque * alpha + 255 * (255 - alpha)) / 255)
}

function multiply(after: AffineTransform, before: AffineTransform): AffineTransform {
  return {
    a: after.a * before.a + after.c * before.b,
    b: after.b * before.a + after.d * before.b,
    c: after.a * before.c + after.c * before.d,
    d: after.b * before.c + after.d * before.d,
    e: after.a * before.e + after.c * before.f + after.e,
    f: after.b * before.e + after.d * before.f + after.f,
  }
}

function invert(matrix: AffineTransform): AffineTransform {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (Math.abs(determinant) < 1e-12) throw new Error('OCR preprocessing produced a non-invertible transform')
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  }
}

function mapPoint(matrix: AffineTransform, point: ImagePoint): ImagePoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

function createMapping(transform: AffineTransform): GeometryMapping & { inverse: AffineTransform } {
  const inverse = invert(transform)
  return {
    inverse,
    originalToProcessed: (point) => mapPoint(transform, point),
    processedToOriginal: (point) => mapPoint(inverse, point),
    boxToOriginal: <T extends OcrImageBox>(box: T) => {
      const sourcePoints = box.points ?? [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ]
      const points = sourcePoints.map((point) => mapPoint(inverse, point)) as [
        ImagePoint, ImagePoint, ImagePoint, ImagePoint,
      ]
      const polygon = box.polygon?.map((point) => mapPoint(inverse, point))
      const bounds = polygon?.length ? polygon : points
      const xs = bounds.map(({ x }) => x)
      const ys = bounds.map(({ y }) => y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return {
        ...box,
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
        points,
        ...(polygon ? { polygon } : {}),
      }
    },
  }
}

function projectionRoughness(values: Float64Array) {
  let total = 0
  let difference = 0
  for (let index = 0; index < values.length; index += 1) {
    total += values[index]
    if (index) difference += Math.abs(values[index] - values[index - 1])
  }
  return difference / Math.max(1, total)
}

function detectQuarterTurn(image: RgbaImage) {
  const stride = Math.max(1, Math.ceil(Math.sqrt(image.width * image.height / ORIENTATION_SAMPLE_PIXELS)))
  const rows = new Float64Array(Math.ceil(image.height / stride))
  const columns = new Float64Array(Math.ceil(image.width / stride))
  let foreground = 0
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const darkness = 210 - luminance(image.data, (y * image.width + x) * 4)
      if (darkness <= 0) continue
      rows[Math.floor(y / stride)] += darkness
      columns[Math.floor(x / stride)] += darkness
      foreground += 1
    }
  }
  const rowScore = projectionRoughness(rows)
  const columnScore = projectionRoughness(columns)
  const ratio = columnScore / Math.max(rowScore, 1e-9)
  // Glyph strokes can make columns rougher even on an upright, sparse cover.
  // Require the ink to be more concentrated into columns as well; roughness
  // alone mistakes widely spaced characters in a horizontal title for lines.
  const rowEnergy = rows.reduce((sum, value) => sum + value * value, 0)
  const columnEnergy = columns.reduce((sum, value) => sum + value * value, 0)
  const concentrationRatio = columnEnergy / Math.max(rowEnergy, 1)
  return {
    rotate: foreground >= 40 && columnScore > 0.08 && ratio >= 1.75 && concentrationRatio > 1,
    rowScore,
    columnScore,
    ratio,
    concentrationRatio,
    foreground,
  }
}

function rotateQuarter(image: RgbaImage, clockwise: boolean): { image: RgbaImage; transform: AffineTransform } {
  const output = new Uint8Array(image.data.byteLength)
  const targetWidth = image.height
  const targetHeight = image.width
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const targetX = clockwise ? image.height - 1 - y : y
      const targetY = clockwise ? x : image.width - 1 - x
      const source = (y * image.width + x) * 4
      const target = (targetY * targetWidth + targetX) * 4
      output[target] = image.data[source]
      output[target + 1] = image.data[source + 1]
      output[target + 2] = image.data[source + 2]
      output[target + 3] = image.data[source + 3]
    }
  }
  return {
    image: { width: targetWidth, height: targetHeight, data: output },
    // Coordinates describe pixel edges; this is the convention used by OCR boxes.
    transform: clockwise
      ? { a: 0, b: 1, c: -1, d: 0, e: image.height, f: 0 }
      : { a: 0, b: -1, c: 1, d: 0, e: 0, f: image.width },
  }
}

function projectionScore(points: Int32Array, angleDegrees: number, width: number, height: number) {
  const radians = angleDegrees * Math.PI / 180
  const sine = Math.sin(radians)
  const cosine = Math.cos(radians)
  const bins = new Uint32Array(height + Math.ceil(Math.abs(sine) * width) + 8)
  const centerY = height / 2
  const offset = (bins.length - height) / 2
  for (let index = 0; index < points.length; index += 2) {
    const projectedY = sine * points[index] + cosine * (points[index + 1] - centerY) + centerY + offset
    const bin = Math.round(projectedY)
    if (bin >= 0 && bin < bins.length) bins[bin] += 1
  }
  let score = 0
  for (const count of bins) score += count * count
  return score
}

function detectDeskew(image: RgbaImage, maximum: number) {
  const stride = Math.max(1, Math.ceil(Math.sqrt(image.width * image.height / DESKEW_SAMPLE_PIXELS)))
  const coordinates: number[] = []
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      if (luminance(image.data, (y * image.width + x) * 4) < 180) coordinates.push(x - image.width / 2, y)
    }
  }
  if (coordinates.length < 160) return { angle: 0, improvement: 0, samples: coordinates.length / 2 }
  const points = Int32Array.from(coordinates)
  const baseline = projectionScore(points, 0, image.width, image.height)
  let bestScore = baseline
  let bestAngle = 0
  for (let angle = -maximum; angle <= maximum + 1e-6; angle += 0.5) {
    if (Math.abs(angle) < 0.25) continue
    const score = projectionScore(points, angle, image.width, image.height)
    if (score > bestScore) {
      bestScore = score
      bestAngle = angle
    }
  }
  // Refine the coarse winner at 0.1° steps: the projection histogram is smooth
  // enough that ±0.4° around the 0.5° grid point brackets the true peak.
  if (bestAngle !== 0) {
    for (let step = -4; step <= 4; step += 1) {
      const angle = Math.round((bestAngle + step * 0.1) * 10) / 10
      if (Math.abs(angle) < 0.05 || Math.abs(angle) > maximum) continue
      const score = projectionScore(points, angle, image.width, image.height)
      if (score > bestScore) {
        bestScore = score
        bestAngle = angle
      }
    }
  }
  const improvement = (bestScore - baseline) / Math.max(1, baseline)
  // A high threshold is deliberate: a missed small skew is safer than rotating a diagram or invoice table.
  return { angle: improvement >= 0.07 && Math.abs(bestAngle) >= 0.5 ? bestAngle : 0, improvement, samples: points.length / 2 }
}

function rotateSmallAngle(image: RgbaImage, angleDegrees: number): { image: RgbaImage; transform: AffineTransform } {
  const radians = angleDegrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const centerX = image.width / 2
  const centerY = image.height / 2
  const transform: AffineTransform = {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: centerX - cosine * centerX + sine * centerY,
    f: centerY - sine * centerX - cosine * centerY,
  }
  const inverse = invert(transform)
  const output = new Uint8Array(image.data.byteLength)
  output.fill(255)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const sourceX = inverse.a * (x + 0.5) + inverse.c * (y + 0.5) + inverse.e - 0.5
      const sourceY = inverse.b * (x + 0.5) + inverse.d * (y + 0.5) + inverse.f - 0.5
      if (sourceX < 0 || sourceY < 0 || sourceX >= image.width - 1 || sourceY >= image.height - 1) continue
      const x0 = Math.floor(sourceX)
      const y0 = Math.floor(sourceY)
      const xWeight = sourceX - x0
      const yWeight = sourceY - y0
      const target = (y * image.width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = image.data[(y0 * image.width + x0) * 4 + channel]
        const topRight = image.data[(y0 * image.width + x0 + 1) * 4 + channel]
        const bottomLeft = image.data[((y0 + 1) * image.width + x0) * 4 + channel]
        const bottomRight = image.data[((y0 + 1) * image.width + x0 + 1) * 4 + channel]
        output[target + channel] = Math.round(
          topLeft * (1 - xWeight) * (1 - yWeight)
          + topRight * xWeight * (1 - yWeight)
          + bottomLeft * (1 - xWeight) * yWeight
          + bottomRight * xWeight * yWeight,
        )
      }
    }
  }
  return { image: { ...image, data: output }, transform }
}

function normalizeBackground(image: RgbaImage) {
  const tileSize = 64
  const columns = Math.ceil(image.width / tileSize)
  const rows = Math.ceil(image.height / tileSize)
  const backgrounds = new Uint8Array(columns * rows)
  const histogram = new Uint32Array(256)
  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      histogram.fill(0)
      const startX = tileX * tileSize
      const startY = tileY * tileSize
      const endX = Math.min(image.width, startX + tileSize)
      const endY = Math.min(image.height, startY + tileSize)
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) histogram[luminance(image.data, (y * image.width + x) * 4)] += 1
      }
      const target = Math.ceil((endX - startX) * (endY - startY) * 0.88)
      let count = 0
      let value = 255
      for (let level = 0; level < 256; level += 1) {
        count += histogram[level]
        if (count >= target) {
          value = level
          break
        }
      }
      backgrounds[tileY * columns + tileX] = value
    }
  }

  const output = new Uint8Array(image.data.byteLength)
  for (let y = 0; y < image.height; y += 1) {
    const tileY = Math.min(rows - 1, Math.floor(y / tileSize))
    const nextY = Math.min(rows - 1, tileY + 1)
    const yWeight = (y % tileSize) / tileSize
    for (let x = 0; x < image.width; x += 1) {
      const tileX = Math.min(columns - 1, Math.floor(x / tileSize))
      const nextX = Math.min(columns - 1, tileX + 1)
      const xWeight = (x % tileSize) / tileSize
      const top = backgrounds[tileY * columns + tileX] * (1 - xWeight)
        + backgrounds[tileY * columns + nextX] * xWeight
      const bottom = backgrounds[nextY * columns + tileX] * (1 - xWeight)
        + backgrounds[nextY * columns + nextX] * xWeight
      const background = top * (1 - yWeight) + bottom * yWeight
      const source = luminance(image.data, (y * image.width + x) * 4)
      const normalized = Math.max(0, Math.min(255, Math.round(255 - Math.max(0, background - source) * 1.8)))
      const offset = (y * image.width + x) * 4
      output[offset] = normalized
      output[offset + 1] = normalized
      output[offset + 2] = normalized
      output[offset + 3] = 255
    }
  }
  return { ...image, data: output }
}

function findCrop(image: RgbaImage, margin: number, maximumFraction: number) {
  const rowInk = new Uint32Array(image.height)
  const columnInk = new Uint32Array(image.width)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (luminance(image.data, (y * image.width + x) * 4) < 242) {
        rowInk[y] += 1
        columnInk[x] += 1
      }
    }
  }
  const minimumRowInk = Math.max(2, Math.ceil(image.width * 0.0015))
  const minimumColumnInk = Math.max(2, Math.ceil(image.height * 0.0015))
  let top = rowInk.findIndex((value) => value >= minimumRowInk)
  let left = columnInk.findIndex((value) => value >= minimumColumnInk)
  if (top < 0 || left < 0) return undefined
  let bottom = image.height - 1
  let right = image.width - 1
  while (bottom > top && rowInk[bottom] < minimumRowInk) bottom -= 1
  while (right > left && columnInk[right] < minimumColumnInk) right -= 1
  top = Math.max(0, top - margin)
  left = Math.max(0, left - margin)
  bottom = Math.min(image.height - 1, bottom + margin)
  right = Math.min(image.width - 1, right + margin)
  const maxHorizontalCrop = Math.floor(image.width * maximumFraction)
  const maxVerticalCrop = Math.floor(image.height * maximumFraction)
  left = Math.min(left, maxHorizontalCrop)
  right = Math.max(right, image.width - 1 - maxHorizontalCrop)
  top = Math.min(top, maxVerticalCrop)
  bottom = Math.max(bottom, image.height - 1 - maxVerticalCrop)
  if (!left && !top && right === image.width - 1 && bottom === image.height - 1) return undefined
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

function cropImage(image: RgbaImage, crop: { x: number; y: number; width: number; height: number }) {
  const output = new Uint8Array(crop.width * crop.height * 4)
  const rowBytes = crop.width * 4
  for (let y = 0; y < crop.height; y += 1) {
    const sourceStart = ((crop.y + y) * image.width + crop.x) * 4
    output.set(image.data.subarray(sourceStart, sourceStart + rowBytes), y * rowBytes)
  }
  return {
    image: { width: crop.width, height: crop.height, data: output },
    transform: { a: 1, b: 0, c: 0, d: 1, e: -crop.x, f: -crop.y } satisfies AffineTransform,
  }
}

function sharpen(image: RgbaImage) {
  if (image.width < 3 || image.height < 3) return image
  const output = new Uint8Array(image.data)
  const amount = 0.18
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const offset = (y * image.width + x) * 4
      const value = image.data[offset]
      const laplacian = 4 * value
        - image.data[offset - 4] - image.data[offset + 4]
        - image.data[offset - image.width * 4] - image.data[offset + image.width * 4]
      const enhanced = Math.max(0, Math.min(255, Math.round(value + amount * laplacian)))
      output[offset] = enhanced
      output[offset + 1] = enhanced
      output[offset + 2] = enhanced
      output[offset + 3] = 255
    }
  }
  return { ...image, data: output }
}

/**
 * Production-safe local preprocessing. Every stage is linear in input pixels;
 * expensive perspective warping is deliberately skipped unless a reliable skew signal exists.
 */
export function preprocessOcrImage(input: RgbaImage, options: OcrPreprocessOptions = {}): OcrPreprocessResult {
  validateImage(input)
  const orientation = options.orientation ?? 'auto'
  const maximumDeskew = Math.max(0, Math.min(6, options.maxDeskewDegrees ?? 4))
  const maximumCrop = Math.max(0, Math.min(0.45, options.maxCropFraction ?? 0.15))
  const diagnostics: PreprocessDiagnostic[] = []
  let image: RgbaImage = {
    width: input.width,
    height: input.height,
    data: new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength),
  }
  let transform = { ...IDENTITY }

  let quarterTurn: 'clockwise' | 'counterclockwise' | undefined
  let orientationMetrics: Record<string, number | string | boolean> | undefined
  if (orientation === 'clockwise' || orientation === 'counterclockwise') quarterTurn = orientation
  else if (orientation === 'auto') {
    const detected = detectQuarterTurn(image)
    orientationMetrics = detected
    if (detected.rotate) quarterTurn = 'clockwise'
  }
  if (quarterTurn) {
    const rotated = rotateQuarter(image, quarterTurn === 'clockwise')
    image = rotated.image
    transform = multiply(rotated.transform, transform)
    diagnostics.push({
      stage: 'orientation',
      status: 'applied',
      message: quarterTurn === 'clockwise' ? '已顺时针旋转 90°' : '已逆时针旋转 90°',
      metrics: orientationMetrics,
    })
  } else {
    diagnostics.push({
      stage: 'orientation',
      status: 'skipped',
      message: orientation === 'none' ? '方向检测已关闭' : '未发现足够可靠的 90° 旋转证据',
      metrics: orientationMetrics,
    })
  }

  if (options.deskew === false || maximumDeskew === 0) {
    diagnostics.push({ stage: 'perspective', status: 'skipped', message: '小角度倾斜校正已关闭；未进行四角透视变换' })
  } else {
    const detected = detectDeskew(image, maximumDeskew)
    if (detected.angle) {
      const rotated = rotateSmallAngle(image, detected.angle)
      image = rotated.image
      transform = multiply(rotated.transform, transform)
      diagnostics.push({
        stage: 'perspective',
        status: 'applied',
        message: `已校正 ${detected.angle.toFixed(1)}° 小角度倾斜；未检测到可靠四角边界，未做透视拉伸`,
        metrics: detected,
      })
    } else {
      diagnostics.push({
        stage: 'perspective',
        status: 'skipped',
        message: '未发现可靠的小角度倾斜或四角边界，保留原始几何形状',
        metrics: detected,
      })
    }
  }

  if (options.normalizeBackground === false) {
    diagnostics.push({ stage: 'background', status: 'skipped', message: '背景归一化已关闭' })
  } else {
    image = normalizeBackground(image)
    diagnostics.push({ stage: 'background', status: 'applied', message: '已完成局部背景归一化与去阴影' })
  }

  if (options.crop === false) {
    diagnostics.push({ stage: 'crop', status: 'skipped', message: '自动裁边已关闭' })
  } else {
    const margin = Math.max(0, Math.round(options.cropMargin ?? Math.min(image.width, image.height) * 0.02))
    const crop = findCrop(image, margin, maximumCrop)
    if (crop) {
      const cropped = cropImage(image, crop)
      image = cropped.image
      transform = multiply(cropped.transform, transform)
      diagnostics.push({ stage: 'crop', status: 'applied', message: '已保守裁除空白边缘', metrics: crop })
    } else diagnostics.push({ stage: 'crop', status: 'skipped', message: '未发现可安全裁除的空白边缘' })
  }

  if (options.sharpen === false) {
    diagnostics.push({ stage: 'sharpen', status: 'skipped', message: '清晰化已关闭' })
  } else {
    image = sharpen(image)
    diagnostics.push({ stage: 'sharpen', status: 'applied', message: '已进行保守边缘清晰化' })
  }

  const mapping = createMapping(transform)
  return { image, mapping, transform, inverseTransform: mapping.inverse, diagnostics }
}
