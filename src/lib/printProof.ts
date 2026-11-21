import { getDocument, type PDFPageProxy } from 'pdfjs-dist'
import type { DocumentWatermark, PdfSource, WorkspacePage } from '../types/pdf'
import { composePdf, getPdfPage, pdfPrintAssets, releasePdfPageResources, retainPdfPageResources } from './pdf'

export interface PrintProof { url: string; widthPt: number; heightPt: number }

/** Read-only preview of the printable page, rather than a picture of its unedited source.
 * The source path is cheap for untouched pages. For edits, use exactly the compositor used
 * by the print job (handles rotation + crop + page size + flattened marks + watermark). */
export async function makePrintProof(page: WorkspacePage, sources: PdfSource[], watermark: DocumentWatermark | undefined, maxWidth: number): Promise<PrintProof> {
  async function paint(proxy: PDFPageProxy, extraRotation: number): Promise<PrintProof> {
    const rotation = ((proxy.rotate + extraRotation) % 360 + 360) % 360
    const natural = proxy.getViewport({ scale: 1, rotation })
    const scale = Math.min(maxWidth / Math.max(1,natural.width), 1024 / Math.max(1,natural.height))
    const viewport = proxy.getViewport({ scale, rotation }); const canvas = document.createElement('canvas')
    canvas.width = Math.max(1,Math.round(viewport.width)); canvas.height = Math.max(1,Math.round(viewport.height))
    try {
      const ctx = canvas.getContext('2d', {alpha:false}); if (!ctx) throw new Error('无法创建预览画布')
      await proxy.render({ canvasContext:ctx, viewport, intent:'print', annotationMode:1, background:'#ffffff' }).promise
      return { url:canvas.toDataURL('image/png'), widthPt:natural.width, heightPt:natural.height }
    } finally { canvas.width = canvas.height = 0 }
  }
  const src = sources.find(s=>s.id===page.sourceId)
  if (src && !watermark && !page.inheritedWatermarks?.length && !page.crop && !page.pageSize && !page.annotations.length) {
    retainPdfPageResources(src,page.sourcePage)
    try { return await paint(await getPdfPage(src,page.sourcePage),page.rotation) }
    finally { releasePdfPageResources(src,page.sourcePage) }
  }
  const data = await composePdf([page],sources,{watermark})
  const task = getDocument({...pdfPrintAssets,data})
  try { const doc=await task.promise; return await paint(await doc.getPage(1),0) }
  finally { await task.destroy() }
}
