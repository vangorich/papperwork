import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { reconcilePrintPageOrder } from '../lib/printPreview'
import { createPreviewLoader, selectSheetPages, validCopies, type PreviewImage, type PreviewLoader, type PreviewSize, type SheetPage } from '../lib/printSheet'
import { PrintSheetPreview, usePrintPreviewAsset } from './PrintSheetPreview'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Cpu, Eye, EyeOff, FileImage, FileOutput, FilePlus2, FileText, Files, FolderOpen, Gauge, GripVertical, Languages, Layers3, LoaderCircle, LockKeyhole, PackageMinus, Printer, RefreshCw, RotateCcw, Save, ScanText, Settings2, ShieldCheck, Sparkles, Stamp, Trash2, X } from 'lucide-react'
import { formatBytes } from '../lib/cn'
import { parsePageRanges, resolvePageRangeIds } from '../lib/pdf'
import type { PdfEncryptionOptions } from '../lib/pdfSecurity'
import { measureWatermarkText, prepareWatermarkImage } from '../lib/watermark'
import type { DocumentWatermark, NativePrinter, PdfCompressionMode, PdfCompressionProgress, PrintOptions } from '../types/pdf'
import { Button, FormSelect } from './ui'
import { ColorPalette } from './ColorPalette'

export type PageImportOperation = 'before' | 'after' | 'replace'

export interface PageExportOptions {
  format: 'pdf' | 'png' | 'jpeg' | 'docx'
  splitPdf: boolean
  dpi: number
  wordMode: 'editable' | 'layout'
}

export type OcrMode = 'auto' | 'printed' | 'handwriting'

export interface OcrSourceOption {
  id: string
  name: string
  pageCount: number
  pages?: Array<{ id: string; pageNumber: number }>
}

export interface OcrRunOptions {
  sourceIds: string[]
  mode: OcrMode
  skipTextPages: boolean
  /** Optional workspace page ids for context-menu OCR of only the requested pages. */
  pageIds?: string[]
}

export interface OcrProgress {
  stage: string
  currentPage: number
  totalPages: number
  sourceName?: string
}

export function PasswordDialog({
  open,
  fileName,
  reason,
  onCancel,
  onSubmit,
}: {
  open: boolean
  fileName: string
  reason: 'required' | 'incorrect'
  onCancel: () => void
  onSubmit: (password: string) => void
}) {
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!open) return
    setPassword('')
    setVisible(false)
  }, [fileName, open, reason])

  return (
    <Dialog open={open} onClose={onCancel} className="dialog password-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel password-dialog__panel">
        <div className="dialog__header">
          <div className="password-dialog__title">
            <span className="password-dialog__icon"><LockKeyhole size={19} /></span>
            <div><DialogTitle>输入文档密码</DialogTitle></div>
          </div>
          <button type="button" aria-label="取消打开加密 PDF" onClick={onCancel}><X size={18} /></button>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (password) onSubmit(password)
        }}>
          <p className="password-dialog__file" title={fileName}>{fileName}</p>
          <label>
            文档打开密码
            <span className="password-dialog__input">
              <input
                autoFocus
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                aria-invalid={reason === 'incorrect'}
                aria-describedby={reason === 'incorrect' ? 'pdf-password-error' : 'pdf-password-help'}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
              <button
                type="button"
                aria-label={visible ? '隐藏密码' : '显示密码'}
                title={visible ? '隐藏密码' : '显示密码'}
                onClick={() => setVisible((current) => !current)}
              >{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </span>
            {reason === 'incorrect'
              ? <small id="pdf-password-error" className="field-error" role="alert">密码不正确，请重新输入。</small>
              : <small id="pdf-password-help">成功打开后会保存到本机安全密码历史。</small>}
          </label>
          <div className="dialog__actions">
            <Button type="button" onClick={onCancel}>取消</Button>
            <Button type="submit" variant="primary" disabled={!password}>打开 PDF</Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}

export function PdfEncryptionDialog({
  open,
  sourceName,
  running,
  onClose,
  onEncrypt,
}: {
  open: boolean
  sourceName: string
  running: boolean
  onClose: () => void
  onEncrypt: (options: PdfEncryptionOptions) => void
}) {
  const [userPassword, setUserPassword] = useState('')
  const [userConfirm, setUserConfirm] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [ownerConfirm, setOwnerConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [allowPrinting, setAllowPrinting] = useState(false)
  const [allowCopying, setAllowCopying] = useState(false)
  const [allowEditing, setAllowEditing] = useState(false)
  useEffect(() => {
    if (!open) return
    setUserPassword('')
    setUserConfirm('')
    setOwnerPassword('')
    setOwnerConfirm('')
    setVisible(false)
    setAllowPrinting(false)
    setAllowCopying(false)
    setAllowEditing(false)
  }, [open, sourceName])
  const mismatch = Boolean(
    (userConfirm && userPassword !== userConfirm)
    || (ownerConfirm && ownerPassword !== ownerConfirm)
    || (userPassword && ownerPassword && userPassword === ownerPassword),
  )
  const complete = userPassword && userConfirm && ownerPassword && ownerConfirm && !mismatch

  return (
    <Dialog open={open} onClose={running ? () => undefined : onClose} className="dialog password-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel password-dialog__panel pdf-encryption-dialog__panel">
        <div className="dialog__header">
          <div className="password-dialog__title">
            <span className="password-dialog__icon"><ShieldCheck size={19} /></span>
            <div><DialogTitle>加密 PDF 副本</DialogTitle></div>
          </div>
          <button type="button" aria-label="关闭加密设置" disabled={running} onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (!complete) return
          onEncrypt({ userPassword, ownerPassword, allowPrinting, allowCopying, allowEditing })
        }}>
          <p className="password-dialog__file" title={sourceName}>{sourceName}</p>
          <div className="pdf-encryption-dialog__grid">
            <label>打开密码
              <input autoFocus type={visible ? 'text' : 'password'} autoComplete="new-password" value={userPassword} onChange={(event) => setUserPassword(event.currentTarget.value)} />
            </label>
            <label>确认打开密码
              <input type={visible ? 'text' : 'password'} autoComplete="new-password" value={userConfirm} onChange={(event) => setUserConfirm(event.currentTarget.value)} />
            </label>
            <label>打印、编辑权限密码
              <input type={visible ? 'text' : 'password'} autoComplete="new-password" value={ownerPassword} onChange={(event) => setOwnerPassword(event.currentTarget.value)} />
            </label>
            <label>确认权限密码
              <input type={visible ? 'text' : 'password'} autoComplete="new-password" value={ownerConfirm} onChange={(event) => setOwnerConfirm(event.currentTarget.value)} />
            </label>
          </div>
          {mismatch && <small className="field-error" role="alert">两次密码需一致，且打开密码不能与权限密码相同。</small>}
          <label className="checkbox-row pdf-encryption-dialog__reveal">
            <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.currentTarget.checked)} />
            <span><strong>显示密码</strong></span>
          </label>
          <fieldset className="pdf-encryption-dialog__permissions">
            <legend>使用打开密码时允许</legend>
            <label><input type="checkbox" checked={allowPrinting} onChange={(event) => setAllowPrinting(event.currentTarget.checked)} />打印</label>
            <label><input type="checkbox" checked={allowCopying} onChange={(event) => setAllowCopying(event.currentTarget.checked)} />复制文字与图片</label>
            <label><input type="checkbox" checked={allowEditing} onChange={(event) => setAllowEditing(event.currentTarget.checked)} />编辑文档</label>
          </fieldset>
          <small className="pdf-encryption-dialog__method"><LockKeyhole size={13} /> AES-256；原文件保持不变。</small>
          <div className="dialog__actions">
            <Button type="button" onClick={onClose} disabled={running}>取消</Button>
            <Button type="submit" variant="primary" busy={running} disabled={!complete}>加密并另存为</Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}

export function PageExportDialog({
  open,
  pageCount,
  initialFormat = 'pdf',
  onClose,
  onExport,
}: {
  open: boolean
  pageCount: number
  initialFormat?: PageExportOptions['format']
  onClose: () => void
  onExport: (options: PageExportOptions) => void
}) {
  const [format, setFormat] = useState<PageExportOptions['format']>(initialFormat)
  const [splitPdf, setSplitPdf] = useState(false)
  const [dpi, setDpi] = useState(216)
  const [wordMode, setWordMode] = useState<PageExportOptions['wordMode']>('editable')
  useEffect(() => {
    if (!open) return
    setFormat(initialFormat)
    setSplitPdf(false)
    setDpi(216)
    setWordMode('editable')
  }, [initialFormat, open, pageCount])
  return (
    <Dialog open={open} onClose={onClose} className="dialog page-export-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel dialog__panel--wide">
        <div className="dialog__header">
          <div><DialogTitle>导出 {pageCount} 个选中页面</DialogTitle></div>
          <button aria-label="关闭页面导出" onClick={onClose}><X size={18} /></button>
        </div>
        <fieldset className="import-options">
          <legend>输出格式</legend>
          {([
            ['pdf', 'PDF 文档', '保留矢量文字、批注与页面质量'],
            ['png', 'PNG 图片', '无损图片，适合归档和再次编辑'],
            ['jpeg', 'JPEG 图片', '文件较小，适合分享与票据'],
            ['docx', 'Word 文档', '可编辑文字与表格，或选择精准版式模式'],
          ] as const).map(([value, title, description]) => (
            <label className="import-option" data-active={format === value || undefined} key={value}>
              <input type="radio" name="page-export-format" checked={format === value} onChange={() => setFormat(value)} />
              <span><strong>{title}</strong><small>{description}</small></span>
            </label>
          ))}
        </fieldset>
        {format === 'pdf' && pageCount > 1 && (
          <label className="checkbox-row">
            <input type="checkbox" checked={splitPdf} onChange={(event) => setSplitPdf(event.target.checked)} />
            <span><strong>每页拆成单独 PDF</strong><small>关闭时将选中页合成一个 PDF；开启后选择文件夹批量保存。</small></span>
          </label>
        )}
        {format === 'docx' && (
          <fieldset className="import-options page-export-word-mode">
            <legend>Word 转换方式</legend>
            <label className="import-option" data-active={wordMode === 'editable' || undefined}>
              <input
                type="radio"
                name="word-export-mode"
                checked={wordMode === 'editable'}
                onChange={() => setWordMode('editable')}
              />
              <span>
                <strong>可编辑内容（推荐）</strong>
                <small>文字保留字体与字号，表格转换为 Word 表格，并按原页面位置近似排版。</small>
              </span>
            </label>
            <label className="import-option" data-active={wordMode === 'layout' || undefined}>
              <input
                type="radio"
                name="word-export-mode"
                checked={wordMode === 'layout'}
                onChange={() => setWordMode('layout')}
              />
              <span>
                <strong>精准版式</strong>
                <small>每页作为高清图片放入 Word；外观最接近 PDF，但正文不可直接编辑。</small>
              </span>
            </label>
          </fieldset>
        )}
        {(format === 'png' || format === 'jpeg' || (format === 'docx' && wordMode === 'layout')) && (
          <label>图片清晰度
            <select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}>
              <option value="144">144 DPI · 流畅</option>
              <option value="216">216 DPI · 高清（推荐）</option>
              <option value="300">300 DPI · 打印</option>
              <option value="400">400 DPI · 精细归档</option>
            </select>
            <small>超大页面会自动限制像素，避免导出时内存激增。</small>
          </label>
        )}
        <div className="dialog__actions">
          <Button type="button" onClick={onClose}>取消</Button>
          <Button type="button" variant="primary" onClick={() => onExport({ format, splitPdf, dpi, wordMode })}>
            <FileOutput size={15} /> 开始导出
          </Button>
        </div>
      </DialogPanel>
    </Dialog>
  )
}

