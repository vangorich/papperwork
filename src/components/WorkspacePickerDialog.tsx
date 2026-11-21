import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, Layers3, Pencil, Plus, X } from 'lucide-react'
import { workspaceNameError, type NamedWorkspace } from '../lib/workspaceNames'
import { Button } from './ui'
import './workspacePicker.css'

interface Props {
  projects: NamedWorkspace[]
  newPrintName?: string
  pageCount: number
  scopeLabel: string
  /** A synchronous validation error keeps the picker and the print job open. */
  onConfirm: (targetId: string, name?: string) => string | void
  onClose: () => void
}

export function WorkspacePickerDialog({ projects, newPrintName, pageCount, scopeLabel, onConfirm, onClose }: Props) {
  const printing = newPrintName !== undefined
  const [targetId, setTarget] = useState(printing ? 'new' : projects[0]?.id ?? 'new')
  // A suggested print destination is a local draft, not an entry in projects.
  // Focusing the default radio or opening the picker must not make it look created.
  const [pickedNew, setPickedNew] = useState(false)
  const [newName, setNewName] = useState<string>()
  const [rename, setRename] = useState<{ id: string; name: string }>()
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const [submitError, setSubmitError] = useState('')
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null)
  const radios = useRef(new Map<string, HTMLButtonElement>())
  const composing = useRef(false), submitted = useRef(false)
  const uid = useId(), titleId = `${uid}-title`, inputId = `${uid}-name`, hintId = `${uid}-hint`
  const original = projects.find(p => p.id === targetId)
  const tentative = (id: string) => id === 'new' ? newName ?? newPrintName ?? ''
    : rename?.id === id ? rename.name : projects.find(p => p.id === id)?.name ?? ''
  const proposedName = editing?.text ?? tentative(targetId)
  const changingName = printing && (targetId === 'new' || proposedName.trim() !== original?.name)
  const validation = changingName ? workspaceNameError(proposedName, projects, targetId === 'new' ? undefined : targetId) : ''
  const error = submitError || validation
  const targetExists = targetId === 'new' || !!original

  // Focus once on open, not on every parent render (e.g. a second print arrival).
  useLayoutEffect(() => {
    const previous = document.activeElement
    const selected = panel.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    selected?.focus({ preventScroll: true })
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const editId = editing?.id
  useLayoutEffect(() => {
    if (editId !== undefined) { input.current?.focus(); input.current?.select() }
  }, [editId])

  function choose(id: string, focus = false) {
    setSubmitError(''); setEditing(undefined); composing.current = false
    if (id !== targetId) setRename(undefined) // never silently rename a non-destination
    setTarget(id)
    setPickedNew(id === 'new')
    if (focus) radios.current.get(id)?.focus()
  }
  function startName(id: string) {
    if (editing?.id === id) { input.current?.focus(); input.current?.select(); return }
    const value = tentative(id)
    choose(id)
    setEditing({ id, text: value })
  }
  function endName(keep: boolean) {
    if (!editing || (keep && validation)) return
    if (keep) {
      if (editing.id === 'new') setNewName(editing.text.trim())
      else setRename({ id: editing.id, name: editing.text.trim() })
    }
    setEditing(undefined); setSubmitError(''); composing.current = false
    radios.current.get(targetId)?.focus({ preventScroll: true })
  }
  function join() {
    if (submitted.current || composing.current || validation || !targetExists) return
    submitted.current = true
    const problem = onConfirm(targetId, changingName ? proposedName.trim() : undefined)
    if (problem) { submitted.current = false; setSubmitError(problem) }
  }
  const order = [...projects.map(p => p.id), 'new']
  function option(id: string, label: string, small?: string) {
    const selected = targetId === id
    const draft = printing && id === 'new' ? (selected && pickedNew ? 'chosen' : 'ghost') : undefined
    return <div className="workspace-picker__row" key={id} data-selected={selected || undefined} data-draft={draft}>
      <button type="button" role="radio" aria-checked={selected} data-active={selected && draft !== 'ghost' || undefined}
        ref={el => { if (el) radios.current.set(id, el); else radios.current.delete(id) }}
        tabIndex={selected ? 0 : -1} onClick={() => choose(id)} onKeyDown={event => {
          const i = order.indexOf(id), k = event.key
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) return
          event.preventDefault(); event.stopPropagation()
          choose(order[k === 'Home' ? 0 : k === 'End' ? order.length - 1 : (i + (k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 1) + order.length) % order.length], true)
        }}>
        <span aria-hidden="true">{id === 'new' ? <Plus size={15}/> : <Layers3 size={15}/>}</span>
        <strong>{label}</strong>{small && <small>{small}</small>}<i aria-hidden="true" />
      </button>
      {printing && selected && draft !== 'ghost' && !editing && <button type="button" className="workspace-picker__pencil"
        aria-label={`重命名工作区：${tentative(id)}`} title="重命名工作区" onClick={() => startName(id)}><Pencil size={15} aria-hidden="true"/></button>}
    </div>
  }
  return <div className="workspace-picker__backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section ref={panel} className="workspace-picker" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={e => {
      // Let the OS input method consume Enter/Escape before the modal's shortcuts.
      if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) { e.stopPropagation(); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (editing) endName(false); else onClose(); return }
      if (e.key !== 'Tab') return
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter(el => el.tabIndex >= 0)
      const first = controls[0], last = controls.at(-1)
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }}>
      <header><span><Layers3 size={18} aria-hidden="true"/></span><div><h2 id={titleId}>加入哪个工作区？</h2><p>{scopeLabel} · 共 {pageCount} 页</p></div>
        <button type="button" aria-label="关闭" title="关闭 (Esc)" onClick={onClose}><X size={16}/></button></header>
      {printing && <div className="workspace-picker__tools"><span>目标工作区</span><button type="button" onClick={() => startName('new')}><Plus size={15} aria-hidden="true"/>新建工作区</button></div>}
      <div className="workspace-picker__list" role="radiogroup" aria-label="目标工作区">
        {projects.map(p => option(p.id, p.id === targetId && rename?.id === p.id ? rename.name : p.name))}
        {option('new', printing ? `加入工作区：${tentative('new')}` : '新建工作区', printing ? (targetId === 'new' && pickedNew ? '加入时创建' : '待创建') : '使用首个文件名')}
      </div>
      {editing && <div className="workspace-picker__name-editor">
        <label htmlFor={inputId}>{editing.id === 'new' ? '新工作区名称' : '工作区名称'}</label>
        <div><input id={inputId} ref={input} value={editing.text} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={hintId}
          onChange={e => { setEditing({ id: editing.id, text: e.target.value }); setSubmitError('') }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={e => { if (e.key === 'Enter' && !composing.current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); endName(true) } }} />
          <button type="button" aria-label="确认名称" title="确认名称，不立即导入" disabled={Boolean(validation)} onClick={() => endName(true)}><Check size={16}/></button>
        </div>
        <small id={hintId} aria-live="polite" data-error={Boolean(error) || undefined}>{error || '点击“加入”后生效。'}</small>
      </div>}
      {!editing && error && <p className="workspace-picker__error" role="alert">{error}</p>}
      <footer><Button type="button" onClick={onClose}>取消</Button><Button type="button" variant="primary" disabled={Boolean(validation) || !targetExists} onClick={join}>加入 {pageCount} 页</Button></footer>
    </section>
  </div>
}
