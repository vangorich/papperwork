import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS as DndCss } from '@dnd-kit/utilities'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bookmark,
  BookmarkPlus,
  BookOpen,
  Check,
  Columns2,
  ClipboardPaste,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileImage,
  FileOutput,
  FileText,
  FolderOpen,
  FolderX,
  GripVertical,
  Hash,
  Hand,
  Info,
  Layers3,
  MapPin,
  Maximize2,
  MessageSquareText,
  MoreHorizontal,
  MousePointer2,
  PackageMinus,
  PanelLeftClose,
  Pencil,
  Plus,
  Replace,
  RotateCw,
  RotateCcw,
  ScanText,
  Scissors,
  ShieldCheck,
  Trash2,
  UserRound,
  Wrench,
  X,
} from 'lucide-react'
import type { OutlineNode, PdfSource, WorkspacePage } from '../types/pdf'
import { normalizeSourceDisplayName, readOutline, sourceLabel } from '../lib/pdf'
import { PdfPage } from './PdfPage'
import { ThumbnailWindow } from './ThumbnailWindow'
import { ToolButton } from './ui'

interface SidebarProps {
  onClose: () => void
  pages: WorkspacePage[]
  /** Merge/collector views navigate the complete workspace, not just the active document. */
  showAllPages?: boolean
  sources: PdfSource[]
  activeId?: string
  selectedIds: Set<string>
  multiSelect: boolean
  onSelect: (id: string, additive: boolean, range: boolean) => void
  onReorder: (active: string, over: string) => void
  onReorderSources: (activeSourceId: string, overSourceId: string) => void
  onRenameSource: (sourceId: string, name: string) => void
  onCompressSource: (sourceId: string) => void
  splitSourceIds?: Set<string>
  onToggleSplitSource?: (sourceId: string) => void
  onClearSplitSources?: () => void
  onRotate: (id: string) => void
  onRotateLeft?: (id: string) => void
  onDelete: (id: string) => void
  onReplace: (id: string, file: File) => void
  onRemoveSource: (sourceId: string) => void
  onCloseAllSources?: () => void
  onImport: () => void
  canPaste: boolean
  /** Number of pages waiting on the internal clipboard (drives the paste hint). */
  pasteCount?: number
  onCopy: () => void
  onCut: () => void
  onPaste: (pageId: string) => void
  onInsertExternal: (pageId: string, position: 'before' | 'after') => void
  onReplaceExternal: (pageId: string) => void
  onExportSelected: () => void
  onSplitDocument?: (pageId: string) => void
  onUseHandTool?: (pageId: string) => void
  onUseSelectTool?: (pageId: string) => void
  onExportPage?: (pageId: string) => void
  onExportPageImage?: (pageId: string) => void
  onInsertNote?: (pageId: string) => void
  onPageProperties?: (pageId: string) => void
  onResizePage?: (pageId: string) => void
  onAddBookmark?: (pageId: string) => void
  onOcrPage?: (pageId: string) => void
  onAddSourceToWorkspace?: (sourceId: string) => void
  onAddPagesToWorkspace?: (pageId: string) => void
  userBookmarks?: { id: string; title: string; pageId: string }[]
  onBookmarkJump?: (pageId: string) => void
  onRemoveBookmark?: (id: string) => void
  onOutlineJump: (sourceId: string, sourcePage: number) => void
  /** Only supplied for a single-page view. Keep keyboard focus on the outline. */
  onStepOutlinePage?: (direction: -1 | 1) => void
}

const pageGroupId = (page: WorkspacePage) => page.groupId ?? page.sourceId

