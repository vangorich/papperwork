import { describe, expect, it } from 'vitest'
import type { Markup } from '../types/pdf'
import { cloneAnnotationsForPaste, rotateAnnotationCoordinates } from './annotations'
import { fitTextFontSize } from './text'

describe('page element editing', () => {
  it('pastes multiple elements at the same normalized positions with fresh ids', () => {
    let id = 0
    const templates: Markup[] = [
      { id: 'text-old', type: 'text', x: 0.18, y: 0.24, width: 0.32, height: 0.06, text: 'Name' },
      {
        id: 'note-old', type: 'note', x: 0.74, y: 0.81, width: 0.04, height: 0.04,
        replies: [{ id: 'reply-old', author: 'Reviewer', text: 'Done', createdAt: '2026-07-30T00:00:00Z' }],
      },
    ]
    const pasted = cloneAnnotationsForPaste(templates, () => `new-${++id}`)

    expect(pasted.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(
      templates.map(({ x, y, width, height }) => ({ x, y, width, height })),
    )
    expect(pasted.map((annotation) => annotation.id)).toEqual(['new-1', 'new-2'])
    expect(pasted[1].replies?.[0].id).toBe('new-3')
    expect(pasted[1].replies).not.toBe(templates[1].replies)
  })

  it('shrinks auto-fit text for long and wide CJK content', () => {
    const shortText = fitTextFontSize('姓名', 180, 32, 24)
    const longText = fitTextFontSize('这是需要自动缩小字号的很长中文填写内容', 180, 32, 24)
    expect(shortText).toBeGreaterThan(longText)
    expect(longText).toBeGreaterThanOrEqual(8)
  })

  it('keeps page elements anchored when the page rotates clockwise', () => {
    const rotated = rotateAnnotationCoordinates({
      id: 'field', type: 'text', x: 0.1, y: 0.2, width: 0.3, height: 0.08,
      points: [{ x: 0.2, y: 0.7 }], pageAspectRatio: 0.75, pageHeight: 800,
    }, 90)
    expect(rotated.x).toBeCloseTo(0.72)
    expect(rotated.y).toBeCloseTo(0.1)
    expect(rotated.width).toBeCloseTo(0.08)
    expect(rotated.height).toBeCloseTo(0.3)
    expect(rotated.points?.[0].x).toBeCloseTo(0.3)
    expect(rotated.points?.[0].y).toBeCloseTo(0.2)
    expect(rotated.pageAspectRatio).toBeCloseTo(4 / 3)
    expect(rotated.pageHeight).toBeCloseTo(600)
  })
})
