import type { PdfCompressionOptions, PdfCompressionProgress, PdfCompressionResult, PdfSource } from '../types/pdf'

import wasmUrl from 'qpdf-run/qpdf.wasm?url'

// qpdf's MEMFS, the input snapshot and the output coexist while writing. Check before copying.
export const MAX_COMPRESSION_BYTES = 96 * 1024 * 1024
type WorkerResult = Pick<PdfCompressionResult, 'bytes' | 'skippedLargeImages'>
export type CompressionMessage = { progress: PdfCompressionProgress } | WorkerResult | { error: string }

export async function compressSource(
  source: Pick<PdfSource, 'bytes' | 'documentInfo'>, { mode, signal }: PdfCompressionOptions, onProgress?: (value: PdfCompressionProgress) => void,
): Promise<PdfCompressionResult> {
  const aborted = () => new DOMException('PDF 压缩已取消', 'AbortError')
  if (signal?.aborted) throw aborted()
  if (source.documentInfo?.encrypted) throw new Error('加密 PDF 无法安全压缩，请先解除密码保护')
  if (source.documentInfo?.hasSignatures) throw new Error('重写会使数字签名失效，请使用未签名的原稿')
  const originalSize = source.bytes.byteLength
  if (!originalSize || originalSize > MAX_COMPRESSION_BYTES) throw new Error('PDF 为空或超过 96 MiB 安全压缩上限')
  onProgress?.({ stage: 'loading', current: 0, total: 1 })
  if (signal?.aborted) throw aborted()

  // A dedicated worker makes even synchronous parsing/deflation and canvas codecs cancellable.
  // WebView2 can serve embedded assets to the window, but not reliably to a nested
  // classic worker. Fetch on the window and transfer once to the single cancellable worker.
  const wasmReply = await fetch(wasmUrl, {signal})
  if (!wasmReply.ok) throw new Error('无法载入内置压缩引擎，请检查安装文件。')
  const wasm = new Uint8Array(await wasmReply.arrayBuffer())
  if(signal?.aborted) throw aborted()
  const worker = new Worker(new URL('./pdfCompression.worker.ts', import.meta.url), { type: 'module' })
  let cancel: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const { bytes: candidate, skippedLargeImages } = await new Promise<WorkerResult>((resolve, reject) => {
      cancel = () => reject(aborted())
      signal?.addEventListener('abort', cancel, { once: true })
      timeout = setTimeout(() => reject(new Error('压缩超时，未生成副本')), 180_000)
      worker.onmessage = ({ data }: MessageEvent<CompressionMessage>) => {
        if ('progress' in data) onProgress?.(data.progress)
        else if ('bytes' in data) resolve(data)
        else reject(new Error(data.error))
      }
      worker.onerror = () => reject(new Error('压缩工作线程出错，未生成副本'))
      worker.onmessageerror = worker.onerror as () => void
      const bytes = new Uint8Array(source.bytes) // never detach the workspace's bytes, including subarray views
      worker.postMessage({ bytes, mode, wasm }, [bytes.buffer, wasm.buffer])
    })
    if (signal?.aborted) throw aborted()
    const hasGain = candidate.byteLength < originalSize
    const bytes = hasGain ? candidate : source.bytes
    const savedBytes = originalSize - bytes.byteLength
    onProgress?.({ stage: 'complete', current: 1, total: 1, skippedLargeImages })
    return { mode, bytes, skippedLargeImages, originalSize, attemptedSize: candidate.byteLength, compressedSize: bytes.byteLength,
      savedBytes, savingsRatio: savedBytes / originalSize, hasGain }
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel)
    clearTimeout(timeout)
    worker.terminate()
  }
}
