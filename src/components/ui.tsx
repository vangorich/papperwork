import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { twMerge } from 'tailwind-merge'

export function Button({
  children,
  className,
  variant = 'ghost',
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger'
  busy?: boolean
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={twMerge('button', `button--${variant}`, className)}
    >
      {busy && <LoaderCircle aria-hidden="true" className="spin" size={15} />}
      {children}
    </button>
  )
}

export type FormSelectOption = {
  value: string
  label: string
  hint?: string
}

/**
 * Lightweight custom dropdown. Native <select> popups in a frameless Electron
 * window force a full style/layout pass over the (heavy) document behind the
 * dialog before they can open — a visible stall. This renders an in-page
 * popover instead: instant to open, styled like the rest of the app, and it
 * carries a hidden input so plain FormData form submission keeps working.
 */
export function FormSelect({
  id,
  name,
  label,
  value,
  onChange,
  options,
  disabled,
  loading,
  placeholder = '请选择',
}: {
  id?: string
  name: string
  label: string
  value: string
  onChange: (value: string) => void
  options: FormSelectOption[]
  disabled?: boolean
  loading?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [rect, setRect] = useState<DOMRect>()
  const generatedId = useId()
  const controlId = id ?? generatedId
  const selected = options.find((option) => option.value === value)

  // Measure after commit (getBoundingClientRect during render reads the
  // pre-commit layout) and re-measure on every render while open so a reflow
  // above the trigger — e.g. the printer detail box appearing when detection
  // resolves — cannot strand the portaled list at stale coordinates.
  useLayoutEffect(() => {
    if (!open) return
    const next = triggerRef.current?.getBoundingClientRect()
    if (!next) return
    setRect((current) => current
      && current.left === next.left && current.top === next.top
      && current.width === next.width && current.height === next.height
      ? current
      : next)
  })

  // Focus the current selection once the list is actually mounted (rect only
  // exists after the post-commit measure), so arrow keys continue from it.
  useEffect(() => {
    if (!open || !rect) return
    const active = listRef.current?.querySelector<HTMLButtonElement>('.form-select__option[data-active]')
    ;(active ?? listRef.current?.querySelector<HTMLButtonElement>('.form-select__option'))?.focus()
  }, [open, rect])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Capture phase + stopPropagation: an open dropdown swallows Escape so
      // the surrounding dialog does not close with it.
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveFocus(event.key === 'ArrowDown' ? 1 : -1)
      } else if (event.key === 'Tab') {
        // Move focus to the trigger first; the browser's default Tab then
        // advances to the field AFTER the select instead of dropping to body
        // (and wrapping to the dialog's first control via the focus guard).
        triggerRef.current?.focus()
        setOpen(false)
      }
    }
    // Close only when the trigger actually MOVES (the portaled list would be
    // stranded at stale coordinates — same as native dropdowns). Scroll events
    // are delivered a frame late, so a scroll-into-view issued right before
    // the opening click arrives AFTER open; the pane is already settled, the
    // trigger hasn't moved, and closing then would kill the just-opened list.
    // The list's own overflow scrolling (long printer lists) never closes it.
    const onRelayout = (event?: Event) => {
      if (event?.target instanceof Node && listRef.current?.contains(event.target)) return
      const next = triggerRef.current?.getBoundingClientRect()
      if (!next || !rect) return
      if (Math.abs(next.left - rect.left) < 0.5 && Math.abs(next.top - rect.top) < 0.5) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onRelayout, true)
    window.addEventListener('resize', onRelayout)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onRelayout, true)
      window.removeEventListener('resize', onRelayout)
    }
  }, [open, rect])

  const moveFocus = (delta: number) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.form-select__option') ?? [])]
    if (!buttons.length) return
    const index = buttons.findIndex((button) => button === document.activeElement)
    buttons[(index + delta + buttons.length) % buttons.length].focus()
  }

  // Flip above the trigger when the viewport has no room below (short windows,
  // bottom-row fields); `bottom`-anchoring needs no measured list height.
  const flip = rect ? window.innerHeight - rect.bottom - 8 < Math.min(238, 12 + options.length * 40) && rect.top > window.innerHeight - rect.bottom : false
  const width = rect ? Math.min(Math.max(rect.width, 168), window.innerWidth - 16) : 0
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 0
  const maxHeight = rect
    ? Math.max(96, Math.min(238, (flip ? rect.top - 12 : window.innerHeight - rect.bottom - 12)))
    : 238
  return (
    <div className="form-select" data-open={open || undefined}>
      <span className="form-select__label" id={`${controlId}-label`}>{label}</span>
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        id={controlId}
        ref={triggerRef}
        className="form-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${controlId}-options` : undefined}
        aria-labelledby={`${controlId}-label ${controlId}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="form-select__value" data-placeholder={!selected && !loading || undefined}>
          {loading ? '正在检测…' : selected?.label ?? placeholder}
        </span>
        {loading
          ? <LoaderCircle size={14} aria-hidden="true" className="spin" />
          : <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open && rect && createPortal(
        <ul
          className="form-select__list"
          role="listbox"
          ref={listRef}
          id={`${controlId}-options`}
          aria-labelledby={`${controlId}-label`}
          style={flip
            ? { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight }
            : { left, top: rect.bottom + 4, width, maxHeight }}
        >
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                className="form-select__option"
                data-active={option.value === value || undefined}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                  // Keep focus on the trigger: unmounting the focused option
                  // would drop focus to body and break the Tab order.
                  triggerRef.current?.focus()
                }}
              >
                <span>{option.label}</span>
                {option.hint && <small>{option.hint}</small>}
                {option.value === value && <Check size={14} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  )
}

export function ToolButton({
  label,
  caption,
  active,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  caption?: string
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={twMerge('tool-button', caption && 'tool-button--caption', className)}
      data-active={active || undefined}
      {...props}
    >
      {children}{caption && <span aria-hidden="true">{caption}</span>}
    </button>
  )
}

export function Divider() {
  return <span className="toolbar-divider" aria-hidden="true" />
}
