import { PDF_CSS_UNITS } from './cn'
import type { Markup } from '../types/pdf'

/** CSS line-height shared by the textarea and the export rasterizer. */
export const TEXT_LINE_HEIGHT = 1.35

/**
 * Minimum box height (as a page-height fraction) that still shows one full
 * line of text at the given font size: the 1.35 line box plus the fixed
 * chrome around it (textarea + box padding + border ≈ 11 CSS px at zoom 1).
 * The resize floor and the toolbar font-size bump both derive from this so a
 * text box can never clip its first line.
 */
export function textMinHeightFraction(fontSize: number, pageHeightPt: number, zoom = 1) {
  if (pageHeightPt <= 0) return 0
  return (fontSize * TEXT_LINE_HEIGHT + 11 / (PDF_CSS_UNITS * zoom)) / pageHeightPt
}

export function fitTextFontSize(text: string, boxWidth: number, boxHeight: number, maxSize = 28, minSize = 8) {
  const content = text || 'M'
  for (let size = Math.floor(maxSize); size >= minSize; size -= 1) {
    const availableUnits = Math.max(0.5, boxWidth / size)
    const lines = content.split('\n').reduce(
      (total, line) => {
        const units = [...line].reduce((width, character) => width + (/^[\x00-\xff]$/.test(character) ? 0.56 : 1), 0)
        return total + Math.max(1, Math.ceil(Math.max(0.5, units) / availableUnits))
      },
      0,
    )
    if (lines * size * 1.35 <= boxHeight) return size
  }
  return minSize
}

/**
 * Produces the PNG snapshot embedded into exported PDFs for editable text
 * annotations. Keeping this helper outside the page component also lets the
 * phrase library apply text and typography in one update without duplicating
 * the rasterisation rules.
 */
export function rasterizeText(annotation: Markup) {
  const canvas = document.createElement('canvas')
  canvas.height = 360
  const boxAspect = annotation.width > 0 && annotation.height > 0
    ? annotation.width / annotation.height * (annotation.pageAspectRatio ?? 1 / 1.414)
    : 1200 / 360
  canvas.width = Math.max(180, Math.min(3600, Math.round(canvas.height * boxAspect)))
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = annotation.color ?? '#18324a'
  context.textBaseline = 'top'
  // fontSize and pageHeight are both stored in PDF points. Keeping the
  // rasterizer in that coordinate system makes its output match Acrobat-style
  // point sizes; the renderer converts points to CSS pixels only for display.
  const boxHeight = annotation.height * (annotation.pageHeight ?? 120)
  const rasterScale = canvas.height / Math.max(1, boxHeight)
  const padding = Math.max(4, 2 * rasterScale)
  context.font = `${annotation.italic ? 'italic ' : ''}${annotation.bold ? '700 ' : '400 '}${(annotation.fontSize ?? 16) * rasterScale}px ${annotation.fontFamily ?? 'Microsoft YaHei'}`
  const maxWidth = canvas.width - padding * 2
  const lines = (annotation.text ?? '').split('\n').flatMap((paragraph) => {
    if (!paragraph) return ['']
    const wrapped: string[] = []
    let line = ''
    for (const character of paragraph) {
      const candidate = line + character
      if (line && context.measureText(candidate).width > maxWidth) {
        wrapped.push(line)
        line = character
      } else line = candidate
    }
    wrapped.push(line)
    return wrapped
  })
  const lineHeight = (annotation.fontSize ?? 16) * rasterScale * TEXT_LINE_HEIGHT
  lines.forEach((line, index) => context.fillText(line, padding, padding + index * lineHeight, maxWidth))
  return canvas.toDataURL('image/png')
}
