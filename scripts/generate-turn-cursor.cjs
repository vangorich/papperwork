// Authoring only. The image decoder is already in the PDF.js test toolchain.
// Windows CUR uses the native hotspot/mask layout. Match the fallback SVG.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
const { createCanvas, loadImage } = require('@napi-rs/canvas')
;(async () => {
  const root = path.resolve(__dirname, '../src/assets'),
    svg = fs.readFileSync(path.join(root, 'rotate-cursor.svg'), 'utf8')
  const sizes = [32, 48],
    frames = []
  for (const s of sizes) {
    const hi = s * 4,
      img = await loadImage(
        Buffer.from(svg.replace('width="32" height="32"', `width="${hi}" height="${hi}"`)),
      ),
      c = createCanvas(s, s),
      ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0, s, s)
    const rgba = ctx.getImageData(0, 0, s, s).data,
      stride = Math.ceil(s / 32) * 4,
      n = s * s * 4,
      b = Buffer.alloc(40 + n + stride * s)
    assert(
      rgba.some((v, i) => i % 4 === 3 && v > 210),
      'empty cursor',
    )
    b.writeUInt32LE(40)
    b.writeInt32LE(s, 4)
    b.writeInt32LE(2 * s, 8)
    b.writeUInt16LE(1, 12)
    b.writeUInt16LE(32, 14)
    b.writeUInt32LE(n, 20)
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4,
          row = s - y - 1,
          j = 40 + (row * s + x) * 4
        b[j] = rgba[i + 2]
        b[j + 1] = rgba[i + 1]
        b[j + 2] = rgba[i]
        b[j + 3] = rgba[i + 3]
        if (!rgba[i + 3]) b[40 + n + row * stride + (x >> 3)] |= 128 >> (x & 7)
      }
    frames.push(b)
  }
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(2, 2)
  head.writeUInt16LE(sizes.length, 4)
  let off = head.length
  sizes.forEach((s, i) => {
    const a = 6 + 16 * i
    head[a] = head[a + 1] = s
    head.writeUInt16LE(Math.round((15 * s) / 32), a + 4)
    head.writeUInt16LE(Math.round((15 * s) / 32), a + 6)
    head.writeUInt32LE(frames[i].length, a + 8)
    head.writeUInt32LE(off, a + 12)
    off += frames[i].length
  })
  fs.writeFileSync(path.join(root, 'rotate-native.cur'), Buffer.concat([head, ...frames]))
  console.log('Generated monochrome rotation cursor at 32 / 48 px')
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
