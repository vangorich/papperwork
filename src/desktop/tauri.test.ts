import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTauriDesktop } from './tauri'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ipc }))
vi.mock('./features', () => ({ nativeFeatures: {} }))

const ref = (name: string, size = 4, token = 'native-id') => ({ path: `D:\\中文资料\\${name}`, name, size, token, type: /\.ofd$/i.test(name) ? 'ofd' : 'pdf' })
const events = new Map<string, (event: { payload?: unknown }) => void>()
let desktop: NonNullable<Window['desktop']>
let dom: EventTarget
beforeEach(async () => {
  events.clear(); vi.resetAllMocks()
  dom = new EventTarget()
  vi.stubGlobal('window', dom)
  ipc.listen.mockImplementation(async (name, cb) => { events.set(name, cb); return () => events.delete(name) })
  await installTauriDesktop()
  desktop = window.desktop!
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Tauri document bridge', () => {
  it('keeps print folder previews metadata-only and reads large files in bounded raw chunks', async () => {
    const chunk = 16 * 1024 * 1024, big = ref('10.pdf', chunk + 3), small = ref('2.pdf', 5, 'two')
    ipc.invoke.mockImplementation(async (command, { offset, length }) => {
      if (command === 'pick_documents') return [big, small]
      if (command === 'read_granted') return new Uint8Array(length).fill(offset === 0 ? 11 : 22).buffer
      throw Error(command)
    })
    expect((await desktop.openPdfFolderForPrint()).map(r => r.name)).toEqual(['2.pdf', '10.pdf'])
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    const loaded = await desktop.readPdfFileForPrint(big.path)
    expect(loaded.bytes.length).toBe(big.size)
    expect([...loaded.bytes.subarray(chunk - 1)]).toEqual([11, 22, 22, 22])
    expect(ipc.invoke.mock.calls.slice(1).map(c => [c[0], c[1]])).toEqual([
      ['read_granted', { token: big.token, offset: 0, length: chunk }],
      ['read_granted', { token: big.token, offset: chunk, length: 3 }],
    ])
    await expect(desktop.readPdfFileForPrint('D:\\unselected.pdf')).rejects.toThrow(/授权/)
  })
  it('passes exact binary views on save and uses the refreshed grant for another overwrite', async () => {
    const file = ref('原件.pdf'), bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3)
    let revision = 0
    ipc.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'pick_documents') return [file]
      if (cmd === 'read_granted') return new Uint8Array(file.size).buffer
      if (cmd === 'prepare_overwrite') return { path: file.path, token: 'write-once' }
      if (cmd === 'write_granted') return { ...file, token: `revision-${++revision}` }
      if (cmd === 'choose_save') return null
      throw Error(cmd)
    })
    await desktop.openFiles()
    expect(await desktop.overwritePdf(bytes, file.path)).toBe(file.path)
    await desktop.overwritePdf(bytes, file.path)
    const writes = ipc.invoke.mock.calls.filter(c => c[0] === 'write_granted')
    expect(writes[0][1]).toBe(bytes)
    expect(writes[0][2]).toEqual({ headers: { 'x-paperwork-ticket': 'write-once' } })
    expect(ipc.invoke.mock.calls.filter(c => c[0] === 'prepare_overwrite').map(c => c[1].token)).toEqual(['native-id', 'revision-1'])
    expect(await desktop.savePdf(bytes, '另存.pdf')).toBeNull()
    expect(ipc.invoke.mock.calls.filter(c => c[0] === 'write_granted')).toHaveLength(2)
  })
  it('binds the original revision to each source and enforces create-only on protected copies', async () => {
    let latest = 'rev-A', picked = 0
    const path = ref('same.pdf').path
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'pick_documents') return [ref('same.pdf', 4, ++picked === 1 ? 'rev-A' : 'rev-B')]
      if (cmd === 'read_granted') return new ArrayBuffer(4)
      if (cmd === 'prepare_overwrite') { if (args.token !== latest) throw Error('原件版本已变化'); return {path,token:'write-ticket'} }
      if (cmd === 'write_granted') return ref('same.pdf', 4, latest = 'rev-C')
      if (cmd === 'choose_save') { expect(args.createOnly).toBe(true); return null }
      throw Error(cmd)
    })
    const [old] = await desktop.openFiles(); latest = 'rev-B'; const [newer] = await desktop.openFiles()
    await desktop.overwritePdf(new Uint8Array(4), path, newer.desktopGrant)
    await expect(desktop.overwritePdf(new Uint8Array(4), path, old.desktopGrant)).rejects.toThrow('版本已变化')
    expect(await desktop.savePdfCopy!(new Uint8Array(4), 'protected-copy.pdf')).toBeNull()
  })
  it('claims cold and warm requests after subscription, not before React is ready', async () => {
    let queue = [{ path: 'a.ofd', token: 'cold' }]
    const file = ref('a.ofd')
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'take_pending_opens') return queue
      if (cmd === 'claim_open') return file
      if (cmd === 'read_granted') return new ArrayBuffer(file.size)
      if (cmd === 'acknowledge_open') queue = queue.filter(v => v.token !== args.token)
    })
    events.get('paperwork-open-available')!({})
    expect(ipc.invoke).not.toHaveBeenCalled()
    const received: string[] = []
    const off = desktop.onOpenFileRequested((_, token) => { received.push(token); desktop.acknowledgeOpenFile(token) })
    desktop.notifyRendererReady()
    await vi.waitFor(() => expect(received).toEqual(['cold']))
    expect((await desktop.readFileAtPath('cold')).type).toBe('ofd')
    queue.push({ path: 'b.pdf', token: 'warm' }); events.get('paperwork-open-available')!({})
    await vi.waitFor(() => expect(received).toEqual(['cold', 'warm']))
    off()
    const count = ipc.invoke.mock.calls.length
    events.get('paperwork-open-available')!({})
    expect(ipc.invoke).toHaveBeenCalledTimes(count)
  })
  it('allows cancel and a later close without destroying or hiding the native window in JS', async () => {
    ipc.invoke.mockResolvedValue(undefined)
    const prompt = vi.fn(); const off = desktop.onCloseRequest(prompt)
    events.get('paperwork-close-request')!({}); desktop.confirmClose(false)
    events.get('paperwork-close-request')!({}); desktop.confirmClose(true); off()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(ipc.invoke.mock.calls.map(c => [c[0], c[1]])).toEqual([['decide_close', { proceed: false }], ['decide_close', { proceed: true }]])
    expect(ipc.close).not.toHaveBeenCalled()
  })
  it('stores only a private MIME marker and invalidates it for external text or images', () => {
    const values = new Map<string, string>()
    const clip = (name: string) => Object.assign(new Event(name, { cancelable: true }), { clipboardData: {
      setData: (k: string, v: string) => values.set(k, v), getData: (k: string) => values.get(k) ?? '',
    } })
    vi.stubGlobal('document', { execCommand: () => !dom.dispatchEvent(clip('copy')) })
    const token = 'paperwork:pages:12345'
    desktop.writeInternalClipboardToken(token)
    expect([...values]).toEqual([['application/x-paperwork-internal', token]])
    dom.dispatchEvent(clip('paste')); expect(desktop.readInternalClipboardToken()).toBe(token)
    values.clear(); values.set('text/plain', 'external selection')
    dom.dispatchEvent(clip('paste')); expect(desktop.readInternalClipboardToken()).not.toBe(token)
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})
