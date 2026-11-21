import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api'
import { DOMMatrix, ImageData, Path2D, createCanvas, loadImage } from '@napi-rs/canvas'
import { PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, StandardFonts, TextRenderingMode, clip, degrees, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, setTextRenderingMode } from 'pdf-lib'
import { GlobalWorkerOptions } from 'pdfjs-dist'
import type { Markup, OcrPageLayer, OcrWord, PdfSource, WorkspacePage } from '../types/pdf'
import { composePdf, getPdfPage, pagesForSource, releasePdfDocument } from './pdf'
import { makePdfMarkdown } from './pdfMarkdown'
import { ocrLayerFromResult } from './ocrResultLayer'

// Same PDF.js parser, operator list and renderer as the app. Its Node font loader
// wants filesystem paths instead of the desktop renderer's bundled asset URLs.
vi.mock('pdfjs-dist', async importOriginal => {
  const pdfjs = await importOriginal<typeof import('pdfjs-dist')>()
  return { ...pdfjs, getDocument: (args: DocumentInitParameters) => pdfjs.getDocument({ ...args,
    cMapUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url)),
    standardFontDataUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
  }) }
})
const sources: PdfSource[] = []
const options = { includeImages: false, assetDirectory: '插图 (本地)' }
beforeAll(() => {
  GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  vi.stubGlobal('DOMMatrix', DOMMatrix); vi.stubGlobal('ImageData', ImageData); vi.stubGlobal('Path2D', Path2D)
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1)
    return Object.assign(canvas, { toBlob: (cb: (b: Blob) => void) => cb(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' })) })
  } })
})
afterEach(async () => { await Promise.all(sources.splice(0).map(releasePdfDocument)) })
afterAll(() => vi.unstubAllGlobals())
async function source(doc: PDFDocument): Promise<PdfSource> {
  const s: PdfSource = { id: `s${sources.length}`, name: 'not-body-text.pdf', bytes: await doc.save(), pageCount: doc.getPageCount(),
    pageText: ['DO NOT EXPORT INDEX'], textIndexed: true, pageSizes: [] }
  sources.push(s); return s
}
function layer(words: OcrWord[], extra: Partial<OcrPageLayer> = {}): OcrPageLayer {
  return { text: 'DO NOT EXPORT WHOLE PAGE', words, mode: 'printed', engine: 'stored', revision: 1, createdAt: '', ...extra }
}
const word = (text: string, x: number, y: number, width = .14): OcrWord => ({ text, x, y, width, height: .04, confidence: .99 })
const mark = (text: string, x = .06, y = .8): Markup => ({ id: text, type: 'text', text, x, y, width: .25, height: .08 })
const blank: WorkspacePage = { id: 'empty', sourceId: 'blank', sourcePage: 0, rotation: 0, annotations: [] }
const count = (s: string, fragment: string) => s.split(fragment).length - 1
async function redBlue(doc: PDFDocument) {
  const canvas = createCanvas(32, 16), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 16, 16); ctx.fillStyle = '#0000ff'; ctx.fillRect(16, 0, 16, 16)
  return doc.embedPng(canvas.toBuffer('image/png'))
}
async function pixels(bytes: Uint8Array) {
  const image = await loadImage(Buffer.from(bytes)), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return { w: image.width, h: image.height, rgb: (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3) }
}

