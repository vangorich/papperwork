// Node Vitest doesn't have Web Workers. Run the *installed* worker script and WASM on synthetic
// fixtures in a VM with their normal message protocol. Browser tests also exercise real termination,
// asset URLs, Canvas JPEG, and the WebView2-compatible nested worker (no shims there).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { vi } from 'vitest'
import { optimize } from '../src/lib/pdfCompression.worker'
import type { PdfCompressionMode } from '../src/types/pdf'

const require = createRequire(import.meta.url)
const wasmBinary = new Uint8Array(readFileSync(require.resolve('qpdf-run/qpdf.wasm')))

export async function withCompressionWorker<T>(test: () => Promise<T>) {
  class LocalWorker {
    onmessage?: (event: { data: unknown }) => void
    onerror?: (e: unknown) => void
    handle: (data: unknown) => void
    closed = false
    constructor(url: string | URL) {
      const send = (data: unknown) => { if (!this.closed) this.onmessage?.({ data: structuredClone(data) }) }
      if (!String(url).includes('pdfCompression.worker')) throw Error('unexpected second compression worker')
      this.handle = async data => {
        const {bytes, mode, wasm} = data as {bytes:Uint8Array;mode:PdfCompressionMode;wasm:Uint8Array}
        try { send(await optimize(bytes,mode,progress=>send({progress}),wasm)) }
        catch(e){send({error:(e as Error).message})}
      }
    }
    postMessage(data: unknown, transfer: Transferable[] = []) {
      const copy = structuredClone(data, { transfer })
      queueMicrotask(() => { if (!this.closed) this.handle(copy) })
    }
    terminate() { this.closed = true }
  }
  vi.stubGlobal('fetch', async (input:string) => {if(!String(input).includes('qpdf.wasm')) throw Error('unexpected fetch');return new Response(wasmBinary)})
  vi.stubGlobal('Worker', LocalWorker)
  try { return await test() } finally { vi.unstubAllGlobals() }
}