function SourceHeader({
  source,
  pageCount,
  expanded,
  current,
  onOpen,
  onInfo,
  onCompress,
  onAddToWorkspace,
  splitSelected,
  splitDisabled,
  onToggleSplit,
  onRename,
  onRemove,
  onCloseAll,
}: {
  source: PdfSource
  pageCount: number
  expanded: boolean
  current: boolean
  onOpen: () => void
  onInfo: () => void
  onCompress: () => void
  onAddToWorkspace?: () => void
  splitSelected?: boolean
  splitDisabled?: boolean
  onToggleSplit?: () => void
  onRename: (name: string) => void
  onRemove: () => void
  onCloseAll?: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [actionsMenu, setActionsMenu] = useState<{ x: number; y: number; trigger: HTMLButtonElement }>()
  const renameInputRef = useRef<HTMLInputElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const cancelRenameRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const label = sourceLabel(source)
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: `source:${source.id}` })

  const beginRename = () => {
    cancelRenameRef.current = false
    restoreFocusRef.current = false
    setRenameError('')
    setDraftName(label)
    setRenaming(true)
    window.setTimeout(() => {
      const input = renameInputRef.current
      if (!input) return
      input.focus()
      const extensionAt = input.value.lastIndexOf('.')
      input.setSelectionRange(0, extensionAt > 0 ? extensionAt : input.value.length)
    }, 0)
  }

  const finishRename = () => {
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = false
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      setRenaming(false)
      if (restoreFocus) window.setTimeout(() => openButtonRef.current?.focus(), 0)
      return
    }
    const next = normalizeSourceDisplayName(draftName)
    if (!next) {
      setRenameError('名称不能为空')
      return
    }
    onRename(next)
    setRenaming(false)
    if (restoreFocus) window.setTimeout(() => openButtonRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!actionsMenu) return
    const close = () => setActionsMenu(undefined)
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const trigger = actionsMenu.trigger
      close()
      requestAnimationFrame(() => trigger.focus())
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [actionsMenu])

  return (
    <div
      ref={setNodeRef}
      className="source-accordion__header"
      style={{ transform: DndCss.Transform.toString(transform), transition }}
      data-expanded={expanded || undefined}
      data-current={current || undefined}
      data-drag-over={isOver || undefined}
      data-dragging={isDragging || undefined}
      onContextMenu={(event) => {
        // Right-click shows the same actions menu as the “…” button.
        event.preventDefault()
        const trigger = openButtonRef.current
        if (renaming || !trigger) return
        setActionsMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)),
          trigger,
        })
      }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="tool-button"
        aria-label={`拖拽调整文件顺序：${label}`}
        title={`拖拽调整文件顺序：${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      {renaming ? (
        <label className="source-accordion__rename">
          <FileText size={13} aria-hidden="true" />
          <span className="sr-only">文件显示名称</span>
          <input
            ref={renameInputRef}
            value={draftName}
            maxLength={128}
            aria-label={`重命名 ${label}`}
            aria-invalid={Boolean(renameError)}
            aria-describedby={renameError ? `rename-error-${source.id}` : undefined}
            onChange={(event) => {
              setDraftName(event.target.value)
              if (renameError) setRenameError('')
            }}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (!normalizeSourceDisplayName(draftName)) {
                  setRenameError('名称不能为空')
                  return
                }
                restoreFocusRef.current = true
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRenameRef.current = true
                restoreFocusRef.current = true
                event.currentTarget.blur()
              }
            }}
          />
          {renameError
            ? <small id={`rename-error-${source.id}`} className="source-accordion__rename-error" role="alert">{renameError}</small>
            : <small>{pageCount} 页</small>}
        </label>
      ) : (
        <button
          ref={openButtonRef}
          className="source-accordion__open"
          aria-expanded={expanded}
          aria-controls={expanded ? `source-pages-${source.id}` : undefined}
          aria-label={`${expanded ? '折叠' : '展开并查看'}：${label}`}
          title="按 F2 或使用铅笔按钮重命名显示名称"
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              beginRename()
            }
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FileText size={13} />
          <span title={label}>{label}</span>
          <small>{pageCount} 页</small>
        </button>
      )}
      {!renaming && (
        <>
          {onToggleSplit && (
            <button
              type="button"
              className="tool-button source-split-check"
              data-active={splitSelected || undefined}
              aria-pressed={Boolean(splitSelected)}
              aria-label={`${splitSelected ? '取消' : '加入'}分屏浏览：${label}`}
              title={splitDisabled ? '最多同时分屏 4 个 PDF' : splitSelected ? '从分屏中移除' : '加入分屏浏览'}
              disabled={splitDisabled}
              onClick={(event) => { event.stopPropagation(); onToggleSplit() }}
            >
              {splitSelected ? <Check size={13} /> : <Columns2 size={13} />}
            </button>
          )}
          <ToolButton
            label={`更多文件操作：${label}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(actionsMenu)}
            data-source-action="more"
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setActionsMenu({
                x: Math.max(8, Math.min(rect.right - 248, window.innerWidth - 256)),
                y: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 250)),
                trigger: event.currentTarget,
              })
            }}
          >
            <MoreHorizontal size={14} />
          </ToolButton>
        </>
      )}
      {actionsMenu && createPortal(
        <div
          className="page-context-menu source-actions-menu"
          role="menu"
          aria-label={`文件操作：${label}`}
          style={{
            left: actionsMenu.x,
            top: actionsMenu.y,
            maxHeight: Math.max(120, window.innerHeight - actionsMenu.y - 8),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button autoFocus role="menuitem" onClick={() => { setActionsMenu(undefined); beginRename() }}><Pencil size={14} /><span>重命名显示名称</span></button>
          <button role="menuitem" disabled={!onAddToWorkspace} onClick={() => { setActionsMenu(undefined); onAddToWorkspace?.() }}><Layers3 size={14} /><span>整个文件加入工作区</span></button>
          <button role="menuitem" onClick={() => { setActionsMenu(undefined); onCompress() }}><PackageMinus size={14} /><span>压缩原文件并另存为</span></button>
          <button role="menuitem" onClick={() => { setActionsMenu(undefined); onInfo() }}><Info size={14} /><span>查看文件信息</span></button>
          <span className="page-context-menu__line" />
          <button role="menuitem" className="danger" onClick={() => { setActionsMenu(undefined); onRemove() }}><X size={14} /><span>关闭此来源</span></button>
          <button role="menuitem" className="danger" disabled={!onCloseAll} onClick={() => { setActionsMenu(undefined); onCloseAll?.() }}><FolderX size={14} /><span>关闭所有文件</span></button>
        </div>,
        document.body,
      )}
    </div>
  )
}

