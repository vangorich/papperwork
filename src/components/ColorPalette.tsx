import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Pipette, SlidersHorizontal, X } from 'lucide-react'
import { loadRecentColors, rememberRecentColor } from '../lib/recentColors'

/**
 * Office-style color picker: a popover palette of theme/standard/recent
 * colors that commits once per click, instead of a native color wheel that
 * fires change events on every drag tick (which re-rendered the whole page
 * tree and burned the undo stack). "Pick from page" uses the EyeDropper API:
 * the palette closes so the page is fully visible, and a floating hint in the
 * top-right shows the current/picked color with a way back to the palette.
 */

type EyeDropperLike = { open: () => Promise<{ sRGBHex: string }> }
const eyeDropperCtor = () =>
  (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper

/** Mix a #rrggbb color toward white (positive amount) or black (negative). */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16)
  const target = amount >= 0 ? 255 : 0
  const ratio = Math.abs(amount)
  const channel = (shift: number) => {
    const component = (value >> shift) & 0xff
    return Math.round(component + (target - component) * ratio)
  }
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

const THEME_BASE = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']
const GRAYS = ['#000000', '#262626', '#595959', '#808080', '#a6a6a6', '#bfbfbf', '#d9d9d9', '#e7e6e6', '#f2f2f2', '#ffffff']
const THEME_LEVELS = [0.8, 0.6, 0.4, -0.25, -0.5]
const STANDARD = ['#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080']

const normalizeHex = (color: string) => (/^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '#000000')

export function ColorPalette({ value, onChange, label, disabled }: {
  value: string
  onChange: (color: string) => void
  /** Accessible label, e.g. "绘图颜色". */
  label: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>(() => loadRecentColors())
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nativeInputRef = useRef<HTMLInputElement>(null)
  const hintTimer = useRef<number>()

  useEffect(() => {
    if (!open) return
    setRecents(loadRecentColors())
    const close = (event: Event) => {
      if (event.target instanceof Node && triggerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault();event.stopPropagation()
      setOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown,true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keydown,true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  useEffect(() => () => window.clearTimeout(hintTimer.current), [])

  const apply = (color: string) => {
    onChange(normalizeHex(color))
    setRecents(rememberRecentColor(color))
    setOpen(false)
    requestAnimationFrame(()=>triggerRef.current?.focus({preventScroll:true}))
  }

  const pickFromPage = async () => {
    const Ctor = eyeDropperCtor()
    if (!Ctor) {
      nativeInputRef.current?.click()
      return
    }
    // Close the palette before picking: the pick click would otherwise count
    // as an outside pointerdown, and the page must be fully visible anyway.
    setOpen(false)
    setPicked(undefined)
    setPicking(true)
    try {
      const result = await new Ctor().open()
      apply(result.sRGBHex)
      setPicked(normalizeHex(result.sRGBHex))
      window.clearTimeout(hintTimer.current)
      hintTimer.current = window.setTimeout(() => setPicked(undefined), 5000)
    } catch {
      // Escape aborts the eyedropper with an AbortError; nothing to apply.
    } finally {
      setPicking(false)
    }
  }

  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined
  const popoverHeight = 340
  const flipUp = rect ? rect.bottom + popoverHeight + 8 > window.innerHeight : false

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="color-palette-trigger"
        aria-label={`${label}：${value}，打开颜色选择`}
        title={`${label} ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="color-palette-swatch" style={{ background: value }} aria-hidden="true" />
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      <input
        ref={nativeInputRef}
        type="color"
        className="color-palette-native"
        value={normalizeHex(value)}
        tabIndex={-1}
        aria-hidden="true"
        // Native popups fire 'input' on every drag tick; commit once on change.
        onChange={(event) => apply(event.target.value)}
      />
      {open && rect && createPortal(
        <div
          className="color-palette-popover"
          role="dialog"
          aria-label={`${label} · 颜色选择`}
          style={{
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)),
            top: flipUp ? Math.max(8, rect.top - popoverHeight - 6) : rect.bottom + 6,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="color-palette-heading">主题颜色</div>
          <div className="color-palette-grid">
            {THEME_BASE.map((color) => (
              <button key={`base-${color}`} type="button" className="color-swatch" style={{ background: color }} data-active={normalizeHex(value) === color || undefined} aria-label={color} title={color} onClick={() => apply(color)} />
            ))}
            {THEME_LEVELS.map((level) => (
              THEME_BASE.map((base) => {
                const color = shade(base, level)
                return <button key={`${level}-${base}`} type="button" className="color-swatch" style={{ background: color }} data-active={normalizeHex(value) === color || undefined} aria-label={color} title={color} onClick={() => apply(color)} />
              })
            ))}
          </div>
          <div className="color-palette-heading">灰度 / 标准颜色</div>
          <div className="color-palette-grid">
            {GRAYS.map((color) => (
              <button key={color} type="button" className="color-swatch" style={{ background: color }} data-active={normalizeHex(value) === color || undefined} aria-label={color} title={color} onClick={() => apply(color)} />
            ))}
          </div>
          <div className="color-palette-grid color-palette-grid--standard">
            {STANDARD.map((color) => (
              <button key={color} type="button" className="color-swatch" style={{ background: color }} data-active={normalizeHex(value) === color || undefined} aria-label={color} title={color} onClick={() => apply(color)} />
            ))}
          </div>
          {recents.length > 0 && (
            <>
              <div className="color-palette-heading">最近使用</div>
              <div className="color-palette-grid color-palette-grid--standard">
                {recents.map((color) => (
                  <button key={color} type="button" className="color-swatch" style={{ background: color }} data-active={normalizeHex(value) === color || undefined} aria-label={color} title={color} onClick={() => apply(color)} />
                ))}
              </div>
            </>
          )}
          <div className="color-palette-custom">
            <button type="button" onClick={() => void pickFromPage()} disabled={!eyeDropperCtor()}>
              <Pipette size={13} aria-hidden="true" /> 从页面取色
            </button>
            <button type="button" onClick={() => nativeInputRef.current?.click()}>
              <SlidersHorizontal size={13} aria-hidden="true" /> 更多颜色…
            </button>
          </div>
        </div>,
        document.body,
      )}
      {(picking || picked) && createPortal(
        <div className="eyedrop-hint" role="status">
          {picking ? (
            <>
              <span className="color-palette-swatch" style={{ background: value }} aria-hidden="true" />
              <span>点击页面任意位置取色，Esc 取消</span>
            </>
          ) : (
            <>
              <span className="color-palette-swatch" style={{ background: picked }} aria-hidden="true" />
              <strong>{picked}</strong>
              <button
                type="button"
                onClick={() => {
                  window.clearTimeout(hintTimer.current)
                  setPicked(undefined)
                  setOpen(true)
                }}
              >返回颜色设置</button>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => {
                  window.clearTimeout(hintTimer.current)
                  setPicked(undefined)
                }}
              ><X size={12} /></button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
