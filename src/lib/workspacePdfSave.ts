import type { ExportOptions, PdfSource, WorkspacePage } from '../types/pdf'
import { pageGroupId } from './editorDocuments'
import { composePdf, compositionNeedsNewFile, recordOriginalOverwrite } from './pdf'

export function pageSources(pages: WorkspacePage[], sources: PdfSource[]) {
  const ids = new Set(pages.map(page => page.sourceId))
  return sources.filter(source => ids.has(source.id))
}

// Resolve each editor group's watermark once before splitting the output files.
// A merge workspace has one global mark in addition to its page-carried ink.
export function prepareStandalonePdfExport(
  pages: WorkspacePage[], sources: PdfSource[], editor: boolean,
  resolve: (groupId?: string) => ExportOptions['watermark'],
) {
  const options = editor
    ? { groupWatermarks: new Map([...new Set(pages.map(pageGroupId))].map(id => [id, resolve(id)])) }
    : { watermark: resolve() }
  return (subset = pages) => composePdf(subset, sources, options)
}

export async function downloadBytes(bytes: Uint8Array, name: string, createOnly = false) {
  if (window.desktop) {
    if (!createOnly) return window.desktop.savePdf(bytes, name)
    if (!window.desktop.savePdfCopy) throw new Error('当前桌面版本不能安全另存为新副本。原文件未改动。')
    return window.desktop.savePdfCopy(bytes, name)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const anchor = Object.assign(document.createElement('a'), { href: url, download: name })
  anchor.click()
  URL.revokeObjectURL(url)
  return name
}

export async function confirmPdfCopy(sources: PdfSource[], encryptedOutput = false) {
  for (const source of sources) {
    if (!await compositionNeedsNewFile(source)) continue
    const protection = encryptedOutput ? '副本将使用新设置的密码和权限。' : '副本将是未加密的 PDF，不保留原密码或权限限制。'
    const destination = window.desktop ? '不能替换原文件。' : '请在浏览器中选择新文件名，不要覆盖原件。'
    const prompt = sources.some(s => s.fileInfo?.ofdSignature)
      ? `这是 OFD 的未验签阅览副本，新 PDF 不含原签名或附件，不能代替原件。${destination}\n\n${protection}其他来源的表单和书签也可能不保留。另存为新 PDF？`
      : `只能另存为新 PDF 副本。${destination}\n\n${protection}原有书签、表单或其他文档级信息可能丢失；原件上的数字签名（如有）不能验证重新生成的副本。\n\n确定继续另存为？取消不会写入任何文件。`
    if (!window.confirm(prompt)) return null
    // Create-only single and batch writers ship together. Never fall back to
    // an overwrite-capable host when the input requires a new destination.
    if (window.desktop && !window.desktop.savePdfCopy) throw new Error('当前桌面版本不能安全另存为新副本。原文件未改动。')
    return 'new-file'
  }
  return 'ordinary'
}

export async function saveWorkspacePdf({ target, dirty, saveAs, sources, suggested, compose }: {
  target?: PdfSource; dirty: boolean; saveAs: boolean; sources: PdfSource[]; suggested: string; compose: () => Promise<Uint8Array>
}) {
  const path = target?.path && /\.pdf$/i.test(target.path) ? target.path : undefined
  if (path && !dirty && !saveAs) return 'unchanged'
  // A replaced group's backing file can differ from every remaining page source.
  const decision = await confirmPdfCopy(target && !sources.includes(target) ? [target, ...sources] : sources)
  if (!decision) return null
  const bytes = await compose()
  if (decision === 'ordinary' && !saveAs && target && path && window.desktop?.overwritePdf) {
    if (!await window.desktop.overwritePdf(bytes, path, target.desktopGrant)) return null
    recordOriginalOverwrite(target, bytes)
    return 'original'
  }
  const guarded = decision === 'new-file' || target?.fileInfo?.extension === 'MSG' || (!target && sources.some(s => s.fileInfo?.extension === 'MSG'))
  const name = guarded ? `${suggested.replace(/\.pdf$/i, '')}-副本.pdf` : suggested
  return await downloadBytes(bytes, name, guarded) ? 'copy' : null
}
