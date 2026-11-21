import { describe, expect, it } from 'vitest'
import type { OcrWord } from '../types/pdf'
import {
  buildOcrText,
  hasSufficientNativeTextLayer,
  joinOcrWordsText,
  normalizeOcrBoundingBox,
  normalizeOcrWords,
  ocrDisplayWord,
  ocrReadingOrder,
  ocrTableRangeClipboard,
  ocrTableSelectionClipboard,
  ocrWordSpanPlacement,
  reconstructOcrTables,
  rotateNormalizedOcrBox,
  sortOcrWordsReadingOrder,
  tablesClipboardPayload,
  tableToTsv,
} from './ocr'

const word = (text: string, x: number, y: number, width = 0.1, height = 0.04): OcrWord => ({
  text, x, y, width, height, confidence: 0.9,
})

describe('OCR geometry helpers', () => {
  it('normalizes pixel bboxes and clips them to page bounds', () => {
    expect(normalizeOcrBoundingBox(
      { x: 200, y: 100, width: 400, height: 80 },
      { width: 1000, height: 500 },
    )).toEqual({ x: 0.2, y: 0.2, width: 0.39999999999999997, height: 0.15999999999999998 })
    expect(normalizeOcrBoundingBox(
      { x: -20, y: 90, width: 50, height: 30 },
      { width: 100, height: 100 },
    )).toEqual({ x: 0, y: 0.9, width: 0.3, height: 0.09999999999999998 })
  })

  it('drops invalid words and normalizes confidence', () => {
    const result = normalizeOcrWords([
      { ...word('  正文  ', 100, 40, 80, 20), confidence: 1.4 },
      word('  ', 10, 10, 10, 10),
      word('outside', 200, 200, 10, 10),
    ], { width: 200, height: 100 })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ text: '正文', confidence: 1 })
    expect(result[0].x).toBeCloseTo(0.5)
    expect(result[0].y).toBeCloseTo(0.4)
    expect(result[0].width).toBeCloseTo(0.4)
    expect(result[0].height).toBeCloseTo(0.2)
  })

  it('maps source bboxes through clockwise page rotation', () => {
    const source = word('A', 0.1, 0.2, 0.3, 0.1)
    const ninety = rotateNormalizedOcrBox(source, 90)
    expect(ninety.x).toBeCloseTo(0.7)
    expect(ninety).toMatchObject({ y: 0.1, width: 0.1, height: 0.3 })
    const oneEighty = rotateNormalizedOcrBox(source, 180)
    expect(oneEighty.x).toBeCloseTo(0.6)
    expect(oneEighty.y).toBeCloseTo(0.7)
    expect(oneEighty).toMatchObject({ width: 0.3, height: 0.1 })
    const twoSeventy = rotateNormalizedOcrBox(source, 270)
    expect(twoSeventy.y).toBeCloseTo(0.6)
    expect(twoSeventy).toMatchObject({ x: 0.2, width: 0.1, height: 0.3 })
  })
})

describe('native text-layer coverage', () => {
  const textItem = (str: string, x: number, y: number) => ({
    str,
    width: str.length * 8,
    height: 12,
    transform: [12, 0, 0, 12, x, y],
  })

  it('does not skip OCR for a residual hidden or partial text fragment', () => {
    expect(hasSufficientNativeTextLayer([
      textItem('残缺的隐藏文字层', 40, 700),
    ], { width: 612, height: 792 })).toBe(false)
    expect(hasSufficientNativeTextLayer([
      textItem('这只是页面第一行的一部分文字', 40, 700),
      textItem('尾部残片', 260, 700),
      textItem('页码', 300, 20),
    ], { width: 612, height: 792 })).toBe(false)
  })

  it('does not treat page-edge metadata as a complete body text layer', () => {
    expect(hasSufficientNativeTextLayer([
      textItem('合同标题与公司名称', 40, 770),
      textItem('归档编号 2026-09-05', 220, 754),
      textItem('扫描设备生成的页眉信息', 40, 738),
      textItem('第 1 页，共 12 页', 250, 24),
    ], { width: 612, height: 792 })).toBe(false)
  })

  it('does not skip OCR for a corrupt Unicode mapping', () => {
    expect(hasSufficientNativeTextLayer([
      textItem('第一行���文字映射已经损坏', 40, 680),
      textItem('第二行���无法可靠搜索复制', 40, 660),
      textItem('第三行���仍应重新执行识别', 40, 640),
      textItem('第四行���用于达到正文长度阈值', 40, 620),
    ], { width: 612, height: 792 })).toBe(false)
  })

  it('skips OCR when substantial text spans several baselines', () => {
    expect(hasSufficientNativeTextLayer([
      textItem('第一行包含足够完整的正文内容用于判断', 40, 700),
      textItem('第二行继续包含可选择的原生 PDF 文本', 40, 680),
      textItem('第三行证明文字层并非单个隐藏残片', 40, 660),
      textItem('第四行补充更多正文字符以达到可靠阈值', 40, 640),
    ], { width: 612, height: 792 })).toBe(true)
  })
})

