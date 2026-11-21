// Detects "label:" fill-in blanks on flat PDFs (Adobe Fill & Sign style):
// a text run ending with a colon, followed by empty space on the same line,
// is treated as a fillable spot. Pure geometry — PdfPage supplies span rects
// in page-relative CSS px and calls findFormBlankAt on hover.

export interface FormBlankSpan {
  text: string
  left: number
  top: number
  right: number
  bottom: number
  /** Computed font size in CSS px when cheap to read; estimated otherwise. */
  fontSize?: number
}

export interface FormBlank {
  left: number
  top: number
  width: number
  height: number
  /** Label glyph size in the same CSS-px units as the input rects. */
  fontSizePx: number
}

// A colon only counts at the END of the run — "备注：内容" is prose, not a blank.
const TRAILING_COLON = /[:：]$/
/** Below this gap the "blank" is just natural spacing before the next words. */
const MIN_BLANK_WIDTH = 30
const H_PADDING = 2
const PAGE_EDGE_INSET = 8

export function findFormBlankAt(
  spans: Iterable<FormBlankSpan>,
  point: { x: number; y: number },
  pageWidth: number,
): FormBlank | null {
  const list = [...spans]
  for (const label of list) {
    const text = label.text.trimEnd()
    if (text.length < 2 || !TRAILING_COLON.test(text)) continue
    const height = label.bottom - label.top
    if (height <= 0) continue
    // Right boundary: the nearest text on the same line (whitespace-only runs
    // are transparent), never covering it; otherwise the page edge.
    let rightBound = pageWidth - PAGE_EDGE_INSET
    for (const other of list) {
      if (other === label || !other.text.trim()) continue
      const overlap = Math.min(label.bottom, other.bottom) - Math.max(label.top, other.top)
      if (overlap < height * 0.5) continue
      if (other.left > label.right - 1 && other.left - H_PADDING < rightBound) rightBound = other.left - H_PADDING
    }
    const left = label.right + H_PADDING
    const width = rightBound - left
    if (width < MIN_BLANK_WIDTH) continue
    // Hover band: the label's line, loosened a quarter-height each way.
    if (point.x < left - H_PADDING || point.x > rightBound + H_PADDING) continue
    if (point.y < label.top - height * 0.25 || point.y > label.bottom + height * 0.25) continue
    return {
      left,
      top: label.top,
      width,
      height,
      fontSizePx: label.fontSize && label.fontSize > 0 ? label.fontSize : height * 0.8,
    }
  }
  return null
}
