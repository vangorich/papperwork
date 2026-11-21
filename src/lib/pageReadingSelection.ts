import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import { bandPath, getOcrRunFrame, ocrGapDistance, ocrSelectionBands, selectedOcrInk, type SelectedInk } from './ocrSelectionBands'

// The raster owns the printed ink. This layer supplies caret positions, reading order
// and one translucent selection wash; the browser still owns Selection, copy and keys.
type Run = { el: HTMLElement; b: DOMRect; text: string; col?: 0 | 1 }
const mid = (b: DOMRect) => b.top + b.height / 2
const words = (layer: HTMLElement) => Array.from(layer.querySelectorAll<HTMLSpanElement>('span:not(.markedContent):not([role="img"]):not([hidden])')).filter(el => el.firstChild instanceof Text && el.textContent?.trim())
const median = (list: number[]) => list.length ? list.sort((a,b)=>a-b)[list.length>>1] : 0

type NativePaper = { width: number; height: number; boxes: DOMRect[] }

// Capture only flat text metrics from the SAME stream PDF.js lays out. The
// view and glyph advances are in unturned CropBox units, unaffected by zoom,
// page-turn animation, fallback-font timing or fractional DOM rounding.
export function nativeReadingStream(view: readonly number[]) {
  const [left, bottom, right, top] = view
  const boxes: DOMRect[] = [], styles: TextContent['styles'] = Object.create(null)
  let flat = true
  const stream = new TransformStream<TextContent, TextContent>({ transform(chunk, out) {
    out.enqueue(chunk)
    if (!flat) return
    Object.assign(styles, chunk.styles) // fonts are sent only on first use, not in every chunk
    for (const item of chunk.items) {
      if ('str' in item && boxes.length < 12000) {
        if (!item.str.trim()) { boxes.push(new DOMRect()); continue } // one slot per PDF.js textDiv, including EOL
        const [a, b, c, d, x, y] = item.transform, font = styles[item.fontName]
        if (item.dir === 'ltr' && !font?.vertical && a > 0 && d > 0 && Math.abs(b) < 1e-6*a && Math.abs(c) < 1e-6*d && item.width > 0) {
          boxes.push(new DOMRect(x-left, top-y-d*(font?.ascent ?? .8), item.width, d)); continue
        }
      }
      flat = false; boxes.length = 0; break // marked group, bidi, vertical or ambiguous axes: no reordering
    }
  } })
  return { width: right - left, height: top - bottom, boxes, stream }
}

/** The browser keeps the real glyph nodes for carets, search and selection. */
export function prepareNativeReading(layer: HTMLElement, spans: HTMLElement[], paper?: NativePaper) {
  if (paper && (paper.boxes.length !== spans.length || layer.querySelector('.markedContent') ||
      spans.some(el => (el.hasAttribute('dir') && el.getAttribute('dir') !== 'ltr') || el.style.transform.includes('rotate')))) paper = undefined
  // Ambiguous pages keep PDF.js order and the existing viewport-based table fallback.
  const viewport = layer.getBoundingClientRect(), { width, height } = paper ?? viewport
  const measured: Run[] = [], seen = new Map<string, Run[]>(), duplicates: HTMLElement[] = []
  for (const [index, el] of spans.entries()) {
    const text = el.textContent?.trim()
    if (!text || !layer.contains(el)) continue
    const b = paper ? paper.boxes[index] : el.getBoundingClientRect()
    if (!(b.width > 0 && b.height > 0)) continue
    if (!paper) { b.x -= viewport.left; b.y -= viewport.top }
    const run: Run = { el, b, text }
    if (paper) {
      const peers = seen.get(text) ?? [], eps = Math.min(2, b.height * .13)
      if (peers.some(p => Math.abs(p.b.top-b.top) < eps && Math.abs(p.b.left-b.left) < eps && Math.abs(p.b.right-b.right) < eps)) {
        duplicates.push(el); continue
      }
      peers.push(run); seen.set(text, peers)
    }
    measured.push(run)
  }
  for (const el of duplicates) { el.hidden = true; el.setAttribute('aria-hidden', 'true') }
  if (paper && measured.length > 1) orderNativeRuns(layer, measured, width)
  return { width, height, runs: measured }
}

