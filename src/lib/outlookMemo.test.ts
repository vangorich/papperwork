import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { MemoMessage } from '../types/outlookMail'
import { renderOutlookMemo } from './outlookMemo'

const mail: MemoMessage = {
  from: '林文 <lin@example.invalid>', to: ['开发组 <dev@example.invalid>'], cc: ['复核组'],
  subject: '纸页校样 café', body: '正文', attachments: [], warnings: [],
}
const compact = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '')
const offlineFetch = vi.fn(() => { throw new Error('memo must not fetch') })
beforeAll(() => {
  vi.stubGlobal('DOMMatrix', DOMMatrix); vi.stubGlobal('ImageData', ImageData); vi.stubGlobal('Path2D', Path2D)
  vi.stubGlobal('document', { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('unexpected DOM element: ' + tag)
    return createCanvas(1, 1)
  } })
  vi.stubGlobal('fetch', offlineFetch)
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
})
afterAll(() => vi.unstubAllGlobals())

describe('local Outlook memo PDF', () => {
  it('prints whole headers and flowing text, with native Unicode runs inside portrait print margins on every sheet', async () => {
    const longAddress = 'address'.repeat(32) + '@example.invalid'
    const bcc = '合成密送@example.invalid', attachment = '测试条目.pdf'
    // More than 255 distinct glyphs forces multiple one-byte subsets.
    const alphabet = Array.from({ length: 280 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
    const body = ['正文起点 Hello café', '', alphabet, 'https://example.invalid/local-only',
      ...Array.from({ length: 85 }, (_, i) => `第 ${i + 1} 条记录：分页保留。`), '正文终点 END'].join('\r\n')
    const data = await renderOutlookMemo({ ...mail, to: [longAddress, ...mail.to], bcc: [bcc], sentAt: '2026-05-05T12:30:00Z', attachments: [attachment], body })
    const loading = getDocument({ data, useSystemFonts: false, isEvalSupported: false, stopAtErrors: true })
    try {
      const doc = await loading.promise
      expect(doc.numPages).toBeGreaterThanOrEqual(3)
      let text = ''
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n), content = await page.getTextContent({ disableNormalization: true })
        expect(page.view).toEqual([0, 0, 595.28, 841.89]); expect(page.rotate).toBe(0)
        let footer = ''
        for (const item of content.items) if ('str' in item && item.str.trim()) {
          const [, , , , x, y] = item.transform
          expect(x).toBeGreaterThanOrEqual(56.9); expect(x + item.width).toBeLessThanOrEqual(538.5)
          if (y < 60) { expect(y).toBeCloseTo(43); footer += item.str }
          else { expect(y).toBeGreaterThanOrEqual(71); expect(y).toBeLessThan(785); text += item.str }
        }
        expect(compact(footer)).toBe(`第${n}/${doc.numPages}页`)
      }
      const printed = compact(text)
      expect(printed).toContain(compact(`备忘录发件人：${mail.from}发送时间：2026`))
      expect(printed).toContain(compact(`收件人：${longAddress}; ${mail.to[0]}抄送：${mail.cc[0]}密送：${bcc}主题：${mail.subject}附件：${attachment}${body}`))
      expect(offlineFetch).not.toHaveBeenCalled()
    } finally { await loading.destroy() }
  }, 30_000)

  it('rejects excessive input, addresses, pages and single clusters instead of returning a clipped PDF', async () => {
    await expect(renderOutlookMemo({ ...mail, body: 'a'.repeat(1_000_001) })).rejects.toThrow(/MSG.*1000000/)
    await expect(renderOutlookMemo({ ...mail, to: Array(4097).fill('') })).rejects.toThrow(/MSG.*4096/)
    await expect(renderOutlookMemo({ ...mail, body: 'a' + '̀'.repeat(65) })).rejects.toThrow(/MSG.*组合字符/)
    await expect(renderOutlookMemo({ ...mail, body: '\n'.repeat(15_000) + 'last' })).rejects.toThrow(/MSG.*256 页/)
  }, 15_000)
})
