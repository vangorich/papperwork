import { describe, expect, it } from 'vitest'
import { gripCursor, resizeAtGrip, signedAngle, turnFrom, type Box, type Grip } from './objectTransform'

function pin(box: Box, grip: Grip, angle: number, w: number, h: number) {
  const a = (angle * Math.PI) / 180,
    sign = (positive: boolean, negative: boolean) => Number(positive) - Number(negative)
  const dx = (sign(grip.includes('w'), grip.includes('e')) * box.width * w) / 2,
    dy = (sign(grip.includes('n'), grip.includes('s')) * box.height * h) / 2
  return [
    (box.x + box.width / 2) * w + dx * Math.cos(a) - dy * Math.sin(a),
    (box.y + box.height / 2) * h + dx * Math.sin(a) + dy * Math.cos(a),
  ]
}
describe('object transform grips in screen space', () => {
  const box = { x: 0.31, y: 0.33, width: 0.24, height: 0.11 },
    w = 870,
    h = 1130
  it.each(['nw', 'ne', 'sw', 'se', 'n', 'e', 's', 'w'] as Grip[])(
    'pins the opposite anchor when moving %s at arbitrary angles and zooms',
    (grip) => {
      for (const a of [-117, -30, 0, 31, 90, 179])
        for (const z of [0.7, 1, 2.2]) {
          const resized = resizeAtGrip(box, grip, 24 * z, 32 * z, w * z, h * z, a, {
            minW: 0.02,
            minH: 0.02,
            aspect: false,
          })
          const before = pin(box, grip, a, w * z, h * z),
            after = pin(resized, grip, a, w * z, h * z)
          expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(1e-8)
          expect(resized.width).toBeGreaterThan(0)
          expect(resized.height).toBeGreaterThan(0)
        }
    },
  )
  it('locks aspect by projecting the drag along the diagonal; does not flip on crossing the pin', () => {
    for (const movement of [
      [54, -16],
      [-5000, -5000],
      [8000, 9000],
    ]) {
      const next = resizeAtGrip(box, 'se', movement[0], movement[1], w, h, 33, {
        minW: 0.02,
        minH: 0.02,
        aspect: true,
      })
      expect(next.width / next.height).toBeCloseTo(box.width / box.height, 8)
      expect(next.width).toBeGreaterThan(0)
      expect(next.x + next.width).toBeLessThanOrEqual(1.000001)
      expect(next.y + next.height).toBeLessThanOrEqual(1.000001)
    }
  })
  it('pins a tiled instance even when it straddles the visible sheet', () => {
    const tile = { ...box, x: -0.07, y: -0.03 }
    const next = resizeAtGrip(tile, 'se', 34, 24, w, h, -28, {
      minW: 0.04,
      minH: 0.025,
      aspect: true,
      tiled: true,
    })
    const a = pin(tile, 'se', -28, w, h),
      b = pin(next, 'se', -28, w, h)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-8)
  })
  it('keeps native diagonal cursors on all four corners even between quarter turns',()=>{
    for(const a of [-135,-47,-28,0,29,45,78,90,130,180])for(const d of ['nw','ne','sw','se'] as const)expect(['nwse-resize','nesw-resize']).toContain(gripCursor(d,a))
    expect(gripCursor('n',0)).toBe('ns-resize');expect(gripCursor('w',0)).toBe('ew-resize')
  })
  it('rotates around the displayed centre and snaps only when requested', () => {
    const start = { x: 0, y: -50 },
      end = { x: 20, y: -50 },
      centre = { x: 0, y: 0 }
    expect(turnFrom(start, end, centre, 0, false)).toBeCloseTo(21.8, 1)
    expect(turnFrom(start, end, centre, 0, true)).toBe(15)
    expect(turnFrom(start, centre, centre, 32, false)).toBe(32)
    expect(signedAngle(332)).toBe(-28)
    expect(gripCursor('nw', 90)).toBe('nesw-resize')
    expect(gripCursor('e', 90)).toBe('ns-resize')
  })
})
