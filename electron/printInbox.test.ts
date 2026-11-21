import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Inbox = Pick<NonNullable<Window['desktop']>, 'takeVirtualPrintJobs' | 'acknowledgeVirtualPrintJobs'>
type Handler = (event: unknown, ids?: readonly string[]) => Promise<unknown>
const wire = vi.hoisted(() => ({ root: '', handlers: new Map<string, Handler>(), bridge: undefined as Inbox | undefined }))

// Exercise the registered preload and main handlers, but never start Electron or its printer watcher.
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true, on: vi.fn(), setAppUserModelId: vi.fn(), whenReady: () => new Promise(() => {}),
    getPath: (name: string) => { if (name !== 'userData' || !wire.root) throw Error('unexpected app path'); return wire.root },
  },
  ipcMain: { on: vi.fn(), handle: (channel: string, handler: Handler) => wire.handlers.set(channel, handler) },
  ipcRenderer: { invoke: (channel: string, ids?: readonly string[]) => wire.handlers.get(channel)!(undefined, ids) },
  contextBridge: { exposeInMainWorld: (_key: string, bridge: Inbox) => { wire.bridge = bridge } },
}))
vi.mock('./ocr', () => ({}))
vi.mock('./ocrConnections', () => ({}))
vi.mock('./wordImport', () => ({}))

const [a, b, c] = [1, 2, 3].map(n => `170000000000${n}-00000000-0000-4000-8000-00000000000${n}.pdf`)
const queue = () => path.join(wire.root, 'VirtualPrintQueue')
const file = (id: string) => path.join(queue(), id)
const peek = async (ids?: readonly string[]) => (await wire.bridge!.takeVirtualPrintJobs(ids)).map(job => job.id)
const ack = (id: string) => wire.bridge!.acknowledgeVirtualPrintJobs([id])
const files = async () => (await fs.readdir(queue())).sort()

beforeAll(async () => { await import('./main'); await import('./preload') })
beforeEach(async () => {
  wire.root = await fs.mkdtemp(path.join(tmpdir(), 'paperwork-receipt-'))
  await fs.mkdir(queue())
  for (const id of [c, b, a]) {
    const pdf = await PDFDocument.create(); pdf.addPage([160, 220]).drawText(id)
    await fs.writeFile(file(id), await pdf.save())
  }
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(wire.root, { recursive: true, force: true }); wire.root = '' })

describe('Electron print inbox IPC with a temporary disk queue', () => {
  it('peeks in queue order, reads only the first non-excluded PDF, and can revisit postponed A', async () => {
    const reads = vi.spyOn(fs, 'readFile')
    expect(await peek()).toEqual([a]); expect(await peek([a])).toEqual([b])
    expect(await peek([a, b])).toEqual([c]); expect(await peek([a, b, c])).toEqual([])
    expect(await peek()).toEqual([a]); expect(await files()).toEqual([a, b, c])
    expect(reads.mock.calls.map(([p]) => path.basename(String(p)))).toEqual([a, b, c, a])
  })

  it('reports a failed unlink, preserves the files, and consumes only individually acknowledged jobs', async () => {
    const original = await fs.readFile(file(a)), untouched = await fs.readFile(file(c))
    const unlink = fs.unlink.bind(fs)
    let locked = true
    vi.spyOn(fs, 'unlink').mockImplementation(p => locked && p === file(a)
      ? Promise.reject(Object.assign(new Error('synthetic busy file'), { code: 'EBUSY' })) : unlink(p))
    await expect(ack(a)).rejects.toThrow('synthetic busy file')
    expect(await peek([a])).toEqual([b]); expect(await files()).toEqual([a, b, c])
    await ack(b); await expect(ack(a)).rejects.toThrow('synthetic busy file')
    expect(await files()).toEqual([a, c]); expect(await fs.readFile(file(a))).toEqual(original)
    locked = false
    await ack(a); await ack(a) // An already delivered receipt is idempotent.
    expect(await files()).toEqual([c]); expect(await fs.readFile(file(c))).toEqual(untouched)
  })
})
