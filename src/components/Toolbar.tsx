import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Columns2,
  Copy,
  Crop,
  Download,
  FileOutput,
  FilePlus2,
  Files,
  FolderOpen,
  Fullscreen,
  Gauge,
  Hand,
  Highlighter,
  ImagePlus,
  KeyRound,
  List,
  ListChecks,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  MousePointer2,
  MoveHorizontal,
  PenLine,
  Printer,
  PackageMinus,
  RectangleVertical,
  Redo2,
  RotateCw,
  Rows3,
  Save,
  SaveAll,
  Scan,
  ScanText,
  Search,
  Scissors,
  Signature,
  SlidersHorizontal,
  Square,
  SquareStack,
  Stamp,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
} from 'lucide-react'
import type { RenderQuality, Tool, ViewMode } from '../types/pdf'
import { ColorPalette } from './ColorPalette'

type Action = () => void
type Icon = typeof Save
export type ToolbarSelection = (
  | { kind: 'annotations'; onClear: Action }
  | {
      kind: 'pages'
      canAct: boolean
      onSelectAll: Action
      onClearSelection: Action
      onRotate: Action
      onExit: Action
    }
) & {
  count: number
  canPaste: boolean
  onCopy: Action
  onCut: Action
  onPaste: Action
  onRemove: Action
}
interface ToolbarProps {
  viewMode: ViewMode
  tool: Tool
  renderQuality: RenderQuality
  canUndo: boolean
  canRedo: boolean
  disabled: boolean
  zoom: number
  onOpen: Action
  onSave: Action
  onPrepareMarkdown?: Action
  onMarkdown?: Action
  onShareMcp?: Action
  onCompress?: Action
  onSaveAs: Action
  onExport: Action
  workspaceActions?: {inbox?: Action; reverse:Action; clear:Action; export:Action}
  onPrint: Action
  onOcr: Action
  onOcrCurrentPage?: Action
  onSearch: Action
  onViewMode: (mode: ViewMode) => void
  onFitWidth: Action
  onFitPage: Action
  onActualSize: Action
  selection?: ToolbarSelection
  onTool: (tool: Tool) => void
  drawingColor: string
  drawingWidth: number
  drawingFilled: boolean
  onDrawingColor: (color: string) => void
  onDrawingWidth: (width: number) => void
  onDrawingFilled: (filled: boolean) => void
  onRenderQuality: (quality: RenderQuality) => void
  onUndo: Action
  onRedo: Action
  onBlank: Action
  onSignature: Action
  onImage: Action
  onStamp: Action
  onCrop: Action
  multiSelect: boolean
  onMultiSelect: Action
  canSecurePdf: boolean
  activePdfEncrypted: boolean
  onEncryptPdf: Action
  onRemovePdfPassword: Action
  onManagePasswords: Action
  onEditTextOverlay?: Action
  onEditForm?: Action
  onAutoFillForm?: Action
  onOpenBookmarks?: Action
  onWatermark?: Action
  onRemoveWatermark?: Action
  hasWatermark?: boolean
  onVerifyInvoice?: Action
  onMergeInvoices?: Action
  onArchiveInvoices?: Action
  onStitchPages?: Action
  onCreateTableOfContents?: Action
}
interface Command {
  label: string
  icon: Icon
  run?: Action
  children?: Command[]
  checked?: boolean
  active?: boolean
  hint?: string
  panel?: ReactNode
}
type Family = '文件' | '编辑' | '文档' | '阅读'
interface Slot {
  cmd: Command
  rank: number
  family: Family
  caption?: string
  primary?: boolean
}
const cmd = (label: string, icon: Icon, run?: Action, hint?: string): Command => ({
  label,
  icon,
  run,
  hint,
})
const group = (label: string, icon: Icon, children: Command[]): Command => ({ label, icon, children })
const available = (c: Command): boolean => Boolean(c.run || c.panel || c.children?.some(available))
const layouts: [ViewMode, string, Icon][] = [
  ['single', '单页', RectangleVertical],
  ['continuous', '连续滚动', Rows3],
  ['spread', '双页', Columns2],
]
const marksActive = (tool: Tool) =>
  ['draw', 'rectangle', 'ellipse', 'highlight', 'edit-text'].includes(tool)
