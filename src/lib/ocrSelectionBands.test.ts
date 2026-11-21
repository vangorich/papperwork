import { describe, expect, it } from 'vitest'
import { bandPath, ocrGapDistance, ocrSelectionBands, type OcrRunFrame, type SelectedInk } from './ocrSelectionBands'

// Construct points in the local frame of a printed line, not its bounding rectangle.
function point(along: number, across: number, angle: number) {
  const a = angle * Math.PI / 180
  return { x: 120 + along * Math.cos(a) - across * Math.sin(a), y: 85 + along * Math.sin(a) + across * Math.cos(a) }
}
function run(start: number, end: number, options: Partial<Pick<SelectedInk, 'line' | 'cell' | 'angle' | 'height'>> & { across?: number } = {}): SelectedInk {
  const { across = 0, angle = 0, height = 12, line = 0, cell = null } = options
  return { start: point(start, across, angle), end: point(end, across, angle), height, angle, cell, line }
}

describe('OCR text selection paint', () => {
  it.each([-6, 0, 4, 94, 184, 274])('joins ordinary word spaces into one strip along the %d° baseline', angle => {
    const runs = [run(2, 18, { angle }), run(22, 38, { angle }), run(44, 51, { angle })]
    const original = structuredClone(runs)
    const bands = ocrSelectionBands(runs)
    expect(bands).toHaveLength(1)
    const expected = [point(2,-6,angle), point(51,-6,angle), point(51,6,angle), point(2,6,angle)]
    bands[0].forEach((p,i) => { expect(p.x).toBeCloseTo(expected[i].x, 6); expect(p.y).toBeCloseTo(expected[i].y, 6) })
    expect(bandPath(bands).match(/M/g)).toHaveLength(1)
    expect(runs).toEqual(original)
  })
  it('never fills another line, a column gutter or a neighboring cell, including two touching cells', () => {
    expect(ocrSelectionBands([run(0,20), run(24,44,{line:1})])).toHaveLength(2)
    expect(ocrSelectionBands([run(0,20), run(100,120)])).toHaveLength(2)
    expect(ocrSelectionBands([run(0,20,{cell:1}), run(20,38,{cell:2})])).toHaveLength(2)
    expect(ocrSelectionBands([run(0,20,{cell:1}),run(24,38,{cell:1})])).toHaveLength(1)
    expect(ocrSelectionBands([run(0,20),run(24,38,{across:14})])).toHaveLength(2)
  })
  it('rejects nonfinite OCR geometry rather than letting the path expand the selection', () => {
    const bad = { ...run(22,40), angle: NaN }
    const d = bandPath(ocrSelectionBands([run(0,20), bad, run(42,60)]))
    expect(d.match(/M/g)).toHaveLength(2); expect(d).not.toContain('NaN')
  })
  it.each([5,95,185,275])('snaps in the actual word frame, not its screen AABB at %d°', angle => {
    const f: OcrRunFrame = { x:.12,y:.17,width:.04,height:.024,length:5,line:1,cell:null,angle }
    expect(ocrGapDistance(f,point(-5,6,angle),1000,500)?.before).toBe(true)
    expect(ocrGapDistance(f,point(48,6,angle),1000,500)?.before).toBe(false)
    expect(ocrGapDistance(f,point(48,26,angle),1000,500)).toBeUndefined()
  })
})
