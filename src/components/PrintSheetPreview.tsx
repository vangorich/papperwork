import { useEffect, useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PrintOptions } from '../types/pdf'
import { placeOnSheet, sheetGrid, sheetSize, type PageSizePt, type PreviewLoader, type SelectionIssue, type SheetPage } from '../lib/printSheet'
import './printSheetPreview.css'

/** Keep results scoped to the page/request that produced them, including on rapid reordering. */
export function usePrintPreviewAsset(page: SheetPage | undefined, width: number, needSize: boolean, load: PreviewLoader) {
  const key = page?.key, itemId = page?.itemId, pageIndex = page?.pageIndex
  const [result, setResult] = useState<{ token: string; load: PreviewLoader; asset: Awaited<ReturnType<PreviewLoader>> }>()
  const token = `${key}/${width}/${needSize}`
  useEffect(() => {
    if (key == null || itemId == null || pageIndex == null) return
    let active = true
    void load({ key, itemId, pageIndex }, width, needSize, () => active).then(asset => {
      if (active) setResult({ token, load, asset })
    })
    return () => { active = false }
  }, [key, itemId, pageIndex, width, needSize, load, token])
  return result?.token === token && result.load === load ? result.asset : undefined
}

type SheetOptions = Pick<PrintOptions, 'color' | 'duplex' | 'landscape' | 'margins' | 'pageBorder' | 'pagesPerSheet' | 'scaleFactor'> & {
  paperSize: NonNullable<PrintOptions['paperSize']>; sizing: 'fit' | 'actual'
}

function SheetCell({ page, cell, options, load, onLocate }: {
  page: SheetPage; cell: PageSizePt; options: SheetOptions; load: PreviewLoader; onLocate: (page: SheetPage) => void
}) {
  const actual = options.sizing === 'actual'
  const asset = usePrintPreviewAsset(page, options.pagesPerSheet === 1 ? 520 : options.pagesPerSheet <= 4 ? 320 : 200, actual, load)
  const [bitmap, setBitmap] = useState<{ url: string; aspect: number }>()
  const url = asset?.url
  const aspect = bitmap?.url === url ? bitmap?.aspect : undefined
  const missingSize = actual && asset && !asset.size
  const safe = options.margins === 'default'
  const placement = aspect && !missingSize ? placeOnSheet(cell, safe, aspect, options.scaleFactor, actual ? asset?.size?.widthPt : undefined) : undefined
  const inset = placement?.inset ?? 0
  const message = !asset ? '加载中' : !url || aspect === 0 ? '缩略图不可用' : missingSize ? '缺少实际尺寸' : aspect && !placement ? '留白后无空间' : ''
  const number = page.sourceIndex + 1
  // The clipping box represents one printable cell; the border travels with the page, not the cell.
  return <button type="button" className="print-sheet__cell" aria-label={`定位原第 ${number} 页，返回页序 / 排除`} title={`原第 ${number} 页${placement?.cropped ? '（可能裁切）' : ''}，点击返回页序`} onClick={() => onLocate(page)}>
    {url && !missingSize && <span className="print-sheet__clip" style={{ inset: `${inset / cell.heightPt * 100}% ${inset / cell.widthPt * 100}%` }}>
      <img src={url} alt="" draggable={false} data-bordered={options.pageBorder || undefined} style={{ width: placement ? `${placement.contentWidth / placement.width * 100}%` : '100%', visibility: placement ? 'visible' : 'hidden', filter: options.color ? undefined : 'grayscale(1)' }}
        onLoad={e => setBitmap({ url, aspect: e.currentTarget.naturalWidth / e.currentTarget.naturalHeight })} onError={() => setBitmap({ url, aspect: 0 })} />
    </span>}
    {message && <span className="print-sheet__missing">{message}</span>}
  </button>
}

