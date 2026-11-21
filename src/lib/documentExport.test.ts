import { createRequire } from 'node:module'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  buildEditableDocx,
  buildImageDocx,
  calculatePageRasterScale,
  createStoredZip,
  extractEditableDocxPages,
  type EditableDocxPage,
  type RenderedPageImage,
} from './documentExport'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = new URL(
  '../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()
const AdmZip = require('adm-zip') as new (bytes: Buffer) => {
  getEntries(): { entryName: string; getData(): Buffer }[]
  readAsText(name: string): string
}

describe('multi-format document export', () => {
  it('caps page rasterization by DPI, pixel count and maximum dimension', () => {
    expect(calculatePageRasterScale(612, 792, 144)).toBe(2)
    const scale = calculatePageRasterScale(10_000, 4_000, 600, 12_000_000, 4096)
    expect(10_000 * 4_000 * scale ** 2).toBeLessThanOrEqual(12_000_000)
    expect(10_000 * scale).toBeLessThanOrEqual(4096)
    expect(calculatePageRasterScale(612, 792, -10)).toBe(0.5)
  })

  it('creates a standards-readable stored ZIP without external compression code', () => {
    const bytes = createStoredZip([
      { name: 'hello.txt', bytes: new TextEncoder().encode('你好 Paperwork') },
      { name: 'folder/value.bin', bytes: Uint8Array.of(0, 1, 2, 255) },
    ])
    const zip = new AdmZip(Buffer.from(bytes))
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(['hello.txt', 'folder/value.bin'])
    expect(zip.readAsText('hello.txt')).toBe('你好 Paperwork')
    expect([...zip.getEntries()[1].getData()]).toEqual([0, 1, 2, 255])
  })

  it('builds a DOCX with one related image and section per PDF page', () => {
    const images: RenderedPageImage[] = [
      {
        name: 'page-01.png', bytes: Uint8Array.of(137, 80, 78, 71), mimeType: 'image/png',
        width: 1200, height: 1600, pageWidthPoints: 595.28, pageHeightPoints: 841.89,
      },
      {
        name: 'page-02.jpg', bytes: Uint8Array.of(255, 216, 255, 217), mimeType: 'image/jpeg',
        width: 1600, height: 900, pageWidthPoints: 841.89, pageHeightPoints: 595.28,
      },
    ]
    const zip = new AdmZip(Buffer.from(buildImageDocx(images, { title: '审阅 & 归档' })))
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('[Content_Types].xml')
    expect(names).toContain('word/document.xml')
    expect(names).toContain('word/media/page-1.png')
    expect(names).toContain('word/media/page-2.jpg')
    const documentXml = zip.readAsText('word/document.xml')
    expect(documentXml.match(/<w:p>/g)).toHaveLength(2)
    expect(documentXml).toContain('w:orient="landscape"')
    expect(documentXml).toContain('r:embed="rId2"')
    expect(zip.readAsText('docProps/core.xml')).toContain('审阅 &amp; 归档')
  })

  it('uses positioned OCR words when a page has no native text', async () => {
    const source = await PDFDocument.create()
    source.addPage([200, 300])
    const pages = await extractEditableDocxPages(await source.save(), {
      ocrWordsByPage: [[
        { text: '扫描', confidence: 0.95, x: 0.1, y: 0.2, width: 0.18, height: 0.05 },
        { text: '内容', confidence: 0.96, x: 0.3, y: 0.2, width: 0.18, height: 0.05 },
      ]],
    })

    expect(pages).toHaveLength(1)
    expect(pages[0].lines).toHaveLength(1)
    expect(pages[0].lines[0].runs.map((run) => run.text).join('')).toContain('扫描')
    expect(pages[0].lines[0].runs.map((run) => run.text).join('')).toContain('内容')
    expect(pages[0].lines[0].xPoints).toBeCloseTo(20)
    expect(pages[0].lines[0].runs[0].fontFamily).toBe('Microsoft YaHei')
  })

  it('builds an editable DOCX with styled text, tables and page sections', () => {
    const pages: EditableDocxPage[] = [
      {
        widthPoints: 595.28,
        heightPoints: 841.89,
        lines: [{
          xPoints: 36,
          yPoints: 48,
          heightPoints: 14,
          runs: [{
            text: '合同 & <可编辑>',
            fontFamily: 'SimSun',
            fontSizePoints: 14,
            bold: true,
            italic: true,
          }],
        }],
        tables: [{
          id: 'table-1',
          rows: [['项目', '金额'], ['服务', '¥100']],
          columnCount: 2,
          confidence: 0.98,
          source: 'geometry',
          bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.15 },
        }],
      },
      {
        widthPoints: 841.89,
        heightPoints: 595.28,
        lines: [{
          xPoints: 28,
          yPoints: 32,
          heightPoints: 11,
          runs: [{ text: 'Landscape page', fontSizePoints: 11 }],
        }],
        tables: [],
      },
    ]

    const zip = new AdmZip(Buffer.from(buildEditableDocx(pages, { title: '结构化 & 导出' })))
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('word/document.xml')
    expect(names).toContain('word/styles.xml')
    const documentXml = zip.readAsText('word/document.xml')
    expect(documentXml).toContain('合同 &amp; &lt;可编辑&gt;')
    expect(documentXml).toContain('<w:rFonts w:ascii="SimSun"')
    expect(documentXml).toContain('<w:sz w:val="28"/>')
    expect(documentXml).toContain('<w:b/>')
    expect(documentXml).toContain('<w:i/>')
    expect(documentXml).toContain('<w:tbl>')
    expect(documentXml).toContain('<w:gridCol')
    expect(documentXml.match(/<w:sectPr>/g)).toHaveLength(2)
    expect(documentXml).toContain('w:orient="landscape"')
    expect(zip.readAsText('docProps/core.xml')).toContain('结构化 &amp; 导出')
  })
})
