import { describe, expect, it } from 'vitest'
import { openOutlineFont } from './ofdOutlineFont'
import { tinyGlyphFont } from '../../tests/ofdReceiptFixture'

const ignore = () => {}
function table(b: Uint8Array, name: string) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < d.getUint16(4); i++) {
    const p = 12 + 16 * i
    if (String.fromCharCode(...b.subarray(p, p + 4)) === name) return d.getUint32(p + 8)
  }
  throw Error('table absent from fixture')
}
describe('explicit OFD glyph outlines', () => {
  it('uses the addressed subset glyph, not the Unicode codepoint as a glyph id', () => {
    const glyph = openOutlineFont(tinyGlyphFont(), ignore)
    expect(glyph(1).shape).toContain('500 700 l')
    expect(glyph(2).shape).toContain('600 700 l')
    expect(glyph(1).advance).toBe(0.8)
  })
  it('converts a quadratic off-curve point to a cubic PDF segment', () => {
    const b = tinyGlyphFont()
    b[table(b, 'glyf') + 15] = 0
    expect(openOutlineFont(b, ignore)(1).shape).toContain(' c\n')
  })
  it('rejects missing tables, invalid indices, and self-referential components', () => {
    const b = tinyGlyphFont()
    expect(() => openOutlineFont(b.subarray(0, 42), ignore)).toThrow('字形')
    expect(() => openOutlineFont(b, ignore)(3)).toThrow('字形')
    const d = new DataView(b.buffer)
    d.setUint16(table(b, 'glyf') + 34 + 12, 2)
    expect(() => openOutlineFont(b, ignore)(2)).toThrow('引用')
  })
})