const formatBytes = (bytes?: number) => {
  if (!Number.isFinite(bytes) || bytes === undefined || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: value >= 10 ? 1 : 2 })} ${units[unit]}`
}

const formatDate = (value?: string) => {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function PropertyRow({ label, value, mono = false }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="file-info__property" data-mono={mono || undefined}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

export function FileInfoDialog({ source, onClose }: { source: PdfSource; onClose: () => void }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'copy-failed' | 'located' | 'missing'>('idle')
  const copyTimer = useRef<number>()
  const info = source.documentInfo
  const file = source.fileInfo
  const location = source.originalPath ?? source.path
  const extension = file?.extension || source.name.match(/\.[^.]+$/)?.[0]?.slice(1).toUpperCase()
  const type = extension ? `${extension.toUpperCase()} 文件` : 'PDF 文档'
  const properties = [
    ['标题', info?.title],
    ['作者', info?.author],
    ['主题', info?.subject],
    ['关键词', info?.keywords],
    ['语言', info?.language],
  ] as const
  const production = [
    ['创建工具', info?.creator],
    ['生成程序', info?.producer],
    ['文档创建日期', formatDate(info?.createdAt)],
    ['文档修改日期', formatDate(info?.modifiedAt)],
  ] as const
  const details = [
    ['文件创建日期', formatDate(file?.createdAt)],
    ['文件修改日期', formatDate(file?.modifiedAt)],
    ['最近访问日期', formatDate(file?.accessedAt)],
  ] as const
  const capabilityLabels = [
    info && (info.encrypted ? '已加密' : '未加密'),
    info?.linearized === true ? '已线性化' : info?.linearized === false ? '未线性化' : undefined,
    info?.hasForms === true ? '包含表单' : info?.hasForms === false ? '无表单' : undefined,
    file?.ofdSignature ? 'OFD 原件含数字签名，未验签；当前显示 PDF 阅览副本' : info?.hasSignatures === true ? '包含签名' : info?.hasSignatures === false ? '无签名' : undefined,
  ].filter((item): item is string => Boolean(item))

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    }
  }, [onClose])

  const copyLocation = async () => {
    if (!location) return
    try {
      await navigator.clipboard.writeText(location)
      setFeedback('copied')
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setFeedback('idle'), 1800)
    } catch {
      setFeedback('copy-failed')
    }
  }

  const revealLocation = async () => {
    if (!location || !window.desktop?.showItemInFolder) return
    try {
      const located = await window.desktop.showItemInFolder(location)
      setFeedback(located ? 'located' : 'missing')
    } catch {
      setFeedback('missing')
    }
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setFeedback('idle'), 2400)
  }

  return createPortal(
    <div
      className="file-info"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="file-info__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-info-title"
        aria-describedby="file-info-description"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className="file-info__header">
          <div className="file-info__identity">
            <span className="file-info__document-icon" aria-hidden="true"><FileText size={21} /></span>
            <div>
              <span className="file-info__eyebrow">文件属性</span>
              <h2 id="file-info-title" title={sourceLabel(source)}>{sourceLabel(source)}</h2>
              <p id="file-info-description">{source.displayName ? `原始文件名：${source.name}` : '来源文件与 PDF 文档元数据'}</p>
            </div>
          </div>
          <ToolButton label="关闭文件信息" autoFocus onClick={onClose}>
            <X size={16} />
          </ToolButton>
        </header>

        <div className="file-info__summary" aria-label="文件摘要">
          <div><span>类型</span><strong>{type}</strong></div>
          <div><span>大小</span><strong>{formatBytes(file?.size ?? source.bytes.byteLength)}</strong></div>
          <div><span>页数</span><strong>{source.pageCount.toLocaleString('zh-CN')}</strong></div>
          <div><span>PDF 版本</span><strong>{info?.pdfVersion || '未知'}</strong></div>
        </div>

        <div className="file-info__scroll">
          <section className="file-info__section file-info__section--location" aria-labelledby="file-location-heading">
            <div className="file-info__section-title">
              <MapPin size={14} />
              <h3 id="file-location-heading">文件位置</h3>
            </div>
            <div className="file-info__path-row">
              <code>{location || '此文件来自内存、拖放或虚拟打印任务，没有可访问的本地路径。'}</code>
              <button
                type="button"
                className="file-info__copy"
                disabled={!location}
                onClick={() => void copyLocation()}
                aria-label="复制文件路径"
                title="复制文件路径"
              >
                {feedback === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <div className="file-info__location-actions">
              <button
                type="button"
                className="button"
                disabled={!location || !window.desktop?.showItemInFolder}
                title={location ? '在资源管理器中定位此文件' : '此来源没有本地文件路径'}
                onClick={() => void revealLocation()}
              >
                <FolderOpen size={14} /> 在资源管理器中显示 <ExternalLink size={12} />
              </button>
              {!location && <small>保存到本地后即可定位文件</small>}
              <span className="file-info__copy-status" role="status" aria-live="polite">
                {feedback === 'copied' && '路径已复制'}
                {feedback === 'copy-failed' && '无法复制路径'}
                {feedback === 'located' && '已在资源管理器中定位'}
                {feedback === 'missing' && '文件已移动或不存在'}
              </span>
            </div>
          </section>

          <div className="file-info__section-grid">
            {details.some(([, value]) => value) && (
              <section className="file-info__section" aria-labelledby="file-dates-heading">
                <div className="file-info__section-title"><CalendarDays size={14} /><h3 id="file-dates-heading">文件时间</h3></div>
                <dl>{details.map(([label, value]) => <PropertyRow key={label} label={label} value={value} />)}</dl>
              </section>
            )}
            {properties.some(([, value]) => value) && (
              <section className="file-info__section" aria-labelledby="document-properties-heading">
                <div className="file-info__section-title"><UserRound size={14} /><h3 id="document-properties-heading">文档属性</h3></div>
                <dl>{properties.map(([label, value]) => <PropertyRow key={label} label={label} value={value} />)}</dl>
              </section>
            )}
            {production.some(([, value]) => value) && (
              <section className="file-info__section" aria-labelledby="document-production-heading">
                <div className="file-info__section-title"><Wrench size={14} /><h3 id="document-production-heading">生成信息</h3></div>
                <dl>{production.map(([label, value]) => <PropertyRow key={label} label={label} value={value} />)}</dl>
              </section>
            )}
            {capabilityLabels.length > 0 && (
              <section className="file-info__section" aria-labelledby="document-features-heading">
                <div className="file-info__section-title"><ShieldCheck size={14} /><h3 id="document-features-heading">文档特性</h3></div>
                <div className="file-info__badges">{capabilityLabels.map((label) => <span key={label}>{label}</span>)}</div>
              </section>
            )}
          </div>

          {(info?.fingerprint || info?.modifiedFingerprint) && (
            <section className="file-info__section" aria-labelledby="document-id-heading">
              <div className="file-info__section-title"><Hash size={14} /><h3 id="document-id-heading">文档标识</h3></div>
              <dl>
                <PropertyRow label="原始指纹" value={info?.fingerprint} mono />
                <PropertyRow label="修改后指纹" value={info?.modifiedFingerprint} mono />
              </dl>
            </section>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}

const SortableThumbnail = memo(function SortableThumbnail({
  page,
  source,
  index,
  selected,
  active,
  multiSelect,
  onSelect,
  onNavigate,
  keyboardMove, moveTarget, insertion, showSource, menuOpen, onMore,
  onRotate,
  onReplace,
  onContextMenu,
}: {
  page: WorkspacePage
  source?: PdfSource
  index: number
  selected: boolean
  active: boolean
  multiSelect: boolean
  onSelect: (pageId: string, additive: boolean, range: boolean) => void
  /** ArrowUp/ArrowDown on a focused (clicked) thumbnail jumps prev/next page. */
  onNavigate: (pageId: string, delta: number) => void
  keyboardMove?: (id: string, event: React.KeyboardEvent<HTMLButtonElement>) => void
  insertion?: 'before' | 'after'
  showSource: boolean
  menuOpen: boolean
  onMore:(pageId:string,trigger:HTMLElement,quick:boolean)=>void
  moveTarget?: boolean
  onRotate: (pageId: string) => void
  onReplace: (pageId: string, file: File) => void
  onContextMenu: (pageId: string, event: React.MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id })
  const label = source ? sourceLabel(source) : '空白页'

  return (
    <article
      ref={setNodeRef}
      className="thumbnail thumbnail--folio"
      data-page-id={page.id}
      data-insertion={insertion}
      data-move-target={moveTarget || undefined}
      data-selected={selected || undefined}
      data-active={active || undefined}
      data-dragging={isDragging || undefined}
      style={{ transform: DndCss.Transform.toString(transform), transition }}
      onClick={(event) => onSelect(page.id, multiSelect || event.ctrlKey || event.metaKey, event.shiftKey)}
      onContextMenu={(event) => onContextMenu(page.id, event)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) onReplace(page.id, file)
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        // Nested buttons own Space/Enter, including finishing a keyboard drag.
        if (event.target !== event.currentTarget || event.defaultPrevented) return
        if(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)){event.preventDefault();event.stopPropagation();onMore(page.id,event.currentTarget,false);return}
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(page.id, multiSelect || event.ctrlKey || event.metaKey, event.shiftKey)
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          event.preventDefault()
          onNavigate(page.id, event.key === 'ArrowUp' ? -1 : 1)
        }
      }}
      aria-label={`第 ${index + 1} 页，来源 ${label}`}
    >
      <div className="thumbnail__body"><div className="thumbnail__paper">
        <PdfPage item={page} source={source} zoom={0.2} textLayer={false} compact interactive={false} />
      </div></div>
      <div className="thumb-strip">
        <button type="button" {...attributes} {...listeners} className="thumb-strip__grip" aria-label="拖动排序" title={`移动第 ${index+1} 页 · 空格开始，上下键调整`} onKeyDown={event=>keyboardMove?keyboardMove(page.id,event):listeners?.onKeyDown?.(event)}><GripVertical size={12}/><span>{index+1}</span></button>
        {multiSelect && <span className="thumbnail__check" data-checked={selected||undefined} aria-hidden="true">{selected&&<Check size={11}/>}</span>}
        <span className="thumb-strip__source" title={label}>{showSource?label:''}</span>
        {page.rotation!==0&&<small className="thumb-strip__degrees">{page.rotation}°</small>}
        <button type="button" className="thumb-strip__button" title="顺时针旋转 90 度" aria-label="顺时针旋转 90 度" onClick={event=>{event.stopPropagation();onRotate(page.id)}}><RotateCw size={14}/></button>
        <button type="button" className="thumb-strip__button" aria-label={`第 ${index+1} 页更多操作`} title="更多页面操作" aria-haspopup="menu" aria-expanded={menuOpen} onClick={event=>{event.stopPropagation();onMore(page.id,event.currentTarget,true)}} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();onMore(page.id,event.currentTarget,true)}}}><MoreHorizontal size={16}/></button>
      </div>
    </article>
  )
})

function ThumbnailDragPreview({ source, index }: { source?: PdfSource; index: number }) {
  const label = source ? sourceLabel(source) : '空白页'
  return (
    <div className="thumbnail-drag-preview thumbnail-drag-preview--page" aria-hidden="true">
      <div className="thumbnail-drag-preview__paper"><span>{index + 1}</span></div>
      <div className="thumbnail-drag-preview__copy">
        <span><GripVertical size={13} /> 正在移动</span>
        <strong>第 {index + 1} 页</strong>
        <small title={label}>{label}</small>
      </div>
    </div>
  )
}

function SourceDragPreview({ source, pageCount }: { source: PdfSource; pageCount: number }) {
  return (
    <div className="thumbnail-drag-preview thumbnail-drag-preview--source" aria-hidden="true">
      <span><GripVertical size={13} /> 来源文件</span>
      <strong title={sourceLabel(source)}>{sourceLabel(source)}</strong>
      <small>{pageCount} 页</small>
    </div>
  )
}

// Resolve a section once for the whole tree, including pages between bookmarks.
function currentChapter(nodes: OutlineNode[], page?: number) {
  let match: OutlineNode | undefined
  const walk = (list: OutlineNode[]) => { for (const n of list) {
    if (page != null && n.pageIndex != null && n.pageIndex <= page && n.pageIndex >= (match?.pageIndex ?? -1)) match = n
    if (n.children.length) walk(n.children)
  }}
  walk(nodes); return match
}
function OutlineBranch({nodes, sourceId, current, onJump, positions}: {
  nodes: OutlineNode[]; sourceId: string; current?: OutlineNode; onJump: (id: string, page: number) => void; positions: Map<number,number>
}) {
  return <ul className="outline-tree">{nodes.map((n,i) => <li key={`${i}:${n.title}`}>
    <button data-outline-step aria-current={n===current ? 'location' : undefined} disabled={n.pageIndex==null || !positions.has(n.pageIndex)} onClick={()=>n.pageIndex!=null && onJump(sourceId,n.pageIndex)}>
      <span className="outline-title">{n.title || '未命名章节'}</span><span className="outline-number">{n.pageIndex!=null ? positions.get(n.pageIndex) : ''}</span>
    </button>{n.children.length>0 && <OutlineBranch nodes={n.children} sourceId={sourceId} current={current} onJump={onJump} positions={positions}/>}
  </li>)}</ul>
}

export function Sidebar(props: SidebarProps) {
  const [tab, setTab] = useState<'pages' | 'outline'>('pages')
  const [outlines, setOutlines] = useState<Record<string, OutlineNode[]>>({})
  const [expandedSourceId, setExpandedSourceId] = useState<string>()
  const [activeDragId, setActiveDragId] = useState<string>()
  const [contextMenu, setContextMenu] = useState<{ x:number; y:number; pageId:string; quick?:boolean; origin?:HTMLElement }>()
  const pageMenuRef=useRef<HTMLDivElement>(null)
  const [infoSourceId, setInfoSourceId] = useState<string>()
  const hoverTimer = useRef<number>()
  const pendingSource = useRef<string>()
  const thumbList = useRef<HTMLDivElement>(null)
  const shownPages = useRef(props.pages)

  const groupIds = useMemo(() => new Set(props.pages.map(pageGroupId)), [props.pages])
  const activeSources = useMemo(
    () => props.sources.filter((source) => groupIds.has(source.id)),
    [groupIds, props.sources],
  )
  const contentSources = useMemo(
    () => props.sources.filter((source) => props.pages.some((page) => page.sourceId === source.id)),
    [props.pages, props.sources],
  )
  // O(1) lookups: the thumbnail loop previously did pages.indexOf /
  // sources.find / pages.filter per row — O(n²) per sidebar render.
  const sourceById = useMemo(() => new Map(props.sources.map((source) => [source.id, source])), [props.sources])
  const pagesByGroupId = useMemo(() => {
    const map = new Map<string, WorkspacePage[]>()
    for (const page of props.pages) {
      const group = pageGroupId(page)
      const list = map.get(group)
      if (list) list.push(page)
      else map.set(group, [page])
    }
    return map
  }, [props.pages])
  // Stable per-thumbnail dispatchers through a ref: the memo'd
  // SortableThumbnail re-renders only when ITS page/flags change, not when
  // selection or unrelated workspace edits churn callback identity.
  const thumbHandlersRef = useRef({
    selectedIds: props.selectedIds,
    pages: props.pages,
    onSelect: props.onSelect,
    onRotate: props.onRotate,
    onDelete: props.onDelete,
    onReplace: props.onReplace,
  })
  thumbHandlersRef.current = {
    selectedIds: props.selectedIds,
    pages: props.pages,
    onSelect: props.onSelect,
    onRotate: props.onRotate,
    onDelete: props.onDelete,
    onReplace: props.onReplace,
  }
  const thumbSelect = useCallback((pageId: string, additive: boolean, range: boolean) => thumbHandlersRef.current.onSelect(pageId, additive, range), [])
  const thumbNavigate = useCallback((pageId: string, delta: number) => {
    const handlers = thumbHandlersRef.current
    const list = shownPages.current
    const index = list.findIndex((page) => page.id === pageId)
    const next = index >= 0 ? list[index + delta] : undefined
    if (!next) return
    handlers.onSelect(next.id, false, false)
    // Move focus to the new thumbnail so repeated arrows keep stepping. When
    // the target sits in a collapsed file group, the accordion expands after
    // selection — retry once on a short timer for that render.
    const focusThumb = () => {
      const node = Array.from(thumbList.current?.querySelectorAll<HTMLElement>('.thumbnail') ?? [])
        .find((el) => el.dataset.pageId === next.id)
      if (!node) return false
      node.focus({ preventScroll: true })
      node.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      return true
    }
    requestAnimationFrame(() => {
      if (!focusThumb()) window.setTimeout(focusThumb, 60)
    })
  }, [])
  const thumbRotate = useCallback((pageId: string) => thumbHandlersRef.current.onRotate(pageId), [])
  const thumbMore=useCallback((pageId:string,origin:HTMLElement,quick:boolean)=>{
    const handlers=thumbHandlersRef.current;if(!handlers.selectedIds.has(pageId))handlers.onSelect(pageId,false,false)
    const b=origin.getBoundingClientRect(),w=quick?184:248,h=quick?205:520
    setContextMenu(old=>old?.origin===origin&&old.quick===quick?undefined:{pageId,origin,quick,x:Math.max(6,Math.min(innerWidth-w-6,b.right-w)),y:Math.max(6,Math.min(b.bottom+4+h<=innerHeight?b.bottom+4:b.top-h-4,innerHeight-h-6))})
  },[])
  const thumbReplace = useCallback((pageId: string, file: File) => thumbHandlersRef.current.onReplace(pageId, file), [])
  const thumbContextMenu = useCallback((pageId: string, event: React.MouseEvent) => {
    event.preventDefault()
    const handlers = thumbHandlersRef.current
    if (!handlers.selectedIds.has(pageId)) handlers.onSelect(pageId, false, false)
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 258)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 604)),
      pageId,origin:(event.currentTarget as HTMLElement),
    })
  }, [])
  const currentPage = props.pages.find((page) => page.id === props.activeId)
  const currentSourceId = currentPage && pageGroupId(currentPage)
  const draggedPage = props.pages.find((page) => page.id === activeDragId)
  const pageDragActive = Boolean(activeDragId && !activeDragId.startsWith('source:'))
  const draggedSourceId = activeDragId?.startsWith('source:')
    ? activeDragId.slice('source:'.length)
    : undefined
  const draggedSource = props.sources.find((source) => source.id === draggedSourceId)
  const infoSource = props.sources.find((source) => source.id === infoSourceId)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const clearHoverTimer = () => {
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
    pendingSource.current = undefined
  }

  useEffect(() => () => {
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current)
  }, [])

  useEffect(() => {
    if (!activeSources.length) {
      setExpandedSourceId(undefined)
      return
    }
    if (activeDragId) return

    // 跳页、搜索或备注导航到另一个文件时，手风琴同步切换到该文件。
    if (currentSourceId && activeSources.some((source) => source.id === currentSourceId)) {
      setExpandedSourceId(currentSourceId)
      return
    }
    setExpandedSourceId((current) =>
      current && activeSources.some((source) => source.id === current)
        ? current
        : activeSources[0].id,
    )
  }, [activeDragId, activeSources, currentSourceId])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(undefined)
    pageMenuRef.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus({preventScroll:true})
    const escape = (event: KeyboardEvent) => {if(event.key==='Escape'){event.preventDefault();contextMenu.origin?.focus({preventScroll:true});close()}}
    window.addEventListener('resize',close);window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize',close);window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [contextMenu])

  useEffect(() => {
    if (tab !== 'outline') return
    contentSources.forEach((source) => {
      if (outlines[source.id]) return
      void readOutline(source).then((outline) =>
        setOutlines((current) => ({ ...current, [source.id]: outline })),
      )
    })
  }, [contentSources, outlines, tab])

  const openSource = (sourceId: string, selectFirstPage: boolean) => {
    clearHoverTimer()
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(undefined)
      return
    }
    setExpandedSourceId(sourceId)
    if (!selectFirstPage) return
    const firstPage = props.pages.find((page) => pageGroupId(page) === sourceId)
    if (firstPage) props.onSelect(firstPage.id, false, false)
  }

  const dragStart = (event: DragStartEvent) => {
    const original = event.activatorEvent, rect = event.active.rect.current.initial ?? thumbList.current?.querySelector(`[data-page-id="${CSS.escape(String(event.active.id))}"]`)?.getBoundingClientRect()
    if (rect && original instanceof MouseEvent) pointerOffset.current = {x:original.clientX - rect.left, y:original.clientY - rect.top}
    if(original instanceof MouseEvent) dragPoint.current={x:original.clientX,y:original.clientY}
    setDropSlot(undefined); setActiveDragId(String(event.active.id))
  }
  const slotAt = (id: string) => {
    const row = thumbList.current?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"]`)
    const rect = row?.getBoundingClientRect()
    return rect ? {id, after: pointerY.current >= rect.top + rect.height / 2} : undefined
  }
  const dragMove = (event: DragOverEvent) => {
    const slot = dragPoint.current ? slotUnderPointer() : event.over && slotAt(String(event.over.id))
    setDropSlot(old => old?.id === slot?.id && old?.after === slot?.after ? old : slot ?? undefined)
  }

  const dragOver = (event: DragOverEvent) => {
    // 来源标题拖拽只调整整组顺序，不触发页面拖入标题时的延迟展开。
    if (String(event.active.id).startsWith('source:')) {
      clearHoverTimer()
      return
    }
    const overId = event.over ? String(event.over.id) : ''
    const sourceId = overId.startsWith('source:') ? overId.slice('source:'.length) : undefined

    if (!sourceId || sourceId === expandedSourceId) {
      clearHoverTimer()
      return
    }
    if (pendingSource.current === sourceId) return

    clearHoverTimer()
    pendingSource.current = sourceId
    hoverTimer.current = window.setTimeout(() => {
      setExpandedSourceId(sourceId)
      pendingSource.current = undefined
      hoverTimer.current = undefined
    }, 400)
  }

  const finishDrag = () => {
    clearHoverTimer()
    dragPoint.current=undefined
    setDropSlot(undefined)
    setActiveDragId(undefined)
  }

  const dragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const hit=dragPoint.current ? slotUnderPointer() : undefined
    const overId = dragPoint.current ? hit?.id : event.over ? String(event.over.id) : undefined
    if (activeId.startsWith('source:')) {
      if (overId?.startsWith('source:')) {
        props.onReorderSources(
          activeId.slice('source:'.length),
          overId.slice('source:'.length),
        )
      }
    } else if (overId && !overId.startsWith('source:')) {
      const slot = hit ?? slotAt(overId), from = sortableIds.indexOf(activeId), over = sortableIds.indexOf(overId)
      if (slot && from >= 0 && over >= 0 && from !== over) {
        const to = over + Number(slot.after) - Number(from < over)
        if (sortableIds[to] && from !== to) props.onReorder(activeId, sortableIds[to])
      }
    }
    finishDrag()
  }

  const activeSource = activeSources.find((source) => source.id === currentSourceId) ?? activeSources[0]
  const activeGroupId = activeSource?.id ?? currentSourceId ?? groupIds.values().next().value
  // Keep workspace order, including pages moved across sources. PdfPage still
  // lazily paints only visible/nearby thumbnails; this only chooses navigation rows.
  const thumbnailPages = props.showAllPages
    ? props.pages
    : activeGroupId ? pagesByGroupId.get(activeGroupId) ?? [] : []
  const pageIndexById = useMemo(() => new Map(thumbnailPages.map((p,i) => [p.id,i])), [thumbnailPages])
  useEffect(()=>{if(contextMenu && (!pageIndexById.has(contextMenu.pageId)||tab!=='pages'))setContextMenu(undefined)},[pageIndexById,tab,contextMenu])
  shownPages.current = thumbnailPages
  const outlinePositions = useMemo(() => {
    const bySource = new Map<string,Map<number,number>>()
    thumbnailPages.forEach((p,i)=>{let pos=bySource.get(p.sourceId); if(!pos){pos=new Map();bySource.set(p.sourceId,pos)} if(!pos.has(p.sourcePage))pos.set(p.sourcePage,i+1)})
    return bySource
  }, [thumbnailPages])
  const sortableIds = useMemo(() => thumbnailPages.map(p => p.id), [thumbnailPages])
  const [dropSlot, setDropSlot] = useState<{id: string; after: boolean}>()
  const pointerOffset = useRef({x: 0, y: 0})
  const pointerY = useRef(0)
  const dragPoint = useRef<{x:number;y:number}>()
  const slotUnderPointer=useCallback(()=>{
    const list=thumbList.current, p=dragPoint.current;if(!list||!p)return
    const view=list.getBoundingClientRect();if(p.x<view.left||p.x>=view.right||p.y<view.top||p.y>=view.bottom)return
    let nearest:HTMLElement|undefined, distance=Infinity
    for(const row of list.querySelectorAll<HTMLElement>('.thumbnail[data-page-id]')){
      const r=row.getBoundingClientRect(); const gap=Math.max(r.top-p.y,p.y-r.bottom,0)
      if(gap<distance){nearest=row;distance=gap;if(!gap)break}
    }
    if(nearest){const r=nearest.getBoundingClientRect();return {id:nearest.dataset.pageId!, after:p.y>=r.top+r.height/2}}
  },[])
  useEffect(()=>{
    const list=thumbList.current;if(!list || !pageDragActive)return
    let frame=0
    const refresh=()=>{frame=0;const slot=slotUnderPointer();setDropSlot(old=>old?.id===slot?.id&&old?.after===slot?.after?old:slot)}
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(refresh)}
    const moved=(e:PointerEvent)=>{if(e.isPrimary)dragPoint.current={x:e.clientX,y:e.clientY}}
    const wheel=(e:WheelEvent)=>{
      const r=list.getBoundingClientRect();if(e.ctrlKey||!e.deltaY||e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)return
      dragPoint.current={x:e.clientX,y:e.clientY};pointerY.current=e.clientY
      e.preventDefault();e.stopPropagation()
      list.scrollBy({top:e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?list.clientHeight:1),behavior:'instant'});schedule()
    }
    window.addEventListener('pointermove',moved,true);window.addEventListener('wheel',wheel,{capture:true,passive:false});list.addEventListener('scroll',schedule,{passive:true});return()=>{cancelAnimationFrame(frame);window.removeEventListener('pointermove',moved,true);window.removeEventListener('wheel',wheel,true);list.removeEventListener('scroll',schedule)}
  },[pageDragActive,slotUnderPointer])
  // Keep the compact drag badge pinned to the picked-up handle, not the row's top-left.
  const pinBadge = useCallback<import('@dnd-kit/core').Modifier>(({transform}) => ({ ...transform,
    x: transform.x + pointerOffset.current.x - 12, y: transform.y + pointerOffset.current.y - 16 }), [])
  const [keyMove, setKeyMove] = useState<{ id: string; to: string }>()
  // DnD's geometry-based KeyboardSensor can consume a step just scrolling to
  // an unmounted row. For a virtual list navigate by page IDs, then commit once.
  const keyMoveRef = useRef(keyMove)
  function updateMove(next?: {id: string; to: string}) { keyMoveRef.current = next; setKeyMove(next) }
  useEffect(() => { updateMove() }, [tab, activeGroupId])
  function keyReorder(id: string, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const current = keyMoveRef.current
    if (!current && event.key !== ' ' && event.key !== 'Enter') return
    if (![' ', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (!current) { if (!event.repeat) updateMove({id, to: id}); return }
    if (event.key === 'Escape') { updateMove(); return }
    if (event.key === ' ' || event.key === 'Enter') {
      if (event.repeat) return
      updateMove()
      if (current.id !== current.to) props.onReorder(current.id, current.to)
      return
    }
    const i = sortableIds.indexOf(current.to)
    const to = sortableIds[i + (event.key === 'ArrowDown' ? 1 : -1)]
    if (i >= 0 && to) updateMove({ id: current.id, to })
  }

  return (
    <aside className="sidebar" aria-label="文档导航" onKeyDown={(event) => {
      if (!props.onStepOutlinePage || tab !== 'outline' || event.defaultPrevented || event.nativeEvent.isComposing ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      if (!(event.target instanceof Element) || !event.target.closest('[data-outline-step]')) return
      // At the first/last page the keys are still owned by the outline, not the scroller.
      event.preventDefault()
      props.onStepOutlinePage(event.key === 'ArrowDown' ? 1 : -1)
    }}>
      <div className="sidebar__tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pages'} onClick={() => setTab('pages')}>
          <FileText size={15} aria-hidden="true" /> 缩略图
        </button>
        <button role="tab" data-outline-step aria-keyshortcuts={props.onStepOutlinePage && tab === 'outline' ? 'ArrowUp ArrowDown' : undefined} aria-selected={tab === 'outline'} onClick={() => setTab('outline')}>
          <BookOpen size={15} /> 目录
        </button>
        <button
          type="button"
          className="sidebar__close"
          aria-label="收起侧边栏"
          title="收起侧边栏"
          onClick={props.onClose}
        ><PanelLeftClose size={15} /></button>
      </div>
      {tab === 'pages' ? (
        <>
          {props.splitSourceIds?.size ? (
            <div className="source-browser-toolbar">
              <span>分屏浏览 · {props.splitSourceIds.size}/4</span>
              <button onClick={props.onClearSplitSources}><X size={12} /> 退出分屏</button>
            </div>
          ) : null}
          <DndContext
            sensors={sensors}
            collisionDetection={args => {
              const p = args.pointerCoordinates, box = thumbList.current?.getBoundingClientRect()
              if (p) {
                pointerY.current = p.y
                if (box && (p.x < box.left || p.x > box.right || p.y < box.top || p.y > box.bottom)) return []
                const hit = pointerWithin(args); if (hit.length) return hit
              }
              return closestCenter(args)
            }}
            autoScroll={{ canScroll: node => node === thumbList.current, threshold: {x: 0, y: .15} }}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragMove={dragMove} onDragOver={dragMove}
            onDragStart={dragStart}
            onDragEnd={dragEnd}
            onDragCancel={finishDrag}
          >
            <SortableContext items={sortableIds} strategy={() => null}>
              <div ref={thumbList}
                onBlurCapture={e => { if (keyMoveRef.current && e.relatedTarget) updateMove() }}
                onPointerDownCapture={() => { if (keyMoveRef.current) updateMove() }}
                className="thumbnail-list thumbnail-list--direct"
                data-moving={pageDragActive || undefined}
                aria-label={props.showAllPages ? '全部页面缩略图' : activeSource ? `${sourceLabel(activeSource)}的页面` : '页面缩略图'}
              >
                {pageDragActive && <span className="sr-only" role="status">拖至插入线，松开移动。Esc 取消。</span>}
                {keyMove && <span className="sr-only" role="status" aria-live="polite">正在移动页面，目标为第 {sortableIds.indexOf(keyMove.to) + 1} 页。上下键调整位置，空格确认，Esc 取消。</span>}
                <ThumbnailWindow pages={thumbnailPages} activeId={keyMove?.to ?? props.activeId} dragId={activeDragId} container={thumbList}>{page => {
                  const index = pageIndexById.get(page.id) ?? 0
                  return (
                    <Fragment key={page.id}>
                      <SortableThumbnail
                        page={page}
                        source={sourceById.get(page.sourceId)}
                        index={index}
                        selected={props.selectedIds.has(page.id)}
                        active={props.activeId === page.id}
                        multiSelect={props.multiSelect}
                        onSelect={thumbSelect}
                        onNavigate={thumbNavigate}
                        keyboardMove={keyReorder}
                        insertion={dropSlot?.id === page.id && activeDragId !== page.id ? (dropSlot.after ? 'after' : 'before') : undefined}
                        moveTarget={keyMove?.to === page.id}
                        onRotate={thumbRotate}
                        onMore={thumbMore} menuOpen={contextMenu?.pageId===page.id} showSource={Boolean(props.showAllPages || (currentSourceId && page.sourceId!==currentSourceId))}
                        onReplace={thumbReplace}
                        onContextMenu={thumbContextMenu}
                      />
                      {props.canPaste && props.activeId === page.id && !activeDragId && (
                        <button
                          type="button"
                          className="thumbnail-insert-hint"
                          title={`点击将剪贴板的 ${props.pasteCount || ''} 页粘贴到第 ${index + 1} 页之后（或按 Ctrl+V）`}
                          onClick={() => props.onPaste(page.id)}
                        >
                          <span><ClipboardPaste size={11} /> 粘贴{props.pasteCount ? ` ${props.pasteCount} 页` : ''}到此处</span>
                        </button>
                      )}
                    </Fragment>
                  )
                }}</ThumbnailWindow>
              </div>
            </SortableContext>
            {/* Drop animation calls scrollIntoView on the expanded card and scrolls
                the whole shell. Keep drag feedback, but never animate the drop. */}
            <DragOverlay dropAnimation={null} modifiers={[pinBadge]} style={{pointerEvents:'none'}}>
              {draggedPage && (
                <ThumbnailDragPreview
                  source={sourceById.get(draggedPage.sourceId)}
                  index={pageIndexById.get(draggedPage.id) ?? 0}
                />
              )}
            </DragOverlay>
          </DndContext>
        </>
      ) : (
        <div className="outline-panel">
          <section className="user-bookmarks" aria-labelledby="user-bookmarks-title">
            <header>
              <h3 id="user-bookmarks-title"><Bookmark size={13} /> 我的书签</h3>
              <span>{props.userBookmarks?.length ?? 0}</span>
            </header>
            {props.userBookmarks?.length ? (
              <ul>
                {props.userBookmarks.map((bookmark) => (
                  <li key={bookmark.id}>
                    <button
                      type="button"
                      className="user-bookmarks__jump" data-outline-step aria-current={bookmark.pageId === props.activeId ? 'page' : undefined}
                      title={`跳转到：${bookmark.title}`}
                      onClick={() => props.onBookmarkJump?.(bookmark.pageId)}
                      disabled={!props.onBookmarkJump}
                    >
                      <Bookmark size={12} /><span>{bookmark.title}</span><small className="folio-number">{(pageIndexById.get(bookmark.pageId) ?? 0) + 1}</small>
                    </button>
                    <button
                      type="button"
                      className="user-bookmarks__remove"
                      aria-label={`删除书签：${bookmark.title}`}
                      title="删除书签"
                      onClick={() => props.onRemoveBookmark?.(bookmark.id)}
                      disabled={!props.onRemoveBookmark}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p>暂无手动书签，可在页面右键菜单中添加。</p>}
          </section>
          {contentSources.map((source) => (
            <section key={source.id} className="outline-source">
              <h3><BookOpen size={15}/>{sourceLabel(source)}</h3>
              {!outlines[source.id]
                ? <p>正在读取目录…</p>
                : outlines[source.id].length
                  ? <OutlineBranch nodes={outlines[source.id]} sourceId={source.id} current={currentChapter(outlines[source.id],currentPage?.sourceId===source.id ? currentPage.sourcePage : undefined)} positions={outlinePositions.get(source.id)!} onJump={props.onOutlineJump} />
                  : <p>此文档没有书签目录</p>}
            </section>
          ))}
        </div>
      )}
      {contextMenu && pageIndexById.has(contextMenu.pageId) && createPortal(
        <div
          ref={pageMenuRef} className="page-context-menu" data-quick={contextMenu.quick||undefined}
          role="menu" aria-label={`第 ${(pageIndexById.get(contextMenu.pageId)??0)+1} 页操作`}
          onKeyDown={event=>{if(event.key==='Tab'||event.key==='Escape'){if(event.key==='Escape')event.preventDefault();event.stopPropagation();contextMenu.origin?.focus({preventScroll:true});setContextMenu(undefined);return}if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')],n=items.indexOf(document.activeElement as HTMLButtonElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(n+(event.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus()}}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            maxHeight: Math.max(120, window.innerHeight - contextMenu.y - 8),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {([-1, 1] as const).map(delta => {
            const i = sortableIds.indexOf(contextMenu.pageId), other = sortableIds[i + delta]
            return <button key={delta} role="menuitem" disabled={!other} onClick={() => { if(other) props.onReorder(contextMenu.pageId, other); setContextMenu(undefined) }}>{delta < 0 ? <ArrowUpToLine size={14}/> : <ArrowDownToLine size={14}/>}<span>{delta < 0 ? '向前移一页' : '向后移一页'}</span></button>
          })}
          {contextMenu.quick ? <>
            <button role="menuitem" onClick={()=>{props.onExportPage?.(contextMenu.pageId);setContextMenu(undefined)}} disabled={!props.onExportPage}><FileOutput size={14}/><span>导出此页</span></button>
            <button role="menuitem" className="danger" onClick={()=>{props.onDelete(contextMenu.pageId);setContextMenu(undefined)}}><Trash2 size={14}/><span>删除页面</span></button>
            <button role="menuitem" onClick={()=>setContextMenu({...contextMenu,quick:false,x:Math.min(contextMenu.x,innerWidth-254),y:Math.max(6,Math.min(contextMenu.y,innerHeight-565))})}><MoreHorizontal size={14}/><span>全部页面操作…</span></button>
          </> : <>
          <button role="menuitem" disabled={!props.onUseHandTool} onClick={() => { props.onUseHandTool?.(contextMenu.pageId); setContextMenu(undefined) }}><Hand size={14} /><span>手型工具</span><kbd>H</kbd></button>
          <button role="menuitem" disabled={!props.onUseSelectTool} onClick={() => { props.onUseSelectTool?.(contextMenu.pageId); setContextMenu(undefined) }}><MousePointer2 size={14} /><span>选择工具</span><kbd>V</kbd></button>
          <span className="page-context-menu__line" />
          <button role="menuitem" onClick={() => { props.onCopy(); setContextMenu(undefined) }}><Copy size={14} /><span>复制页面</span><kbd>Ctrl+C</kbd></button>
          <button role="menuitem" onClick={() => { props.onCut(); setContextMenu(undefined) }}><Scissors size={14} /><span>剪切页面</span><kbd>Ctrl+X</kbd></button>
          <button role="menuitem" disabled={!props.canPaste} onClick={() => { props.onPaste(contextMenu.pageId); setContextMenu(undefined) }}>
            <ClipboardPaste size={14} /><span>粘贴到此页后</span><kbd>Ctrl+V</kbd>
          </button>
          <button role="menuitem" disabled={!props.onAddPagesToWorkspace} onClick={() => { props.onAddPagesToWorkspace?.(contextMenu.pageId); setContextMenu(undefined) }}>
            <Layers3 size={14} /><span>{props.selectedIds.has(contextMenu.pageId) && props.selectedIds.size > 1 ? `将已选 ${props.selectedIds.size} 页加入工作区` : '将当前页加入工作区'}</span>
          </button>
          <span className="page-context-menu__line" />
          <button role="menuitem" onClick={() => { props.onInsertExternal(contextMenu.pageId, 'before'); setContextMenu(undefined) }}>
            <ArrowUpToLine size={14} /><span>在上方插入…</span>
          </button>
          <button role="menuitem" onClick={() => { props.onInsertExternal(contextMenu.pageId, 'after'); setContextMenu(undefined) }}>
            <ArrowDownToLine size={14} /><span>在下方插入…</span>
          </button>
          <button role="menuitem" onClick={() => { props.onReplaceExternal(contextMenu.pageId); setContextMenu(undefined) }}>
            <Replace size={14} /><span>替换该页…</span>
          </button>
          <button role="menuitem" onClick={() => { (props.onExportPage ? props.onExportPage(contextMenu.pageId) : props.onExportSelected()); setContextMenu(undefined) }}>
            <FileOutput size={14} /><span>导出该页…</span>
          </button>
          {props.selectedIds.size > 1 && <button role="menuitem" onClick={() => { props.onExportSelected(); setContextMenu(undefined) }}>
            <FileOutput size={14} /><span>提取已选 {props.selectedIds.size} 页…</span>
          </button>}
          <button role="menuitem" onClick={() => { props.onSplitDocument?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onSplitDocument}>
            <Scissors size={14} /><span>拆分当前 PDF…</span>
          </button>
          <span className="page-context-menu__line" />
          <button role="menuitem" onClick={() => { props.onExportPageImage?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onExportPageImage}><FileImage size={14} /><span>当页转换为图片输出</span></button>
          <button role="menuitem" onClick={() => { props.onInsertNote?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onInsertNote}><MessageSquareText size={14} /><span>插入备注</span></button>
          <button role="menuitem" onClick={() => { props.onPageProperties?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onPageProperties}><Info size={14} /><span>查看页面属性</span></button>
          <button role="menuitem" onClick={() => { props.onResizePage?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onResizePage}><Maximize2 size={14} /><span>调整页面大小</span></button>
          <button role="menuitem" onClick={() => { props.onAddBookmark?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onAddBookmark}><BookmarkPlus size={14} /><span>添加书签</span></button>
          <button role="menuitem" onClick={() => { props.onOcrPage?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onOcrPage}><ScanText size={14} /><span>OCR 识别本页</span></button>
          <span className="page-context-menu__line" />
          <button role="menuitem" onClick={() => { props.onRotateLeft?.(contextMenu.pageId); setContextMenu(undefined) }} disabled={!props.onRotateLeft}><RotateCcw size={14} /><span>向左旋转页面</span></button>
          <button role="menuitem" onClick={() => { props.onRotate(contextMenu.pageId); setContextMenu(undefined) }}><RotateCw size={14} /><span>向右旋转页面</span></button>
          <button role="menuitem" className="danger" onClick={() => { props.onDelete(contextMenu.pageId); setContextMenu(undefined) }}><Trash2 size={14} /><span>删除页面</span></button>
          </>}
        </div>,
        document.body,
      )}
      {infoSource && <FileInfoDialog source={infoSource} onClose={() => setInfoSourceId(undefined)} />}
    </aside>
  )
}
