import { uid } from './cn'
import { buildOcrText, normalizeOcrWords, ocrDisplayWord, reconstructOcrTables } from './ocr'
import type { OcrPageLayer, OcrWord } from '../types/pdf'

type Box = Pick<OcrWord,'x'|'y'|'width'|'height'|'points'>

/** WinRT/Paddle sees the upright displayed crop, including a white pixel border.
 * Compute reading order/cells there, then invert the view turn ONCE for storage.
 * Rendering, copying and saving all continue to use unrotated source coordinates. */
export function ocrLayerFromResult(result: OcrRecognitionResult, content: Box, rotation: number,
  mode: 'auto' | 'printed' | 'handwriting' | 'mixed'): OcrPageLayer {
  const upright = normalizeOcrWords(result.items.map(item=>({
    text:item.correctedText ?? item.text, rawText:item.rawText ?? item.text, correctedText:item.correctedText ?? item.text,
    confidence:item.confidence, x:item.box.x-content.x, y:item.box.y-content.y, width:item.box.width, height:item.box.height,
    rotation:item.box.rotation, points:item.box.points?.map(p=>({x:p.x-content.x,y:p.y-content.y})) as OcrWord['points'],
    candidates:item.candidates, requiresReview:item.requiresReview,
  })),content)
  const inverse=(360-rotation%360)%360
  function sourceBox(b: Box | undefined): Box | undefined {
    if(!b || !inverse)return b
    const {x,y,width:w,height:h}=b
    const points=b.points ?? [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]
    const src=ocrDisplayWord({...b,points,text:'',confidence:0},inverse)
    return {x:src.x,y:src.y,width:src.width,height:src.height,points:src.points}
  }
  const text=upright.length ? buildOcrText(upright) : result.correctedText?.trim() || result.text.trim()
  const rawText=upright.length ? buildOcrText(upright.map(w=>({...w,text:w.rawText ?? w.text}))) : result.rawText?.trim() || result.text.trim()
  const tables=reconstructOcrTables(upright,result.correctedText?.trim() || result.text)
  return {text,correctedText:text,rawText,confidence:result.confidence,
    words:inverse ? upright.map(w=>ocrDisplayWord(w,inverse)) : upright,
    tables:inverse ? tables.map(t=>({...t,bounds:sourceBox(t.bounds),cells:t.cells?.map(row=>row.map(cell=>({...cell,bounds:sourceBox(cell.bounds)})))})) : tables,
    engine:result.engine ?? 'PaddleOCR + ONNX Runtime',version:result.model ?? 'PP-OCRv6 Small',
    mode:mode==='auto'?'mixed':mode,language:result.model?.match(/^Windows OCR \(([^)]+)\)$/)?.[1] ?? '引擎未报告语言',
    documentType:result.documentType,warnings:result.warnings,createdAt:new Date().toISOString(),revision:uid()}
}
