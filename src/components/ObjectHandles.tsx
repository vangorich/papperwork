import { Fragment, type KeyboardEvent, type PointerEvent } from 'react'
import { gripCursor, signedAngle, type Grip } from '../lib/objectTransform'

const corners = ['nw', 'ne', 'sw', 'se'] as const,
  edges = ['n', 's', 'e', 'w'] as const
const names = { nw: '左上', ne: '右上', sw: '左下', se: '右下', n: '上', s: '下', e: '右', w: '左' }
interface Props {
  label: string
  angle: number
  turning: boolean
  onStart: (event: PointerEvent<HTMLElement>, mode: 'resize' | 'rotate', dir: Grip) => void
  onAngle: (angle: number) => void
  onSizeKey: (e: KeyboardEvent, dir: Grip) => void
  onSizeKeyUp?: (e: KeyboardEvent, dir: Grip) => void
  onSizeBlur?: () => void
}
/** Edge, corner and outer corner are disjoint in the object's own frame.
 * No permanent rotation knob; the NE outer zone remains keyboard reachable. */
export function ObjectHandles({
  label,
  angle,
  turning,
  onStart,
  onAngle,
  onSizeKey,
  onSizeKeyUp,
  onSizeBlur,
}: Props) {
  return (
    <div className="object-handles" data-turning={turning || undefined}>
      {edges.map((dir) => (
        <span
          key={dir}
          aria-hidden="true"
          data-edge={dir}
          className="object-edge"
          style={{ cursor: gripCursor(dir, angle) }}
          onPointerDown={(e) => onStart(e, 'resize', dir)}
        />
      ))}
      {corners.map((dir) => (
        <Fragment key={dir}>
          <button
            type="button"
            className="object-corner"
            data-grip={dir}
            style={{ cursor: gripCursor(dir, angle) }}
            aria-label={`${names[dir]}角调整${label}大小`}
            title="拖动角点自由拉伸 · Ctrl 保持长宽比"
            onPointerDown={(e) => onStart(e, 'resize', dir)}
            onKeyDown={(e) => onSizeKey(e, dir)}
            onKeyUp={(e) => onSizeKeyUp?.(e, dir)}
            onBlur={onSizeBlur}
          />
          <button
            type="button"
            className="object-turn-zone"
            data-rotate-zone={dir}
            tabIndex={dir === 'ne' ? 0 : -1}
            aria-label={`${names[dir]}角外侧旋转${label}`}
            title="绕中心旋转 · Shift 吸附 15° · Home 归零"
            onPointerDown={(e) => onStart(e, 'rotate', dir)}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onAngle(0)
            }}
            onKeyDown={(e) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', ' ', 'Enter'].includes(
                  e.key,
                )
              )
                return
              e.preventDefault()
              e.stopPropagation()
              const step = e.shiftKey ? 15 : 1
              onAngle(
                e.key === 'Home'
                  ? 0
                  : signedAngle(
                      angle +
                        (['ArrowLeft', 'ArrowDown'].includes(e.key)
                          ? -step
                          : ['Enter', ' '].includes(e.key)
                            ? 15
                            : step),
                    ),
              )
            }}
          />
        </Fragment>
      ))}
      {turning && (
        <>
          <span className="object-pivot" />
          <span className="transform-angle" style={{ transform: `rotate(${-angle}deg)` }}>
            {Math.round(signedAngle(angle))}°
          </span>
        </>
      )}
    </div>
  )
}