export function PrintSheetPreview({ pages, issue, side, onSide, options, load, onLocate, onFocusField }: {
  pages: readonly SheetPage[]; issue?: SelectionIssue; side: number; onSide: (index: number) => void
  options: SheetOptions; load: PreviewLoader; onLocate: (page: SheetPage) => void; onFocusField: (id: string) => void
}) {
  const { paperSize, landscape, pagesPerSheet: n, duplex } = options
  const first = usePrintPreviewAsset(paperSize === 'auto' ? pages[0] : undefined, 0, true, load)
  const paper = sheetSize(paperSize, landscape, first?.size)
  if (!pages.length) return <div className="print-sheet__empty"><strong>没有可预览的纸张</strong><span>{issue?.message}</span>
    {issue && <button type="button" className="print-sheet__link" onClick={() => onFocusField(issue.field)}>{issue.field === 'print-restore' ? '前往恢复页面' : issue.field === 'print-subset' ? '调整页面子集' : issue.field === 'print-range' ? '修改打印范围' : '前往添加文件'}</button>}
  </div>
  const sides = Math.ceil(pages.length / n), index = Math.min(side, sides - 1)
  const twoSided = duplex !== 'simplex', sheetCount = twoSided ? Math.ceil(sides / 2) : sides
  const sheet = twoSided ? Math.floor(index / 2) : index
  const position = `第 ${sheet + 1} / ${sheetCount} 张${twoSided ? index % 2 ? ' · 背面' : ' · 正面' : ''}`
  const visible = pages.slice(index * n, (index + 1) * n)
  const { cols, rows } = sheetGrid(n, !!paper && paper.widthPt > paper.heightPt)
  const pxToMm = (pt: number) => +(pt * 25.4 / 72).toFixed(1)
  return <section className="print-sheet" aria-label="纸张近似预览">
    <div className="print-sheet__bar"><strong aria-live="polite">{position}</strong><span>{paperSize === 'auto' ? '随 PDF' : paperSize.length === 2 ? paperSize.toUpperCase() : paperSize === 'legal' ? 'Legal' : 'Letter'}{paper && ` · ${pxToMm(paper.widthPt)} × ${pxToMm(paper.heightPt)} mm`}</span>
      <span className="print-preview__nav"><button type="button" disabled={index === 0} aria-label={twoSided ? '上一面' : '上一张'} onClick={() => onSide(index - 1)}><ChevronLeft size={15} /></button><button type="button" disabled={index + 1 === sides} aria-label={twoSided ? '下一面' : '下一张'} onClick={() => onSide(index + 1)}><ChevronRight size={15} /></button></span>
    </div>
    {sides > 8 && <input className="print-sheet__jump" type="range" min={1} max={sides} value={index + 1} aria-label="快速浏览纸面" aria-valuetext={position} onChange={e => onSide(Number(e.target.value) - 1)} />}
    <div className="print-sheet__stage">
      {paper ? <div className="print-sheet__paper" style={{ '--sheet-ratio': paper.widthPt / paper.heightPt, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } as CSSProperties}>
        {visible.map(page => <SheetCell key={page.key} page={page} cell={{ widthPt: paper.widthPt / cols, heightPt: paper.heightPt / rows }} options={options} load={load} onLocate={onLocate} />)}
      </div> : <div className="print-sheet__empty">{first ? <>无法读取首个输出页的纸张尺寸。<button className="print-sheet__link" type="button" onClick={() => onFocusField('print-paper')}>选择固定纸张</button></> : '正在读取纸张尺寸…'}</div>}
    </div>
    <div className="print-sheet__caption"><strong>本面原页：{visible.map(p => p.sourceIndex + 1).join('、')}</strong><small>仅预览一份。点击纸面上的页面，可返回定位并调整页序。</small></div>
    <p className="print-sheet__note">近似预览，无法读取驱动的实际可打印区域。{options.margins === 'default' ? '按每格四边各留 12 pt（约 4.2 mm）估算。' : '未加安全留白，仍受打印机硬边距限制。'}{paperSize === 'auto' && '随 PDF 按首个输出页估算，混合尺寸建议指定纸张。'}最终以打印机和系统对话框为准，不是硬校样。</p>
  </section>
}