function orderNativeRuns(layer: HTMLElement, measured: Run[], width: number) {
  measured.sort((a,b)=>mid(a.b)-mid(b.b)||a.b.left-b.b.left)
  const rows:Run[][]=[];let current:Run[]=[]
  for(const run of measured){if(!current.length||Math.abs(mid(run.b)-mid(current[0].b))>Math.min(run.b.height,current[0].b.height)*.46){current=[];rows.push(current)}current.push(run)}
  const gaps:{l:number;r:number;row:number}[]=[]
  rows.forEach((row,idx)=>{row.sort((a,b)=>a.b.left-b.b.left);row.forEach((v,i)=>{if(i&&v.b.left-row[i-1].b.right>Math.max(width*.047,v.b.height*2))gaps.push({l:row[i-1].b.right,r:v.b.left,row:idx})})})
  // Choose the best continuous gap cheaply, using a fixed sampling grid instead of comparing every pair of words.
  let cut=0,support=0
  for(let i=3;i<22;i++){const x=width*i/24;const votes=new Set(gaps.filter(g=>g.l<x&&g.r>x).map(g=>g.row)).size;if(votes>support){cut=x;support=votes}}
  const candidates=rows.filter(row=>row.some(v=>v.b.right<cut)&&row.some(v=>v.b.left>cut))
  const prose=support>=2 && candidates.length>=2 && median(candidates.flatMap(row=>[row.filter(v=>v.b.right<cut),row.filter(v=>v.b.left>cut)].map(side=>side.map(v=>v.text).join(' ').length)))>=14 && !candidates.some(row=>row.some(v=>/^[-+¥￥$]?\d[\d,.]*%?$/.test(v.text)))
  const logical:Run[][]=[], left:Run[][]=[],right:Run[][]=[]
  const flush=()=>{logical.push(...left,...right);left.length=right.length=0}
  for(const row of rows){if(!prose||row.some(v=>v.b.left<cut && v.b.right>cut)){flush();logical.push(row);continue}
    const a=row.filter(v=>v.b.right<=cut),b=row.filter(v=>v.b.left>=cut);a.forEach(v=>{v.col=0});b.forEach(v=>{v.col=1});if(a.length)left.push(a);if(b.length)right.push(b)
  }flush()
  const fragment=document.createDocumentFragment();logical.forEach((row,r)=>{if(r)fragment.append(document.createElement('br'));row.forEach((v,i)=>{v.el.dataset.readRow=String(r);if(v.col!==undefined)v.el.dataset.readCol=String(v.col);if(i&&v.b.left-row[i-1].b.right>Math.max(1,v.b.height*.09))v.el.dataset.readSpace='1';fragment.append(v.el)})})
  // PDF.js positions these text leaves absolutely. Keep their exact nodes for search and editing.
  layer.replaceChildren(fragment)
}

const textEnd = (el: HTMLElement) => getOcrRunFrame(el)?.length ?? (el.dataset.ocrIndex !== undefined
  ? (el.firstChild?.textContent ?? '').trimEnd().length : el.firstChild?.textContent?.length ?? 0)
export function clippedRunText(range:Range,el:HTMLSpanElement){const node=el.firstChild;if(!(node instanceof Text)||!range.intersectsNode(node))return '';const len=textEnd(el);return node.data.slice(range.startContainer===node?Math.min(len,range.startOffset):0,range.endContainer===node?Math.min(len,range.endOffset):len)}
export function nativeReadingCopy(layer:HTMLElement,range:Range){
  if(!layer.querySelector('[data-read-row]'))return
  let last:string|undefined,out='';for(const el of layer.querySelectorAll<HTMLSpanElement>('[data-read-row]')){const part=clippedRunText(range,el);if(!part)continue;out+=(last===undefined?'':el.dataset.readRow!==last?'\n':el.dataset.readSpace?' ':'')+part;last=el.dataset.readRow}return out
}

