import { describe, it, expect } from 'vitest'
import { ocrLayerFromResult } from './ocrResultLayer'
import { ocrDisplayWord, ocrWordSpanPlacement, tableToTsv } from './ocr'
import type { OcrWord } from '../types/pdf'

const crop={x:17,y:19,width:900,height:1320}
const parts: [string,number,number,number][]=[['Item',.12,.2,.08],['Total',.62,.2,.09],['Paper',.12,.24,.08],['7.50',.62,.24,.08],['Ink',.12,.28,.06],['19.00',.62,.28,.09]]
const result:OcrRecognitionResult={text:'',confidence:0,mode:'printed',elapsedMs:1,items:parts.map(([text,x,y,w])=>{
  const l=crop.x+x*crop.width,t=crop.y+y*crop.height,width=w*crop.width,height=.017*crop.height
  return {text,confidence:0,box:{x:l,y:t,width,height,rotation:0,points:[{x:l,y:t},{x:l+width,y:t},{x:l+width,y:t+height},{x:l,y:t+height}]}}
})}
describe('recognition at display rotation → source coordinate layer',()=>{
  it.each([0,90,180,270])('keeps every word and cell aligned, in reading order, for %i°',turn=>{
    const straight=ocrLayerFromResult(result,crop,0,'printed'),stored=ocrLayerFromResult(result,crop,turn,'printed')
    expect(stored.text).toBe(straight.text);expect(stored.tables!.map(tableToTsv)).toEqual(['Item\tTotal\nPaper\t7.50\nInk\t19.00'])
    function check(original:OcrWord,source:OcrWord){
      const actual=ocrDisplayWord(source,turn)
      for(const key of ['x','y','width','height'] as const)expect(actual[key]).toBeCloseTo(original[key],9)
      const a=ocrWordSpanPlacement(source,turn,crop.height/crop.width),b=ocrWordSpanPlacement(original,0,crop.height/crop.width)
      for(const k of ['x','y','width','height','angle'] as const)expect(a[k]).toBeCloseTo(b[k],9)
    }
    stored.words.forEach((w,i)=>check(straight.words[i],w))
    for(const [i,row] of stored.tables![0].cells!.entries())for(const [j,c] of row.entries()){
      const ref=straight.tables![0].cells![i][j];expect(c.wordIndexes).toEqual(ref.wordIndexes)
      check({...ref.bounds!,text:'',confidence:0},{...c.bounds!,text:'',confidence:0})
    }
  })
})
