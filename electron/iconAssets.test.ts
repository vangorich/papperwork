import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { TRAY_ICON_PNG_DATA_URL } from './trayIcon'

const repoRoot = path.join(__dirname, '..')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const readBuild = (name: string) => readFileSync(path.join(repoRoot, 'build', name))

function expectPng(buffer: Buffer) {
  expect([...buffer.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(buffer.toString('ascii', 12, 16)).toBe('IHDR')
  expect(buffer[24]).toBe(8) // 8-bit RGBA with transparency
  expect(buffer[25]).toBe(6)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function readIco(file: string) {
  const ico = readBuild(file)
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  expect(ico.readUInt16LE(4)).toBe(sizes.length)
  let nextOffset = 6 + 16 * sizes.length
  return sizes.map((size, index) => {
    const base = 6 + index * 16
    expect(ico[base]).toBe(size === 256 ? 0 : size)
    expect(ico[base + 1]).toBe(ico[base])
    expect(ico.readUInt16LE(base + 2)).toBe(0)
    expect(ico.readUInt16LE(base + 4)).toBe(1)
    expect(ico.readUInt16LE(base + 6)).toBe(32)
    const length = ico.readUInt32LE(base + 8)
    expect(ico.readUInt32LE(base + 12)).toBe(nextOffset)
    expect(length).toBeGreaterThan(0)
    const png = ico.subarray(nextOffset, nextOffset + length)
    expect(png.length).toBe(length)
    expect(expectPng(png)).toEqual({ width: size, height: size })
    nextOffset += length
    if (index === sizes.length - 1) expect(nextOffset).toBe(ico.length)
    return png
  })
}

// Decode native PNG scanlines using Node's zlib, without an image dependency.
function pixels(png: Buffer) {
  const { width, height } = expectPng(png)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  expect(raw.length).toBe((stride + 1) * height)
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x
      const a = x >= 4 ? rgba[index - 4] : 0
      const b = y > 0 ? rgba[index - stride] : 0
      const c = x >= 4 && y > 0 ? rgba[index - stride - 4] : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
        ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth][filter]
      rgba[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  return (x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
}

describe('brand icon assets', () => {
  it.each(['icon.ico', 'pdf.ico'])('%s contains exactly seven ordered PNG-backed frames', (file) => {
    for (const frame of readIco(file)) pixels(frame) // every frame decompresses completely
  })

  it('PNG, previews, renderer and tray use the exact corresponding ICO bytes', () => {
    const app = readIco('icon.ico')
    const pdf = readIco('pdf.ico')
    expect(readBuild('icon.png')).toEqual(app[6])
    expect(readBuild('icon-preview-128.png')).toEqual(app[5])
    expect(readBuild('pdf-icon-preview-128.png')).toEqual(pdf[5])
    const header = readFileSync(path.join(repoRoot,'src','App.tsx'),'utf8')
    expect(header).toContain('./app-icon-32.png')
    expect(readFileSync(path.join(repoRoot,'public','app-icon-32.png'))).toEqual(app[2])
    expect(readFileSync(path.join(repoRoot,'public','app-icon-64.png'))).toEqual(app[4])
    expect(readFileSync(path.join(repoRoot,'public','app-icon.png'))).toEqual(app[6])
    expect(TRAY_ICON_PNG_DATA_URL.startsWith('data:image/png;base64,')).toBe(true)
    const tray = Buffer.from(TRAY_ICON_PNG_DATA_URL.slice('data:image/png;base64,'.length), 'base64')
    expect(tray).toEqual(app[0])
  })

  it('uses the book family for both Windows setup and removal, not the separate PDF file glyph',()=>{
    const cfg=JSON.parse(readFileSync(path.join(repoRoot,'src-tauri','tauri.conf.json'),'utf8'))
    expect(cfg.bundle.windows.nsis.installerIcon).toBe('../build/icon.ico');expect(cfg.bundle.windows.nsis.uninstallerIcon).toBe('../build/icon.ico');expect(cfg.bundle.icon).toContain('../build/icon.ico')
    expect(readFileSync(path.join(repoRoot,'index.html'),'utf8')).toContain('./app-icon-32.png')
  })

  it('embeds graphite bookcloth, two light leaves and a red ribbon in every app frame', () => {
    for (const [index, size] of sizes.entries()) {
      const pixel = pixels(readIco('icon.ico')[index]);const sample=(x:number,y:number)=>pixel(Math.floor(x*size),Math.floor(y*size))
      expect(pixel(0,0)[3]).toBe(0)
      const cloth=sample(.50,.16);expect(cloth[3]).toBe(255);expect(Math.max(...cloth.slice(0,3))).toBeLessThan(100)
      for(const x of [.33,.76]){const leaf=sample(x,.45);expect(Math.min(...leaf.slice(0,3))).toBeGreaterThan(165);expect(leaf[0]).toBeGreaterThanOrEqual(leaf[2])}
      const ribbon=sample(.67,.54);expect(ribbon[0]).toBeGreaterThan(ribbon[2]*1.45)
    }
    const doc=pixels(readIco('pdf.ico')[6]);expect(doc(32,128)[3]).toBe(0);expect(doc(100,70)).toEqual([255,255,255,255])
  })

})