export function PagePropertiesDialog({ open, title, rows, onClose }: {
  open: boolean
  title: string
  rows: { label: string; value: string }[]
  onClose: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} className="dialog page-properties-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel">
        <div className="dialog__header">
          <div><DialogTitle>页面属性</DialogTitle></div>
          <button aria-label="关闭页面属性" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="import-file-summary">
          <span><FileText size={18} /></span><div><strong>{title}</strong><small>当前工作区页面的来源与处理状态</small></div>
        </div>
        <dl className="file-info-list">
          {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl>
        <div className="dialog__actions"><Button type="button" variant="primary" onClick={onClose}>完成</Button></div>
      </DialogPanel>
    </Dialog>
  )
}

export function PageResizeDialog({ open, currentWidthMm, currentHeightMm, onClose, onApply }: {
  open: boolean
  currentWidthMm: number
  currentHeightMm: number
  onClose: () => void
  onApply: (widthMm: number, heightMm: number) => void
}) {
  const [preset, setPreset] = useState('a4')
  const [width, setWidth] = useState('210')
  const [height, setHeight] = useState('297')
  useEffect(() => {
    if (!open) return
    setPreset('a4')
    setWidth('210')
    setHeight('297')
  }, [open, currentWidthMm, currentHeightMm])
  const choosePreset = (value: string) => {
    setPreset(value)
    const sizes: Record<string, [number, number]> = {
      a4: [210, 297], a4l: [297, 210], a3: [297, 420], letter: [215.9, 279.4], legal: [215.9, 355.6], current: [currentWidthMm, currentHeightMm],
    }
    const size = sizes[value]
    if (size) { setWidth(String(Number(size[0].toFixed(1)))); setHeight(String(Number(size[1].toFixed(1)))) }
  }
  const validWidth = Number(width)
  const validHeight = Number(height)
  const valid = validWidth >= 25 && validWidth <= 1200 && validHeight >= 25 && validHeight <= 1200
  return (
    <Dialog open={open} onClose={onClose} className="dialog page-resize-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel">
        <div className="dialog__header">
          <div><DialogTitle>调整页面大小</DialogTitle></div>
          <button aria-label="关闭页面大小设置" onClick={onClose}><X size={18} /></button>
        </div>
        <label>纸张预设
          <select value={preset} onChange={(event) => choosePreset(event.target.value)}>
            <option value="a4">A4 · 210 × 297 mm</option>
            <option value="a4l">A4 横向 · 297 × 210 mm</option>
            <option value="a3">A3 · 297 × 420 mm</option>
            <option value="letter">Letter · 215.9 × 279.4 mm</option>
            <option value="legal">Legal · 215.9 × 355.6 mm</option>
            <option value="current">保持当前尺寸</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <div className="dialog-grid">
          <label>宽度（mm）<input type="number" min="25" max="1200" step="0.1" value={width} onChange={(event) => { setPreset('custom'); setWidth(event.target.value) }} /></label>
          <label>高度（mm）<input type="number" min="25" max="1200" step="0.1" value={height} onChange={(event) => { setPreset('custom'); setHeight(event.target.value) }} /></label>
        </div>
        <div className="notice"><Layers3 size={17} /> 原页面会以矢量方式等比居中，不会先转成模糊图片。原生表单和原生批注将按视觉版式合成。</div>
        <div className="dialog__actions">
          <Button type="button" onClick={onClose}>取消</Button>
          <Button type="button" variant="primary" disabled={!valid} onClick={() => onApply(validWidth, validHeight)}>应用到该页</Button>
        </div>
      </DialogPanel>
    </Dialog>
  )
}

import { MAX_COMPRESSION_BYTES } from '../lib/pdfCompression'

const COMPRESSION_COPY: Record<PdfCompressionMode, {
  title: string
  meta: string
  description: string
  icon: typeof ShieldCheck
}> = {
  lossless: {
    title: '无损结构优化',
    meta: '不改变图像采样',
    description: '压缩数据流，清理无引用对象和可安全共享的重复图片；保留文字、矢量和交互内容。',
    icon: ShieldCheck,
  },
  balanced: {
    title: '均衡图像压缩',
    meta: '推荐 · 扫描图像可有损',
    description: '保留原生文字、矢量和 OCR 层；高分辨率文字扫描适度缩小，保留灰阶与印章颜色。',
    icon: Gauge,
  },
  strong: {
    title: '强力图像压缩',
    meta: '体积优先 · 有损',
    description: '进一步缩小高分辨率扫描图和照片；小字放大时可能变软。原生文字、矢量和批注不转成图片。',
    icon: PackageMinus,
  },
  compact: {
    title: '极致压缩（阅读优先）',
    meta: '扫描件 · 有损',
    description: '对高分辨率扫描件争取节省 75% 以上，保留灰阶和彩色印章。已紧凑的文件可能达不到此比例；请核对小字和细线。',
    icon: ScanText,
  },
}

const compressionStageLabel: Record<PdfCompressionProgress['stage'], string> = {
  loading: '正在读取文档',
  optimizing: '正在优化结构与图像对象',
  rendering: '正在分析图像',
  encoding: '正在编码图像对象',
  saving: '正在生成新 PDF',
  complete: '压缩完成',
}

export function CompressDialog({
  open,
  sourceName,
  sourceSize,
  encrypted,
  hasSignatures,
  running,
  progress, notice, choosingCopy, readyMode, onModeChange,
  onClose,
  onCancel,
  onCompress,
}: {
  open: boolean
  sourceName: string
  sourceSize: number
  encrypted: boolean
  hasSignatures: boolean
  running: boolean
  progress?: PdfCompressionProgress
  notice?: string
  choosingCopy?: boolean
  readyMode?: PdfCompressionMode
  onModeChange?: () => void
  onClose: () => void
  onCancel: () => void
  onCompress: (mode: PdfCompressionMode) => void
}) {
  const [mode, setMode] = useState<PdfCompressionMode>('balanced')
  const tooLarge = sourceSize > MAX_COMPRESSION_BYTES
  const blocked = encrypted || hasSignatures || tooLarge || !sourceSize
  const ratio = progress?.total ? Math.max(0, Math.min(1, progress.current / progress.total)) : 0
  const percent = !progress ? 0
    : progress.stage === 'loading' ? Math.round(ratio * 6)
      : progress.stage === 'optimizing' || progress.stage === 'rendering' || progress.stage === 'encoding'
        ? Math.round(6 + ratio * 88)
        : progress.stage === 'saving' ? Math.round(94 + ratio * 5)
          : 100

  return (
    <Dialog open={open} onClose={() => { if (!running) onClose() }} className="dialog compression-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel dialog__panel--wide compression-dialog__panel">
        <div className="dialog__header">
          <div><DialogTitle>压缩原文件并另存为</DialogTitle></div>
          <button aria-label="关闭压缩设置" disabled={running} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="compression-dialog__body">
        <div className="compression-source">
          <span><FileText size={18} /></span>
          <div><strong title={sourceName}>{sourceName}</strong><small>原始大小 {formatBytes(sourceSize)} · 上限 96 MiB · 只生成副本</small></div>
        </div>

        <p className="dialog__hint">压缩所选源文件，不含尚未导出的编辑。单张图像超过 1000 万像素，或任一边超过 10,000 像素时，会保留原像素。</p>
        <fieldset className="compression-modes" disabled={running || blocked}>
          <legend>选择压缩方式</legend>
          {(Object.keys(COMPRESSION_COPY) as PdfCompressionMode[]).map((value) => {
            const copy = COMPRESSION_COPY[value]
            const Icon = copy.icon
            return (
              <label key={value} data-selected={mode === value || undefined}>
                <input type="radio" name="compression-mode" value={value} checked={mode === value} onChange={() => { setMode(value); onModeChange?.() }} />
                <span className="compression-mode__icon"><Icon size={18} /></span>
                <span><strong>{copy.title}</strong><small>{copy.meta}</small><p>{copy.description}</p></span>
                <Check className="compression-mode__check" size={15} />
              </label>
            )
          })}
        </fieldset>

        {encrypted && (
          <div className="notice notice--warning" role="alert"><AlertTriangle size={17} /> 加密 PDF 无法安全重写，请先在原应用中解密后再压缩。</div>
        )}
        {tooLarge && (
          <div className="notice notice--warning" role="alert"><AlertTriangle size={17} /> 此文件超过 96 MiB。为避免压缩时同时复制输入、图像和输出耗尽内存，请使用较小的原稿。</div>
        )}
        {!encrypted && hasSignatures && (
          <div className="notice notice--warning" role="alert"><AlertTriangle size={17} /> 重写会使数字签名失效。为保留签名，请改用未签名的原稿压缩。</div>
        )}
        {!blocked && mode !== 'lossless' && (
          <div className="notice notice--warning"><AlertTriangle size={17} /> 扫描页的小字、照片可能损失细节。原生文字、链接、目录和批注保留；需保持原图像素时请选择无损结构优化。</div>
        )}

        {notice && <p className="compression-receipt" role="status" aria-live="polite">{notice}</p>}
        {running && (
          <div className="compression-progress" role="status" aria-live="polite">
            <div><span><LoaderCircle size={15} /> {choosingCopy ? '等待选择保存位置并写入副本' : progress ? compressionStageLabel[progress.stage] : '正在准备压缩'}</span><strong>{percent}%</strong></div>
            <progress value={percent} max={100}>{percent}%</progress>
            <small>没有变小时不会生成副本。{progress?.skippedLargeImages ? `已跳过 ${progress.skippedLargeImages} 张超限图像，保留原像素。` : ''}</small>
          </div>
        )}
        </div>

        <div className="dialog__actions">
          {running
            ? <Button type="button" disabled={choosingCopy} onClick={onCancel}>取消压缩</Button>
            : <Button type="button" onClick={onClose}>取消</Button>}
          <Button type="button" variant="primary" disabled={running || blocked} onClick={() => onCompress(mode)}>
            <PackageMinus size={15} /> {readyMode === mode && !running ? '重选保存位置' : '压缩并另存为'}
          </Button>
        </div>
      </DialogPanel>
    </Dialog>
  )
}