describe('offline current-view PDF → Markdown', () => {
  it('uses workspace occurrences, native headings, inferred table cells, and only on-page text markup', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([320, 300]), other = doc.addPage([320, 300])
    other.drawText('Other page', { x: 25, y: 250, size: 12 })
    p.drawText('Parts', { x: 20, y: 118, size: 11 }); p.drawText('12', { x: 180, y: 118, size: 11 })
    p.drawText('Native heading', { x: 20, y: 253, size: 24 }); p.drawText('A native paragraph.', { x: 20, y: 220, size: 11 })
    p.drawText('Value', { x: 180, y: 138, size: 11 }); p.drawText('Item', { x: 20, y: 138, size: 11 })
    const s = await source(doc), [first, second] = pagesForSource(s)
    first.annotations = [{ ...mark('Edited *words*'), bold: true }, { ...mark('private note'), type: 'note' }, { ...mark('duplicate selection'), type: 'highlight' }, { ...mark('zero opacity'), opacity: 0 }]
    const onPage = vi.fn(), out = await makePdfMarkdown([second, first, { ...second, id: 'reused' }], [s], { ...options, onPage })
    expect(out.markdown).toContain('### Native heading'); expect(out.markdown).toContain('| Item | Value |\n| --- | --- |\n| Parts | 12 |')
    expect(out.markdown).toContain('**Edited \\*words\\***'); expect(count(out.markdown, 'Other page')).toBe(2); expect(count(out.markdown, 'Parts')).toBe(1)
    expect(out.markdown.indexOf('Other page')).toBeLessThan(out.markdown.indexOf('Native heading'))
    expect(out.markdown.indexOf('A native paragraph')).toBeLessThan(out.markdown.indexOf('| Item'))
    expect(out.markdown).not.toMatch(/private note|duplicate selection|zero opacity|DO NOT EXPORT|not-body-text/)
    expect(onPage.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]); expect(out.assets).toEqual([])
  })

  it('emits only visible painted native text, not transparent, clipped, covered or optional-layer content', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([320, 240])
    const hidden = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFName.of('off') }))
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [hidden], D: { BaseState: 'ON', OFF: [hidden] } }))
    p.node.Resources()!.set(PDFName.of('Properties'), doc.context.obj({ HiddenLayer: hidden }))
    const text = (s: string, y: number) => p.drawText(s, { x: 12, y, size: 10 })
    text('VISIBLE', 215)
    p.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible)); text('TRSECRET', 190); p.pushOperators(popGraphicsState())
    p.drawText('ALPHASECRET', { x: 12, y: 165, size: 10, opacity: 0 })
    p.pushOperators(pushGraphicsState(), rectangle(220, 120, 55, 30), clip(), endPath()); text('CLIPSECRET', 130); p.pushOperators(popGraphicsState())
    text('COVERSECRET', 100); p.drawRectangle({ x: 10, y: 94, width: 120, height: 22, color: rgb(0, 0, 0) })
    text('THICKSTROKESECRET', 30); p.drawLine({ start: { x: 8, y: 33 }, end: { x: 160, y: 33 }, thickness: 18, color: rgb(0, 0, 0) })
    p.drawRectangle({ x: 175, y: 188, width: 140, height: 36, color: rgb(0, 0, 0) })
    p.drawText('BLACKONBLACKSECRET', { x: 180, y: 193, size: 10 }); p.drawText('Light ink', { x: 180, y: 211, size: 10, color: rgb(1, 1, 1) })
    p.drawText('WHITEONWHITESECRET', { x: 180, y: 147, size: 10, color: rgb(1, 1, 1) })
    p.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of('HiddenLayer')]))
    text('LAYERSECRET', 60); p.drawImage(await redBlue(doc), { x: 170, y: 40, width: 40, height: 20 }); p.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
    const s = await source(doc), out = await makePdfMarkdown(pagesForSource(s), [s], { ...options, includeImages: true })
    expect(out.markdown).toContain('VISIBLE'); expect(out.markdown).toContain('Light ink'); expect(out.markdown).not.toContain('SECRET'); expect(out.assets).toHaveLength(0)
  })

  it('extracts only glyphs inside a native translucent Highlight, not its comment or text obscured by another annotation', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([400, 240]), font = await doc.embedFont(StandardFonts.Helvetica)
    const line = 'OUTSIDE Wide pencil ENDMARK', size = 14, x = 20, y = 190
    p.drawText(line, { x, y, size, font }); p.drawText('COVERED', { x, y: 105, size, font })
    // drawText emits a single Tj, without the pair kerning in the font's string-width estimate.
    const at = (i: number) => x + [...line.slice(0,i)].reduce((n,c)=>n+font.widthOfTextAtSize(c,size),0)
    const annotation = (l: number, r: number, baseline: number, custom?: ReturnType<typeof doc.context.register>) => {
      const bottom = baseline-4, top = baseline+13
      const a = doc.context.obj({ Type:'Annot', Subtype:'Highlight', Rect:[l,bottom,r,top], QuadPoints:[l,top,r,top,l,bottom,r,bottom], C:[1,1,0], CA:.45, F:4,
        Contents:PDFHexString.fromText('COMMENT IS NOT SELECTED BODY'), ...(custom ? {AP:{N:custom}} : {}) })
      p.node.addAnnot(doc.context.register(a))
    }
    const start=line.indexOf('ide'), stop=start+'ide pen'.length
    annotation(at(start)-.05, at(stop)+.05, y)
    annotation(x-.5,x+80,105)
    // A Highlight name and a low dictionary opacity do not make a custom black appearance safe.
    const form=doc.context.register(doc.context.stream('q 0 g 0 0 82 17 re f Q', { Type:'XObject',Subtype:'Form', BBox:[0,0,82,17], Resources:{ExtGState:{}} }))
    annotation(x-1,x+81,105,form)
    const s = await source(doc), pages=pagesForSource(s)
    const out = await makePdfMarkdown(pages,[s],{...options,scope:{kind:'highlights'}})
    expect(out.markdown.trim()).toBe('## 第 1 页\n\nide pen'); expect(out.assets).toHaveLength(0)
    const full=await makePdfMarkdown(pages,[s],options); expect(full.markdown).toContain(line); expect(full.markdown).not.toMatch(/COVERED|COMMENT/)
  })

  it('keeps locally recognized search text after a fresh reopen and second save without blessing unrelated invisible text', async () => {
    const storage=new Map<string,string>(); vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)})
    const doc=await PDFDocument.create(), p=doc.addPage([320,240])
    const scan=createCanvas(220,70), g=scan.getContext('2d');g.fillStyle='white';g.fillRect(0,0,220,70);g.fillStyle='black';g.font='22px sans-serif';g.fillText('Proof 927',5,38)
    p.drawImage(await doc.embedPng(scan.toBuffer('image/png')),{x:16,y:80,width:220,height:70})
    p.pushOperators(pushGraphicsState(),setTextRenderingMode(TextRenderingMode.Invisible));p.drawText('PRIVATE HIDDEN',{x:20,y:205,size:12});p.pushOperators(popGraphicsState())
    const original=await source(doc), [row]=pagesForSource(original)
    row.ocr=layer([word('Proof 927',.07,.48,.33)])
    const reopen=(bytes:Uint8Array)=>{const s={...original,id:'again'+sources.length,name:'moved.pdf',bytes:new Uint8Array(bytes)};sources.push(s);return s}
    const copy=reopen(await composePdf([row],[original])), [page]=pagesForSource(copy)
    const out=await makePdfMarkdown([page],[copy],options);expect(out.markdown.trim()).toBe('## 第 1 页\n\nProof 927')
    const twice=reopen(await composePdf([page],[copy]));expect((await makePdfMarkdown(pagesForSource(twice),[twice],options)).markdown).toBe(out.markdown)
    const changed=await PDFDocument.load(copy.bytes); changed.setTitle('external rewrite');const external=reopen(await changed.save());expect((await makePdfMarkdown(pagesForSource(external),[external],options)).markdown).not.toMatch(/Proof|PRIVATE/)
    expect([...storage.values()].join('')).not.toMatch(/Proof|927\s|PRIVATE|moved\.pdf/)
    storage.clear();expect((await makePdfMarkdown([page],[copy],options)).markdown).not.toMatch(/Proof|PRIVATE/)
  })

  it('deduplicates native/OCR overlap, trusts positioned cells once, and does not discard distinct native text', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([250, 250]); p.drawText('Native copy', { x: 25, y: 200, size: 10 }); p.drawText('Separate native line.', { x: 25, y: 170, size: 11 })
    const s = await source(doc), [page] = pagesForSource(s)
    page.ocr = layer([word('Native copy', .1, .165, .22), word('A|B', .12, .5), word('Count', .6, .5), word('Small', .12, .56), word('8', .6, .56)], {
      tables: [{ id: 't', source: 'engine', confidence: 1, columnCount: 2, rows: [['A|B', 'Count'], ['Small', '8']], bounds: { x: .11, y: .49, width: .65, height: .12 } }],
    })
    const out = await makePdfMarkdown([page], [s], options)
    expect(count(out.markdown, 'Native copy')).toBe(1); expect(count(out.markdown, 'Small')).toBe(1); expect(out.markdown).toContain('Separate native line.')
    expect(out.markdown).toContain('| A\\|B | Count |\n| --- | --- |\n| Small | 8 |'); expect(out.markdown).not.toContain('DO NOT EXPORT')
    const cropped = await makePdfMarkdown([{ ...page, crop: { x: 0, y: 0, width: .5, height: 1 } }], [s], options)
    expect(cropped.markdown).toContain('Small'); expect(cropped.markdown).not.toMatch(/Count|\b8\b|DO NOT EXPORT/)
  })

  it('reads two columns down before crossing the gutter even if the painting order interleaves them', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([520, 520])
    for (const [i, y] of [400, 380, 360].entries()) {
      p.drawText(`Right paragraph line ${i + 1}.`, { x: 285, y, size: 12 }); p.drawText(`Left paragraph line ${i + 1}.`, { x: 24, y, size: 12 })
    }
    const s = await source(doc), { markdown } = await makePdfMarkdown(pagesForSource(s), [s], options)
    expect(markdown.indexOf('Left paragraph line 3')).toBeLessThan(markdown.indexOf('Right paragraph line 1')); expect(markdown).not.toContain('| ---')
  })

  it('reads actual images, deduplicates identical placements and links safe relative PNGs, not a page screenshot', async () => {
    const doc = await PDFDocument.create(), img = await redBlue(doc)
    for (const scale of [1, 2]) {
      const p = doc.addPage([320, 300]); p.drawImage(img, { x: 36, y: 80, width: 64 * scale, height: 32 * scale }); p.drawText('Caption', { x: 36, y: 50, size: 12 })
    }
    const s = await source(doc), pages = pagesForSource(s), { markdown, assets, warnings } = await makePdfMarkdown(pages, [s], { ...options, includeImages: true })
    expect(warnings).toEqual([]); expect(assets).toHaveLength(1); expect(assets[0].name).toBe('figure-001.png')
    expect(count(markdown, '%E6%8F%92%E5%9B%BE%20%28%E6%9C%AC%E5%9C%B0%29/figure-001.png)')).toBe(2)
    const image = await pixels(assets[0].bytes); expect([image.w, image.h]).toEqual([32, 16]); expect(image.rgb(3, 7)).toEqual([255, 0, 0]); expect(image.rgb(28, 7)).toEqual([0, 0, 255])
    expect((await makePdfMarkdown(pages, [s], options)).markdown).not.toContain('![')
  })

  it('applies the nonzero source CropBox and combined intrinsic/workspace turns to text, OCR, markup and actual image pixels', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([320, 260]); p.setCropBox(20, 20, 200, 200); p.setRotation(degrees(90))
    p.drawText('SAFE', { x: 32, y: 180, size: 10 }); p.drawText('OUTSIDE', { x: 144, y: 180, size: 10 }); p.drawText('EDGESECRET', { x: 108, y: 140, size: 10 })
    p.drawImage(await redBlue(doc), { x: 40, y: 70, width: 160, height: 60 }) // visible left half is pure red
    const s = await source(doc), [page] = pagesForSource(s); page.rotation = 90 // total 180: raw left is display right
    page.crop = { x: .5, y: 0, width: .5, height: 1 }; page.ocr = layer([word('OCR-in', .1, .85), word('OCR-out', .72, .85)])
    page.annotations = [mark('Visible edit', .60, .95), mark('Hidden edit', .1, .05)]
    page.annotations[0].height = .035
    const out = await makePdfMarkdown([page], [s], { ...options, includeImages: true })
    expect(out.markdown).toContain('SAFE'); expect(out.markdown).toContain('OCR-in'); expect(out.markdown).toContain('Visible edit')
    expect(out.markdown).not.toMatch(/OUTSIDE|EDGESECRET|OCR-out|Hidden edit|DO NOT EXPORT/); expect(out.assets).toHaveLength(1)
    const image = await pixels(out.assets[0].bytes); expect(image.w).toBeLessThan(32)
    for (let x = 0; x < image.w; x++) expect(image.rgb(x, image.h >> 1)[2]).toBeLessThan(10)
  })

  it('reports missing text without inventing OCR; never falls back to unpositioned full-page text/tables across a crop', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([220, 220]); p.drawImage(await redBlue(doc), { x: 0, y: 0, width: 220, height: 220 })
    const s = await source(doc), [scan] = pagesForSource(s)
    const unpositioned = { ...scan, ocr: layer([], { text: 'Local summary\n| Item | Cost |\n| --- | --- |\n| Cup | 15 |', tables: [{ id: 'old', columnCount: 2, source: 'engine', confidence: 1, rows: [['Item', 'Cost'], ['Cup', '15']] }] }) }
    const out = await makePdfMarkdown([scan, unpositioned, { ...unpositioned, crop: { x: 0, y: 0, width: .5, height: 1 } }, blank], [s], options)
    expect(count(out.markdown, '未运行 OCR')).toBe(2); expect(out.warnings).toHaveLength(2); expect(out.markdown).toContain('> 空白页。')
    expect(count(out.markdown, 'Cup')).toBe(1); expect(count(out.markdown, 'Local summary')).toBe(1); expect(out.markdown).toContain('| --- | --- |\n| Cup | 15 |')
  })

  it('preserves the upright order of two scan tables even when there is no prose to infer a baseline from',async()=>{
    const content={x:12,y:12,width:700,height:1000}
    const cells:[string,number,number][]=[['First',.1,.1],['Count',.55,.1],['Blue',.1,.14],['17',.55,.14],['Second',.1,.65],['Level',.55,.65],['Red',.1,.69],['23',.55,.69]]
    const result:OcrRecognitionResult={text:'',confidence:0,elapsedMs:1,mode:'printed',items:cells.map(([text,x,y])=>{
      const l=x*700+12,t=y*1000+12;return {text,confidence:0,box:{x:l,y:t,width:60,height:17,points:[{x:l,y:t},{x:l+60,y:t},{x:l+60,y:t+17},{x:l,y:t+17}]}}
    })}
    let expected=''
    for(const rotation of [0,90,180,270]){
      const page={...blank,rotation,pageSize:rotation%180?{width:1000,height:700}:{width:700,height:1000},ocr:ocrLayerFromResult(result,content,rotation,'printed')}
      expect(page.ocr.tables).toHaveLength(2);const {markdown}=await makePdfMarkdown([page],[],options)
      if(!rotation){expected=markdown;expect(markdown).toContain('| First | Count |');expect(markdown).toContain('| Second | Level |');expect(markdown.indexOf('Blue')).toBeLessThan(markdown.indexOf('Red'))}
      else expect(markdown).toBe(expected)
    }
  })

  it('uses positioned legacy cells when a crop cuts the table, and never repeats an uncropped table as loose OCR', async () => {
    const doc = await PDFDocument.create(); doc.addPage([200, 200]); const s = await source(doc), [page] = pagesForSource(s)
    const rows = [['Name', 'Cost'], ['Bowl', '47']]
    page.ocr = layer([], { text: 'Summary\n| Name | Cost |\n| --- | --- |\n| Bowl | 47 |', tables: [{ id: 't', rows, columnCount: 2, source: 'engine', confidence: 1,
      bounds: { x: .1, y: .1, width: .8, height: .3 }, cells: rows.map((row, i) => row.map((text, j) => ({ text, wordIndexes: [], bounds: { x: .1 + j * .4, y: .1 + i * .15, width: .35, height: .13 } }))) }] })
    const full = await makePdfMarkdown([page], [s], options); expect(count(full.markdown, 'Bowl')).toBe(1); expect(full.markdown).toContain('Summary')
    const part = await makePdfMarkdown([{ ...page, crop: { x: 0, y: 0, width: .48, height: 1 } }], [s], options)
    expect(part.markdown).toContain('Bowl'); expect(part.markdown).not.toMatch(/Cost|47|Summary/)
  })

  it('skips image decoding on text-only scans and cancels an active figure render without breaking the next export', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage([120, 120]); p.drawImage(await redBlue(doc), { x: 10, y: 10, width: 100, height: 50 })
    const s = await source(doc), pages = pagesForSource(s), proxy = await getPdfPage(s, 0)
    const ops = vi.spyOn(proxy, 'getOperatorList')
    await makePdfMarkdown(pages, [s], options); expect(ops).not.toHaveBeenCalled(); ops.mockRestore()
    const controller = new AbortController(), render = proxy.render.bind(proxy)
    const rendering = vi.spyOn(proxy, 'render').mockImplementationOnce(args => {
      const task = render(args); queueMicrotask(() => controller.abort()); return task
    })
    try {
      await expect(makePdfMarkdown(pages, [s], { ...options, includeImages: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    } finally { rendering.mockRestore() }
    expect((await makePdfMarkdown(pages, [s], { ...options, includeImages: true })).assets).toHaveLength(1)
    await expect(makePdfMarkdown(Array.from({ length: 2501 }, () => blank), [], options)).rejects.toThrow('2500')
  })

  it.each([
    ['A\t', '| A |  |\n| --- | --- |'],
    ['A\tB\n\t', '| A | B |\n| --- | --- |\n|  |  |'],
    ['A\n', '| A |\n| --- |\n|  |'],
  ])('preserves empty edges of an explicitly selected table (%j)', async (tsv, expected) => {
    const p = { ...blank, ocr: layer([word('A',.1,.1),word('B',.5,.1)]) }
    const scope = {kind:'selection' as const,fragments:[{pageId:p.id,boxes:[{x:0,y:0,width:1,height:1}],table:true,text:tsv}]}
    const out = await makePdfMarkdown([p],[],{...options,scope})
    expect(out.markdown).toBe(`## 第 1 页\n\n${expected}\n`)
  })

  it('applies the 2500-page limit to the selected occurrences, not unrelated pages, retaining the real citation', async () => {
    const pages=Array.from({length:2501},(_,i)=>({...blank,id:`p${i}`} as WorkspacePage))
    const last=pages[2500], needle=word('Needle',.1,.2)
    last.ocr=layer([needle]); const fragment={pageId:last.id,boxes:[needle],text:'Needle'}
    const onPage=vi.fn()
    const out=await makePdfMarkdown(pages,[],{...options,scope:{kind:'selection',fragments:[fragment]},onPage})
    expect(out.markdown).toBe('## 第 2501 页\n\nNeedle\n');expect(onPage.mock.calls).toEqual([[0,1],[1,1]])
    await expect(makePdfMarkdown(pages,[],{...options,scope:{kind:'selection',fragments:[fragment,{...fragment,pageId:'closed'}]}})).rejects.toThrow('有效选区')
    await expect(makePdfMarkdown(pages,[],{...options,scope:{kind:'selection',fragments:pages.map(p=>({...fragment,pageId:p.id}))}})).rejects.toThrow('2500')
    await expect(makePdfMarkdown(pages,[],options)).rejects.toThrow('2500')
  })

  it('returns only body text for page citations, not export headings, empty notices or placeholders', async () => {
    const p={...blank,ocr:layer([{...word('Apricot',.1,.15),height:.015}])}
    expect((await makePdfMarkdown([p],[],{...options,omitPageHeadings:true})).markdown).toBe('Apricot')
    expect((await makePdfMarkdown([blank],[],{...options,omitPageHeadings:true})).markdown).toBe('')
    expect((await makePdfMarkdown([p],[],options)).markdown).toBe('## 第 1 页\n\nApricot\n')
  })

  it('rejects unsafe directories, cancellation and missing sources; does not expose markup as executable Markdown', async () => {
    for (const assetDirectory of ['../media', '/root', 'C:/x', '\\\\server', 'ok/../no', '%2e%2e', 'http://host', 'NUL']) {
      await expect(makePdfMarkdown([blank], [], { includeImages: true, assetDirectory })).rejects.toThrow('相对路径')
    }
    const abort = new AbortController(), calls: number[] = []
    await expect(makePdfMarkdown([blank, blank], [], { ...options, signal: abort.signal, onPage(n) { calls.push(n); if (n === 1) abort.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([0, 1]); await expect(makePdfMarkdown([{ ...blank, sourceId: 'missing' }], [], options)).rejects.toThrow('来源已关闭')
    const out = await makePdfMarkdown([{ ...blank, annotations: [mark('<img> ![foo](https://invalid.example/)')] }], [], options)
    expect(out.markdown).toContain('&lt;img&gt; !\\[foo\\]('); expect(out.markdown).not.toContain('![foo](')
  })
})