describe('OCR reading order', () => {
  it('sorts shuffled words by line and then left to right', () => {
    const shuffled = [word('four', 0.3, 0.3), word('two', 0.3, 0.1), word('one', 0.1, 0.1), word('three', 0.1, 0.3)]
    expect(sortOcrWordsReadingOrder(shuffled).map(({ text }) => text)).toEqual(['one', 'two', 'three', 'four'])
    expect(buildOcrText(shuffled)).toBe('one two\nthree four')
  })

  it('does not inject spaces between adjacent CJK words', () => {
    expect(buildOcrText([word('手写', 0.1, 0.1), word('识别', 0.3, 0.1)])).toBe('手写识别')
  })

  it('joins hyphen-wrapped latin words instead of breaking the line', () => {
    expect(buildOcrText([word('exam-', 0.1, 0.1), word('ple', 0.1, 0.2)])).toBe('exam-ple')
    // Real sentence breaks keep their newline.
    expect(buildOcrText([word('end.', 0.1, 0.1), word('Next', 0.1, 0.2)])).toBe('end.\nNext')
  })

  it('keeps skewed lines together when grouping for reading order', () => {
    // A 3° scan: the second word of one physical line drifts below the usual
    // centre-distance threshold and used to split into its own line.
    const skewed = [
      { ...word('first', 0.1, 0.1), rotation: 3 },
      { ...word('second', 0.4, 0.112), rotation: 3 },
      { ...word('third', 0.7, 0.124), rotation: 3 },
    ]
    expect(buildOcrText(skewed)).toBe('first second third')
  })

  it('joins selection subsets with line-aware separators', () => {
    const words = [word('one', 0.1, 0.1), word('two', 0.3, 0.1), word('three', 0.1, 0.3)]
    const { ordered, lineIndex } = ocrReadingOrder(words)
    expect(joinOcrWordsText(ordered, lineIndex)).toBe('one two\nthree')
    // Subset: picking the first word of each line still yields the line break.
    expect(joinOcrWordsText([ordered[0], ordered[2]], lineIndex)).toBe('one\nthree')
  })
})

describe('OCR span placement', () => {
  const quadWord = (text: string, points: [number, number][], rotation?: number): OcrWord => {
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    return {
      text,
      confidence: 0.9,
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      rotation,
      points: points.map(([x, y]) => ({ x, y })) as OcrWord['points'],
    }
  }

  it('anchors at the quad origin with edge lengths and direction', () => {
    // A line rotated +2° (y-down, CSS clockwise), true size 0.4 × 0.03.
    const theta = (2 * Math.PI) / 180
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const p0 = [0.2, 0.118] as [number, number]
    const p1 = [p0[0] + 0.4 * cos, p0[1] + 0.4 * sin] as [number, number]
    // Side edges follow the line's down-normal: rotate (0, h) by +θ.
    const p3 = [p0[0] - 0.03 * sin, p0[1] + 0.03 * cos] as [number, number]
    const p2 = [p1[0] - 0.03 * sin, p1[1] + 0.03 * cos] as [number, number]
    const placement = ocrWordSpanPlacement(quadWord('line', [p0, p1, p2, p3], 2), 0)
    expect(placement.x).toBeCloseTo(p0[0], 5)
    expect(placement.y).toBeCloseTo(p0[1], 5)
    expect(placement.width).toBeCloseTo(0.4, 4)
    expect(placement.height).toBeCloseTo(0.03, 4)
    expect(placement.angle).toBeCloseTo(2, 1)
  })

  it('composes the quarter turn into quad points and angle', () => {
    // Axis-aligned line in source space on a page displayed rotated 90° CW:
    // it must read top-to-bottom with a +90° span angle.
    const word90 = quadWord('side', [[0.1, 0.2], [0.5, 0.2], [0.5, 0.23], [0.1, 0.23]], 0)
    const placement = ocrWordSpanPlacement(word90, 90)
    expect(placement.angle).toBeCloseTo(90, 4)
    expect(placement.width).toBeCloseTo(0.4, 4)
    expect(placement.height).toBeCloseTo(0.03, 4)
    // p0 (0.1, 0.2) → (1 - 0.2, 0.1)
    expect(placement.x).toBeCloseTo(0.8, 5)
    expect(placement.y).toBeCloseTo(0.1, 5)
  })

  it('de-rotates legacy AABB words around their centre instead of the corner', () => {
    // True line: 0.4 × 0.03 at (0.2, 0.1) rotated +10° — engine stores the AABB.
    const theta = (10 * Math.PI) / 180
    const w = 0.4
    const h = 0.03
    const aabbW = w * Math.cos(theta) + h * Math.sin(theta)
    const aabbH = w * Math.sin(theta) + h * Math.cos(theta)
    const legacy: OcrWord = { text: 'tilted', confidence: 0.9, x: 0.2, y: 0.1, width: aabbW, height: aabbH, rotation: 10 }
    const placement = ocrWordSpanPlacement(legacy, 0)
    expect(placement.width).toBeCloseTo(w, 3)
    expect(placement.height).toBeCloseTo(h, 3)
    expect(placement.angle).toBeCloseTo(10, 1)
    // Centre preserved: the origin re-anchors at the true top-left point.
    expect(placement.x + (w * Math.cos(theta) - h * Math.sin(theta)) / 2).toBeCloseTo(0.2 + aabbW / 2, 4)
    expect(placement.y + (w * Math.sin(theta) + h * Math.cos(theta)) / 2).toBeCloseTo(0.1 + aabbH / 2, 4)
  })

  it('keeps flat legacy words axis-aligned', () => {
    const placement = ocrWordSpanPlacement(word('flat', 0.1, 0.2, 0.3, 0.04), 0)
    expect(placement).toMatchObject({ x: 0.1, y: 0.2, width: 0.3, height: 0.04, angle: 0 })
  })
})

