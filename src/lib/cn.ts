export const uid = () => crypto.randomUUID()

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 ** 2).toFixed(1) + ' MB'
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

// PDF coordinates use 72 points per inch while desktop browsers use 96 CSS
// pixels per inch. Matching that ratio makes "100%" agree with Acrobat-style
// readers instead of displaying an A4 page at an undersized 595px width.
export const PDF_CSS_UNITS = 96 / 72

export const pdfRenderScale = (
  displayWidth: number,
  displayHeight: number,
  naturalWidth: number,
  pixelRatio: number,
  maxOutput = 2,
  maxPixels = 24_000_000,
  maxDimension = 8192,
) => {
  const safeDisplayWidth = Math.max(1, displayWidth)
  const safeDisplayHeight = Math.max(1, displayHeight)
  const display = safeDisplayWidth / Math.max(1, naturalWidth)
  // Keep normal pages razor sharp while preventing a 300%-zoom poster from
  // allocating a canvas with tens of millions of pixels per device pixel.
  const pixelBudget = Math.sqrt(Math.max(1, maxPixels) / (safeDisplayWidth * safeDisplayHeight))
  const dimensionBudget = Math.max(1, maxDimension) / Math.max(safeDisplayWidth, safeDisplayHeight)
  return {
    display,
    // Output may fall below 1 only for unusually large pages/zoom levels. This
    // is a hard safety limit: a CSS-sized canvas can itself exceed the budget.
    output: Math.max(Number.EPSILON, Math.min(Math.max(pixelRatio, 1), maxOutput, pixelBudget, dimensionBudget)),
  }
}
