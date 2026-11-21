import { Bold, Italic } from 'lucide-react'
import { ColorPalette } from './ColorPalette'
import { useEffect, useState } from 'react'

export const TYPEFACES = [
  ['Microsoft YaHei', '微软雅黑'],
  ['SimSun', '宋体'],
  ['KaiTi', '楷体'],
  ['Arial', 'Arial'],
  ['Georgia', 'Georgia'],
] as const
export interface TypeStyle {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  color?: string
}
/** Shared, horizontal format vocabulary for text on the page, watermarks and saved phrases. */
export function ObjectTypography({
  value,
  onPatch,
  min = 4,
  max = 96,
  colorLabel = '文字颜色',
}: {
  value: TypeStyle
  onPatch: (patch: TypeStyle) => void
  min?: number
  max?: number
  colorLabel?: string
}) {
  const size = value.fontSize ?? 16,
    [typed, setTyped] = useState(String(size))
  useEffect(() => setTyped(String(size)), [size])
  const commit = () => {
    const n = Number(typed)
    if (!typed.trim() || !Number.isFinite(n)) {
      setTyped(String(size))
      return
    }
    const next = Math.min(max, Math.max(min, Math.round(n)))
    setTyped(String(next))
    if (next !== size) onPatch({ fontSize: next })
  }
  return (
    <div className="object-type-controls" role="group" aria-label="排版样式">
      <select
        aria-label="字体"
        title="字体"
        value={value.fontFamily ?? 'Microsoft YaHei'}
        onChange={(e) => onPatch({ fontFamily: e.target.value })}
      >
        {TYPEFACES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <input
        aria-label="字号"
        title="字号（磅）"
        type="number"
        min={min}
        max={max}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
            e.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        aria-label="粗体"
        title="粗体"
        aria-pressed={!!value.bold}
        onClick={() => onPatch({ bold: !value.bold })}
      >
        <Bold size={13} />
      </button>
      <button
        type="button"
        aria-label="斜体"
        title="斜体"
        aria-pressed={!!value.italic}
        onClick={() => onPatch({ italic: !value.italic })}
      >
        <Italic size={13} />
      </button>
      <ColorPalette
        label={colorLabel}
        value={value.color ?? '#302e29'}
        onChange={(color) => onPatch({ color })}
      />
    </div>
  )
}