describe('OCR display mapping', () => {
  it('sorts reading order on rotated geometry', () => {
    // Two words of one source line on a page displayed rotated 90° CW: the
    // line runs top-to-bottom on screen, and the word with the SMALLER source
    // x sits at the visual top — source y/x no longer describe reading order.
    const words = [
      word('left-column', 0.1, 0.1, 0.2, 0.04),
      word('right-column', 0.6, 0.1, 0.2, 0.04),
    ]
    const displays = words.map((entry) => ocrDisplayWord(entry, 90))
    expect(displays[0].y).toBeLessThan(displays[1].y)
    const { ordered } = ocrReadingOrder(displays)
    expect(ordered.map(({ text }) => text)).toEqual(['left-column', 'right-column'])
  })
})

describe('OCR table reconstruction', () => {
  it('rebuilds aligned cells and exports Excel-compatible TSV', () => {
    const words = [
      word('名称', 0.1, 0.1), word('数量', 0.42, 0.1), word('金额', 0.72, 0.1),
      word('纸张', 0.1, 0.2), word('2', 0.42, 0.2), word('18.00', 0.72, 0.2),
      word('墨盒', 0.1, 0.3), word('1', 0.42, 0.3), word('89.00', 0.72, 0.3),
    ]
    const [table] = reconstructOcrTables(words)
    expect(table.rows).toEqual([
      ['名称', '数量', '金额'], ['纸张', '2', '18.00'], ['墨盒', '1', '89.00'],
    ])
    expect(tableToTsv(table)).toBe('名称\t数量\t金额\n纸张\t2\t18.00\n墨盒\t1\t89.00')
    expect(table.cells?.flat().every((cell) => cell.bounds && cell.bounds.width > 0 && cell.bounds.height > 0)).toBe(true)
    expect(ocrTableRangeClipboard(table, [0, 0], [1, 2])?.tsv).toBe('数量\t金额')
    expect(ocrTableRangeClipboard(table, [0, 2], [1, 1])?.tsv).toBe('数量\n2\n1')
    expect(ocrTableRangeClipboard(table, [1, 2], [0, 1])?.tsv).toBe('纸张\t2\n墨盒\t1')
  })

  it('recognizes numeric columns aligned by their right edge', () => {
    const [table] = reconstructOcrTables([
      word('Item', 0.1, 0.1, 0.1), word('Amount', 0.7, 0.1, 0.1),
      word('A', 0.1, 0.2, 0.05), word('9.00', 0.74, 0.2, 0.06),
      word('B', 0.1, 0.3, 0.05), word('1200.00', 0.66, 0.3, 0.14),
    ])
    expect(table.rows).toEqual([
      ['Item', 'Amount'], ['A', '9.00'], ['B', '1200.00'],
    ])
  })

  it('keeps paragraphs as ordinary text instead of false-positive tables', () => {
    expect(reconstructOcrTables([
      word('这是第一行正文', 0.1, 0.1, 0.6), word('。', 0.72, 0.1, 0.02),
      word('下一行长度不同', 0.1, 0.2, 0.45), word('结束', 0.58, 0.2, 0.08),
    ])).toEqual([])
  })

  it('uses PaddleOCR-VL markdown tables when available', () => {
    const [table] = reconstructOcrTables([], '| 项目 | 金额 |\n| --- | ---: |\n| 服务 | 120 |')
    expect(table.source).toBe('engine')
    expect(tableToTsv(table)).toBe('项目\t金额\n服务\t120')
  })

  it('copies selected cells as a rectangular TSV and HTML table', () => {
    const words = [
      word('名称', 0.1, 0.1), word('数量', 0.42, 0.1), word('金额', 0.72, 0.1),
      word('纸张', 0.1, 0.2), word('2', 0.42, 0.2), word('<18.00>', 0.72, 0.2),
      word('墨盒', 0.1, 0.3), word('1', 0.42, 0.3), word('89.00', 0.72, 0.3),
    ]
    const tables = reconstructOcrTables(words)
    const result = ocrTableSelectionClipboard(tables, [1, 2, 4, 5])
    expect(result?.tsv).toBe('数量\t金额\n2\t<18.00>')
    expect(result?.html).toBe('<table><tbody><tr><td>数量</td><td>金额</td></tr><tr><td>2</td><td>&lt;18.00&gt;</td></tr></tbody></table>')
    expect(result?.rowRange).toEqual([0, 1])
    expect(result?.columnRange).toEqual([1, 2])
  })

  it('attaches OCR word positions to a shape-matching PaddleOCR-VL table', () => {
    const words = [
      word('Item', 0.1, 0.1), word('Amount', 0.5, 0.1),
      word('Service', 0.1, 0.2), word('120', 0.5, 0.2),
    ]
    const [table] = reconstructOcrTables(words, '| Item | Amount |\n| --- | ---: |\n| Service | 120 |')
    expect(table.source).toBe('engine')
    expect(table.cells?.map((row) => row.map((cell) => cell.wordIndexes))).toEqual([
      [[0], [1]], [[2], [3]],
    ])
    expect(ocrTableSelectionClipboard([table], [1, 3])?.tsv).toBe('Amount\n120')
  })

  it('exports complete tables as both TSV and an Excel-readable HTML table', () => {
    expect(tablesClipboardPayload([
      { rows: [['A', 'B'], ['1', '2']] },
      { rows: [['C', '<3>']] },
    ])).toEqual({
      tsv: 'A\tB\n1\t2\n\nC\t<3>',
      html: '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr><tr><td></td></tr><tr><td>C</td><td>&lt;3&gt;</td></tr></tbody></table>',
    })
  })

  it('keeps empty cells in ragged persisted rows so Excel columns do not shift', () => {
    const table = {
      id: 'persisted',
      rows: [['A', 'B', 'C'], ['D']],
      columnCount: 3,
      confidence: 0.9,
      source: 'geometry' as const,
      cells: [
        [
          { text: 'A', wordIndexes: [0] },
          { text: 'B', wordIndexes: [1] },
          { text: 'C', wordIndexes: [2] },
        ],
        [
          { text: 'D', wordIndexes: [3] },
          { text: '', wordIndexes: [] },
          { text: '', wordIndexes: [4] },
        ],
      ],
    }
    const result = ocrTableSelectionClipboard([table], [0, 4])
    expect(result?.tsv).toBe('A\tB\tC\nD\t\t')
    expect(result?.html).toBe('<table><tbody><tr><td>A</td><td>B</td><td>C</td></tr><tr><td>D</td><td></td><td></td></tr></tbody></table>')
  })

  it('falls back for mixed normal text or cross-table selections', () => {
    const words = [
      word('A', 0.1, 0.1), word('B', 0.4, 0.1),
      word('C', 0.1, 0.2), word('D', 0.4, 0.2),
    ]
    const [table] = reconstructOcrTables(words)
    expect(ocrTableSelectionClipboard([table], [0, 99])).toBeUndefined()
    const second = {
      ...table,
      id: 'geometry-2',
      cells: table.cells?.map((row) => row.map((cell) => ({
        ...cell, wordIndexes: cell.wordIndexes.map((index) => index + 10),
      }))),
    }
    expect(ocrTableSelectionClipboard([table, second], [0, 10])).toBeUndefined()
  })
})
