import { describe, expect, it } from 'vitest'
import { buildOcrText, joinOcrWordsText, normalizeOcrWords, ocrReadingOrder, ocrTableSelectionClipboard, ocrWordSpanPlacement, reconstructOcrTables, tableToTsv } from './ocr'
import type { OcrWord } from '../types/pdf'

const w = (text: string, x:number, y:number, width:number, height=.018): OcrWord => ({text,x,y,width,height,confidence:0})
describe('printed OCR: local table regions, not repeated token edges',()=>{
  it('retains multi-token cells, sparse rows, right-aligned amounts and independent tables amid prose',()=>{
    const words = [
      w('打印发票摘要，仅供校样。',.08,.07,.4),
      w('Item',.10,.18,.06),w('数量',.48,.18,.05),w('金额',.78,.18,.08),
      w('Paper',.10,.22,.053),w('clips',.161,.22,.045),w('2',.50,.22,.018),w('9.00',.80,.22,.06),
      w('免税',.10,.26,.055),
      w('Ink',.10,.30,.035),w('refill',.143,.30,.045),w('1',.50,.30,.018),w('1200.00',.75,.30,.11),
      w('本页合计按实际收款金额为准。',.08,.41,.55),
      w('项目',.15,.6,.08),w('数量',.62,.6,.07),w('纸张',.15,.64,.08),w('18',.65,.64,.04),
    ].reverse()
    const tables=reconstructOcrTables(words)
    expect(tables.map(tableToTsv)).toEqual(['Item\t数量\t金额\nPaper clips\t2\t9.00\n免税\t\t\nInk refill\t1\t1200.00','项目\t数量\n纸张\t18'])
    const cell=tables[0].cells![1][0]
    expect(cell.wordIndexes.map(i=>words[i].text)).toEqual(['Paper','clips'])
    expect(tables[0].cells![2][2].bounds!.width).toBeGreaterThan(0)
  })
  it('does not claim newspaper columns or word spacing as a spreadsheet',()=>{
    const words=Array.from({length:4},(_,i)=>[w('Left column sentence.',.07,.15+i*.033,.39),w('右边一栏，同样是一段正文。',.55,.15+i*.033,.36)]).flat()
    expect(reconstructOcrTables(words)).toEqual([])
    expect(reconstructOcrTables([w('Hello',.1,.1,.06),w('world',.169,.1,.06),w('Hello',.1,.14,.06),w('again',.169,.14,.06)])).toEqual([])
  })
  it('does not inject spaces before punctuation or within a segmented decimal',()=>{
    const words=[w('合同',.10,.1,.08),w('，',.18,.1,.014),w('金额',.194,.1,.08),w('12',.31,.1,.030),w('.',.34,.1,.009),w('50',.349,.1,.03),w('元',.38,.1,.03)]
    expect(buildOcrText(words)).toMatch(/合同，金额.*12\.50/)
  })
})

// Generate detector quads by turning physical pixels, not the normalized square.
function rotatePixels(x: number, y: number, width: number, height: number, degrees: number) {
  const a = degrees * Math.PI / 180, dx = (x - .5) * width, dy = (y - .5) * height
  return { x: width / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: height / 2 + dx * Math.sin(a) + dy * Math.cos(a) }
}
function scanned(words: OcrWord[], width: number, height: number, degrees: number) {
  return normalizeOcrWords(words.map(({ text, x, y, width: w, height: h, confidence }) => {
    const points = [[x,y], [x+w,y], [x+w,y+h], [x,y+h]].map(([px,py]) => rotatePixels(px,py,width,height,degrees)) as NonNullable<OcrWord['points']>
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    return { text, confidence, points, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs)-Math.min(...xs), height: Math.max(...ys)-Math.min(...ys) }
  }), { width, height })
}

