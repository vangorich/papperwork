import { useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical, MessageSquareText, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { CompactPopover } from './CompactPopover'
import type { CommonPhrase } from '../types/pdf'

export interface CommonPhrasesListProps {
  phrases: CommonPhrase[]
  filter?: string
  activeTextSelection: boolean
  onApply: (phrase: CommonPhrase, createNew?: boolean) => void
  onEdit: (phrase:CommonPhrase)=>void
  onRemove: (id: string) => void
  onReorder: (activeId: string, overId: string) => void
  onMove: (id: string, delta: -1 | 1) => void
}

function SortablePhrase({
  phrase,
  index,
  count,
  activeTextSelection,
  announce,
  onApply,
  onRemove,onEdit,
  onMove,
}: {
  phrase: CommonPhrase
  index: number
  count: number
  activeTextSelection: boolean
  announce: (message: string) => void
  onApply: CommonPhrasesListProps['onApply']
  onEdit:CommonPhrasesListProps['onEdit']
  onRemove: CommonPhrasesListProps['onRemove']
  onMove: CommonPhrasesListProps['onMove']
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: phrase.id })

  const trigger = useRef<HTMLButtonElement>(null)
  const [open,setOpen] = useState(false)
  const closeHere=()=>{setOpen(false);trigger.current?.focus({preventScroll:true})}
  const move = (delta: -1 | 1) => {
    onMove(phrase.id, delta)
    announce(`已将“${phrase.text}”${delta < 0 ? '上移' : '下移'}一项`)
  }

  return (
    <article
      ref={setNodeRef}
      className="common-phrase-card"
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="phrase-grip"
          aria-label={`拖动排序：${phrase.text}，当前第 ${index + 1} 项，共 ${count} 项`}
          title="拖动排序"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
      <button
        type="button"
        className="common-phrase-card__apply"
        title={activeTextSelection ? '应用到当前文本框' : '在当前页新建文本框'}
        onClick={() => {
          onApply(phrase)
          announce(activeTextSelection ? `已将“${phrase.text}”应用到当前文本框` : `已在当前页插入“${phrase.text}”`)
        }}
      >
        <strong
          style={{
            color: phrase.color,
            fontFamily: phrase.fontFamily,
            fontSize: `${Math.min(phrase.fontSize, 28)}px`,
            fontWeight: phrase.bold ? 700 : 400,
            fontStyle: phrase.italic ? 'italic' : 'normal',
          }}
        >
          {phrase.text}
        </strong>
        <small>
          {phrase.fontFamily} · {phrase.fontSize} pt
          {phrase.bold ? ' · 粗体' : ''}
          {phrase.italic ? ' · 斜体' : ''}
        </small>
      </button>

      <button ref={trigger} className="phrase-menu-trigger" type="button" aria-expanded={open} aria-label={`管理常用语：${phrase.text}`} title="管理常用语" onClick={()=>setOpen(v=>!v)}><MoreHorizontal size={16}/></button>
      {open && <CompactPopover role="toolbar" label="常用语操作" className="phrase-tools-pop" anchor={trigger} onClose={()=>setOpen(false)}>
        <button type="button" aria-label={`编辑常用语：${phrase.text}`} title="编辑内容和排版" onClick={()=>{closeHere();onEdit(phrase)}}><Pencil size={14}/></button>
        <button
          type="button"
          aria-label={`上移常用语：${phrase.text}`}
          title="上移"
          disabled={index === 0}
          onClick={() => {closeHere();move(-1)}}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          aria-label={`下移常用语：${phrase.text}`}
          title="下移"
          disabled={index === count - 1}
          onClick={() => {closeHere();move(1)}}
        >
          <ArrowDown size={13} />
        </button>
        <button
          type="button"
          aria-label={`在当前页新建文本框：${phrase.text}`}
          title="始终在当前页新建"
          onClick={() => {
            closeHere();onApply(phrase, true)
            announce(`已在当前页新建“${phrase.text}”`)
          }}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="danger"
          aria-label={`删除常用语：${phrase.text}`}
          title="删除常用语"
          onClick={() => {
            const fallback=trigger.current?.closest('.phrases-panel')?.querySelector<HTMLInputElement>('[aria-label="筛选常用语"]')
            setOpen(false);onRemove(phrase.id);requestAnimationFrame(()=>fallback?.focus({preventScroll:true}))
            announce(`已删除常用语“${phrase.text}”`)
          }}
        >
          <Trash2 size={13} />
        </button>
      </CompactPopover>}
    </article>
  )
}

export function CommonPhrasesList({
  phrases, filter = '',
  activeTextSelection,
  onApply,
  onRemove,onEdit,
  onReorder,
  onMove,
}: CommonPhrasesListProps) {
  const shown = phrases.filter(p=>p.text.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const [announcement, setAnnouncement] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const announce = (message: string) => {
    setAnnouncement('')
    window.setTimeout(() => setAnnouncement(message), 0)
  }

  const phraseName = (id: string | number) => phrases.find((phrase) => phrase.id === String(id))?.text ?? '常用语'
  const handleDragStart = ({ active }: DragStartEvent) => {
    announce(`开始移动“${phraseName(active.id)}”。使用方向键调整位置，按空格完成，按 Esc 取消。`)
  }
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) {
      announce(`“${phraseName(active.id)}”未移动`)
      return
    }
    if (active.id !== over.id) onReorder(String(active.id), String(over.id))
    const targetIndex = phrases.findIndex((phrase) => phrase.id === String(over.id))
    announce(`已将“${phraseName(active.id)}”移至第 ${targetIndex + 1} 项`)
  }

  return (
    <div className="common-phrases-list">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      {shown.length ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragCancel={({ active }) => announce(`已取消移动“${phraseName(active.id)}”`)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={shown.map((phrase) => phrase.id)} strategy={verticalListSortingStrategy}>
            {shown.map(phrase => (
              <SortablePhrase
                key={phrase.id}
                phrase={phrase}
                index={phrases.indexOf(phrase)}
                count={phrases.length}
                activeTextSelection={activeTextSelection}
                announce={announce}
                onApply={onApply}
                onRemove={onRemove} onEdit={onEdit}
                onMove={onMove}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        <div className="common-phrases-list__empty" role="status">
          <span aria-hidden="true"><MessageSquareText size={20} /></span>
          <strong>{phrases.length ? '没有匹配的常用语' : '还没有常用语'}</strong>
          <p>{phrases.length ? '试试其他关键词。' : '点“新建常用语”保存常用文字。'}</p>
        </div>
      )}
    </div>
  )
}
