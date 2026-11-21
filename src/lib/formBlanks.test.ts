import { describe, expect, it } from 'vitest'
import { findFormBlankAt, type FormBlankSpan } from './formBlanks'

const span = (text: string, left: number, top: number, right: number, bottom: number, fontSize?: number): FormBlankSpan =>
  ({ text, left, top, right, bottom, fontSize })

describe('findFormBlankAt', () => {
  it('detects a blank after a full-width colon, bounded by the next text run', () => {
    const spans = [
      span('姓名：', 40, 100, 88, 118, 14),
      span('性别：', 260, 100, 308, 118, 14),
    ]
    const blank = findFormBlankAt(spans, { x: 150, y: 108 }, 600)
    expect(blank).toMatchObject({ left: 90, top: 100, width: 168, height: 18, fontSizePx: 14 })
  })

  it('detects a blank after a half-width colon up to the page edge', () => {
    const spans = [span('Address:', 40, 100, 96, 116)]
    const blank = findFormBlankAt(spans, { x: 300, y: 108 }, 600)
    expect(blank?.left).toBe(98)
    expect(blank?.width).toBe(600 - 8 - 98)
    expect(blank?.fontSizePx).toBeCloseTo(16 * 0.8)
  })

  it('rejects prose colons with text following immediately', () => {
    const spans = [
      span('备注：', 40, 100, 88, 118),
      span('已经填写好的内容', 92, 100, 220, 118),
    ]
    expect(findFormBlankAt(spans, { x: 95, y: 108 }, 600)).toBeNull()
  })

  it('rejects colons in the middle of a run', () => {
    const spans = [span('时间：2024 年 1 月', 40, 100, 220, 118)]
    expect(findFormBlankAt(spans, { x: 150, y: 108 }, 600)).toBeNull()
  })

  it('ignores whitespace-only runs when finding the right boundary', () => {
    const spans = [
      span('电话：', 40, 100, 88, 118),
      span('   ', 90, 100, 110, 118),
      span('（选填）', 300, 100, 360, 118),
    ]
    const blank = findFormBlankAt(spans, { x: 150, y: 108 }, 600)
    expect(blank?.width).toBe(298 - 90)
  })

  it('stops the blank before underscore lines that follow the label', () => {
    const spans = [
      span('日期：', 40, 100, 88, 118),
      span('__________', 200, 100, 300, 118),
    ]
    const blank = findFormBlankAt(spans, { x: 150, y: 108 }, 600)
    expect(blank?.width).toBe(198 - 90)
  })

  it('misses when hovering outside the label line band', () => {
    const spans = [span('姓名：', 40, 100, 88, 118)]
    expect(findFormBlankAt(spans, { x: 150, y: 140 }, 600)).toBeNull()
    expect(findFormBlankAt(spans, { x: 150, y: 80 }, 600)).toBeNull()
  })

  it('ignores labels on other lines when bounding the blank', () => {
    const spans = [
      span('姓名：', 40, 100, 88, 118),
      span('下一行文字', 95, 140, 200, 158),
    ]
    const blank = findFormBlankAt(spans, { x: 300, y: 108 }, 600)
    expect(blank?.width).toBe(600 - 8 - 90)
  })

  it('requires a label of at least two characters', () => {
    const spans = [span('：', 40, 100, 52, 118)]
    expect(findFormBlankAt(spans, { x: 150, y: 108 }, 600)).toBeNull()
  })
})