describe('printed reading geometry', () => {
  it.each([[1500, 640, 7], [700, 1520, -8]])('restores every grid cell to source pixels at %i × %i, %i°', (width, height, degrees) => {
    const flat = [w('列', .14,.34,.05,.024), w('余额',.71,.34,.1,.024), w('订',.14,.39,.018,.024), w('单',.159,.39,.018,.024), w('75',.75,.39,.06,.024),
      w('另附',.14,.44,.08,.024), w('余款',.14,.49,.08,.024), w('6',.78,.49,.03,.024)].reverse()
    const words = scanned(flat, width, height, degrees), original = structuredClone(words)
    const [reference] = reconstructOcrTables(scanned(flat, width, height, 0)), [table] = reconstructOcrTables(words)
    expect(table && tableToTsv(table)).toBe('列\t余额\n订单\t75\n另附\t\n余款\t6')
    const legacy = words.map(({pageAspect: _aspect, ...v}) => v)
    expect(reconstructOcrTables(legacy)).toEqual([]) // No physical scale: do not guess a rotated grid.
    expect(reconstructOcrTables(legacy, '', height / width).map(tableToTsv)).toEqual([tableToTsv(table)])
    expect(buildOcrText(words)).toBe('列 余额\n订单 75\n另附\n余款 6')
    for (const [r, row] of table.cells!.entries()) for (const [c, cell] of row.entries()) {
      const upright = reference.cells![r][c], b = upright.bounds!
      const pts = [[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]].map(([x,y]) => rotatePixels(x,y,width,height,degrees))
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      expect(cell.bounds!.x * width).toBeCloseTo(Math.min(...xs), 5)
      expect(cell.bounds!.y * height).toBeCloseTo(Math.min(...ys), 5)
      expect(cell.bounds!.width * width).toBeCloseTo(Math.max(...xs)-Math.min(...xs), 5)
      expect(cell.bounds!.height * height).toBeCloseTo(Math.max(...ys)-Math.min(...ys), 5)
      expect(cell.wordIndexes).toEqual(upright.wordIndexes)
      const placed = ocrWordSpanPlacement({ ...cell.bounds!, text: '', confidence: 0 }, 0, height / width)
      expect(placed.x * width).toBeCloseTo(pts[0].x, 5)
      expect(placed.angle).toBeCloseTo(degrees, 5)
      const turned = ocrWordSpanPlacement({ ...cell.bounds!, text: '', confidence: 0 }, 90, width / height)
      expect(turned.x * height).toBeCloseTo(height - pts[0].y, 5)
      expect(turned.y * width).toBeCloseTo(pts[0].x, 5)
      expect(turned.angle).toBeCloseTo(degrees + 90, 5)
    }
    expect(ocrTableSelectionClipboard([table], table.cells![1][0].wordIndexes)?.tsv).toBe('订单')
    expect(words).toEqual(original)
  })

  it('reads local prose down the columns, not through a numeric grid, title or footer', () => {
    const grid = [w('Area',.10,.10,.07),w('Qty',.61,.10,.04),w('North',.10,.14,.09),w('17',.61,.14,.04)]
    const body = [w('Fresh air enters here',.08,.43,.35),w('窄巷尽头还有一间小书店。',.57,.435,.32),
      w('before the sun rises.',.08,.466,.31),w('沿街的孩子在门口等候。',.57,.47,.31)]
    const words = [...grid,w('A short field report',.08,.32,.6),...body,w('Issue 4',.08,.7,.10)].reverse()
    const {ordered, lineIndex, separators} = ocrReadingOrder(words)
    const expected = 'Area Qty\nNorth 17\nA short field report\nFresh air enters here\nbefore the sun rises.\n窄巷尽头还有一间小书店。\n沿街的孩子在门口等候。\nIssue 4'
    expect(buildOcrText(words)).toBe(expected)
    expect(ordered.map((v,i) => v.text + separators[i]).join('')).toBe(expected)
    expect(joinOcrWordsText(ordered.slice(5,-1),lineIndex)).toBe(expected.split('\n').slice(3,-1).join('\n'))
    expect(reconstructOcrTables(words).map(tableToTsv)).toEqual(['Area\tQty\nNorth\t17'])
    expect(reconstructOcrTables(body.slice(0,2))).toEqual([])
    expect(buildOcrText(body.slice(0,2))).toBe('Fresh air enters here 窄巷尽头还有一间小书店。')
  })

  it('uses a recurring gutter even when the columns have staggered baselines; descriptions in a table still read by row', () => {
    const body = [w('Wind moves through the valley.',.08,.30,.32),w('Clouds drift above the ridge.',.59,.316,.33),
      w('The reeds begin to sway.',.08,.34,.34),w('Rain reaches the next town.',.59,.356,.32)]
    expect(buildOcrText(body)).toBe([body[0],body[2],body[1],body[3]].map(v => v.text).join('\n'))
    const table = [w('Cause',.08,.26,.09),w('Effect',.59,.26,.09), ...body.map((v,i) => ({...v, y: i < 2 ? .30 : .34}))]
    expect(buildOcrText(table)).toBe('Cause Effect\nWind moves through the valley. Clouds drift above the ridge.\nThe reeds begin to sway. Rain reaches the next town.')
    expect(reconstructOcrTables(table).map(tableToTsv)).toEqual(['Cause\tEffect\nWind moves through the valley.\tClouds drift above the ridge.\nThe reeds begin to sway.\tRain reaches the next town.'])
  })

  it('keeps ordinary English spaces and joins a fragment only with local spacing evidence', () => {
    const words = [w('We',.06,.2,.03,.023),w('watch',.10,.2,.06,.023),w('the',.17,.2,.03,.023),
      w('sun',.21,.2,.035,.023),w('light',.248,.2,.041,.023),w('return',.30,.2,.067,.023)]
    expect(buildOcrText(words)).toBe('We watch the sunlight return')
    expect(buildOcrText(words.slice(3,5))).toBe('sun light') // Two fragments alone do not prove a compound.
  })

  it('keeps a supported sparse header and last value, without claiming neighboring captions or guessing a header', () => {
    const inputs = [w('说明',.11,.12,.07),w('件数',.72,.16,.06),
      w('零件',.11,.20,.07),w('34',.74,.20,.04),w('包装',.11,.24,.07),w('5',.76,.24,.02),
      w('109',.72,.28,.06),w('附注',.11,.32,.07)].reverse()
    const words = scanned(inputs,1400,900,3.6), [grid] = reconstructOcrTables(words)
    expect(grid && tableToTsv(grid)).toBe('\t件数\n零件\t34\n包装\t5\n\t109')
    expect(grid.cells![0][0].wordIndexes).toEqual([])
    expect(grid.cells![0][1].wordIndexes.map(i => words[i].text)).toEqual(['件数'])
    expect(ocrTableSelectionClipboard([grid], [0, words.length-1])).toBeUndefined()
    const offPitch = inputs.map(v => v.text === '件数' ? {...v, y:.145} : v.text === '109' ? {...v, x:.55} : v)
    expect(reconstructOcrTables(offPitch).map(tableToTsv)).toEqual(['零件\t34\n包装\t5'])
    // Only one observed pair: the right-side list is not evidence for a whole grid.
    expect(reconstructOcrTables(inputs.filter(v => v.text !== '零件'))).toEqual([])
  })

  it('joins only nearby numeric fragments; folds a decimal, not arbitrary punctuation or spelling', () => {
    const line = [w('应',.05,.25,.026,.027),w('付',.077,.25,.026,.027),w('Net',.12,.25,.041,.024),w('due',.17,.25,.045,.024),
      w('3',.46,.25,.012,.025),w('7',.479,.25,.017,.025),w('．',.499,.271,.004,.004),w('06',.506,.25,.027,.025),
      w('42',.76,.25,.032,.025),w('。',.794,.27,.006,.006)]
    const words = scanned(line,1200,850,-4), {ordered,lineIndex} = ocrReadingOrder(words)
    expect(buildOcrText(words)).toBe('应付 Net due 37.06 42。')
    expect(joinOcrWordsText(ordered.slice(4,8),lineIndex)).toBe('37.06')
    expect(words.map(v => v.text)).toEqual(line.map(v => v.text))
    expect(buildOcrText([w('记录',.1,.1,.08),w('．',.181,.1,.01),w('ltem',.22,.1,.07)])).toBe('记录． ltem')
    expect(buildOcrText([w('3',.1,.1,.02),w('8',.21,.1,.02)])).toBe('3 8')
    expect(buildOcrText([w('余',.1,.1,.02),w('35',.121,.1,.03),w('元',.152,.1,.02)])).toBe('余35元')
    expect(buildOcrText([w('35．',.1,.1,.06),w('交付',.2,.1,.06)])).toBe('35． 交付')
  })
})

describe('physical OCR glyph geometry',()=>{
  it('matches physical edge lengths and physical angle on an oblong rotated page',()=>{
    const word:OcrWord={...w('skew',.1,.1,.31,.05),points:[{x:.1,y:.1},{x:.4,y:.12},{x:.395,y:.14},{x:.095,y:.12}]}
    const p=ocrWordSpanPlacement(word,0,2)
    expect(p.angle).toBeCloseTo(Math.atan2(.04,.3)*180/Math.PI,6)
    expect(p.width).toBeCloseTo(Math.hypot(.3,.04),7)
    const turned=ocrWordSpanPlacement(word,90,.5)
    expect(turned.angle).toBeCloseTo(90+p.angle,6)
    expect(turned.width).toBeCloseTo(p.width*.5,6)
    const legacy=ocrWordSpanPlacement(w('old',.1,.2,.3,.04),90,.5)
    expect(legacy.angle).toBe(90);expect(legacy.x).toBeCloseTo(.8);expect(legacy.width).toBeCloseTo(.15)
  })
})