function face(s: Slot) {
  const Glyph = s.cmd.icon
  return (
    <>
      <Glyph size={16} aria-hidden="true" />
      {s.caption && <span>{s.caption}</span>}
      {(s.cmd.children || s.cmd.panel) && <ChevronDown size={11} aria-hidden="true" />}
    </>
  )
}
function classFor(s: Slot) {
  return `command-key${s.primary ? ' command-key--primary' : ''}${s.family === '阅读' ? ' command-key--reader' : ''}`
}
export function Toolbar(p: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null),
    probes = useRef<HTMLDivElement>(null),
    popup = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(),
    id = useId()
  const [visible, setVisible] = useState<number[]>([]),
    [trail, setTrail] = useState<string[]>([]),
    focusLast = useRef(false)
  const doc = !p.disabled,
    set = (tool: Tool) => () => p.onTool(tool),
    s = p.selection
  const undo = cmd('撤销 Ctrl+Z', Undo2, p.canUndo ? p.onUndo : undefined),
    redo = cmd('重做 Ctrl+Y', Redo2, p.canRedo ? p.onRedo : undefined)
  const watermark = cmd(p.hasWatermark ? '编辑水印' : '添加水印', Stamp, p.onWatermark)
  const compress=cmd('压缩 PDF',PackageMinus,p.onCompress,'压缩源文件并另存副本')
  const markdown=cmd('导出 Markdown…', FileOutput, doc ? p.onMarkdown : undefined, '导出全文、所选文字或高亮区域')
  const file = group('文件操作', Files, [
    cmd('另存为', SaveAll, doc ? p.onSaveAs : undefined),
    cmd('导出与优化', Download, doc ? p.onExport : undefined),
    markdown,
    ...(p.onShareMcp ? [cmd('AI 文档授权', KeyRound, p.onShareMcp)] : []),
    cmd('新建空白页', FilePlus2, p.onBlank),
    ...(p.workspaceActions?.inbox ? [cmd('打印收件箱', Printer, p.workspaceActions.inbox)] : []),
    cmd('批量打印 / 打印设置', Printer, p.onPrint),
  ])
  const inserts = group('插入', ImagePlus, [
    cmd('文本框', Type, set('text'), '直接在页上输入'),
    cmd('插入图片', ImagePlus, p.onImage),
    cmd('备注', MessageSquareText, set('note')),
    cmd('插入签名', Signature, p.onSignature),
    cmd('插入电子章', Stamp, p.onStamp),
  ])
  const draw = group('绘图工具', PenLine, [
    cmd('自由画笔', PenLine, set('draw')),
    cmd('矩形', Square, set('rectangle')),
    cmd('圆形', Circle, set('ellipse')),
    cmd('高亮文字', Highlighter, set('highlight')),
    cmd('编辑文字', Type, p.onEditTextOverlay),
  ])
  const pages = group('页面整理', SquareStack, [
    ...(p.workspaceActions ? [cmd('反转顺序', Rows3, p.workspaceActions.reverse),cmd('合并导出', FileOutput,p.workspaceActions.export),cmd('全部清空',Trash2,p.workspaceActions.clear)] : []),
    cmd('页面多选', ListChecks, p.onMultiSelect),
    cmd('裁剪当前页', Crop, p.onCrop),
    cmd('书签与目录', List, p.onOpenBookmarks),
    cmd('创建目录', ListChecks, p.onCreateTableOfContents),
    cmd('多页拼接', SquareStack, p.onStitchPages),
  ])
  const forms = group('表单', ListChecks, [
    cmd('填写表单', Type, set('fill')),
    cmd('编辑表单', ListChecks, p.onEditForm),
    cmd('自动填表', Highlighter, p.onAutoFillForm),
  ])
  const invoices = group('发票', Files, [
    cmd('发票查验', ScanText, p.onVerifyInvoice),
    cmd('发票合并', Columns2, p.onMergeInvoices),
    cmd('发票归档', FileOutput, p.onArchiveInvoices),
  ])
  const protect = group('文档保护', LockKeyhole, [
    watermark,
    cmd('移除水印', Trash2, p.hasWatermark ? p.onRemoveWatermark : undefined),
    cmd('设置 PDF 密码', LockKeyhole, p.canSecurePdf ? p.onEncryptPdf : undefined),
    cmd('移除密码并另存副本', Unlock, p.activePdfEncrypted ? p.onRemovePdfPassword : undefined),
    cmd('密码历史', KeyRound, p.onManagePasswords),
  ])
  const ocr = group('OCR 文字识别', ScanText, [
    cmd('仅识别当前页', ScanText, p.onOcrCurrentPage),
    cmd('批量 OCR…', Files, p.onOcr),
  ])
  const layout = layouts.find(([v]) => v === p.viewMode)!,
    layoutMenu = group(
      `阅读布局：${layout[1]}`,
      layout[2],
      layouts.map(([v, label, icon]) => ({
        ...cmd(label, icon, () => p.onViewMode(v)),
        checked: v === p.viewMode,
      })),
    )
  const zoom = group(`显示与缩放：${Math.round(p.zoom * 100)}%`, Scan, [
    cmd('整页显示', Fullscreen, p.onFitPage),
    cmd('适合宽度', MoveHorizontal, p.onFitWidth),
    cmd('100% 实际大小', Scan, p.onActualSize, 'Ctrl+0'),
    {
      ...cmd('高清显示', Gauge, () => p.onRenderQuality('sharp')),
      checked: p.renderQuality === 'sharp',
    },
    {
      ...cmd('流畅显示', Gauge, () => p.onRenderQuality('smooth')),
      checked: p.renderQuality === 'smooth',
    },
  ])
  const slots: Slot[] = []
  const add = (family: Family, rank: number, command: Command, caption?: string, primary = false) =>
    slots.push({ cmd: command, family, rank, caption, primary })
  add('文件', 0, cmd('打开', FolderOpen, p.onOpen), '打开', true)
  if (doc) add('文件', 1, cmd('保存', Save, p.onSave), '保存')
  add('文件',2,compress,'压缩 PDF')
  if (doc) add('文件',2,markdown,'Markdown')
  add('文件', 8, file, '文件')
  if (!doc) add('文件', 2, cmd('批量打印 / 打印设置', Printer, p.onPrint), '打印')
  if (doc) {
    add('编辑', 12, undo)
    add('编辑', 16, redo)
    add('编辑', 15, cmd('手型工具 (H)：拖动页面浏览', Hand, set('hand')))
    add('编辑', 18, cmd('选择工具 (V)', MousePointer2, set('pan')))
    add('编辑', 10, cmd('文本框：单击放置或拖出输入区域', Type, set('text')))
    add('编辑', 3, inserts, '插入')
    add('编辑', 9, draw, '绘图')
    add('文档', 7, pages, '页面')
    add('文档', 11, watermark)
    add('文档', 14, ocr, 'OCR')
    add('文档', 19, group('专项工具', Files, [forms, invoices]), '专项')
    add('文档', 17, protect, '保护')
    if (s) {
      const enabled = s.count > 0
      const items = [
        ...(s.kind === 'pages'
          ? [
              cmd('全选本组页面', ListChecks, s.onSelectAll),
              cmd('清除选择', X, s.onClearSelection),
              cmd('批量旋转 90 度', RotateCw, s.canAct ? s.onRotate : undefined),
            ]
          : []),
        cmd('复制', Copy, enabled ? s.onCopy : undefined),
        cmd('剪切', Scissors, enabled ? s.onCut : undefined),
        cmd('粘贴', ClipboardPaste, s.canPaste ? s.onPaste : undefined),
        cmd('删除所选', Trash2, enabled ? s.onRemove : undefined),
        cmd('退出选择', X, s.kind === 'pages' ? s.onExit : s.onClear),
      ]
      const label = `已选 ${s.count} ${s.kind === 'pages' ? '页' : '个元素'}`
      add('编辑', 2, group(label, ListChecks, items), label)
    }
    if (['draw', 'rectangle', 'ellipse'].includes(p.tool)) {
      add(
        '编辑',
        2,
        {
          label: '绘图样式',
          icon: SlidersHorizontal,
          panel: (
            <div className="ribbon-pen">
              <label>
                笔色
                <ColorPalette label="绘图颜色" value={p.drawingColor} onChange={p.onDrawingColor} />
              </label>
              <label>
                粗细
                <input
                  type="range"
                  min="1"
                  max="24"
                  value={p.drawingWidth}
                  aria-label="画笔和边框粗细"
                  onChange={(e) => p.onDrawingWidth(+e.target.value)}
                />
                <output>{p.drawingWidth} px</output>
              </label>
              {p.tool !== 'draw' && (
                <label>
                  <input
                    type="checkbox"
                    checked={p.drawingFilled}
                    onChange={(e) => p.onDrawingFilled(e.target.checked)}
                  />
                  实心
                </label>
              )}
            </div>
          ),
        },
        '笔样',
      )
      add('编辑', 2, cmd('完成绘制', Check, set('pan'), 'Esc'), '完成')
    } else if (p.tool === 'text' || p.tool === 'note')
      add('编辑', 2, cmd('取消放置', X, set('pan'), 'Esc'), '取消放置')
    add('阅读', 6, cmd('搜索 Ctrl+F', Search, p.onSearch))
    add('阅读', 4, layoutMenu, layout[1])
    add('阅读', 5, zoom, `${Math.round(p.zoom * 100)}%`)
  }
  const currentTools: Record<string, Tool> = {
    '手型工具 (H)：拖动页面浏览': 'hand',
    '选择工具 (V)': 'pan',
    '文本框：单击放置或拖出输入区域': 'text',
    备注: 'note',
    自由画笔: 'draw',
    矩形: 'rectangle',
    圆形: 'ellipse',
    高亮文字: 'highlight',
    编辑文字: 'edit-text',
    填写表单: 'fill',
  }
  for (const slot of slots) {
    for (const c of [slot.cmd, ...(slot.cmd.children ?? [])])
      if (currentTools[c.label]) c.active = currentTools[c.label] === p.tool
    if (slot.cmd === draw) slot.cmd.active = marksActive(p.tool)
  }
  const more: Slot = {
    family: '文件',
    rank: 0,
    caption: '更多',
    cmd: group('更多工具', MoreHorizontal, []),
  }
  // Measure the real type, icons, zoom percentage and user font scale. Probes
  // are noninteractive spans (never duplicated buttons or focus targets).
  const signature = JSON.stringify(slots.map((v) => [v.cmd.label, v.caption, v.rank]))
  useLayoutEffect(() => {
    const root = ref.current,
      strip = probes.current
    if (!root || !strip) return
    const measure = () => {
      const css = getComputedStyle(root),
        gap = parseFloat(css.columnGap) || 0,
        room = root.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
      const widths = Array.from(strip.children, (c) => c.getBoundingClientRect().width + 0.5),
        moreWidth = widths.pop() ?? 54
      const all = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * gap
      let remaining = room - (all > room ? moreWidth + gap : 0)
      const chosen: number[] = []
      for (const i of slots.map((_, i) => i).sort((a, b) => slots[a].rank - slots[b].rank)) {
        const w = widths[i] + (chosen.length ? gap : 0)
        if (w <= remaining) {
          remaining -= w
          chosen.push(i)
        }
      }
      chosen.sort((a, b) => a - b)
      setVisible((prev) => (prev.join(',') === chosen.join(',') ? prev : chosen))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    for (const el of strip.children) ro.observe(el)
    return () => ro.disconnect()
  }, [signature])
  const hidden = slots.filter((_, i) => !visible.includes(i))
  const sectionIcon = { 文件: Files, 编辑: PenLine, 文档: SquareStack, 阅读: RectangleVertical }
  more.cmd.children = (Object.keys(sectionIcon) as Family[]).flatMap((f) => {
    const list = hidden.filter((s) => s.family === f).map((s) => s.cmd)
    return list.length > 2 ? [group(`${f}操作`, sectionIcon[f], list)] : list
  })
  const shown = slots.filter((_, i) => visible.includes(i))
  if (hidden.length) shown.push(more)
  let current = shown.find((s) => s.cmd.label === trail[0])?.cmd
  for (const k of trail.slice(1)) current = current?.children?.find((c) => c.label === k)
  const close = (restore = true) => {
    setTrail([])
    if (restore)
      (trigger.current?.isConnected
        ? trigger.current
        : ref.current?.querySelector<HTMLButtonElement>('[aria-label="更多工具"]')
      )?.focus({ preventScroll: true })
  }
  const enter = (c: Command) => {
    if (c.children || c.panel) {
      focusLast.current = false
      setTrail((t) => [...t, c.label])
    } else {
      close()
      c.run?.()
    }
  }
  const open = (button: HTMLButtonElement, s: Slot, last = false) => {
    if (!s.cmd.children && !s.cmd.panel) {
      s.cmd.run?.()
      return
    }
    trigger.current = button
    focusLast.current = last
    setTrail((t) => (t.length && t[0] === s.cmd.label ? [] : [s.cmd.label]))
  }
  const name = current?.label
  useLayoutEffect(() => {
    if (!trail.length) return
    if (!name) {
      close()
      return
    }
    const el = popup.current,
      options = el?.querySelectorAll<HTMLElement>('[data-choice]:enabled,input:enabled')
    if (options?.length)
      (focusLast.current
        ? options[options.length - 1]
        : (el?.querySelector<HTMLElement>('[aria-checked=true]') ?? options[0])
      ).focus({ preventScroll: true })
  }, [trail, name])
  useEffect(() => {
    if (!trail.length) return
    const outside = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.color-palette-popover,.eyedrop-hint')) return
      if (
        e.target instanceof Node &&
        !popup.current?.contains(e.target) &&
        !trigger.current?.contains(e.target)
      )
        close(false)
    }
    const resized = () => close()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', resized)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', resized)
    }
  }, [!!trail.length])
  const rect = trail.length ? trigger.current?.getBoundingClientRect() : undefined
  return (
    <>
      <div aria-hidden="true" className="ribbon-width-probes" ref={probes}>
        {[...slots, more].map((s) => (
          <span key={s.cmd.label} className={classFor(s)}>
            {face(s)}
          </span>
        ))}
      </div>
      <div
        className="toolbar command-ribbon command-ribbon--single"
        role="toolbar"
        aria-label="PDF 编辑工具栏"
        onPointerDownCapture={p.onPrepareMarkdown}
        ref={ref}
        onKeyDown={(e) => {
          if (
            e.target instanceof HTMLButtonElement &&
            e.currentTarget.contains(e.target) &&
            ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)
          ) {
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')],
              i = items.indexOf(e.target)
            e.preventDefault()
            e.stopPropagation()
            items[
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? items.length - 1
                  : (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
            ]?.focus()
          }
        }}
      >
        {shown.map((s) => (
          <button
            key={s.cmd.label}
            type="button"
            className={classFor(s)}
            data-family={s.family}
            data-active={s.cmd.active || undefined}
            aria-pressed={s.cmd.children ? undefined : s.cmd.active}
            aria-label={s.cmd.label}
            title={s.cmd.hint ?? s.cmd.label}
            disabled={!available(s.cmd)}
            aria-haspopup={s.cmd.children ? 'menu' : s.cmd.panel ? 'dialog' : undefined}
            aria-expanded={s.cmd.children || s.cmd.panel ? trail[0] === s.cmd.label : undefined}
            aria-controls={trail[0] === s.cmd.label ? id : undefined}
            onClick={(e) => open(e.currentTarget, s)}
            onKeyDown={(e) => {
              if ((s.cmd.panel || s.cmd.children) && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
                e.preventDefault()
                e.stopPropagation()
                open(e.currentTarget, s, e.key === 'ArrowUp')
              }
            }}
          >
            {face(s)}
          </button>
        ))}
      </div>
      {current &&
        rect &&
        createPortal(
          <div
            ref={popup}
            id={id}
            className="toolbar-popover-menu ribbon-menu"
            role={current.panel ? 'dialog' : 'menu'}
            aria-label={trail[trail.length - 1].split('：')[0]}
            style={{
              left: Math.max(5, Math.min(rect.left, innerWidth - 263)),
              ...(rect.top > innerHeight - rect.bottom && innerHeight - rect.bottom < 200
                ? { bottom: innerHeight - rect.top + 4, maxHeight: rect.top - 8 }
                : { top: rect.bottom + 4, maxHeight: Math.max(40, innerHeight - rect.bottom - 9) }),
            }}
            onKeyDown={(e) => {
              if (!(e.target instanceof HTMLElement) || !e.currentTarget.contains(e.target)) return
              if (e.key === 'Escape' || e.key === 'Tab') {
                if (e.key === 'Tab' && current.panel) {
                  const controls = [
                    ...e.currentTarget.querySelectorAll<HTMLElement>(
                      'button:enabled,input:enabled:not([tabindex="-1"])',
                    ),
                  ]
                  if (e.target !== (e.shiftKey ? controls[0] : controls.at(-1))) return
                }
                if (e.key === 'Escape') e.preventDefault()
                e.stopPropagation()
                close()
                return
              }
              if (e.target instanceof HTMLInputElement) return
              if (e.key === 'ArrowLeft' && trail.length > 1) {
                e.preventDefault()
                e.stopPropagation()
                setTrail((t) => t.slice(0, -1))
                return
              }
              const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')],
                i = items.indexOf(document.activeElement as HTMLButtonElement)
              if (e.key === 'ArrowRight' && items[i]?.getAttribute('aria-haspopup')) {
                e.preventDefault()
                e.stopPropagation()
                items[i].click()
                return
              }
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                e.stopPropagation()
                items[
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
                ]?.focus()
              }
            }}
          >
            {trail.length > 1 && (
              <button
                className="command-menu-back"
                type="button"
                role="menuitem"
                onClick={() => setTrail((t) => t.slice(0, -1))}
              >
                <ArrowLeft size={14} />
                返回 · {current.label}
              </button>
            )}
            {current.panel ??
              current.children?.map((c) => (
                <button
                  data-choice
                  key={c.label}
                  type="button"
                  role={c.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={c.checked}
                  data-active={c.active || c.checked || undefined}
                  aria-label={c.label}
                  aria-haspopup={c.children ? 'menu' : c.panel ? 'dialog' : undefined}
                  disabled={!available(c)}
                  onClick={() => enter(c)}
                >
                  <span>
                    <c.icon size={15} />
                  </span>
                  <span>
                    <strong>
                      {c.label}
                      {c.checked ? (
                        <Check size={13} />
                      ) : c.children || c.panel ? (
                        <ChevronRight size={13} />
                      ) : null}
                    </strong>
                    {c.hint && <small>{c.hint}</small>}
                  </span>
                </button>
              ))}
          </div>,
          document.body,
        )}
    </>
  )
}