export function ImportPagesDialog({
  open,
  sourceName,
  pageCount,
  operation,
  replaceCount = 1,
  onClose,
  onApply,
}: {
  open: boolean
  sourceName: string
  pageCount: number
  operation: PageImportOperation
  replaceCount?: number
  onClose: () => void
  onApply: (pageIndices: number[]) => void
}) {
  const [selection, setSelection] = useState<'all' | 'range'>('all')
  const [range, setRange] = useState('')
  const [error, setError] = useState('')
  const rangeRef = useRef<HTMLInputElement>(null)
  const copy = operation === 'before'
    ? { title: '在上方插入 PDF', action: '插入' }
    : operation === 'after'
      ? { title: '在下方插入 PDF', action: '插入' }
      : { title: '用 PDF 替换页面', action: '替换' }

  useEffect(() => {
    if (!open) return
    setSelection('all')
    setRange('')
    setError('')
  }, [open, sourceName])

  const selectedPages = () => selection === 'all'
    ? Array.from({ length: pageCount }, (_, index) => index)
    : parsePageRanges(range, pageCount)

  const validateRange = () => {
    if (selection === 'all') return true
    try {
      selectedPages()
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '页码范围无效')
      return false
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel dialog__panel--wide">
        <div className="dialog__header">
          <div><DialogTitle>{copy.title}</DialogTitle></div>
          <button aria-label="关闭页面选择" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="import-file-summary">
          <span><FileText size={18} /></span>
          <div><strong title={sourceName}>{sourceName}</strong><small>{pageCount} 页 PDF</small></div>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          try {
            const pages = selectedPages()
            setError('')
            onApply(pages)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '页码范围无效')
            rangeRef.current?.focus()
          }
        }}>
          <fieldset className="import-options">
            <legend>选择要{copy.action}的页面</legend>
            <label className="import-option" data-active={selection === 'all' || undefined}>
              <input
                type="radio"
                name="page-selection"
                checked={selection === 'all'}
                onChange={() => { setSelection('all'); setError('') }}
              />
              <span><strong>全部页面</strong><small>按原顺序{copy.action} {pageCount} 页</small></span>
            </label>
            <label className="import-option" data-active={selection === 'range' || undefined}>
              <input
                type="radio"
                name="page-selection"
                checked={selection === 'range'}
                onChange={() => {
                  setSelection('range')
                  setError('')
                  window.setTimeout(() => rangeRef.current?.focus(), 0)
                }}
              />
              <span><strong>指定页码或范围</strong><small>可输入单页、多页或连续范围</small></span>
            </label>
          </fieldset>
          {selection === 'range' && (
            <label htmlFor="import-page-range">页码范围
              <input
                ref={rangeRef}
                id="import-page-range"
                value={range}
                placeholder={`例如 1-3,6,9-${Math.min(12, pageCount)}`}
                aria-invalid={Boolean(error)}
                aria-describedby="import-page-help import-page-error"
                onChange={(event) => { setRange(event.target.value); setError('') }}
                onBlur={validateRange}
              />
              <small id="import-page-help">支持逗号分隔，页码范围为 1-{pageCount}。重复页码会自动去重。</small>
              {error && <span id="import-page-error" className="field-error" role="alert">{error}</span>}
            </label>
          )}
          {operation === 'replace' && (
            <div className="notice"><Layers3 size={17} /> 确认后会删除当前选中的 {replaceCount} 页，再从最早位置完整插入上述页面。可使用 Ctrl+Z 恢复。</div>
          )}
          <div className="dialog__actions">
            <Button type="button" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary">确认{copy.action}{selection === 'all' ? ` ${pageCount} 页` : ''}</Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}

export function ImagePasteDialog({
  open,
  fileName,
  onClose,
  onInsertPage,
  onPlaceImage,
}: {
  open: boolean
  fileName: string
  onClose: () => void
  onInsertPage: () => void
  onPlaceImage: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} className="dialog image-paste-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel">
        <div className="dialog__header">
          <div><DialogTitle>如何粘贴这张截图？</DialogTitle></div>
          <button type="button" aria-label="取消粘贴截图" onClick={onClose}><X size={18} /></button>
        </div>
        <p className="dialog__hint" title={fileName}>{fileName}</p>
        <div className="image-paste-options">
          <button type="button" onClick={onInsertPage}>
            <span><FilePlus2 size={19} /></span>
            <strong>插入为 PDF 页</strong>
            <small>转换成独立页面并插在当前缩略图后，适合整页截图或扫描件。</small>
          </button>
          <button type="button" onClick={onPlaceImage}>
            <span><FileImage size={19} /></span>
            <strong>贴到当前页</strong>
            <small>作为可移动、缩放的图片元素放在页面中央，不改变页数。</small>
          </button>
        </div>
        <div className="dialog__actions"><Button type="button" onClick={onClose}>取消</Button></div>
      </DialogPanel>
    </Dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  tone = 'danger',
  confirmLabel = '确认删除',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  tone?: 'danger' | 'warning'
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel">
        <div className={`dialog__icon dialog__icon--${tone}`}><AlertTriangle size={20} /></div>
        <DialogTitle>{title}</DialogTitle>
        <p>{description}</p>
        <div className="dialog__actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</Button>
        </div>
      </DialogPanel>
    </Dialog>
  )
}

export type CloseGuardFlow = {
  queue: { id: string; label: string }[]
  index: number
  saving: boolean
}

/** Compact unsaved-changes prompt. Each modified file is handled once. */
export function CloseGuardDialog({
  flow,
  onSave,
  onSkip,
  onCancel,
}: {
  flow: CloseGuardFlow | null
  onSave: () => void
  onSkip: () => void
  onCancel: () => void
}) {
  const current = flow?.queue[flow.index]
  return (
    <Dialog open={Boolean(flow)} onClose={onCancel} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel decision-sheet">
        {flow && current ? (
          <>
            <header className="decision-sheet__header"><span className="decision-sheet__mark"><Save size={18} /></span><DialogTitle>保存更改？</DialogTitle></header>
            <div className="decision-sheet__file"><p className="dialog__document-name">{current.label}</p>
              {flow.queue.length > 1 && <small aria-label={`第 ${flow.index + 1} 个，共 ${flow.queue.length} 个`}>{flow.index + 1} / {flow.queue.length}</small>}
            </div>
            <div className="dialog__actions decision-sheet__actions">
              <Button onClick={onCancel} disabled={flow.saving}>取消</Button>
              <Button onClick={onSkip} disabled={flow.saving}>不保存</Button>
              <Button variant="primary" busy={flow.saving} onClick={onSave}>保存</Button>
            </div>
          </>
        ) : null}
      </DialogPanel>
    </Dialog>
  )
}

type StoredPrintSettings = {
  copies?: number
  duplex?: PrintOptions['duplex']
  pagesPerSheet?: number
  margins?: PrintOptions['margins']
  collate?: boolean
  color?: boolean
  landscape?: boolean
  scaleFactor?: number
  sizing?: 'fit' | 'actual'
  dpi?: number
  paperSize?: PrintOptions['paperSize']
  subset?: PrintOptions['subset']
  reverse?: boolean
  pageBorder?: boolean
  /** Legacy v1 field, folded into dpi on load. */
  quality?: 'standard' | 'high'
}
const PRINT_SETTINGS_STORAGE_KEY = 'paperwork-print-settings-v1'
function loadStoredPrintSettings(): StoredPrintSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(PRINT_SETTINGS_STORAGE_KEY) ?? '{}') as StoredPrintSettings
    // v1 stored a two-tier quality flag instead of an explicit DPI choice.
    if (typeof stored.dpi !== 'number' && stored.quality) {
      stored.dpi = stored.quality === 'standard' ? 200 : 300
    }
    return stored
  } catch {
    return {}
  }
}

/** One lazy-loaded page thumbnail inside the print-preview rail. */
function PrintPreviewThumb({ page, position, disabled, current, excluded, load, onSelect, onToggleExclude }: {
  page: SheetPage; position: number; disabled: boolean; current: boolean; excluded: boolean; load: PreviewLoader
  onSelect: () => void; onToggleExclude: () => void
}) {
  const asset = usePrintPreviewAsset(page, 144, false, load)
  const number = page.sourceIndex + 1
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: page.key, disabled })
  return (
    <div ref={setNodeRef} className="print-preview__thumb" data-page-key={page.key} data-current={current || undefined} data-excluded={excluded || undefined} data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined }}>
      <button type="button" id={`print-page-${number}`} className="print-preview__page" aria-label={`第 ${number} 页，顺序 ${position}${excluded ? '，已排除打印' : ''}`} aria-current={current || undefined} onClick={onSelect}>
        {asset?.url ? <img src={asset.url} alt="" draggable={false} /> : asset ? <span className="print-preview__missing">无缩略图</span> : <span className="print-preview__skeleton" aria-hidden="true" />}
        <span className="print-preview__number">{number}</span>
      </button>
      <button type="button" ref={setActivatorNodeRef} className="print-preview__drag" disabled={disabled} {...attributes} {...listeners} aria-label={`调整第 ${number} 页打印顺序，当前位置 ${position}`} title="拖动排序；或按空格拿起、左右方向键移动、空格放下" style={{ touchAction: 'none' }}><GripVertical size={13} /><span>{position}</span></button>
      <button type="button" className="print-preview__exclude" disabled={disabled} aria-label={excluded ? `恢复第 ${number} 页打印` : `排除第 ${number} 页打印`} title={excluded ? '恢复此页' : '不打印此页'} onClick={onToggleExclude}>
        {excluded ? <RotateCcw size={11} /> : <X size={11} />}
      </button>
    </div>
  )
}

