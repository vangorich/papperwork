import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
import { nativeFeatures } from './features'

const options: PrintOptions = { copies: 1, duplex: 'simplex', range: '', landscape: false, collate: true, pagesPerSheet: 1, scaleFactor: 100, sizing: 'actual', color: true, margins: 'default' }
const bytes = (s: string) => new TextEncoder().encode(s)
beforeEach(() => { invoke.mockReset(); listen.mockReset() })

describe('Tauri desktop feature wire format', () => {
  it('packs exactly the supplied page views and omits UI-only page ranges from the manifest', async () => {
    const parent = Uint8Array.of(9, 1, 2, 8)
    invoke.mockResolvedValue(bytes('true').buffer)
    expect(await nativeFeatures.printPages([{ widthPt: 100, heightPt: 200, png: parent.subarray(1, 3) }, { widthPt: 9, heightPt: 12, png: Uint8Array.of(3) }], options)).toBe(true)
    const [action, body, request] = invoke.mock.calls[0]
    expect([action, request.headers['x-native-action']]).toEqual(['native_binary', 'print'])
    const size = new DataView(body.buffer).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, size + 4)))
    expect(meta.pages).toEqual([{ widthPt: 100, heightPt: 200, size: 2 }, { widthPt: 9, heightPt: 12, size: 1 }])
    expect(meta.options.range).toBeUndefined()
    expect(meta.options.sizing).toBe('actual')
    expect(Array.from(body.subarray(size + 4))).toEqual([1, 2, 3])
    invoke.mockRejectedValue('用户取消打印')
    await expect(nativeFeatures.printPages([{ widthPt: 1, heightPt: 1, png: Uint8Array.of(1) }], options)).rejects.toThrow('用户取消打印')
  })
  it('sends only pixels and dimensions to local OCR, never external keys', async () => {
    invoke.mockResolvedValue(bytes('{"text":"PDF", "items":[]}').buffer)
    const data = Uint8Array.of(10, 20, 30, 255)
    await nativeFeatures.recognizeOcrPage({ width: 1, height: 1, data, mode: 'auto', pipeline: { tencent: { secretId: 'DO_NOT_FORWARD', secretKey: 'DO_NOT_FORWARD', region: '' }, custom: { apiKey: 'DO_NOT_FORWARD', endpoint: 'https://example.invalid' }, preprocess: true, handwritingProvider: 'tencent', lowConfidenceProvider: 'custom', lowConfidenceThreshold: .5, contextualCorrection: true } })
    const [, body, req] = invoke.mock.calls[0]
    expect(body).toBe(data)
    expect(JSON.parse(req.headers['x-native-meta'])).toEqual({ width: 1, height: 1, mode: 'auto' })
    expect(JSON.stringify(req)).not.toContain('DO_NOT_FORWARD')
    await expect(nativeFeatures.recognizeOcrPage({ width: 1, height: 1, data, mode: 'handwriting' })).rejects.toThrow('印刷体')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('does not erase existing keys before cold-start settings hydration', async () => {
    const empty = { secretId: '', secretKey: '', apiKey: '' }
    expect(await nativeFeatures.saveOcrSecrets(empty)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockResolvedValueOnce({ tencent: { secretId: 'key-id' } }).mockResolvedValueOnce(true)
    expect((await nativeFeatures.loadOcrSecrets()).tencent?.secretId).toBe('key-id')
    expect(await nativeFeatures.saveOcrSecrets(empty)).toBe(true)
    expect(invoke.mock.calls[1][1]).toEqual({ action: 'saveOcrSecrets', payload: empty })
  })
  it('does not deliver queued jobs after an unmount before async listener registration completes', async () => {
    const cb = vi.fn(), off = vi.fn()
    let done!: (value: () => void) => void
    listen.mockReturnValue(new Promise(resolve => { done = resolve }))
    const unsubscribe = nativeFeatures.onVirtualPrintJob(cb)
    unsubscribe(); listen.mock.calls[0][1](); done(off)
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled(); expect(off).toHaveBeenCalledOnce()
  })
})
