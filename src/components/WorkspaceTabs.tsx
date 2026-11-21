import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { FilePlus2, Info, Layers3, MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import { Button } from './ui'
import './workspaceTabs.css'

export interface WorkspaceInfo {
  pageCount: number
  sourceCount: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
}

export interface WorkspaceTabsProps {
  projects: Array<{ id: string; name: string }>
  activeId: string
  onChange: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
  getInfo: (id: string) => WorkspaceInfo | undefined
  onAddFiles?: () => void
}

type MenuState = { id: string; x: number; y: number; trigger: HTMLButtonElement }

export function WorkspaceTabs({ projects, activeId, onChange, onAdd, onClose, onRename, getInfo, onAddFiles }: WorkspaceTabsProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<{ id: string; kind: 'info' | 'rename' } | null>(null)
  const [name, setName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const nameId = useId()
  const selectedProject = projects.find((project) => project.id === dialog?.id)
  const menuExists = !!menu && projects.some((project) => project.id === menu.id)
  const info = dialog?.kind === 'info' && selectedProject ? getInfo(selectedProject.id) : undefined

  const restoreFocus = () => {
    const target = returnRef.current
    if (target?.isConnected) target.focus({ preventScroll: true })
    else rootRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"], .workspace-tabs__add')?.focus({ preventScroll: true })
  }
  const closeMenu = () => { setMenu(null); restoreFocus() }
  const activateWorkspace = (id: string) => {
    if (id === activeId) return
    onChange(id)
    // Each project owns its own strip. The old focused button leaves the DOM on switch.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.app-shell:not([hidden]) .workspace-tabs [aria-selected="true"]')?.focus({ preventScroll: true }))
  }
  const closeWorkspace = (id: string) => {
    const focused = document.activeElement
    onClose(id)
    requestAnimationFrame(() => {
      if (focused?.isConnected || (document.activeElement && document.activeElement !== document.body)) return
      document.querySelector<HTMLButtonElement>('.app-shell:not([hidden]) .workspace-tabs [aria-selected="true"]')?.focus({ preventScroll: true })
    })
  }
  const openMenu = (id: string, trigger: HTMLButtonElement, x?: number, y?: number) => {
    const rect = trigger.getBoundingClientRect()
    returnRef.current = trigger
    setMenu({ id, trigger, x: x ?? rect.left, y: y ?? rect.bottom + 4 })
  }

  useLayoutEffect(() => {
    if (!menu || !menuExists) return
    const place = () => {
      const element = menuRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
    }
    place()
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu, menuExists])

  useEffect(() => {
    if (!menu || !menuExists) return
    const pointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || menuRef.current?.contains(event.target) || menu.trigger.contains(event.target)) return
      // Restore before the pointer's default action focuses the clicked control.
      closeMenu()
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.stopPropagation()
        if (event.key === 'Escape') event.preventDefault()
        closeMenu()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        if (!items.length) return
        const current = items.findIndex((item) => item === document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next].focus()
      }
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('keydown', keyDown, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [menu, menuExists])

  useEffect(() => {
    if (menu && !menuExists) { setMenu(null); restoreFocus() }
    if (dialog && !selectedProject) { setDialog(null); restoreFocus() }
  }, [menu, menuExists, dialog, selectedProject])

  useEffect(() => {
    const tab = rootRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    const strip = tab?.closest('.workspace-tabs__list')
    if (!tab || !strip) return
    const rect = tab.getBoundingClientRect()
    const bounds = strip.getBoundingClientRect()
    // Scroll only the strip, never the PDF stage or its ancestors.
    if (rect.left < bounds.left) strip.scrollLeft += rect.left - bounds.left
    else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right
  }, [activeId, projects.length])

  const showDialog = (kind: 'info' | 'rename') => {
    const project = projects.find((item) => item.id === menu?.id)
    if (!project) return
    closeMenu() // Headless UI captures this connected trigger for focus restoration.
    setName(project.name)
    setDialog({ id: project.id, kind })
  }

  return (
    <div className="workspace-tabs" ref={rootRef}>
      <div className="workspace-tabs__list" role="tablist" aria-label="工作区">
        {projects.map((project, index) => (
          <div className="workspace-tabs__tab" role="presentation" data-active={project.id === activeId || undefined} key={project.id}
            onContextMenu={(event) => {
              event.preventDefault()
              const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')
              if (trigger) openMenu(project.id, trigger, event.clientX, event.clientY)
            }}>
            <button type="button" role="tab" aria-selected={project.id === activeId}
              tabIndex={project.id === activeId || (!projects.some((item) => item.id === activeId) && index === 0) ? 0 : -1}
              title={project.name} onClick={() => { setMenu(null); activateWorkspace(project.id) }}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  openMenu(project.id, event.currentTarget)
                } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  event.stopPropagation()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? projects.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + projects.length) % projects.length
                  activateWorkspace(projects[next].id)
                }
              }}>
              <Layers3 size={14} aria-hidden="true" /><span>{project.name}</span>
            </button>
            <button type="button" className="workspace-tabs__icon" aria-label={`${project.name}：工作区菜单`} title="工作区菜单"
              aria-haspopup="menu" aria-expanded={menuExists && menu?.id === project.id} aria-controls={menuExists && menu?.id === project.id ? menuId : undefined}
              onClick={(event) => menu?.id === project.id ? closeMenu() : openMenu(project.id, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(project.id, event.currentTarget) }
              }}><MoreHorizontal size={14} aria-hidden="true" /></button>
            <button type="button" className="workspace-tabs__icon workspace-tabs__close" aria-label={`关闭工作区：${project.name}`} title="关闭工作区"
              onClick={() => closeWorkspace(project.id)}><X size={13} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
      <button type="button" className="workspace-tabs__add" onClick={onAdd} aria-label="新建工作区" title="新建工作区"><Plus size={15} aria-hidden="true" /></button>
      {onAddFiles && <button type="button" className="workspace-tabs__add workspace-tabs__files" onClick={onAddFiles} title="添加文件到当前工作区"><FilePlus2 size={14} aria-hidden="true" /><span>添加文件</span></button>}
      {menu && menuExists && createPortal(
        <div className="workspace-tabs__menu" role="menu" id={menuId} aria-label="工作区菜单" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitem" onClick={() => showDialog('info')}><Info size={15} aria-hidden="true" />工作区信息</button>
          <button type="button" role="menuitem" onClick={() => showDialog('rename')}><Pencil size={15} aria-hidden="true" />重命名工作区</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onAdd() }}><Plus size={15} aria-hidden="true" />新建工作区</button>
          <button type="button" role="menuitem" className="workspace-tabs__menu-close" onClick={() => { closeMenu(); closeWorkspace(menu.id) }}><X size={15} aria-hidden="true" />关闭工作区</button>
        </div>, document.body,
      )}
      <Dialog open={!!dialog && !!selectedProject} onClose={() => setDialog(null)} className="dialog workspace-tabs__dialog" initialFocus={dialog?.kind === 'rename' ? inputRef : undefined}>
        <DialogBackdrop className="dialog__backdrop" />
        <DialogPanel className="dialog__panel workspace-tabs__panel">
          <div className="dialog__header">
            <DialogTitle>{dialog?.kind === 'rename' ? '重命名工作区' : '工作区信息'}</DialogTitle>
            <button type="button" aria-label="关闭对话框" onClick={() => setDialog(null)}><X size={18} aria-hidden="true" /></button>
          </div>
          {dialog?.kind === 'rename' ? (
            <form onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim() || !selectedProject) return
              onRename(selectedProject.id, name.trim())
              setDialog(null)
            }}>
              <label htmlFor={nameId}>工作区名称</label>
              <input ref={inputRef} id={nameId} className="workspace-tabs__name-input" value={name} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.target.select()} autoComplete="off" />
              <div className="dialog__actions"><Button type="button" onClick={() => setDialog(null)}>取消</Button><Button type="submit" variant="primary" disabled={!name.trim()}>保存名称</Button></div>
            </form>
          ) : (
            <>
              <p className="workspace-tabs__name">{selectedProject?.name}</p>
              {info ? <dl className="workspace-tabs__info">
                <div><dt>页面数</dt><dd>{info.pageCount}</dd></div>
                <div><dt>来源文件数</dt><dd>{info.sourceCount}</dd></div>
                <div><dt>保存状态</dt><dd>{info.dirty ? '有未保存更改' : '无未保存更改'}</dd></div>
                <div><dt>可撤销</dt><dd>{info.canUndo ? '是' : '否'}</dd></div>
                <div><dt>可重做</dt><dd>{info.canRedo ? '是' : '否'}</dd></div>
              </dl> : <p className="workspace-tabs__unavailable">工作区信息暂不可用</p>}
              <div className="dialog__actions"><Button type="button" onClick={() => setDialog(null)}>关闭</Button></div>
            </>
          )}
        </DialogPanel>
      </Dialog>
    </div>
  )
}
