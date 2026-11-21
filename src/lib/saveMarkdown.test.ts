import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from '@napi-rs/canvas'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { fileURLToPath } from 'node:url'
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import { pagesForSource, releasePdfDocument } from './pdf'
import { saveMarkdownExport } from './saveMarkdown'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
// Keep the real renderer; its Node font/CMap loader expects paths instead of the app's file URLs.
vi.mock('pdfjs-dist', async importActual => {
  const pdfjs = await importActual<typeof import('pdfjs-dist')>()
  return { ...pdfjs, getDocument: (args: DocumentInitParameters) => pdfjs.getDocument({ ...args,
    standardFontDataUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
    cMapUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url)),
  }) }
})
const blank: WorkspacePage = { id: 'blank-1', sourceId: 'blank', sourcePage: 0, rotation: 0, annotations: [
  { id: 'text', type: 'text', text: '纸上笔记', x: .1, y: .1, width: .4, height: .1 },
] }
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const ticket = { token: 'opaque-capability', name: '改名.md', assetDirectory: '改名-images-2' }
let blobs: Blob[], clicks: string[], sources: PdfSource[]
async function drawing() {
  const doc = await PDFDocument.create(), c = createCanvas(8, 6), ctx = c.getContext('2d')
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 6)
  const p = doc.addPage([100, 100]); p.drawImage(await doc.embedPng(c.toBuffer('image/png')), { x: 20, y: 40, width: 16, height: 12 })
  p.drawText('Caption', { x: 10, y: 15, size: 12 })
  doc.addPage([100, 100]).drawText('outside authorized pages', { x: 1, y: 30, size: 9 })
  const source: PdfSource = { id: 's', name: 'source.pdf', bytes: await doc.save(), pageCount: 2, pageSizes: [], pageText: [], textIndexed: false }
  sources.push(source)
  return pagesForSource(source).slice(0, 1)
}
beforeEach(() => {
  blobs = []; clicks = []; sources = []; invoke.mockReset()
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  vi.stubGlobal('window', { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout })
  vi.stubGlobal('DOMMatrix', DOMMatrix); vi.stubGlobal('ImageData', ImageData); vi.stubGlobal('Path2D', Path2D)
  vi.stubGlobal('document', { createElement: (tag: string) => {
    if (tag === 'a') { const a = { download: '', href: '', click: () => clicks.push(a.download) }; return a }
    const c = createCanvas(1, 1); return Object.assign(c, { toBlob: (cb: (blob: Blob) => void) => cb(new Blob([c.toBuffer('image/png')])) })
  } })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { if (!(b instanceof Blob)) throw new Error('Expected file bytes'); blobs.push(b); return 'blob:test' })
})
afterEach(async () => { await Promise.all(sources.map(releasePdfDocument)); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Markdown export writer', () => {
  it('downloads one UTF-8 .md without images, ignoring an unsafe suggested path', async () => {
    const saved = await saveMarkdownExport([blank], [], '../private.md', false)
    expect(saved).toEqual({ name: 'Paperwork.md', imageCount: 0, warnings: [] })
    expect(clicks).toEqual(['Paperwork.md']); expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('text/markdown;charset=utf-8'); expect(await blobs[0].text()).toContain('纸上笔记')
    expect(await blobs[0].text()).not.toContain('![')
  })
  it('downloads a portable ZIP on Electron/browser; the actual Markdown link opens the rendered red PNG', async () => {
    Object.assign(window, { desktop: {} }) // Electron has no Markdown native IPC.
    const pages = await drawing(), result = await saveMarkdownExport(pages, sources, '本地手稿.md', true)
    expect(result).toEqual({ name: '本地手稿.zip', imageCount: 1, warnings: [] }); expect(clicks).toEqual(['本地手稿.zip'])
    const files = unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))
    const md = decode(files['本地手稿.md']), link = /!\[[^\]]*\]\(([^)]+)\)/.exec(md)?.[1]
    expect(md).toContain('Caption'); expect(md).not.toContain('outside authorized pages'); expect(link).toBe('images/figure-001.png')
    expect(Object.keys(files).sort()).toEqual(['images/', 'images/figure-001.png', '本地手稿.md'].sort())
    const img = await loadImage(Buffer.from(files[link!])); expect([img.width, img.height]).toEqual([8, 6])
    const ctx = createCanvas(8, 6).getContext('2d'); ctx.drawImage(img, 0, 0)
    expect([...ctx.getImageData(3, 2, 1, 1).data]).toEqual([255, 0, 0, 255]); expect(invoke).not.toHaveBeenCalled()
  })
  it('binds links to the picker-returned directory after a rename/collision and sends binary contents with tickets only', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} }); invoke.mockResolvedValueOnce(ticket)
    const pages = await drawing(); expect(await saveMarkdownExport(pages, sources, 'suggested.md', true)).toEqual({ name: '改名.md', imageCount: 1, warnings: [] })
    const [choose, image, finish] = invoke.mock.calls
    expect(choose).toEqual(['choose_markdown_export', { name: 'suggested.md', includeImages: true }])
    expect(image[0]).toBe('write_markdown_asset'); expect(image[1].slice(0, 8)).toEqual(Uint8Array.of(137,80,78,71,13,10,26,10))
    expect(image[2]).toEqual({ headers: { 'x-paperwork-ticket': ticket.token, 'x-paperwork-asset': 'figure-001.png' } })
    expect(finish[0]).toBe('finish_markdown_export'); expect(finish[2]).toEqual({ headers: { 'x-paperwork-ticket': ticket.token } })
    expect(decodeURIComponent(decode(finish[1]))).toContain(`](${ticket.assetDirectory}/figure-001.png)`)
    expect(clicks).toEqual([])
  })
  it('does not convert or write on a dismissed picker or a grant revoked in the chooser', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} }); const onPage = vi.fn()
    invoke.mockResolvedValueOnce(null)
    expect(await saveMarkdownExport([blank], [], 'notes.md', true, { onPage })).toBeNull(); expect(invoke).toHaveBeenCalledTimes(1)
    let valid = true
    invoke.mockImplementationOnce(async () => { valid = false; return ticket })
    expect(await saveMarkdownExport([blank], [], 'notes.md', true, { onPage, stillValid: () => valid })).toBeNull()
    expect(onPage).not.toHaveBeenCalled(); expect(invoke).toHaveBeenLastCalledWith('cancel_markdown_export', { token: ticket.token })
  })
  it.each(['abort', 'revoke'] as const)('releases partially written images on %s and does not publish the Markdown', async (reason) => {
    Object.assign(window, { __TAURI_INTERNALS__: {} }); const controller = new AbortController(); let valid = true
    invoke.mockImplementation(async command => {
      if (command === 'choose_markdown_export') return ticket
      if (command === 'write_markdown_asset') { if (reason === 'abort') controller.abort(); else valid = false }
    })
    const pages = await drawing()
    expect(await saveMarkdownExport(pages, sources, 'original.md', true, { signal: controller.signal, stillValid: () => valid })).toBeNull()
    expect(invoke.mock.calls.map(c => c[0])).toEqual(['choose_markdown_export', 'write_markdown_asset', 'cancel_markdown_export'])
    expect(clicks).toEqual([])
  })
  it('does not report a successful save or fall back to a download when native publication fails', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} }); invoke.mockResolvedValueOnce(ticket).mockRejectedValueOnce('目标已被创建')
    await expect(saveMarkdownExport([blank], [], 'original.md', false)).rejects.toThrow('目标已被创建')
    expect(invoke).toHaveBeenLastCalledWith('cancel_markdown_export', { token: ticket.token }); expect(clicks).toEqual([])
  })
})