export function PrintDialog({
  open,
  pageCount,
  items,
  onClose,
  onAddFiles,
  onAddFolder,
  onRemoveItem,
  onClear,
  onPrint,
  onRenderPreview,
  onGetPreviewPageSize,
  printProgress,
}: {
  open: boolean
  pageCount: number
  items: Array<{ id: string; name: string; pageCount: number; size?: number; origin: 'workspace' | 'file' | 'folder' }>
  onClose: () => void
  onAddFiles: () => Promise<void>
  onAddFolder: () => Promise<void>
  onRemoveItem: (id: string) => void
  onClear: () => void
  onPrint: (options: PrintOptions) => Promise<boolean | 'explained'>
  /** Both callbacks describe the final composed page, zero-based within the queue item. */
  onRenderPreview?: PreviewImage
  onGetPreviewPageSize?: PreviewSize
  printProgress?: string
}) {
  const [range, setRange] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [printers, setPrinters] = useState<NativePrinter[]>([])
  const [deviceName, setDeviceName] = useState('')
  const [printerLoading, setPrinterLoading] = useState(false)
  const [printerError, setPrinterError] = useState('')
  const [adding, setAdding] = useState<'files' | 'folder' | null>(null)
  const [importError, setImportError] = useState('')
  // Repeat print jobs keep the previous run's settings (Chrome-style memory).
  const [initialSettings] = useState(loadStoredPrintSettings)
  const [copies, setCopies] = useState(String(initialSettings.copies ?? 1))
  const [sizing, setSizing] = useState<'fit' | 'actual'>(initialSettings.sizing === 'actual' ? 'actual' : 'fit')
  const [color, setColor] = useState(initialSettings.color !== false)
  const [landscape, setLandscape] = useState(initialSettings.landscape === true)
  const [reverse, setReverse] = useState(initialSettings.reverse === true)
  const [pageBorder, setPageBorder] = useState(initialSettings.pageBorder === true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetSide, setSheetSide] = useState(0)
  const [focusTarget, setFocusTarget] = useState('')
  const [scaleFactor, setScaleFactor] = useState(() => {
    const stored = Number(initialSettings.scaleFactor)
    return Number.isFinite(stored) ? Math.min(150, Math.max(50, stored)) : 100
  })
  // Custom dropdowns are controlled (they carry hidden inputs for FormData).
  const [duplex, setDuplex] = useState(initialSettings.duplex ?? 'simplex')
  const [pagesPerSheet, setPagesPerSheet] = useState(String([1, 2, 4, 6, 9, 16].includes(initialSettings.pagesPerSheet ?? 0) ? initialSettings.pagesPerSheet : 1))
  const [margins, setMargins] = useState<NonNullable<PrintOptions['margins']>>(initialSettings.margins ?? 'default')
  const [dpi, setDpi] = useState(String(initialSettings.dpi ?? 300))
  const [paperSize, setPaperSize] = useState<NonNullable<PrintOptions['paperSize']>>(initialSettings.paperSize ?? 'auto')
  const [subset, setSubset] = useState<NonNullable<PrintOptions['subset']>>(initialSettings.subset ?? 'all')
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState('')
  // Exclusion and layout use stable per-item keys, independent of the rail position.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const [previewIndex, setPreviewIndex] = useState(0)
  const [pageOrder, setPageOrder] = useState<string[]>([])
  const sortSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const loadPreview = useMemo(() => createPreviewLoader(onRenderPreview, onGetPreviewPageSize), [onRenderPreview, onGetPreviewPageSize])
  const railRef = useRef<HTMLDivElement>(null)
  const [focusedKey, setFocusedKey] = useState<string>()
  const [dragKey, setDragKey] = useState<string>()
  const printerRequest = useRef(0)
  // Once the user deliberately picks a printer option (including the ''
  // pseudo-option 使用系统打印对话框), a list reload must not stomp it.
  const userPickedPrinter = useRef(false)
  const desktop = window.desktop
  const nativePrint = Boolean(desktop?.printPages)
  const tauriPrint = nativePrint && '__TAURI_INTERNALS__' in window
  const showSheet = nativePrint && sheetOpen

  const loadPrinters = useCallback(async () => {
    if (!desktop?.getPrinters) {
      setPrinters([])
      setDeviceName('')
      return
    }
    const request = ++printerRequest.current
    setPrinterLoading(true)
    setPrinterError('')
    try {
      const available = await desktop.getPrinters()
      if (request !== printerRequest.current) return
      setPrinters(available)
      setDeviceName((current) => {
        const stillThere = available.some((printer) => printer.name === current)
        if (userPickedPrinter.current && (current === '' || stillThere)) return current
        return stillThere ? current : available.find((printer) => printer.isDefault)?.name ?? available[0]?.name ?? ''
      })
      if (!available.length) setPrinterError('未检测到可用打印机，请检查系统打印服务或打印机连接。')
    } catch (error) {
      if (request !== printerRequest.current) return
      setPrinters([])
      setDeviceName('')
      setPrinterError(error instanceof Error ? error.message : '读取系统打印机失败')
    } finally {
      if (request === printerRequest.current) setPrinterLoading(false)
    }
  }, [desktop])

  useEffect(() => {
    if (!open) return
    setAttempted(false)
    setImportError('')
    setPrintError('')
    setPrinting(false)
    userPickedPrinter.current = false
    void loadPrinters()
    return () => { printerRequest.current += 1 }
  }, [loadPrinters, open])

  const addToQueue = async (kind: 'files' | 'folder') => {
    if (adding || printing) return
    setAdding(kind)
    setImportError('')
    try {
      await (kind === 'files' ? onAddFiles() : onAddFolder())
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '文件导入失败，请重试')
    } finally {
      setAdding(null)
    }
  }

  // Merged-order page list for the preview rail; keyed by a signature because
  // the parent hands us a fresh items array every render.
  const itemsSignature = items.map((item) => `${item.id}:${item.pageCount}`).join('|')
  const previewPages = useMemo(
    () => items.flatMap((item) => Array.from({ length: Math.max(0, item.pageCount) }, (_, pageIndex) => ({
      key: `${item.id}:${pageIndex}`,
      itemId: item.id,
      pageIndex,
    }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- itemsSignature covers identity + page counts
    [itemsSignature],
  )
  const orderedPreviewPages = useMemo(() => {
    const byKey = new Map(previewPages.map((page, sourceIndex) => [page.key, { ...page, sourceIndex }]))
    return reconcilePrintPageOrder(pageOrder, [...byKey.keys()]).map((key) => byKey.get(key)!)
  }, [pageOrder, previewPages])
  const clampedPreviewIndex = Math.min(previewIndex, Math.max(0, previewPages.length - 1))
  const reorderPreview = ({ active, over }: DragEndEvent) => {
    setDragKey(undefined)
    if (!over || active.id === over.id || printing || adding) return
    const keys = orderedPreviewPages.map((page) => page.key)
    const from = keys.indexOf(String(active.id))
    const to = keys.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = arrayMove(keys, from, to)
    const currentKey = orderedPreviewPages[clampedPreviewIndex]?.key
    setPageOrder(next)
    setPreviewIndex(Math.max(0, next.indexOf(currentKey ?? '')))
  }

  // Queue edits drop exclusions of pages that no longer exist.
  useEffect(() => {
    const valid = new Set(previewPages.map((page) => page.key))
    setPageOrder((current) => {
      const next = reconcilePrintPageOrder(current, [...valid])
      return current.length === next.length && current.every((key, index) => key === next[index]) ? current : next
    })
    setExcluded((current) => {
      if (!current.size) return current
      const next = new Set([...current].filter((key) => valid.has(key)))
      return next.size === current.size ? current : next
    })
  }, [previewPages])

  const selection = useMemo(() => selectSheetPages(orderedPreviewPages, range, subset, excluded, reverse), [orderedPreviewPages, range, subset, excluded, reverse])
  const copiesError = nativePrint && !validCopies(copies) ? '请输入 1 到 99 之间的整数份数。' : ''
  const rangeIssue = selection.issue?.field === 'print-range' ? selection.issue.message : ''
  const orderKeys = useMemo(() => orderedPreviewPages.map(p => p.key), [orderedPreviewPages])
  const rail = useVirtualizer({ count: orderKeys.length, horizontal: true, enabled: open && !showSheet,
    getScrollElement: () => railRef.current, getItemKey: index => orderKeys[index], estimateSize: () => 80,
    initialRect: { width: 460, height: 140 }, overscan: 2,
    rangeExtractor: r => {
      // Do not unmount a focused handle or active drag when traversing a long rail.
      const indices = new Set(defaultRangeExtractor(r))
      for (const key of [focusedKey, dragKey]) { const i = key && orderKeys.indexOf(key); if (typeof i === 'number' && i >= 0) indices.add(i) }
      if (orderKeys.length) indices.add(clampedPreviewIndex)
      return [...indices].sort((a, b) => a - b)
    },
  })
  const visibleSlots = rail.getVirtualItems()
  useEffect(() => {
    if (!showSheet && orderKeys.length) rail.scrollToIndex(clampedPreviewIndex, { align: 'center' })
  }, [clampedPreviewIndex, orderKeys.length, showSheet, rail])
  useEffect(() => {
    if (!focusTarget) return
    const target = document.getElementById(focusTarget)
    if (target) { target.focus(); setFocusTarget('') }
  }, [focusTarget, showSheet, visibleSlots])
  const focusField = (id: string) => {
    if (id === 'print-restore') setSheetOpen(false)
    setFocusTarget(id)
  }
  const openSheet = () => {
    const index = selection.pages.findIndex(p => p.key === orderKeys[clampedPreviewIndex])
    setSheetSide(Math.floor(Math.max(0, index) / Number(pagesPerSheet)))
    setSheetOpen(true)
  }
  const locatePage = (page: SheetPage) => {
    setPreviewIndex(orderKeys.indexOf(page.key))
    setSheetOpen(false)
    setFocusTarget(`print-page-${page.sourceIndex + 1}`)
  }

  const toggleExcluded = (pageKey: string) => {
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(pageKey)) next.delete(pageKey)
      else next.add(pageKey)
      return next
    })
  }

  const selectedPrinter = printers.find((printer) => printer.name === deviceName)
  const formatSize = (bytes: number) => bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`

  return (
    <Dialog open={open} onClose={() => { if (!printing) onClose() }} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel dialog__panel--print">
        <div className="dialog__header print-center__header">
          <div className="print-center__identity">
            <span className="print-center__mark"><Printer size={20} aria-hidden="true" /></span>
            <div><DialogTitle>批量打印中心</DialogTitle><p>{nativePrint ? '整理文件清单，检查纸张和打印参数。' : '确认页序后生成 PDF，再到 PDF 阅读器中打印。'}</p></div>
          </div>
          <button aria-label="关闭打印设置" disabled={printing} onClick={onClose}><X size={18} /></button>
        </div>
        <form className="print-center" noValidate onSubmit={async (event) => {
          event.preventDefault()
          if (printing || adding) return
          setAttempted(true)
          if (selection.issue) { focusField(selection.issue.field); return }
          if (copiesError) { focusField('print-copies'); return }
          const data = new FormData(event.currentTarget)
          setPrintError('')
          setPrinting(true)
          try {
            const options: PrintOptions = {
              copies: nativePrint ? Number(copies) : 1,
              duplex: nativePrint ? duplex : 'simplex',
              range: selection.range,
              pageOrder: orderedPreviewPages.map(page => page.sourceIndex),
              landscape: nativePrint && landscape,
              collate: data.get('collate') === 'on',
              color: !nativePrint || color,
              pagesPerSheet: nativePrint ? Number(pagesPerSheet) : 1,
              scaleFactor: nativePrint ? scaleFactor : 100,
              ...(tauriPrint && { sizing }),
              deviceName: nativePrint && deviceName || undefined,
              margins: nativePrint ? margins : 'default',
              dpi: nativePrint ? Number(dpi) : 300,
              paperSize: nativePrint ? paperSize : 'auto',
              subset, reverse, pageBorder: nativePrint && pageBorder,
            }
            try {
              localStorage.setItem(PRINT_SETTINGS_STORAGE_KEY, JSON.stringify(nativePrint ? {
                copies: options.copies,
                duplex: options.duplex,
                pagesPerSheet: options.pagesPerSheet,
                margins: options.margins,
                collate: options.collate,
                color: options.color,
                landscape: options.landscape,
                scaleFactor: options.scaleFactor,
                sizing: tauriPrint ? sizing : initialSettings.sizing,
                dpi: options.dpi,
                paperSize: options.paperSize,
                subset: options.subset,
                reverse: options.reverse,
                pageBorder: options.pageBorder,
              } satisfies StoredPrintSettings : { ...initialSettings, subset, reverse }))
            } catch {
              // Storage can be disabled by policy; printing still works.
            }
            const succeeded = await onPrint(options)
            if (succeeded === true) onClose()
            // 'explained': print() already notified the precise reason (e.g.
            // the range∩subset matched nothing) — a generic printer error on
            // top would misdirect the user.
            else if (succeeded !== 'explained') {
              setPrintError(nativePrint ? '打印任务未提交，请检查打印机状态或改用系统打印对话框。' : '未能生成待打印 PDF，请重试。')
              setFocusTarget('print-submit-error')
            }
          } catch (error) {
            setPrintError(error instanceof Error ? error.message : nativePrint ? '打印任务提交失败，请重试。' : '未能生成待打印 PDF，请重试。')
            setFocusTarget('print-submit-error')
          } finally {
            setPrinting(false)
          }
        }}>
          <fieldset className="print-center__body" disabled={printing} aria-busy={printing}>
            <section className="print-pane print-queue" aria-labelledby="print-queue-title" data-sheet-open={showSheet || undefined}>
              <div className="print-pane__heading">
                <div><span className="print-pane__kicker">DOCUMENT QUEUE</span><h3 id="print-queue-title">打印清单</h3></div>
                <span className="print-queue__count">{items.length} 个文件 · {pageCount} 页</span>
              </div>
              <div className="print-queue__toolbar" aria-label="打印清单操作">
                <Button id="print-add-files" type="button" variant="secondary" busy={adding === 'files'} disabled={Boolean(adding) || printing} onClick={() => void addToQueue('files')}><FilePlus2 size={15} /> 添加文件</Button>
                <Button type="button" variant="secondary" busy={adding === 'folder'} disabled={Boolean(adding) || printing} onClick={() => void addToQueue('folder')}><FolderOpen size={15} /> 添加文件夹</Button>
                <Button className="print-queue__clear" type="button" disabled={!items.length || Boolean(adding) || printing} onClick={onClear}><Trash2 size={14} /> 清空</Button>
              </div>
              {importError && <div className="print-inline-error" role="alert"><AlertTriangle size={15} />{importError}</div>}
              {!showSheet && <div className="print-queue__list-wrap" aria-live="polite">
                {items.length ? (
                  <ul className="print-queue__list" aria-label="待打印文件">
                    {items.map((item, index) => (
                      <li className="print-queue__item" key={item.id}>
                        <span className="print-queue__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                        <span className="print-queue__file-icon"><FileText size={17} /></span>
                        <span className="print-queue__file">
                          <strong title={item.name}>{item.name}</strong>
                          <small><span className="print-origin" data-origin={item.origin}>{item.origin === 'workspace' ? '当前工作区' : item.origin === 'folder' ? '文件夹' : '本地文件'}</span><span>{item.pageCount} 页</span>{item.size != null && <span>{formatSize(item.size)}</span>}</small>
                        </span>
                        <button className="print-queue__remove" type="button" disabled={printing} aria-label={`从打印清单移除 ${item.name}`} title="从清单移除" onClick={() => onRemoveItem(item.id)}><X size={15} /></button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="print-queue__empty">
                    <span><Files size={24} /></span><strong>打印清单为空</strong><p>添加多个 PDF，或一次选择整个文件夹中的 PDF。</p>
                    <div><Button type="button" variant="primary" busy={adding === 'files'} disabled={Boolean(adding) || printing} onClick={() => void addToQueue('files')}>选择文件</Button><Button type="button" busy={adding === 'folder'} disabled={Boolean(adding) || printing} onClick={() => void addToQueue('folder')}>选择文件夹</Button></div>
                  </div>
                )}
              </div>}
              {(nativePrint || previewPages.length > 0) && <div className="print-preview">
                <div className="print-preview__head">
                  {nativePrint ? <div className="print-view-switch" role="group" aria-label="检查打印页面">
                    <button type="button" aria-pressed={!showSheet} onClick={() => setSheetOpen(false)}>页序 / 排除</button>
                    <button type="button" aria-pressed={showSheet} onClick={() => { if (!showSheet) openSheet() }}><FileImage size={14} aria-hidden="true" />纸张预览</button>
                  </div> : <strong className="print-preview__title">页序 / 排除</strong>}
                  {!showSheet && orderedPreviewPages.length > 0 && <>
                    <span className="print-preview__meta">顺序 {clampedPreviewIndex + 1} / {previewPages.length}</span>
                    <span className="print-preview__nav">
                      <button type="button" aria-label="上一页" disabled={clampedPreviewIndex <= 0} onClick={() => setPreviewIndex(clampedPreviewIndex - 1)}><ChevronLeft size={14} /></button>
                      <button type="button" aria-label="下一页" disabled={clampedPreviewIndex >= previewPages.length - 1} onClick={() => setPreviewIndex(clampedPreviewIndex + 1)}><ChevronRight size={14} /></button>
                    </span></>}
                </div>
                {showSheet ? <PrintSheetPreview pages={selection.pages} issue={selection.issue} side={sheetSide} onSide={setSheetSide} options={{ paperSize, landscape, pagesPerSheet: Number(pagesPerSheet), sizing: tauriPrint ? sizing : 'fit', scaleFactor, margins, color, pageBorder, duplex }} load={loadPreview} onLocate={locatePage} onFocusField={focusField} /> : orderedPreviewPages.length > 0 ? <>
                  <small id="print-preview-sort-help" className="print-preview__hint">拖动手柄调整页序；键盘按空格拿起、左右键移动、空格放下，Esc 取消。范围和奇偶页按原页码计算。{excluded.size > 0 && <> 已排除 {excluded.size} 页。<button type="button" className="print-sheet__link" id="print-restore" onClick={() => { setExcluded(new Set()); setFocusTarget(`print-page-${orderedPreviewPages[clampedPreviewIndex].sourceIndex + 1}`) }}>恢复全部排除页</button></>}</small>
                  <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragStart={e => setDragKey(String(e.active.id))} onDragCancel={() => setDragKey(undefined)} onDragEnd={reorderPreview} accessibility={{ screenReaderInstructions: { draggable: '按空格拿起页面，左右方向键调整打印顺序，再按空格放下，Escape 取消。' } }}>
                    <SortableContext items={visibleSlots.map(slot => orderKeys[slot.index])} strategy={horizontalListSortingStrategy}>
                      <div className="print-preview__rail" ref={railRef} aria-label="打印页面顺序" aria-describedby="print-preview-sort-help" onFocusCapture={e => setFocusedKey((e.target as HTMLElement).closest<HTMLElement>('[data-page-key]')?.dataset.pageKey)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocusedKey(undefined) }}>
                        <div className="print-preview__track" style={{ width: rail.getTotalSize() }}>
                          {visibleSlots.map(({ index, start }) => {
                            const page = orderedPreviewPages[index]
                            return <div key={page.key} className="print-preview__slot" style={{ left: start }}><PrintPreviewThumb page={page} position={index + 1} disabled={printing || Boolean(adding)} current={index === clampedPreviewIndex} excluded={excluded.has(page.key)} load={loadPreview} onSelect={() => setPreviewIndex(index)} onToggleExclude={() => toggleExcluded(page.key)} /></div>
                          })}
                        </div>
                      </div>
                    </SortableContext>
                  </DndContext>
                </> : <small className="print-preview__hint">添加文件后可调整页序、排除页面或查看纸张。</small>}
              </div>}
            </section>

            <section className="print-pane print-settings" aria-labelledby="print-settings-title">
              <div className="print-pane__heading">
                <div><span className="print-pane__kicker">OUTPUT &amp; LAYOUT</span><h3 id="print-settings-title">{nativePrint ? '打印机与参数' : '待打印 PDF'}</h3></div>
                {nativePrint && desktop?.getPrinters && <Button type="button" className="print-printer__refresh" busy={printerLoading} onClick={() => void loadPrinters()} aria-label="刷新系统打印机">{!printerLoading && <RefreshCw size={14} />} 刷新</Button>}
              </div>
              <div className="print-settings__scroll">
                {nativePrint && desktop?.getPrinters ? (
                  <div className="print-config-section">
                    <div className="print-config-section__title"><Printer size={15} /><h4>系统打印机</h4></div>
                    <FormSelect
                      id="print-device"
                      name="deviceName"
                      label="选择打印机"
                      value={deviceName}
                      onChange={(value) => { userPickedPrinter.current = true; setDeviceName(value) }}
                      loading={printerLoading}
                      options={[
                        { value: '', label: '使用系统打印对话框' },
                        ...printers.map((printer) => ({
                          value: printer.name,
                          label: `${printer.displayName || printer.name}${printer.isDefault ? '（默认）' : ''}`,
                          hint: printer.description || undefined,
                        })),
                      ]}
                    />
                    {selectedPrinter && <div className="print-printer__detail"><span className="print-printer__icon"><Printer size={18} /></span><div><strong>{selectedPrinter.displayName || selectedPrinter.name}</strong><small>{selectedPrinter.description || selectedPrinter.name}</small></div>{selectedPrinter.isDefault && <span className="print-printer__default">系统默认</span>}</div>}
                    {!selectedPrinter && !printerLoading && <p className="print-printer__system-hint">确认后打开系统打印窗口，可进入打印机驱动的原生属性与高级配置。</p>}
                    {printerError && <div className="print-inline-error" role="alert"><AlertTriangle size={15} />{printerError}</div>}
                  </div>
                ) : <div className="notice print-web-notice"><Printer size={17} /> {nativePrint ? '将在系统打印窗口选择打印机。' : '将下载按当前页序生成的待打印 PDF。请在 PDF 阅读器中打印，并设置纸张、每张页数、缩放、颜色、双面和分辨率。'}</div>}

                <div className="print-config-section">
                  <div className="print-config-section__title"><Settings2 size={15} /><h4>页面与版式</h4></div>
                  <div className="print-range-row">
                    <label htmlFor="print-range">打印范围
                      <input id="print-range" name="range" placeholder={pageCount ? `全部，或输入 1-3,6（共 ${pageCount} 页）` : '请先添加打印文件'} disabled={!items.length} value={range} aria-invalid={Boolean(rangeIssue)} aria-describedby={rangeIssue ? 'print-range-error' : 'print-range-help'} onChange={e => setRange(e.target.value)} />
                      <small id="print-range-help">页码以合并后的清单顺序计算，留空表示全部。</small>
                      {rangeIssue && <span id="print-range-error" className="field-error" role="alert">{rangeIssue}</span>}
                    </label>
                    <FormSelect
                      id="print-subset"
                      name="subset"
                      label="页面子集"
                      value={subset}
                      onChange={(value) => setSubset(value as NonNullable<PrintOptions['subset']>)}
                      disabled={!items.length}
                      options={[
                        { value: 'all', label: '全部页面' },
                        { value: 'odd', label: '仅奇数页' },
                        { value: 'even', label: '仅偶数页' },
                      ]}
                    />
                  </div>
                  {attempted && selection.issue && !rangeIssue && <div className="print-inline-error" role="alert">{selection.issue.message}</div>}
                  {nativePrint && <><div className="print-setting-grid print-setting-grid--3">
                    <label htmlFor="print-copies">份数<input id="print-copies" name="copies" type="number" min="1" max="99" step="1" required value={copies} onChange={e => setCopies(e.target.value)} aria-invalid={Boolean(copiesError)} aria-describedby={copiesError ? 'print-copies-error' : undefined} />{copiesError && <span className="field-error" id="print-copies-error" role="alert">{copiesError}</span>}</label>
                    <FormSelect name="duplex" label="双面" value={duplex} onChange={(value) => setDuplex(value as PrintOptions['duplex'])} options={[
                      { value: 'simplex', label: '单面' },
                      { value: 'longEdge', label: '双面 · 长边' },
                      { value: 'shortEdge', label: '双面 · 短边' },
                    ]} />
                    <FormSelect name="pagesPerSheet" label="每张页数" value={pagesPerSheet} onChange={setPagesPerSheet} options={[
                      { value: '1', label: '1 页' },
                      { value: '2', label: '2 页' },
                      { value: '4', label: '4 页' },
                      { value: '6', label: '6 页' },
                      { value: '9', label: '9 页' },
                      { value: '16', label: '16 页' },
                    ]} />
                    <FormSelect id="print-paper" name="paperSize" label="纸张大小" value={paperSize} onChange={(value) => setPaperSize(value as NonNullable<PrintOptions['paperSize']>)} options={[
                      { value: 'auto', label: '随 PDF 页面' },
                      { value: 'a4', label: 'A4' },
                      { value: 'a5', label: 'A5' },
                      { value: 'b5', label: 'B5' },
                      { value: 'letter', label: 'Letter' },
                      { value: 'legal', label: 'Legal' },
                    ]} />
                    <FormSelect name="dpi" label="分辨率" value={dpi} onChange={setDpi} options={[
                      { value: '150', label: '150 DPI', hint: '草稿，最快' },
                      { value: '200', label: '200 DPI', hint: '标准' },
                      { value: '300', label: '300 DPI', hint: '高清 · 推荐' },
                      { value: '400', label: '400 DPI', hint: '精细' },
                      { value: '600', label: '最高 600 DPI', hint: '大幅面或高噪扫描件依安全上限降低分辨率' },
                    ]} />
                    <FormSelect name="margins" label="边距" value={margins} onChange={(value) => setMargins(value as NonNullable<PrintOptions['margins']>)} options={[
                      { value: 'default', label: '安全留白（推荐）' },
                      { value: 'printableArea', label: '充满可打印区域' },
                      { value: 'none', label: '无边距（可能裁切）' },
                    ]} />
                  </div>
                  {tauriPrint && <fieldset className="print-sizing"><legend>缩放基准</legend>
                    <label><input type="radio" name="sizing" value="fit" checked={sizing === 'fit'} onChange={() => setSizing('fit')} />适合纸张</label>
                    <label><input type="radio" name="sizing" value="actual" checked={sizing === 'actual'} onChange={() => setSizing('actual')} />实际大小</label>
                  </fieldset>}
                  <label className="print-scale" htmlFor="print-scale"><span>缩放比例 <output htmlFor="print-scale">{scaleFactor}%</output></span><input id="print-scale" name="scaleFactor" type="range" min="50" max="150" step="5" value={scaleFactor} onChange={(event) => setScaleFactor(Number(event.target.value))} /><small>{tauriPrint && sizing === 'actual' ? '100% 按 PDF 实际尺寸输出（72 pt = 1 英寸），不会为拼版自动缩小。' : '100% 等比缩放到当前纸张或拼版格的可用区域，不一定是原尺寸。'} 超过 100% 或内容超出可打印区域时可能裁切。</small></label></>}
                  <div className="print-checks print-checks--cards">
                    {nativePrint && <><label className="check-row"><input name="collate" type="checkbox" defaultChecked={initialSettings.collate ?? true} /><span><strong>逐份打印</strong><small>多份按套序输出</small></span></label>
                    <label className="check-row"><input name="color" type="checkbox" checked={color} onChange={e => setColor(e.target.checked)} /><span><strong>彩色</strong><small>关闭后灰度输出</small></span></label>
                    <label className="check-row"><input name="landscape" type="checkbox" checked={landscape} onChange={e => setLandscape(e.target.checked)} /><span><strong>横向</strong><small>将纸张横向放置</small></span></label></>}
                    <label className="check-row"><input name="reverse" type="checkbox" checked={reverse} onChange={e => setReverse(e.target.checked)} /><span><strong>逆序打印</strong><small>从末页开始输出</small></span></label>
                    {nativePrint && <label className="check-row"><input name="pageBorder" type="checkbox" checked={pageBorder} onChange={e => setPageBorder(e.target.checked)} /><span><strong>页面边框</strong><small>每页描一圈细线</small></span></label>}
                  </div>
                </div>
              </div>
            </section>
          </fieldset>
          <div className="print-center__footer">
            <div className="print-center__submit-status" aria-live="polite">
              {printError
                ? <div className="print-inline-error" role="alert" id="print-submit-error" tabIndex={-1}><AlertTriangle size={15} />{printError}</div>
                : <div className="print-center__ready" data-printing={printing || undefined}><span className="status-dot" aria-hidden="true" />{printing ? printProgress || (nativePrint ? '正在准备打印…' : '正在生成待打印 PDF…') : items.length ? `清单 ${pageCount} 页，本次输出 ${selection.pages.length} 页` : '请先添加文件'}</div>}
            </div>
            <div className="dialog__actions"><Button type="button" disabled={printing} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={printing} disabled={!items.length || Boolean(adding) || printing}>{!printing && <Printer size={15} />} {nativePrint ? printing ? '正在打印' : '开始打印' : printing ? '正在生成' : '生成待打印 PDF'}</Button></div>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}

/**
 * 文件级 OCR 设置与进度面板。识别任务由 App 管理，因此即使组件因视图切换
 * 重新渲染，任务进度和取消能力也不会丢失。
 */
export function OcrDialog({
  open,
  sources,
  defaultSourceId,
  capabilities,
  running = false,
  progress, lastIssue,
  onClose,
  onRun,
  onCancel,
}: {
  open: boolean
  sources: OcrSourceOption[]
  defaultSourceId?: string
  capabilities?: OcrCapabilities
  running?: boolean
  progress?: OcrProgress
  lastIssue?: string
  onClose: () => void
  onRun: (options: OcrRunOptions) => void | Promise<void>
  onCancel?: () => void
}) {
  const systemOcr = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [pageRange, setPageRange] = useState('')
  const [mode, setMode] = useState<OcrMode>('auto')
  const [skipTextPages, setSkipTextPages] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const [pageRangeError, setPageRangeError] = useState('')
  const sourceListRef = useRef<HTMLDivElement>(null)
  const progressHeadingRef = useRef<HTMLHeadingElement>(null)
  const sourceKey = sources.map((source) => source.id).join('\u0000')

  useEffect(() => {
    if (!open) return
    const fallback = sources[0]?.id
    const initial = defaultSourceId && sources.some((source) => source.id === defaultSourceId)
      ? defaultSourceId
      : fallback
    setSelectedSourceIds(initial ? [initial] : [])
    setScope('all')
    setPageRange('')
    setMode('auto')
    setSkipTextPages(false)
    setSelectionError('')
    setPageRangeError('')
  }, [open, defaultSourceId, sourceKey])

  useEffect(() => {
    if (selectedSourceIds.length !== 1 && scope === 'range') setScope('all')
  }, [scope, selectedSourceIds.length])

  useEffect(() => {
    if (open && running) progressHeadingRef.current?.focus()
  }, [open, running])

  const selectedSource = selectedSourceIds.length === 1
    ? sources.find((source) => source.id === selectedSourceIds[0])
    : undefined
  const selectedRangeIndexes = (() => {
    if (scope !== 'range' || !selectedSource || !pageRange.trim()) return undefined
    try { return parsePageRanges(pageRange, selectedSource.pageCount) } catch { return undefined }
  })()
  const selectedPages = scope === 'range' && selectedRangeIndexes
    ? selectedRangeIndexes.length
    : sources.reduce(
      (sum, source) => sum + (selectedSourceIds.includes(source.id) ? source.pageCount : 0),
      0,
    )
  const allSelected = sources.length > 0 && selectedSourceIds.length === sources.length
  const totalPages = Math.max(0, progress?.totalPages ?? selectedPages)
  const currentPage = Math.min(totalPages, Math.max(0, progress?.currentPage ?? 0))
  const progressPercent = totalPages ? Math.round((currentPage / totalPages) * 100) : 0
  const cancelling = running && Boolean(progress?.stage.includes('正在结束'))

  const requestClose = () => onClose()

  return (
    <Dialog open={open} onClose={requestClose} className="dialog ocr-dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel dialog__panel--wide ocr-dialog__panel">
        <div className="dialog__header ocr-dialog__header">
          <div className="ocr-dialog__identity">
            <span className="ocr-dialog__mark"><ScanText size={22} /></span>
            <div><DialogTitle>识别并生成可复制文字</DialogTitle></div>
          </div>
          <button type="button" aria-label={running ? '转到后台继续 OCR' : '关闭 OCR 设置'} title={running ? '转到后台继续识别' : undefined} onClick={requestClose}><X size={18} /></button>
        </div>

        {running ? (
          <section className="ocr-progress" aria-labelledby="ocr-progress-heading" aria-busy="true">
            <div className="ocr-progress__visual"><ScanText size={30} /><span /></div>
            <div className="ocr-progress__heading">
              <div><h3 ref={progressHeadingRef} id="ocr-progress-heading" tabIndex={-1} aria-live="polite">{progress?.stage || '正在准备识别模型'}</h3></div>
              <strong>{progressPercent}%</strong>
            </div>
            {progress?.sourceName && <p className="ocr-progress__file" title={progress.sourceName}>{progress.sourceName}</p>}
            <div
              className="ocr-progress__track"
              role="progressbar"
              aria-label="OCR 识别进度"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, totalPages)}
              aria-valuenow={currentPage}
            ><span style={{ width: `${progressPercent}%` }} /></div>
            <div className="ocr-progress__meta">
              <span>{totalPages ? `第 ${currentPage} / ${totalPages} 页` : '正在分析文档'}</span>
              <span>本次会话可搜索、复制识别结果</span>
            </div>
            <div className="ocr-progress__notice">
              <Cpu size={17} />
              <p><strong>本地离线处理</strong><small>图片渲染与识别可能短时占用较多处理器资源，应用会逐页处理以控制内存。</small></p>
            </div>
            <div className="dialog__actions">
              <Button type="button" onClick={requestClose}>转到后台</Button>
              {onCancel && <Button type="button" disabled={cancelling} busy={cancelling} onClick={onCancel}>{cancelling ? '正在停止' : '取消识别'}</Button>}
            </div>
          </section>
        ) : (
          <form className="ocr-form" onSubmit={(event) => {
            event.preventDefault()
            if (!selectedSourceIds.length) {
              setSelectionError('请至少选择一个需要识别的文件。')
              window.setTimeout(() => sourceListRef.current?.focus(), 0)
              return
            }
            let pageIds: string[] | undefined
            if (scope === 'range') {
              if (!selectedSource || !selectedSource.pages) {
                setPageRangeError('指定页码范围时只能选择一个文件。')
                return
              }
              try {
                pageIds = resolvePageRangeIds(
                  pageRange,
                  selectedSource.pageCount,
                  selectedSource.pages,
                )
                if (!pageIds.length) throw new Error('页码范围中没有可识别页面')
              } catch (error) {
                setPageRangeError(error instanceof Error ? error.message : '页码范围无效')
                return
              }
            }
            setSelectionError('')
            setPageRangeError('')
            void onRun({ sourceIds: selectedSourceIds, mode, skipTextPages, pageIds })
            onClose()
          }}>
            {lastIssue && <p className="notice notice--warning" role="status">上次识别：{lastIssue}</p>}
            <div className="ocr-engine-card">
              <span className="ocr-engine-card__icon"><Sparkles size={19} /></span>
              <div><strong>{systemOcr ? 'Windows OCR' : 'PP-OCRv6 Small'}</strong><small>{systemOcr ? `本机语言：${capabilities?.languages.join('、') || '请先安装 Windows OCR 语言包'}` : '中英文印刷体与手写体识别 · 本地离线运行'}</small></div>
              <span className="ocr-engine-card__badge">{systemOcr ? '系统离线识别' : '约 31 MB · 已内置'}</span>
            </div>

            <section className="ocr-section">
              <div className="ocr-section__heading">
                <div><span>01</span><h3>选择文件</h3></div>
                <button
                  type="button"
                  className="ocr-select-all"
                  disabled={!sources.length}
                  onClick={() => {
                    setSelectedSourceIds(allSelected ? [] : sources.map((source) => source.id))
                    setSelectionError('')
                  }}
                >{allSelected ? '取消全选' : '选择全部'}</button>
              </div>
              <div
                ref={sourceListRef}
                className="ocr-source-list"
                role="group"
                aria-label="需要执行 OCR 的文件"
                aria-invalid={Boolean(selectionError)}
                aria-describedby={selectionError ? 'ocr-source-error' : undefined}
                tabIndex={-1}
              >
                {sources.map((source) => {
                  const selected = selectedSourceIds.includes(source.id)
                  return (
                    <label key={source.id} className="ocr-source" data-selected={selected || undefined}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => {
                          setSelectedSourceIds((current) => selected
                            ? current.filter((id) => id !== source.id)
                            : [...current, source.id])
                          setSelectionError('')
                        }}
                      />
                      <span className="ocr-source__icon"><FileText size={17} /></span>
                      <span className="ocr-source__name" title={source.name}>{source.name}</span>
                      <small>{source.pageCount} 页</small>
                    </label>
                  )
                })}
                {!sources.length && <div className="ocr-source-list__empty">当前工作区没有可识别的 PDF 文件</div>}
              </div>
              {selectionError && <p id="ocr-source-error" className="field-error ocr-field-error" role="alert">{selectionError}</p>}
            </section>

            <section className="ocr-section">
              <div className="ocr-section__heading"><div><span>02</span><h3>页面范围</h3></div></div>
              <div className="ocr-policy-grid">
                <label className="ocr-policy" data-selected={scope === 'all' || undefined}>
                  <input type="radio" name="ocr-scope" checked={scope === 'all'} onChange={() => { setScope('all'); setSelectionError(''); setPageRangeError('') }} />
                  <span><strong>所选文件的全部页面</strong><small>按文件顺序逐页识别</small></span>
                </label>
                <label className="ocr-policy" data-selected={scope === 'range' || undefined} data-disabled={selectedSourceIds.length !== 1 || undefined}>
                  <input type="radio" name="ocr-scope" checked={scope === 'range'} disabled={selectedSourceIds.length !== 1} onChange={() => { setScope('range'); setSelectionError(''); setPageRangeError('') }} />
                  <span><strong>指定页码或范围</strong><small>仅选择一个文件时可用</small></span>
                </label>
              </div>
              {scope === 'range' && selectedSource && (
                <label className="ocr-page-range" htmlFor="ocr-page-range">
                  <span>页码范围</span>
                  <input
                    id="ocr-page-range"
                    value={pageRange}
                    placeholder={`例如 1-3, 6, ${selectedSource.pageCount}`}
                    aria-invalid={Boolean(pageRangeError)}
                    aria-describedby={pageRangeError ? 'ocr-page-range-error' : 'ocr-page-range-help'}
                    onChange={(event) => { setPageRange(event.currentTarget.value); setPageRangeError('') }}
                  />
                  <small id="ocr-page-range-help">支持逗号分隔，范围为 1-{selectedSource.pageCount}。</small>
                  {pageRangeError && <small id="ocr-page-range-error" className="field-error" role="alert">{pageRangeError}</small>}
                </label>
              )}
            </section>

            <section className="ocr-section">
              <div className="ocr-section__heading"><div><span>03</span><h3>识别类型</h3></div></div>
              <div className="ocr-mode-grid">
                {([
                  { value: 'auto', title: '自动判断', description: systemOcr ? '使用已安装的系统识别语言' : '逐页判断正文或手写内容，适合混合文档', icon: Sparkles },
                  { value: 'printed', title: '正文 / 印刷体', description: '优先速度与版面阅读顺序', icon: Languages },
                  { value: 'handwriting', title: '手写体', description: '增强笔迹和不规则字符识别', icon: ScanText },
                ] as const).filter((item) => !systemOcr || item.value !== 'handwriting').map((item) => {
                  const Icon = item.icon
                  return (
                    <label key={item.value} className="ocr-mode" data-selected={mode === item.value || undefined}>
                      <input type="radio" name="ocr-mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} />
                      <Icon size={18} />
                      <span><strong>{item.title}</strong><small>{item.description}</small></span>
                    </label>
                  )
                })}
              </div>
            </section>

            <section className="ocr-section">
              <div className="ocr-section__heading"><div><span>04</span><h3>已有文字处理</h3></div></div>
              <div className="ocr-policy-grid">
                <label className="ocr-policy" data-selected={skipTextPages || undefined}>
                  <input type="radio" name="ocr-policy" checked={skipTextPages} onChange={() => setSkipTextPages(true)} />
                  <span><strong>跳过完整原生文字页</strong><small>仅当文字跨多行且达到完整度阈值时跳过；残缺或少量隐藏文字仍会 OCR。</small></span>
                </label>
                <label className="ocr-policy" data-selected={!skipTextPages || undefined}>
                  <input type="radio" name="ocr-policy" checked={!skipTextPages} onChange={() => setSkipTextPages(false)} />
                  <span><strong>完整重新识别（推荐）</strong><small>重建所选文件的文字层，避免残缺的原文字层导致漏识别。</small></span>
                </label>
              </div>
            </section>

            <div className="ocr-form__footer">
              <p><strong>{selectedSourceIds.length}</strong> 个文件 · <strong>{selectedPages}</strong> 页<span> · 可搜索、复制；此版本不把新识别的文字层写入导出的 PDF</span></p>
              <div className="dialog__actions">
                <Button type="button" onClick={onClose}>取消</Button>
                <Button type="submit" variant="primary" disabled={!sources.length}><ScanText size={15} /> 开始 OCR</Button>
              </div>
            </div>
          </form>
        )}
      </DialogPanel>
    </Dialog>
  )
}

export function ExportDialog({
  open,
  hasWatermark,
  onClose,
  onExport,
}: {
  open: boolean
  hasWatermark?: boolean
  onClose: () => void
  onExport: (options: { removeMetadata: boolean }) => void
}) {
  return (
    <Dialog open={open} onClose={onClose} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel">
        <div className="dialog__header">
          <div><DialogTitle>导出与优化</DialogTitle></div>
          <button aria-label="关闭导出设置" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          onExport({ removeMetadata: data.get('metadata') === 'on' })
          onClose()
        }}>
          <p className="dialog__hint">
            {hasWatermark
              ? '文档水印会随导出一并写入；需要调整时可在页面上直接拖动、拉伸或双击编辑。'
              : '可从“文档保护”添加水印；窄窗下请展开“更多工具”。'}
          </p>
          <label className="check-row"><input name="metadata" type="checkbox" /> 移除标题、作者、主题和关键词元数据</label>
          <p className="dialog__hint">需要缩小文件？点击顶部“压缩 PDF”，或右键文件标签选择“压缩 PDF”。</p>
          <div className="dialog__actions">
            <Button type="button" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary">导出 PDF</Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}

/**
 * Creates or edits the document-level interactive watermark. Applying writes
 * the watermark onto every page (drag/stretch/double-click to fine-tune
 * there); nothing is exported from this dialog.
 */
export function WatermarkDialog({
  open,
  initial,
  pageWidthPt,
  pageHeightPt,
  onClose,
  onApply,
  onRemove,
}: {
  open: boolean
  initial?: DocumentWatermark
  /** Active page size in points (display orientation), for natural sizing. */
  pageWidthPt: number
  pageHeightPt: number
  onClose: () => void
  onApply: (watermark: DocumentWatermark) => void
  onRemove: () => void
}) {
  const [kind, setKind] = useState<'text' | 'image'>('text')
  const [text, setText] = useState('内部资料')
  const [color, setColor] = useState('#263d4d')
  const [bold, setBold] = useState(true)
  const [fontSize, setFontSize] = useState(38)
  const [opacityPct, setOpacityPct] = useState(18)
  const [rotation, setRotation] = useState(-28)
  const [tiled, setTiled] = useState(false)
  const [image, setImage] = useState<{ name: string; data: string; aspect: number }>()

  useEffect(() => {
    if (!open) return
    setKind(initial?.kind ?? 'text')
    setText(initial?.text ?? '内部资料')
    setColor(initial?.color ?? '#263d4d')
    setBold(initial?.bold !== false)
    setFontSize(initial ? Math.round(initial.height*pageHeightPt/1.45) : 38)
    setOpacityPct(Math.round((initial?.opacity ?? 0.18) * 100))
    setRotation(initial ? ((initial.rotation + 180) % 360 + 360) % 360 - 180 : -28)
    setTiled(initial?.tiled ?? false)
    setImage(undefined)
    if (initial?.kind === 'image' && initial.imageData) {
      const probe = new Image()
      probe.onload = () => setImage({ name: '当前图片水印', data: initial.imageData!, aspect: probe.naturalWidth / Math.max(1, probe.naturalHeight) })
      probe.src = initial.imageData
    }
  }, [open, initial, pageHeightPt])

  const pickImage = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const apply = (data: string) => {
        const probe = new Image()
        probe.onload = () => setImage({ name: file.name, data, aspect: probe.naturalWidth / Math.max(1, probe.naturalHeight) })
        probe.onerror = () => setImage({ name: file.name, data, aspect: 1.6 })
        probe.src = data
      }
      void prepareWatermarkImage(String(reader.result)).then(apply, () => apply(String(reader.result)))
    }
    reader.readAsDataURL(file)
  }

  const buildWatermark = (): DocumentWatermark | undefined => {
    const opacity = Math.max(0.05, Math.min(0.8, opacityPct / 100))
    const angle = Math.max(-180, Math.min(180, rotation))
    // Natural aspect of the content in screen terms: (w·pageW)/(h·pageH).
    const naturalAspect = kind === 'text'
      ? (() => {
          const measured = measureWatermarkText(text.trim() || '水印', fontSize, bold,initial?.fontFamily,initial?.italic)
          return measured.width / measured.height
        })()
      : image?.aspect ?? 1.6
    if (kind === 'text' && !text.trim()) return undefined
    if (kind === 'image' && !image?.data) return undefined

    // Preserve the on-page box when only style changed; resize to fit new content otherwise.
    const contentChanged = !initial
      || initial.kind !== kind
      || (kind === 'text' ? initial.text !== text.trim() : initial.imageData !== image?.data)
    let width: number
    let height: number
    let anchorX: number
    let anchorY: number
    if (!contentChanged && initial) {
      width = initial.width
      height = initial.height
      anchorX = initial.x
      anchorY = initial.y
    } else {
      height = initial ? initial.height : Math.min(tiled ? 0.09 : 0.12, (fontSize * 1.45) / pageHeightPt)
      width = (height * pageHeightPt * naturalAspect) / pageWidthPt
      const maxWidth = tiled ? 0.52 : 0.92
      if (width > maxWidth) {
        height = Math.max(0.02, height * (maxWidth / width))
        width = maxWidth
      }
      const centerX = initial ? initial.x + initial.width / 2 : 0.5
      const centerY = initial ? initial.y + initial.height / 2 : 0.5
      anchorX = centerX - width / 2
      anchorY = centerY - height / 2
    }
    if (!tiled) {
      anchorX = Math.max(0, Math.min(1 - width, anchorX))
      anchorY = Math.max(0, Math.min(1 - height, anchorY))
    }
    return {
      kind,
      fontFamily:initial?.fontFamily,italic:initial?.italic,
      text: kind === 'text' ? text.trim() : undefined,
      imageData: kind === 'image' ? image?.data : undefined,
      color,
      bold,
      opacity,
      rotation: angle,
      tiled,
      x: anchorX,
      y: anchorY,
      width,
      height,
      gapX: 0.09,
      gapY: 0.11,
    }
  }

  const valid = kind === 'text' ? Boolean(text.trim()) : Boolean(image?.data)

  return (
    <Dialog open={open} onClose={onClose} className="dialog">
      <DialogBackdrop className="dialog__backdrop" />
      <DialogPanel className="dialog__panel watermark-sheet">
        <div className="dialog__header">
          <div><DialogTitle>{initial ? '编辑文档水印' : '插入水印'}</DialogTitle></div>
          <button aria-label="关闭水印设置" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          const watermark = buildWatermark()
          if (!watermark) return
          onApply(watermark)
          onClose()
        }}>
          <div className="watermark-kind-row" role="radiogroup" aria-label="水印类型">
            <label className="watermark-kind" data-selected={kind === 'text' || undefined}>
              <input type="radio" name="watermark-kind" checked={kind === 'text'} onChange={() => setKind('text')} />
              <FileText size={16} /><strong>文字水印</strong>
            </label>
            <label className="watermark-kind" data-selected={kind === 'image' || undefined}>
              <input type="radio" name="watermark-kind" checked={kind === 'image'} onChange={() => setKind('image')} />
              <Stamp size={16} /><strong>图片 / 电子章</strong>
            </label>
          </div>
          {kind === 'text' ? (
            <label>水印文字
              <input name="watermark-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="例如 内部资料 / CONFIDENTIAL" autoFocus />
              <small>双击页上水印可改字。</small>
            </label>
          ) : (
            <div className="watermark-image-row">
              <label className="watermark-image-picker">
                <FileImage size={17} />
                <span><strong>{image?.name ?? '选择图片水印或电子章'}</strong><small>PNG/JPEG，自动去除纯白底</small></span>
                <input hidden type="file" accept="image/png,image/jpeg" onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) pickImage(file)
                }} />
              </label>
              {image && <Button type="button" onClick={() => setImage(undefined)}>移除图片</Button>}
            </div>
          )}
          {kind==='text' && <div className="watermark-presets" role="group" aria-label="水印预设">{['内部资料','草稿','仅供审阅'].map(preset=><button type="button" key={preset} aria-pressed={text===preset} onClick={()=>setText(preset)}>{preset}</button>)}</div>}
          <div className="watermark-proof" aria-label="水印样式预览"><div style={{color,fontFamily:initial?.fontFamily,fontStyle:initial?.italic?'italic':undefined, opacity: Math.max(0.05, opacityPct/100), transform:`rotate(${rotation}deg)`,fontWeight:bold?700:400}}>{kind==='text'?text||'水印':image?<img src={image.data} alt=""/>:'选择图片'}</div></div>
          <details className="drawer-disclosure"><summary>微调样式　{opacityPct}%　{rotation}°</summary><div className="form-grid form-grid--3">
            <label>不透明度<input type="number" min="5" max="80" value={opacityPct} onChange={(event) => setOpacityPct(Number(event.target.value))} /><small>%</small></label>
            <label>旋转角度<input type="number" min="-180" max="180" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} /><small>度</small></label>
            {kind === 'text' && (!initial ? (
              <label>初始字号<input type="number" min="12" max="120" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /><small>之后可在页面上拉伸</small></label>
            ) : (
              <label>文字颜色<ColorPalette label="水印文字颜色" value={color} onChange={setColor} /></label>
            ))}
          </div>
          {kind === 'text' && !initial && (
            <label>文字颜色<ColorPalette label="水印文字颜色" value={color} onChange={setColor} /></label>
          )}
          {kind === 'text' && <label className="check-row"><input type="checkbox" checked={bold} onChange={(event) => setBold(event.target.checked)} /> 粗体</label>}
          </details>
          <label className="check-row"><input type="checkbox" checked={tiled} onChange={(event) => setTiled(event.target.checked)} /> 平铺到每一页</label>
          <p className="dialog__hint">应用后可在页面上移动。当前版本保存后会合入页面内容。</p>
          <div className="dialog__actions">
            {initial && <Button type="button" onClick={() => { onRemove(); onClose() }}>移除水印</Button>}
            <Button type="button" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" disabled={!valid}>{initial ? '保存修改' : '添加水印'}</Button>
          </div>
        </form>
      </DialogPanel>
    </Dialog>
  )
}
