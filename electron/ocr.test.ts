import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
const backendSource = readFileSync(new URL('./ocr.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const models = [
  ['PP-OCRv6_small_det_infer.onnx', 9_880_512, 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e'],
  ['PP-OCRv6_small_rec_infer.onnx', 21_159_378, '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634'],
  ['ppocrv6_dict.txt', 74_948, '41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8'],
] as const

describe('local OCR runtime contract', () => {
  it('ships the verified PP-OCRv6 Small model assets', () => {
    for (const [name, size, hash] of models) {
      const bytes = readFileSync(new URL(`../resources/ocr/${name}`, import.meta.url))
      expect(bytes.byteLength).toBe(size)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
    }
  })

  it('exposes OCR through the context-isolated preload', () => {
    expect(mainSource).toContain("ipcMain.handle('ocr:recognize-page'")
    expect(mainSource).toContain("ipcMain.handle('ocr:status'")
    expect(preloadSource).toContain("recognizeOcrPage: (payload: OcrPageInput)")
    expect(preloadSource).toContain("ipcRenderer.invoke('ocr:recognize-page', payload)")
  })

  it('serializes inference and rejects oversized RGBA pages', () => {
    expect(backendSource).toContain('const MAX_PIXELS = 20_000_000')
    expect(backendSource).toContain('let recognitionQueue: Promise<unknown> = Promise.resolve()')
    expect(backendSource).toContain('data.byteLength !== pixels * 4')
  })

  it('packages only the Windows OCR runtime and offline model directory', () => {
    const packagedFiles = packageJson.build.files as string[]
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'resources/ocr', to: 'ocr' }),
    ]))
    expect(packagedFiles).toEqual(expect.arrayContaining([
      'dist/**/*',
      'node_modules/paddleocr/dist/*.mjs',
      'node_modules/paddleocr/dist/*.cjs',
      'node_modules/onnxruntime-common/dist/**/*.js',
      'node_modules/onnxruntime-common/dist/**/package.json',
      'node_modules/onnxruntime-node/dist/**/*.js',
      'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*',
    ]))
    expect(packagedFiles).not.toContain('node_modules/paddleocr/dist/**/*')
    expect(packagedFiles).not.toContain('node_modules/onnxruntime-common/dist/**/*')
    expect(packagedFiles).not.toContain('node_modules/onnxruntime-node/dist/**/*')
    expect(packageJson.build.asarUnpack).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*')
  })

  it('packages the arm64 build with the arm64 CPU-only OCR runtime', () => {
    const arm64Config = readFileSync(new URL('../electron-builder.arm64.yml', import.meta.url), 'utf8')
    expect(arm64Config).toContain('- arm64')
    expect(arm64Config).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime.dll')
    expect(arm64Config).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node')
    expect(arm64Config).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**/*')
    expect(arm64Config).toContain('resources/ocr')
    // DirectML GPU-provider DLLs are intentionally excluded from the ARM64 build.
    expect(arm64Config).not.toContain('DirectML.dll')
    expect(arm64Config).not.toContain('dxcompiler.dll')
    expect(arm64Config).not.toContain('win32/x64')
  })
})
