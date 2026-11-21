import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { DOMMatrix, ImageData, Path2D, createCanvas, loadImage } from '@napi-rs/canvas'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { zipSync, strToU8 } from 'fflate'
import { firstPage, makeOfdFixture, ofdManifest, ofdPage } from '../../tests/ofdFixture'
import { receiptFixture, NS, signPath } from '../../tests/ofdReceiptFixture'
import { convertOfd, previewOfd } from './ofd'
import { openOfdArchive } from './ofdArchive'

beforeAll(() => {
  vi.stubGlobal('DOMParser', DOMParser)
  vi.stubGlobal('DOMMatrix', DOMMatrix); vi.stubGlobal('ImageData', ImageData); vi.stubGlobal('Path2D', Path2D)
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1)
    return Object.assign(canvas, { toBlob: (cb: (blob: Blob) => void) => cb(new Blob([canvas.toBuffer('image/png')])) })
  } })
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => Object.assign(await loadImage(Buffer.from(await blob.arrayBuffer())), { close() {} }))
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
})
afterAll(() => vi.unstubAllGlobals())

describe('local OFD import', () => {
  it('keeps the source bytes intact; PDF pages, visible marks, template, raster and searchable Chinese match document order', async () => {
    const input = makeOfdFixture(), original = input.slice()
    const bytes = await convertOfd(input)
    expect(input).toEqual(original)
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-')
    const loading = getDocument({ data: bytes, useSystemFonts: false })
    try {
      const doc = await loading.promise
      expect(doc.numPages).toBe(2)
      const first = await doc.getPage(1), second = await doc.getPage(2)
      for (const [page, w, h, label] of [[first, 100, 70, '发票样张'], [second, 80, 110, 'Page Two']] as const) {
        expect(page.view[2]).toBeCloseTo(w * 72 / 25.4); expect(page.view[3]).toBeCloseTo(h * 72 / 25.4)
        const content = await page.getTextContent()
        expect(content.items.map(item => 'str' in item ? item.str : '').join('').replace(/\s/g, '')).toBe(label.replace(/\s/g, ''))
      }
      const viewport = first.getViewport({ scale: 2 }), canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), ctx = canvas.getContext('2d')
      await first.render({ viewport, canvasContext: ctx as unknown as CanvasRenderingContext2D }).promise
      const px = (v: number) => Math.round(v * 72 / 25.4 * 2)
      const color = (x: number, y: number) => [...ctx.getImageData(px(x), px(y), 1, 1).data].slice(0, 3)
      expect(color(25, 2)).toEqual([24, 96, 176])
      expect(color(9, 32)).toEqual([210, 36, 42])
      expect(color(50, 32)).toEqual([0, 0, 0])
      expect(color(74, 60)).toEqual([255, 255, 255])
      const label = ctx.getImageData(px(5), px(10), px(29), px(12)).data
      let ink = 0
      for (let i = 0; i < label.length; i += 4) if (label[i] < 100) ink++
      expect(ink).toBeGreaterThan(100)
    } finally { await loading.destroy() }
  })

  it('opens an otherwise unchanged supported page with a 1.3 manifest, but not an unknown major version', async () => {
    const body='<o:DocBody><o:DocRoot>Doc_0/Document.xml</o:DocRoot></o:DocBody>'
    const make=(version:string)=>makeOfdFixture({'OFD.xml':ofdManifest(body).replace('Version="1.0"',`Version="${version}"`)})
    expect((await convertOfd(make('1.3'))).length).toBeGreaterThan(100)
    await expect(convertOfd(make('3.0'))).rejects.toThrow('版本')
  })

  it('renders a signature-bearing 1.3 reading copy with explicit TrueType glyphs, searchable labels, and BMP pixels', async () => {
    const input=receiptFixture(), original=input.slice();const r=await previewOfd(input)
    expect(r.signature).toBe('unverified');expect(input).toEqual(original)
    const loading=getDocument({data:r.bytes,useSystemFonts:false});try{const doc=await loading.promise,p=await doc.getPage(1),v=p.getViewport({scale:2});const c=createCanvas(Math.ceil(v.width),Math.ceil(v.height)),ctx=c.getContext('2d');await p.render({viewport:v,canvasContext:ctx as unknown as CanvasRenderingContext2D}).promise
      const color=(x:number,y:number)=>[...ctx.getImageData(Math.round(x*72/25.4*2),Math.round(y*72/25.4*2),1,1).data].slice(0,3)
      expect(color(7,13)).toEqual([0,0,0]);expect(color(17,13)).toEqual([0,0,0]);expect(color(50,32)).toEqual([210,40,64]);expect((await p.getTextContent()).items.map(i=>'str'in i?i.str:'').join('').replace(/\s/g,'')).toBe('甲乙')
    }finally{await loading.destroy()}
    await expect(convertOfd(input)).rejects.toThrow('签章')
    await expect(previewOfd(receiptFixture({[signPath]:`<o:Signature ${NS}><o:SignedInfo><o:StampAnnot PageRef="9" Boundary="0 0 10 10"/></o:SignedInfo><o:SignedValue>SignedValue.dat</o:SignedValue></o:Signature>`}))).rejects.toThrow(/印章|签章/)
  })

  it('rejects broken archives and damaged member checksums', async () => {
    const bytes = makeOfdFixture()
    await expect(convertOfd(bytes.subarray(0, 42))).rejects.toThrow('压缩包损坏')
    const stored = zipSync({ 'OFD.xml': strToU8(ofdManifest('<o:DocBody/>')) }, { level: 0 })
    stored[30 + 'OFD.xml'.length + 1] ^= 1
    await expect(convertOfd(stored)).rejects.toThrow('压缩包损坏')
  })

  it('rejects oversized XML, forged uncompressed sizes, unsafe paths and DTDs', async () => {
    expect(() => openOfdArchive(zipSync({ 'OFD.xml': new Uint8Array(3 * 1024 * 1024 + 1) }))).toThrow('XML')
    const lie = zipSync({ 'OFD.xml': strToU8('<OFD>bounded</OFD>') })
    const view = new DataView(lie.buffer, lie.byteOffset, lie.byteLength), central = view.getUint32(lie.length - 6, true)
    view.setUint32(central + 24, 2, true)
    await expect(openOfdArchive(lie).xml('OFD.xml', 'OFD')).rejects.toThrow('压缩包损坏')
    expect(() => openOfdArchive(makeOfdFixture({ '../escape.xml': 'x' }))).toThrow('根目录')
    for (const loc of ['../escape', 'https://example.invalid/remote', 'file:///C:/x', '//server/file']) {
      await expect(convertOfd(makeOfdFixture({ 'OFD.xml': ofdManifest(`<o:DocBody><o:DocRoot>${loc}</o:DocRoot></o:DocBody>`) }))).rejects.toThrow(/包内路径|根目录/)
    }
    await expect(convertOfd(makeOfdFixture({ 'OFD.xml': '<!DOCTYPE OFD><OFD/>' }))).rejects.toThrow('DTD')
  })

  it('explicitly refuses signed, multi-document, missing-page and unsupported content rather than silently dropping it', async () => {
    const body = '<o:DocBody><o:DocRoot>Doc_0/Document.xml</o:DocRoot></o:DocBody>'
    for (const [xml, message] of [[body + body, '单文档'], [body.replace('</o:DocBody>', '<o:Signatures>Signs/Signatures.xml</o:Signatures></o:DocBody>'), '签章']] as const) {
      await expect(convertOfd(makeOfdFixture({ 'OFD.xml': ofdManifest(xml) }))).rejects.toThrow(message)
    }
    await expect(convertOfd(makeOfdFixture({ 'Doc_0/Signs/Signatures.xml': '<Signatures/>' }))).rejects.toThrow('签章')
    await expect(convertOfd(makeOfdFixture({ [firstPage]: null }))).rejects.toThrow('缺少包内文件')
    await expect(convertOfd(makeOfdFixture({ [firstPage]: ofdPage('<o:Content><o:Layer><o:AlienObject/></o:Layer></o:Content>') }))).rejects.toThrow('暂不支持页面图元')
    await expect(convertOfd(makeOfdFixture({ 'Doc_0/Assets/black.png': strToU8('<svg/>') }))).rejects.toThrow('支持 PNG')
  })
})
