import { useEffect, useRef, useState, useMemo } from 'react'
import {flushSync} from 'react-dom'
import { Check, Pencil, SlidersHorizontal, Trash2, Grid2X2 } from 'lucide-react'
import type { DocumentWatermark } from '../types/pdf'
import { PDF_CSS_UNITS } from '../lib/cn'
import { clampWatermarkBox, watermarkTileBoxes, watermarkFont } from '../lib/watermark'
import { holdObjectCursor, gripCursor, resizeAtGrip, signedAngle, turnFrom, type Grip as AnnotationResizeDir } from '../lib/objectTransform'
import { ObjectTypography, type TypeStyle } from './ObjectTypography'
import { PageToolRail } from './PageToolRail'
import { ObjectHandles } from './ObjectHandles'
import { CompactPopover } from './CompactPopover'
import { frameSampler } from '../lib/gesturePreview'

interface WatermarkLayerProps {
  watermark: DocumentWatermark
  /** True while the watermark tool is active; otherwise the layer is display-only. */
  interactive: boolean
  selected: boolean
  zoom: number
  /** Displayed page size in PDF points (post-rotation). */
  pageWidthPt: number
  pageHeightPt: number
  onSelect?: () => void
  onChange?: (next: DocumentWatermark) => void
  onRemove?: () => void
  onDone?: () => void
}

let textMeasurer: CanvasRenderingContext2D | undefined

/** Width of watermark text rendered at `fontPx`, matching rasterizeWatermarkText's font. */
export function measureWatermarkTextWidth(text: string, fontPx: number, bold?: boolean,fontFamily?:string,italic?:boolean) {
  textMeasurer ??= document.createElement('canvas').getContext('2d')!
  textMeasurer.font = watermarkFont(fontPx,{bold,fontFamily,italic})
  return textMeasurer.measureText(text).width
}

/** Horizontal padding baked into the rasterized text image, as a fraction of font size. */
const TEXT_PAD_RATIO = 0.5833
/** Line box height baked into the rasterized text image, as a fraction of font size. */
const TEXT_HEIGHT_RATIO = 1.45

/**
 * Interactive document watermark. Every tile renders from one shared config,
 * so dragging, stretching or editing any tile updates all of them at once.
 * Follows the annotation pattern: local draft during a gesture, one committed
 * undo entry on pointer-up.
 */
