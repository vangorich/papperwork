import { afterEach, describe, expect, it, vi } from 'vitest'
import { rgbaToPng, signTencentRequest, testOcrConnection, validateOcrEndpoint } from './ocrConnections'

afterEach(() => vi.unstubAllGlobals())

describe('external OCR connection safety', () => {
  it('encodes deterministic PNG data with the standard signature', () => {
    const image = { width: 1, height: 1, data: Uint8Array.from([12, 34, 56, 255]) }
    const first = rgbaToPng(image)
    const second = rgbaToPng(image)
    expect([...first.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(first.equals(second)).toBe(true)
    expect(() => rgbaToPng({ ...image, width: 2 })).toThrow(/RGBA dimensions/)
  })

  it('rejects remote HTTP before making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(() => validateOcrEndpoint('http://ocr.example.com/v1')).toThrow(/HTTPS/)
    await expect(testOcrConnection('custom', { custom: { endpoint: 'http://ocr.example.com/v1' } }))
      .resolves.toMatchObject({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows localhost HTTP for an explicitly configured local engine', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 204 })
    vi.stubGlobal('fetch', fetch)
    expect(validateOcrEndpoint('http://localhost:8866/ocr').href).toBe('http://localhost:8866/ocr')
    await expect(testOcrConnection('custom', { custom: { endpoint: 'http://localhost:8866/ocr' } }))
      .resolves.toEqual({ ok: true, message: expect.stringContaining('204') })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'OPTIONS', redirect: 'error' })
  })

  it('keeps Tencent TC3 signing deterministic', () => {
    const first = signTencentRequest('id', 'key', 'HandwritingOCR', '{"ImageBase64":"abc"}', 1_700_000_000)
    const second = signTencentRequest('id', 'key', 'HandwritingOCR', '{"ImageBase64":"abc"}', 1_700_000_000)
    expect(first).toBe(second)
    expect(first).toMatch(/Signature=[a-f0-9]{64}$/)
    expect(signTencentRequest('id', 'key', 'HandwritingOCR', '{}', 1_700_000_000)).not.toBe(first)
  })
})
