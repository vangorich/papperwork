import type { Markup } from '../types/pdf'
import { uid } from './cn'

export function cloneAnnotationsForPaste(templates: Markup[], createId: () => string = uid) {
  return templates.map((annotation) => ({
    ...annotation,
    id: createId(),
    points: annotation.points?.map((point) => ({ ...point })),
    replies: annotation.replies?.map((reply) => ({ ...reply, id: createId() })),
  }))
}

export function rotateAnnotationCoordinates(annotation: Markup, delta: number) {
  const turns = ((Math.round(delta / 90) % 4) + 4) % 4
  let rotated = { ...annotation, points: annotation.points?.map((point) => ({ ...point })) }
  for (let turn = 0; turn < turns; turn += 1) {
    const previousAspect = rotated.pageAspectRatio
    rotated = {
      ...rotated,
      x: 1 - rotated.y - rotated.height,
      y: rotated.x,
      width: rotated.height,
      height: rotated.width,
      points: rotated.points?.map((point) => ({ x: 1 - point.y, y: point.x })),
      pageAspectRatio: previousAspect ? 1 / previousAspect : undefined,
      pageHeight: rotated.pageHeight && previousAspect ? rotated.pageHeight * previousAspect : rotated.pageHeight,
    }
  }
  return rotated
}