export function WatermarkLayer({
  watermark,
  interactive,
  selected,
  zoom,
  pageWidthPt,
  pageHeightPt,
  onSelect,
  onChange,
  onRemove, onDone,
}: WatermarkLayerProps) {
  const [draft, setDraft] = useState(watermark)
  const [anchor,setAnchor] = useState({x:.5,y:.5})
  const [turning,setTurning]=useState(false),[options,setOptions]=useState(false)
  const proxy=useRef<HTMLDivElement>(null), styleButton=useRef<HTMLButtonElement>(null), positionRail=useRef<() => void>()
  const [editing, setEditing] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const cancelEdit = useRef(false)
  /** Reverts/aborts an in-flight gesture; set by startPointer, used on unmount. */
  const dragTeardown = useRef<() => void>()
  useEffect(() => setDraft(watermark), [watermark])
  useEffect(() => {
    if (!interactive || !selected) { setEditing(false);setOptions(false);dragTeardown.current?.() }
  }, [interactive,selected])
  // A gesture owns window listeners; never let them outlive the component.
  useEffect(() => () => dragTeardown.current?.(), [])

  /** Start a fresh text-edit session (never inherit a stale Escape-cancel flag). */
  const beginEdit = (tileIndex?: number) => {
    cancelEdit.current = false
    if (tileIndex !== undefined) focusTile(boxes[tileIndex])
    setEditing(true)
  }

  const boxes = watermarkTileBoxes(draft)
  const focusTile=(b:typeof boxes[number])=>setAnchor({x:b.x+b.width/2,y:b.y+b.height/2})
  const distance=(b:typeof boxes[number])=>(b.x+b.width/2-anchor.x)**2+(b.y+b.height/2-anchor.y)**2
  const primary=boxes.reduce((best,b,i)=>distance(b)<distance(boxes[best])?i:best,0)
  const pageWidthPx = pageWidthPt * PDF_CSS_UNITS * zoom
  const pageHeightPx = pageHeightPt * PDF_CSS_UNITS * zoom

  const commit = (next: DocumentWatermark) => {
    const clamped = next.tiled
      ? next
      : { ...next, ...clampWatermarkBox(next) }
    draftRef.current=clamped;setDraft(clamped)
    onChange?.(clamped)
  }

  /**
   * Re-fit the box to the text's natural aspect after a content edit, keeping
   * height (font size) and center X. Typing must never deform glyphs: the box
   * tracks the text instead of scaleX stretching it. Computed in points so the
   * result is zoom-independent and matches the export raster aspect exactly.
   */
  const fitTextToBox = (current: DocumentWatermark): DocumentWatermark => {
    if (current.kind !== 'text') return current
    const fontPt = (current.height * pageHeightPt) / TEXT_HEIGHT_RATIO
    const naturalPt =
      measureWatermarkTextWidth(current.text || '水印', fontPt, current.bold,current.fontFamily,current.italic) + fontPt * TEXT_PAD_RATIO
    let width = naturalPt / pageWidthPt
    let height = current.height
    const maxWidth = 0.92 // matches the dialog's cap for single watermarks
    if (width > maxWidth) {
      height = Math.max(0.015, height * (maxWidth / width))
      width = maxWidth
    }
    const centerX = current.x + current.width / 2
    return { ...current, width, height, x: centerX - width / 2 }
  }

  /**
   * Keyboard resize on a focused corner handle: arrows nudge 0.5% (Shift 2%).
   * Auto-repeat updates only the draft; the whole streak commits ONCE on
   * keyup/blur so a held key cannot flood the undo history with per-tick steps.
   */
  const keyResizeStreak = useRef(false)
  const commitKeyResizeStreak = () => {
    if (!keyResizeStreak.current) return
    keyResizeStreak.current = false
    // setWatermark swallows value-equal commits, so a streak that ended back
    // at its start leaves no undo entry.
    commit(draftRef.current)
  }
  const keyResize = (event: React.KeyboardEvent, dir: AnnotationResizeDir) => {
    if (event.type === 'keyup') {
      commitKeyResizeStreak()
      return
    }
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const vertical = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!horizontal && !vertical) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 0.02 : 0.005
    const box=resizeAtGrip(boxes[primary],dir,horizontal*step*pageWidthPx,vertical*step*pageHeightPx,pageWidthPx,pageHeightPx,draft.rotation,{minW:.04,minH:.025,aspect:event.ctrlKey,tiled:draft.tiled})
    keyResizeStreak.current=true;focusTile(box);const next={...draftRef.current,...box};draftRef.current=next;setDraft(next)
  }

  const startPointer = (event: React.PointerEvent, mode: 'move' | 'resize' | 'rotate', tileIndex: number, dir?: AnnotationResizeDir) => {
    if(!interactive || event.button!==0 || !event.isPrimary || dragTeardown.current)return
    if(mode==='move' && (event.target as HTMLElement).closest('textarea,button,input,select'))return
    const el=event.currentTarget as HTMLElement, sheet=el.closest<HTMLElement>('.pdf-page'),page=sheet?.getBoundingClientRect()
    if(!page||!sheet)return
    event.preventDefault();event.stopPropagation();onSelect?.();setOptions(false)
    const tile=boxes[tileIndex],initial={...draft},start={x:event.clientX,y:event.clientY},pointer=event.pointerId
    const centre={x:page.left+(tile.x+tile.width/2)*page.width,y:page.top+(tile.y+tile.height/2)*page.height}
    const unpin=mode==='move'?undefined:holdObjectCursor(mode==='rotate'?'var(--object-turn-cursor)':gripCursor(dir!,initial.rotation))
    const scroller=sheet.closest<HTMLElement>('.split-pane__body,.stage'),sx=scroller?.scrollLeft??0,sy=scroller?.scrollTop??0
    const direct=mode==='rotate'||(mode==='move'&&!initial.tiled)
    sheet.dataset.watermarkGesture=mode
    focusTile(tile);let moved=false,latest=initial,lastEvent:PointerEvent|undefined
    if(mode==='rotate')setTurning(true)
    const apply=(ev:PointerEvent)=>{
      const scrollX=(scroller?.scrollLeft??0)-sx,scrollY=(scroller?.scrollTop??0)-sy,dx=ev.clientX-start.x+scrollX,dy=ev.clientY-start.y+scrollY
      if(!moved && Math.hypot(dx,dy)<2)return
      moved=true
      if(mode==='rotate')latest={...initial,rotation:turnFrom(start,{x:ev.clientX+scrollX,y:ev.clientY+scrollY},centre,initial.rotation,ev.shiftKey)}
      else if(mode==='resize' && dir){const box=resizeAtGrip(tile,dir,dx,dy,page.width,page.height,initial.rotation,{minW:.04,minH:.025,aspect:dir.length===2&&ev.ctrlKey,tiled:initial.tiled});latest={...initial,...box};focusTile(box)}
      else{let next={...tile,x:tile.x+dx/page.width,y:tile.y+dy/page.height};if(!initial.tiled)next=clampWatermarkBox(next);latest={...initial,...next};if(!direct)focusTile(next)}
      if(direct){
        if(mode==='rotate'){sheet.style.setProperty('--wm-turn',`${latest.rotation}deg`);const n=proxy.current?.querySelector('.transform-angle');if(n)n.textContent=`${Math.round(latest.rotation)}°`}
        else sheet.style.setProperty('--wm-offset',`${(latest.x-tile.x)*page.width}px ${(latest.y-tile.y)*page.height}px`)
        positionRail.current?.();return
      }
      draftRef.current=latest;setDraft(latest)
    }
    const samples=frameSampler(apply)
    const scrolled=()=>{if(lastEvent)samples.push(lastEvent)};scroller?.addEventListener('scroll',scrolled,{passive:true})
    const detach=()=>{unpin?.();scroller?.removeEventListener('scroll',scrolled);delete sheet.dataset.watermarkGesture;sheet.style.removeProperty('--wm-turn');sheet.style.removeProperty('--wm-offset');samples.cancel();dragTeardown.current=undefined;setTurning(false);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',lost,true);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',esc,true);el.removeEventListener('lostpointercapture',lost);if(el.hasPointerCapture(pointer))el.releasePointerCapture(pointer)}
    const cancel=()=>{detach();draftRef.current=initial;setDraft(initial);focusTile(tile);positionRail.current?.()}
    const lost=(ev:PointerEvent)=>{if(ev.pointerId===pointer)cancel()}
    const esc=(ev:KeyboardEvent)=>{if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();cancel()}}
    const move=(ev:PointerEvent)=>{if(ev.pointerId!==pointer)return;if(!(ev.buttons&1)){cancel();return}ev.preventDefault();lastEvent=ev;samples.push(ev)}
    const end=(ev:PointerEvent)=>{if(ev.pointerId!==pointer || ev.button!==0)return;samples.cancel();apply(ev);detach();if(moved)flushSync(()=>commit(latest))}
    dragTeardown.current=cancel;try{el.setPointerCapture(pointer)}catch{/* detached tile: window still receives the pointer */}
    window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',lost,true);window.addEventListener('blur',cancel);window.addEventListener('keydown',esc,true);el.addEventListener('lostpointercapture',lost)
  }

  const text=draft.text??'',fontPx=Math.max(6,draft.height*pageHeightPx/TEXT_HEIGHT_RATIO)
  // All repeated tiles have the same text and dimensions. Moving a tiled
  // watermark must not remeasure hundreds of identical glyph runs per frame.
  const natural=useMemo(()=>draft.kind==='text'?measureWatermarkTextWidth(text||'水印',fontPx,draft.bold,draft.fontFamily,draft.italic)+fontPx*TEXT_PAD_RATIO:1,[draft.kind,text,fontPx,draft.bold,draft.fontFamily,draft.italic])
  const scaleX=Math.max(.05,Math.min(24,draft.width*pageWidthPx/Math.max(1,natural)))
  const renderText = () => {
    return (
      <span
        className="watermark-tile__text"
        style={{
          fontSize: fontPx,fontFamily:draft.fontFamily||'Microsoft YaHei',fontStyle:draft.italic?'italic':'normal',
          color: draft.color ?? '#263d4d',
          fontWeight: draft.bold === false ? 400 : 700,
          opacity: draft.opacity,
          transform: `scaleX(${scaleX})`,
        }}
      >
        {text || '水印'}
      </span>
    )
  }

  const changeType=(patch:TypeStyle)=>{
    const {fontSize,...style}=patch,next={...draftRef.current,...style}
    if(fontSize!==undefined){const height=Math.max(.015,Math.min(.85,fontSize*TEXT_HEIGHT_RATIO/pageHeightPt));next.y+=(next.height-height)/2;next.height=height}
    commit(fontSize!==undefined||'fontFamily' in style||'bold' in style||'italic' in style?fitTextToBox(next):next)
  }
  const toggleTile=()=>{const current=draftRef.current;setAnchor({x:.5,y:.5});commit({...current,tiled:!current.tiled,...(current.tiled?clampWatermarkBox({...current,x:.5-current.width/2,y:.5-current.height/2}):{})})}

  const tiles = boxes.map((box, index) => {
    const isPrimary = selected && index === primary
    return (
      <div
        key={index}
        className="annotation watermark-tile"
        data-selected={isPrimary || undefined}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : -1}
        aria-label={interactive ? `水印${draft.tiled ? `（平铺 ${index + 1}/${boxes.length}）` : ''}，可拖动、拉伸，双击编辑` : undefined}
        style={{
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
          // Opacity belongs to the watermark CONTENT (text/image below), not
          // the tile: the selection frame, corner handles and settings bar
          // are UI and must stay fully opaque while editing.
          transform: draft.rotation ? `rotate(${draft.rotation}deg)` : undefined,
          ['--annotation-zoom' as string]: zoom,
        }}
        onPointerDown={(event) => startPointer(event, 'move', index)}
        onDoubleClick={(event) => {
          if (!interactive || draft.kind !== 'text') return
          event.stopPropagation()
          onSelect?.()
          beginEdit(index)
        }}
        onKeyDown={(event) => {
          if (!interactive) return
          if (event.target instanceof HTMLTextAreaElement) return
          if (event.key === 'Enter' && draft.kind === 'text') {
            event.preventDefault()
            beginEdit(index)
          } else if (event.key === 'Delete') {
            event.preventDefault()
            event.stopPropagation()
            onRemove?.()
          }
        }}
      >
        {draft.kind === 'image' && draft.imageData && (
          <img src={draft.imageData} alt="图片水印" draggable={false} style={{ opacity: draft.opacity }} />
        )}
        {draft.kind === 'text' && !(editing && isPrimary) && renderText()}
        {draft.kind === 'text' && editing && isPrimary && (
          <textarea
            autoFocus
            aria-label="水印文字"
            value={draft.text ?? ''}
            rows={1}
            style={{
              fontFamily:draft.fontFamily||'Microsoft YaHei',fontStyle:draft.italic?'italic':'normal',
              fontSize: Math.max(6, (box.height * pageHeightPx) / TEXT_HEIGHT_RATIO),
              color: draft.color ?? '#263d4d',
              fontWeight: draft.bold === false ? 400 : 700,
            }}
            onFocus={(event) => event.currentTarget.select()}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const text = event.target.value.replace(/[\r\n]+/g, ' ')
              setDraft((current) => ({ ...current, text }))
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if(event.nativeEvent.isComposing || event.keyCode===229)return
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelEdit.current = true
                setDraft((current) => ({ ...current, text: watermark.text }))
                // Blur BEFORE unmounting: Chromium does not dispatch blur when
                // a focused element leaves the document, and onBlur is the only
                // place that consumes cancelEdit — a stale flag would silently
                // drop the NEXT edit's commit.
                event.currentTarget.blur()
                setEditing(false)
              }
            }}
            onBlur={() => {
              setEditing(false)
              if (cancelEdit.current) {
                cancelEdit.current = false
                return
              }
              // Enter and blur both land here; commit only real changes so
              // one edit gesture produces exactly one undo entry. A text
              // change re-fits the box so glyphs keep their natural shape.
              const current = draftRef.current
              if (current.text !== watermark.text) commit(fitTextToBox(current))
            }}
          />
        )}
      </div>
    )
  })

  const primaryBox = boxes[primary]
  return (
    <>
      <div className="watermark-layer" data-interactive={interactive || undefined} aria-label="水印层">
        {tiles}
      </div>
      {/* Interaction chrome lives in an UNCLIPPED sibling: the tiles layer
          overflow-clips to the page, which would cut off corner handles,
          rotate zones and the settings bar whenever the watermark sits near a
          page edge. The proxy mirrors the primary tile's geometry/rotation. */}
      {interactive && selected && primaryBox && (
        <div className="watermark-ui-layer">
          <div
            ref={proxy} className="watermark-ui"
            style={{
              left: `${primaryBox.x * 100}%`,
              top: `${primaryBox.y * 100}%`,
              width: `${primaryBox.width * 100}%`,
              height: `${primaryBox.height * 100}%`,
              transform: draft.rotation ? `rotate(${draft.rotation}deg)` : undefined,
              ['--annotation-zoom' as string]: zoom,
            }}
          >
            <ObjectHandles label="水印" angle={draft.rotation} turning={turning} onStart={(event,mode,dir)=>startPointer(event,mode,primary,dir)} onAngle={rotation=>commit({...draft,rotation})} onSizeKey={keyResize} onSizeKeyUp={keyResize} onSizeBlur={commitKeyResizeStreak}/>
          </div>
          <PageToolRail anchor={proxy} followMove={positionRail} geometry={`${primaryBox.x}:${primaryBox.y}:${draft.width}:${draft.height}:${draft.rotation}:${zoom}`} label="水印设置" className="annotation-editor text-format-rail shared-object-rail watermark-tools-rail">
            {draft.kind==='text'&&<ObjectTypography value={{...draft,bold:draft.bold!==false,fontSize:Math.round(draft.height*pageHeightPt/TEXT_HEIGHT_RATIO)}} min={4} max={180} colorLabel="水印文字颜色" onPatch={changeType}/>}
            <button type="button" aria-label="每页平铺水印" aria-pressed={draft.tiled} title={draft.tiled?'改为每页一个':'在每页平铺'} onClick={toggleTile}><Grid2X2 size={14}/></button>
            <button ref={styleButton} type="button" aria-label="水印样式" title="不透明度与精确角度" aria-haspopup="dialog" aria-expanded={options} onClick={()=>setOptions(o=>!o)}><SlidersHorizontal size={15}/></button>
            <button type="button" className="danger" aria-label="删除水印" title="删除水印（可撤销）" onClick={()=>onRemove?.()}><Trash2 size={14}/></button>
            <button type="button" aria-label="完成水印编辑" title="完成编辑" onClick={onDone}><Check size={15}/></button>
          </PageToolRail>
          {options && <CompactPopover anchor={styleButton} role="dialog" label="水印样式" className="watermark-tools-pop" onClose={()=>setOptions(false)}>
            {draft.kind==='text'&&<button type="button" aria-label="编辑水印文字" onClick={()=>{setOptions(false);beginEdit()}}><Pencil size={13}/> 编辑文字</button>}
            <label>不透明度<input aria-label="不透明度" type="range" min={5} max={80} value={Math.round(draft.opacity*100)}
              onChange={e=>{const next={...draftRef.current,opacity:+e.target.value/100};draftRef.current=next;setDraft(next)}}
              onPointerUp={()=>commit(draftRef.current)} onKeyUp={e=>{if(e.key.startsWith('Arrow')||['End','Home','PageUp','PageDown'].includes(e.key))commit(draftRef.current)}} onBlur={()=>{if(draftRef.current.opacity!==watermark.opacity)commit(draftRef.current)}}/><output>{Math.round(draft.opacity*100)}%</output></label>
            <label>角度<input aria-label="水印角度" type="number" min={-180} max={180} step={1} defaultValue={Math.round(signedAngle(draft.rotation))} onBlur={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))commit({...draftRef.current,rotation:signedAngle(e.target.valueAsNumber)})}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/></label>
            <label>平铺<input type="checkbox" checked={draft.tiled} onChange={toggleTile}/></label>
          </CompactPopover>}
        </div>
      )}
    </>
  )
}
