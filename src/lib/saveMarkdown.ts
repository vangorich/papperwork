import type { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import type { MarkdownScope } from './markdownScopeTypes'

interface SaveOptions {
  scope?: MarkdownScope
  /** Save precisely this user-reviewed string; do not re-read the document or attach assets. */
  reviewedText?: string
  signal?: AbortSignal
  /** MCP grants are live: permission may disappear while the native picker is open. */
  stillValid?: () => boolean
  onPage?: (current: number, total: number) => void
}
export interface SavedMarkdown { name: string; imageCount: number; warnings: string[] }
interface Ticket { token: string; name: string; assetDirectory: string }

export function hasNativeMarkdownPicker() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
const device = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9¹²³])$/i
function markdownName(name: string) {
  return name.length > 3 && name.length <= 250 && /\.md$/i.test(name) && !name.startsWith(' ')
    && !/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/.test(name) && !device.test(name.split('.')[0].trimEnd())
    ? name : 'Paperwork.md'
}
function validAsset(name: string) {
  return /^[A-Za-z0-9_-]{1,96}\.(?:png|jpg|jpeg|webp)$/.test(name) && !device.test(name.split('.')[0])
}
function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
  } finally {
    // Retain the object URL until the browser has had time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/** Save only the supplied page occurrences. No path or file capability is returned to an MCP caller.
 * Browser/Electron use one download (ZIP when requested); null means cancelled before publication. */
export async function saveMarkdownExport(
  pages: readonly WorkspacePage[], sources: readonly PdfSource[], name: string, includeImages: boolean, options: SaveOptions = {},
): Promise<SavedMarkdown | null> {
  const invalid = () => !!options.signal?.aborted || options.stillValid?.() === false
  const check = () => { if (invalid()) throw new DOMException('Markdown 导出已取消', 'AbortError') }
  if (invalid()) return null
  if (!pages.length) throw new Error('请选择要导出的页面')
  if (options.reviewedText !== undefined) {
    if (includeImages) throw new Error('审阅后的文字只能另存为纯 Markdown，不会附加未预览的资源。')
    if (!options.reviewedText.trim() || options.reviewedText.length > 16_000_000) throw new Error('审阅文本为空或过长，未写入文件。')
  }
  let invoke: typeof tauriInvoke | undefined, ticket: Ticket | null = null, committed = false
  let cancelling: Promise<void> | undefined
  const cancelTicket = () => {
    if (invoke && ticket && !committed) cancelling ??= invoke<void>('cancel_markdown_export', { token: ticket.token })
    return cancelling
  }
  const abort = () => { void cancelTicket()?.catch(() => { /* finally also waits for cleanup */ }) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    let leaf = markdownName(name), directory = 'images'
    if (hasNativeMarkdownPicker()) {
      invoke = (await import('@tauri-apps/api/core')).invoke
      check()
      ticket = await invoke<Ticket | null>('choose_markdown_export', { name: leaf, includeImages })
      if (!ticket) return null
      check()
      leaf = ticket.name
      directory = ticket.assetDirectory
    }
    check()
    const result = options.reviewedText !== undefined
      ? { markdown: options.reviewedText, assets: [], warnings: [] }
      : await (await import('./pdfMarkdown')).makePdfMarkdown(pages, sources, {
          includeImages, assetDirectory: directory, scope: options.scope, signal: options.signal,
          onPage: (n, total) => { check(); options.onPage?.(n, total) },
        })
    check()
    const names = new Set<string>()
    for (const asset of result.assets) {
      const key = asset.name.toLowerCase()
      if (!includeImages || !validAsset(asset.name) || names.has(key)) throw new Error('插图名称重复或无效，未保存 Markdown')
      names.add(key)
    }
    const markdown = new TextEncoder().encode(result.markdown)
    if (invoke && ticket) {
      const headers = { 'x-paperwork-ticket': ticket.token }
      for (const asset of result.assets) {
        check()
        await invoke('write_markdown_asset', asset.bytes, { headers: { ...headers, 'x-paperwork-asset': asset.name } })
      }
      check()
      await invoke('finish_markdown_export', markdown, { headers })
      committed = true
    } else if (includeImages) {
      const { zipSync } = await import('fflate')
      check()
      const entries: Record<string, Uint8Array> = { [leaf]: markdown, [`${directory}/`]: new Uint8Array() }
      for (const asset of result.assets) entries[`${directory}/${asset.name}`] = asset.bytes
      const zip = zipSync(entries, { level: 0 }) // Generated images are already compressed.
      check()
      leaf = leaf.slice(0, -3) + '.zip'
      download(leaf, zip, 'application/zip')
    } else {
      check()
      download(leaf, markdown, 'text/markdown;charset=utf-8')
    }
    return { name: leaf, imageCount: result.assets.length, warnings: result.warnings }
  } catch (e) {
    if (invalid() || (e instanceof Error && e.name === 'AbortError')) return null
    throw e instanceof Error ? e : new Error(String(e)) // Tauri rejects with strings.
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (!committed) await cancelTicket()
  }
}