export function installPageReadingSelection(layer:HTMLElement) {
  const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg'), path=document.createElementNS(ns,'path')
  svg.classList.add('page-selection-wash');svg.setAttribute('aria-hidden','true');svg.append(path);layer.after(svg)
  let frame=0,drag:((ev:PointerEvent)=>void)|undefined,id:number|undefined, cache:HTMLSpanElement[]|undefined
  let hatch = false
  function ensureHatch() {
    if (hatch) return
    const defs = document.createElementNS(ns, 'defs'), pattern = document.createElementNS(ns, 'pattern')
    pattern.id = `ocr-paper-selection-${crypto.randomUUID()}`
    pattern.setAttribute('patternUnits','userSpaceOnUse'); pattern.setAttribute('width','4'); pattern.setAttribute('height','4')
    pattern.setAttribute('patternTransform','rotate(35)')
    for (const [width,opacity] of [['4','.23'],['1','.09']]) {
      const stripe = document.createElementNS(ns, 'rect'); stripe.setAttribute('width',width); stripe.setAttribute('height','4')
      stripe.setAttribute('fill','#686868'); stripe.setAttribute('fill-opacity',opacity); pattern.append(stripe)
    }
    defs.append(pattern); svg.append(defs); svg.style.setProperty('--ocr-band-paint', `url(#${pattern.id})`); hatch = true
  }
  function clearPaint() { path.removeAttribute('d'); delete layer.dataset.selectionWash; delete svg.dataset.ocrBandCount }
  function paint() {
    frame = 0
    const selection = window.getSelection(), r = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!r || r.collapsed || !layer.contains(r.startContainer) || !layer.contains(r.endContainer)) { clearPaint(); return }
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) { clearPaint(); return }
    const parts: string[] = [], scratch = document.createRange(), ink: SelectedInk[] = []
    let bands = 0, measured = 0
    const flush = () => { if (ink.length) { const quads = ocrSelectionBands(ink); bands += quads.length; parts.push(bandPath(quads)); ink.length = 0 } }
    const ocr = layer.dataset.ocr === 'true'
    for (const el of cache ?? words(layer)) {
      const n = el.firstChild
      if (!(n instanceof Text) || !r.intersectsNode(n)) continue
      const end = textEnd(el), lo = r.startContainer === n ? Math.min(end,r.startOffset) : 0, hi = r.endContainer === n ? Math.min(end,r.endOffset) : end
      if (hi <= lo) continue
      if (++measured > 12000) { clearPaint(); return } // preserve native selection on exceptionally dense pages
      if (ocr) {
        const run = selectedOcrInk(el,n,lo,hi,rect,scratch)
        if (run) { ink.push(run); continue }
        flush() // Do not bridge a region without a trustworthy baseline.
      }
      scratch.setStart(n,lo); scratch.setEnd(n,hi)
      for (const b of scratch.getClientRects()) if (b.width > .25 && b.height > .25) {
        const x = (b.left-rect.left).toFixed(2), y = (b.top-rect.top).toFixed(2)
        parts.push(`M${x} ${y}h${b.width.toFixed(2)}v${b.height.toFixed(2)}H${x}Z`); if (ocr) bands++
      }
    }
    flush()
    if (!parts.length) { clearPaint(); return }
    if (ocr) { ensureHatch(); svg.dataset.ocrBandCount = String(bands) } else delete svg.dataset.ocrBandCount
    path.setAttribute('d', parts.join('')); layer.dataset.selectionWash = 'true'
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(paint)}
  function stop(){drag=undefined;id=undefined;cache=undefined;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',stop)}
  function move(e:PointerEvent){if(e.pointerId!==id)return;if(!(e.buttons&1)){stop();return}drag?.(e)}
  function up(e: PointerEvent) {
    if (e.pointerId !== id) return
    drag?.(e)
    stop()
    // Coalesce during motion, but don't leave the previous word's strip in place
    // at release. Copy and the visible strip must reflect the same final range.
    cancelAnimationFrame(frame)
    paint()
  }
  function cancel(e:PointerEvent){if(e.pointerId===id)stop()}
  function down(e:PointerEvent){
    if(e.pointerType!=='mouse'||e.button!==0||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey||layer.closest('[data-hand], [data-drawing-tool]'))return
    const root=(e.target as HTMLElement).closest<HTMLSpanElement>('span[data-read-row],span[data-ocr-index]');if(!root||!layer.contains(root)||root.dir==='rtl')return
    const n=root.firstChild, hit=document.caretRangeFromPoint?.(e.clientX,e.clientY);if(!(n instanceof Text)||hit?.startContainer!==n)return
    const anchor=Math.min(hit.startOffset,textEnd(root)),x0=e.clientX,y0=e.clientY;stop();id=e.pointerId
    // A fresh drag inside yesterday's selection otherwise starts a native text DnD,
    // emits pointercancel, and copies the old rows. Preserve modified gestures.
    const previous=window.getSelection()
    if(previous && !previous.isCollapsed && previous.rangeCount && layer.contains(previous.anchorNode) && previous.getRangeAt(0).isPointInRange(n,anchor)) previous.collapse(n,anchor)
    const anchorFrame = getOcrRunFrame(root)
    const rad = (anchorFrame?.angle ?? Number(layer.dataset.mainRotation ?? 0)) * Math.PI / 180
    const vertical = Math.abs(Math.sin(rad)) > Math.abs(Math.cos(rad))
    const backwards = (vertical ? Math.sin(rad) : Math.cos(rad)) < 0
    // Only intervene in whitespace. Inside glyphs and outside this page,
    // Chromium keeps its ligature/grapheme-aware and cross-page behavior.
    drag = v => {
      if (Math.hypot(v.clientX-x0, v.clientY-y0) < 3) return
      const h = document.elementFromPoint(v.clientX, v.clientY)
      if (!h || !layer.contains(h) || h.closest('span')) return
      // A fast first move can already be in the gutter. Extending the range
      // before Blink's first mousemove turns that gesture into text DnD and
      // fires pointercancel. Still resolve a one-move overshoot on pointerup.
      if (root.dataset.readRow !== undefined && v.type === 'pointermove' && window.getSelection()?.isCollapsed) return
      const along = vertical ? v.clientY : v.clientX, cross = vertical ? v.clientX : v.clientY
      const pageBox = anchorFrame ? layer.getBoundingClientRect() : undefined
      const point = pageBox && { x: v.clientX-pageBox.left, y: v.clientY-pageBox.top }
      let best: HTMLSpanElement | undefined, score = Infinity, before = false
      for (const el of (cache ??= words(layer))) {
        if (anchorFrame && pageBox && point) {
          const f = getOcrRunFrame(el)
          if (!f) continue
          const near = ocrGapDistance(f, point, pageBox.width, pageBox.height)
          if (!near) continue
          // Only a tie-breaker for noisy scans; a deliberate cross-line drag still wins.
          const dist = near.score + (f.line === anchorFrame.line ? 0 : .5) + (f.cell === anchorFrame.cell ? 0 : .5)
          if (dist < score) { best = el; score = dist; before = near.before }
          continue
        }
        const b = el.getBoundingClientRect()
        if (cross < (vertical ? b.left : b.top) || cross > (vertical ? b.right : b.bottom)) continue
        const start = vertical ? b.top : b.left, end = vertical ? b.bottom : b.right
        const dist = Math.max(start - along, 0, along - end) + (el.dataset.readCol === root.dataset.readCol ? 0 : 6)
        if (dist < score) { best = el; score = dist; before = (along < start) !== backwards }
      }
      // Native clientWidth is the *unturned* layer's inline extent, even at 90°.
      const inlineSize = anchorFrame && vertical ? layer.clientHeight : layer.clientWidth
      if (best?.firstChild && score <= Math.max(60, inlineSize * .16)) {
        window.getSelection()?.setBaseAndExtent(n, anchor, best.firstChild, before ? 0 : textEnd(best))
      }
    }
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',stop)
  }
  layer.addEventListener('pointerdown',down);document.addEventListener('selectionchange',schedule);window.addEventListener('resize',schedule);const observer=new ResizeObserver(schedule);observer.observe(layer)
  return ()=>{stop();cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('selectionchange',schedule);window.removeEventListener('resize',schedule);layer.removeEventListener('pointerdown',down);svg.remove();delete layer.dataset.selectionWash}
}
