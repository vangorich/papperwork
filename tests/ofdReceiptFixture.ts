// Synthetic structures only: no text, fonts, images, certificates or signed data from real files.
import { makeOfdFixture, ofdManifest, ofdPage, firstPage } from './ofdFixture'
export const NS = 'xmlns:o="http://www.ofdspec.org/2016"'
export function tinyGlyphFont() {
  const bytes = (len: number) => new Uint8Array(len),
    tables: Record<string, Uint8Array> = {
      head: bytes(54),
      hhea: bytes(36),
      maxp: bytes(6),
      hmtx: bytes(12),
      loca: bytes(16),
    }
  const u16 = (b: Uint8Array, i: number, n: number) => new DataView(b.buffer).setUint16(i, n),
    u32 = (b: Uint8Array, i: number, n: number) => new DataView(b.buffer).setUint32(i, n)
  u16(tables.head, 18, 1000)
  u16(tables.head, 50, 1)
  u16(tables.hhea, 34, 3)
  u16(tables.maxp, 4, 3)
  ;[0, 1, 2].forEach((i) => u16(tables.hmtx, i * 4, 800))
  const rect = bytes(34)
  u16(rect, 0, 1)
  u16(rect, 6, 500)
  u16(rect, 8, 700)
  u16(rect, 10, 3)
  rect.set([1, 1, 1, 1], 14)
  ;[0, 500, 0, -500, 0, 0, 700, 0].forEach((v, i) => u16(rect, 18 + 2 * i, v))
  const comp = bytes(18)
  u16(comp, 0, -1)
  u16(comp, 6, 600)
  u16(comp, 8, 700)
  u16(comp, 10, 3)
  u16(comp, 12, 1)
  u16(comp, 14, 100)
  const glyf = bytes(52)
  glyf.set(rect)
  glyf.set(comp, 34)
  tables.glyf = glyf
  ;[0, 0, 34, 52].forEach((v, i) => u32(tables.loca, 4 * i, v))
  let pos = 12 + Object.keys(tables).length * 16
  const file = bytes(pos + Object.values(tables).reduce((n, b) => n + ((b.length + 3) & ~3), 0))
  u32(file, 0, 0x10000)
  u16(file, 4, Object.keys(tables).length)
  Object.entries(tables).forEach(([tag, v], i) => {
    const at = 12 + 16 * i
    file.set(
      [...tag].map((c) => c.charCodeAt(0)),
      at,
    )
    u32(file, at + 8, pos)
    u32(file, at + 12, v.length)
    file.set(v, pos)
    pos += (v.length + 3) & ~3
  })
  return file
}
export function tinyBmp() {
  const b = new Uint8Array(70),
    v = new DataView(b.buffer)
  b.set([66, 77])
  v.setUint32(2, 70, true)
  v.setUint32(10, 54, true)
  v.setUint32(14, 40, true)
  v.setInt32(18, 2, true)
  v.setInt32(22, 2, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, 24, true)
  for (const i of [54, 57, 62, 65]) b.set([64, 40, 210], i)
  return b
}
export const signPath = 'Doc_0/Signs/S0/Signature.xml'
export function receiptFixture(overrides: Record<string, string | Uint8Array | null> = {}) {
  return makeOfdFixture({
    'OFD.xml': ofdManifest(
      '<o:DocBody><o:DocRoot>/Doc_0/Document.xml</o:DocRoot><o:Signatures>/Doc_0/Signs/Signatures.xml</o:Signatures></o:DocBody>',
    ).replace('Version="1.0"', 'Version="1.3"'),
    'Doc_0/Signs/Signatures.xml': `<o:Signatures ${NS}><o:Signature ID="s0" Type="Sign" BaseLoc="S0/Signature.xml"/></o:Signatures>`,
    [signPath]: `<o:Signature ${NS}><o:SignedInfo><o:References><o:Reference FileRef="/OFD.xml"/></o:References></o:SignedInfo><o:SignedValue>SignedValue.dat</o:SignedValue></o:Signature>`,
    'Doc_0/Signs/S0/SignedValue.dat': new Uint8Array([1, 2, 3]),
    'Doc_0/Resources/Public.xml': `<o:Res ${NS} BaseLoc="../Assets"><o:Fonts><o:Font ID="4" FontName="Synthetic"><o:FontFile>glyph.ttf</o:FontFile></o:Font></o:Fonts><o:MultiMedias><o:MultiMedia ID="5" Type="Image"><o:MediaFile>mark.bmp</o:MediaFile></o:MultiMedia></o:MultiMedias></o:Res>`,
    [firstPage]: ofdPage(
      '<o:Content><o:Layer><o:TextObject ID="31" Font="4" Size="10" Boundary="5 5 80 22"><o:CGTransform CodePosition="0" CodeCount="2" GlyphCount="2"><o:Glyphs>1 2</o:Glyphs></o:CGTransform><o:TextCode X="0" Y="12" DeltaX="9">甲乙</o:TextCode></o:TextObject><o:ImageObject ID="33" Boundary="45 28 12 10" ResourceID="5"/></o:Layer></o:Content>',
    ),
    'Doc_0/Pages/P1/Content.xml': ofdPage('<o:Content><o:Layer/></o:Content>'),
    'Doc_0/Assets/glyph.ttf': tinyGlyphFont(),
    'Doc_0/Assets/mark.bmp': tinyBmp(),
    ...overrides,
  })
}
