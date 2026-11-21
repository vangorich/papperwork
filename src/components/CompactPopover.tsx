import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** A small floating surface. Opening it never changes the size of its owner. */
export function CompactPopover({
  anchor,
  role,
  label,
  className,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLButtonElement>
  role: 'toolbar' | 'dialog'
  label: string
  className: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null),
    close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const el = panel.current,
      button = anchor.current
    if (!el || !button) return
    const position = () => {
      const r = button.getBoundingClientRect(),
        w = el.offsetWidth,
        h = el.offsetHeight
      if (
        !button.isConnected ||
        getComputedStyle(button).visibility === 'hidden' ||
        !r.width ||
        r.bottom < 0 ||
        r.top >= innerHeight
      ) {
        close.current()
        return
      }
      el.style.left = `${Math.max(5, Math.min(innerWidth - w - 5, r.right - w))}px`
      el.style.top = `${Math.max(5, Math.min(innerHeight - h - 5, r.bottom + h + 5 <= innerHeight ? r.bottom + 4 : r.top - h - 4))}px`
    }
    position()
    el.querySelector<HTMLElement>('button:enabled,input:enabled')?.focus({ preventScroll: true })
    const outside = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target) && !button.contains(e.target))
        close.current()
    }
    const ro = new ResizeObserver(position)
    ro.observe(el)
    ro.observe(button)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      ro.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={panel}
      className={className}
      role={role}
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || e.key === 'Tab') {
          if (e.key === 'Tab' && role === 'dialog') {
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>('button:enabled,input:enabled'),
            ]
            if (e.target !== (e.shiftKey ? controls[0] : controls.at(-1))) return
          }
          if (e.key === 'Escape') e.preventDefault()
          anchor.current?.focus({ preventScroll: true })
          close.current()
          return
        }
        if (role !== 'toolbar' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')],
          i = items.indexOf(document.activeElement as HTMLButtonElement)
        e.preventDefault()
        items[
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : (i + (e.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length
        ]?.focus()
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
