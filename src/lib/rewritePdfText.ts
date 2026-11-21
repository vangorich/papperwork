import {
  EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream,
  PDFString, StandardFontEmbedder, isStandardFont, numberToString, type PDFPage,
} from 'pdf-lib'
import { strFromU8 } from 'fflate'

const name = PDFName.of
const printable = /^[\x20-\x7e]*$/
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
const maxPageBytes = 2 * 1024 * 1024
class RewriteError extends Error {}
function refuse(message: string): never { throw new RewriteError(message) }

function checkSingleRevision(bytes: Uint8Array) {
  // pdf-lib reads objects in file order. Don't flatten prior revisions (including old signatures)
  // or try to repair a missing trailer. A marker inside binary data can only cause a refusal.
  const tail = strFromU8(bytes.subarray(-1024), true)
  const trailer = /startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(tail)
  if (!trailer || Number(trailer[1]) >= bytes.length || !Number(trailer[1])) refuse('PDF 缺少完整的交叉引用结尾，请从源文档重新导出。')
  const end = bytes.length - tail.length + tail.lastIndexOf('%%EOF')
  for (let at = bytes.indexOf(37); at >= 0 && at < end; at = bytes.indexOf(37, at + 1)) {
    if (bytes[at + 1] === 37 && bytes[at + 2] === 69 && bytes[at + 3] === 79 && bytes[at + 4] === 70) {
      refuse('PDF 含多个修订版本，无法排除历史签名或旧对象。请使用未签名的单版本原稿。')
    }
  }
}

function checkProtection(doc: PDFDocument) {
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) refuse('PDF 已加密，请使用未加密的原稿。')
  const markers = ['ByteRange', 'SigFlags', 'DocMDP', 'FieldMDP', 'UR3', 'Perms'].map(name)
  // Include compressed objects and direct dictionaries in arrays/stream dictionaries.
  // Indirect references need not be followed: their objects are already in the list.
  const pending = doc.context.enumerateIndirectObjects().map(([, object]) => object)
  while (pending.length) {
    const object = pending.pop()!
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined
    if (dict) {
      // pdf-lib 1.x does not decode lowercase hex escapes in names. Don't reserialize a key
      // that might otherwise hide /ByteRange or change another object's resource mapping.
      if (dict.keys().some(key => /#23[0-9a-f]{2}/i.test(key.asString()))) refuse('PDF 字典名称的转义存在歧义，请从源文档重新导出。')
      const type = dict.lookup(PDFName.Type)
      if (type === name('Sig') || type === name('DocTimeStamp') || dict.lookup(name('FT')) === name('Sig') || markers.some(key => dict.has(key))) {
        refuse('PDF 含签名或签名权限，改写会使签名失效。请使用未签名的原稿。')
      }
    }
    for (const child of dict?.values() ?? (object instanceof PDFArray ? object.asArray() : [])) {
      if (child instanceof PDFDict || child instanceof PDFArray) pending.push(child)
    }
  }
  if (['AcroForm', 'StructTreeRoot', 'OCProperties', 'OutputIntents', 'NeedsRendering'].some(key => doc.catalog.has(name(key)))) {
    refuse('文档含表单、替代文字、可选图层或特殊渲染设置，无法确认可见文字。请在源文档中编辑。')
  }
}

// Only ordinary page content streams, never external data, predictors, forms or other stream semantics.
async function readStream(stream: PDFRawStream, budget: number) {
  const filterKey = name('Filter'), filter = stream.dict.lookup(filterKey)
  const length = stream.dict.lookup(PDFName.Length)
  if (!(length instanceof PDFNumber) || length.asNumber() !== stream.contents.length) refuse('页面内容流长度不一致，请从完整原稿重新导出。')
  if (stream.dict.keys().some(key => key !== PDFName.Length && key !== filterKey) || (stream.dict.has(filterKey) && filter !== PDFName.FlateDecode)) {
    refuse('页面内容流使用了不支持的过滤器或附加属性，请从源文档重新导出。')
  }
  const tooLarge = '页面内容超过原生文字编辑上限，请拆页或在源文档中编辑。'
  if (!filter) {
    if (stream.contents.length > budget) refuse(tooLarge)
    return strFromU8(stream.contents, true)
  }
  const reader = new Blob([stream.contents]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  const parts: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return parts.join('')
      budget -= value.length
      if (budget < 0) refuse(tooLarge)
      parts.push(strFromU8(value, true)) // One JS character per byte, including bytes in comments.
    }
  } finally { await reader.cancel().catch(() => {}) }
}

function simpleFont(resources: PDFDict | undefined, token: string) {
  const dict = resources?.lookupMaybe(PDFName.Font, PDFDict)?.lookup(name(token.slice(1)))
  const badFont = '仅支持标准西文字体的简单单字节编码；嵌入字体、中文字体和自定义字形映射请在源文档中编辑。'
  if (!(dict instanceof PDFDict) || dict.lookup(PDFName.Type) !== PDFName.Font || dict.lookup(name('Subtype')) !== name('Type1') ||
      dict.keys().some(key => !['/Type', '/Subtype', '/BaseFont', '/Encoding', '/Name'].includes(key.asString()))) refuse(badFont)
  const base = dict.lookup(name('BaseFont')), encoding = dict.lookup(name('Encoding'))
  const font = base instanceof PDFName ? base.decodeText() : undefined
  if (!isStandardFont(font) || font === 'Symbol' || font === 'ZapfDingbats' || (dict.has(name('Encoding')) && encoding !== name('WinAnsiEncoding'))) refuse(badFont)
  return { font, winAnsi: encoding === name('WinAnsiEncoding') }
}

// A deliberately closed grammar, not a search through a stream for apparent "(...) Tj" pairs.
// Unknown operators (including BI/ID, Do, gs, clipping, marked content and TJ) reject the whole page.
const operands: Record<string, string> = {
  q: '', Q: '', BT: '', ET: '', Tf: '/n', Tj: 's', Tm: 'nnnnnn', Td: 'nn', TD: 'nn', 'T*': '',
  TL: 'n', Tr: 'n', Tc: 'n', Tw: 'n', Tz: 'n', Ts: 'n', cm: 'nnnnnn',
  g: 'n', G: 'n', rg: 'nnn', RG: 'nnn', k: 'nnnn', K: 'nnnn', w: 'n', J: 'n', j: 'n', M: 'n', d: 'an',
  m: 'nn', l: 'nn', c: 'nnnnnn', v: 'nnnn', y: 'nnnn', h: '', re: 'nnnn', n: '',
  S: '', s: '', f: '', F: '', 'f*': '', B: '', 'B*': '', b: '', 'b*': '',
}
const syntaxError = '页面含不支持或不完整的绘制指令，不能安全定位原生文字。请在源文档中编辑。'
function* operations(source: string) {
  // No unescaped nested parentheses, compound operands (except numeric dash arrays), or inline images.
  // Sticky matching is essential: an unrecognized delimiter must never be skipped.
  const lex = /[\x00\t\n\f\r ]+|%[^\r\n]*|\((?:\\(?:\r\n|[\s\S])|[^()\\])*\)|<[\da-fA-F\x00\t\n\f\r ]*>|\[[\d.+\-\x00\t\n\f\r ]*\]|\/?[^\x00\t\n\f\r ()<>[\]{}/%]+/y
  let args: string[] = [], shape = '', start = 0, end = 0
  while (lex.lastIndex < source.length) {
    const match = lex.exec(source)
    if (!match) refuse(syntaxError)
    const word = match[0], first = word[0]
    if (first === '%' || /[\x00\t\n\f\r ]/.test(first)) continue
    const kind = first === '/' ? '/' : first === '(' || first === '<' ? 's' : first === '[' ? 'a' : number.test(word) ? 'n' : ''
    if (kind) {
      if (kind === 'n' && !Number.isFinite(Number(word)) || kind === '/' && !/^\/[A-Za-z0-9_.+\-]+$/.test(word)) refuse(syntaxError)
      if (kind === 'a' && word.slice(1, -1).split(/[\x00\t\n\f\r ]+/).some(n => n && !number.test(n))) refuse(syntaxError)
      if (!args.length) start = match.index
      args.push(word); shape += kind; end = lex.lastIndex
      if (args.length > 6) refuse(syntaxError)
    } else {
      if (word === 'Do' || word === 'BI') refuse('页面含图像或表单绘制，不能确认唯一的原生文字。扫描页请使用 OCR，表单请在源文档中编辑。')
      if (operands[word] !== shape) refuse(syntaxError)
      yield { op: word, args, start, end, opEnd: lex.lastIndex }
      args = []; shape = ''
    }
  }
  if (args.length) refuse(syntaxError)
}

function decodeOperand(raw: string) {
  const body = raw.slice(1, -1)
  const bytes = raw[0] === '<' ? PDFHexString.of(body.replace(/[\x00\t\n\f\r ]/g, '')).asBytes()
    : PDFString.of(body.replace(/\r\n?/g, '\n')).asBytes()
  return strFromU8(bytes, true)
}

type Run = ReturnType<typeof simpleFont> & { text: string; scale: number; stream: number; start: number; end: number; opEnd: number }
function readRuns(sources: string[], page: PDFPage) {
  const resources = page.node.Resources(), runs: Run[] = [], savedScales: number[] = []
  let inText = false, scale = 100, font: ReturnType<typeof simpleFont> | undefined
  for (const [stream, source] of sources.entries()) {
    for (const { op, args, start, end, opEnd } of operations(source)) {
      if (op === 'BT' || op === 'ET') {
        if (inText === (op === 'BT')) refuse(syntaxError)
        inText = !inText; font = undefined // Require an explicit Tf in each text object.
      } else if (op.startsWith('T')) {
        if (!inText) refuse(syntaxError)
        if (op === 'Tf') {
          if (Number(args[1]) <= 0) refuse('字号必须为正数，请选择可见的正文。')
          font = simpleFont(resources, args[0])
        } else if (op === 'Tj') {
          if (!font) refuse('没有明确的文字字体。请从源文档重新导出。')
          const text = decodeOperand(args[0])
          if (!printable.test(text) || !font.winAnsi && /['`]/.test(text)) refuse('此页的字形不能唯一映射到可打印 ASCII，不能安全改写。')
          runs.push({ ...font, text, scale, stream, start, end, opEnd })
        } else if (op === 'Tz') {
          scale = Number(args[0]); if (scale <= 0) refuse(syntaxError)
        } else if (['Tr', 'Tc', 'Tw', 'Ts'].includes(op) && Number(args[0]) !== 0) {
          refuse('不支持隐藏、裁剪、字距或基线偏移的文字，请选择普通可见正文。')
        }
      } else if (op === 'q' || op === 'Q') {
        if (inText || op === 'Q' && !savedScales.length) refuse(syntaxError)
        if (op === 'q') savedScales.push(scale)
        else scale = savedScales.pop()!
      } else if (inText && !['g', 'G', 'rg', 'RG', 'k', 'K'].includes(op)) refuse(syntaxError)
      if (op === 'cm' || op === 'Tm') {
        const [a, b, c, d] = args.map(Number)
        if (!Number.isFinite(a*d - b*c) || a*d === b*c) refuse('页面含退化变换，无法确认文字可见。')
      }
    }
  }
  if (inText || savedScales.length) refuse(syntaxError)
  return runs
}

function patch(source: string, run: Run, offset: number, find: string, replacement: string) {
  if (!run.winAnsi && /['`]/.test(replacement)) refuse('原字体的默认编码无法准确表示这些引号，请使用其他文字或在源文档中编辑。')
  const font = StandardFontEmbedder.for(run.font)
  const hex = (text: string) => font.encodeText(text).toString()
  // Tj advances by individual glyph widths, NOT by the AFM kerning of the whole word.
  const advance = (text: string) => Array.from(text).reduce((n, c) => n + font.widthOfTextAtSize(c, 1000), 0)
  const oldWidth = advance(find), newWidth = advance(replacement)
  const left = run.text.slice(0, offset), right = run.text.slice(offset + find.length)
  const prefix = source.slice(0, run.start) + (left ? `${hex(left)} Tj\n` : '')
  const show = source.slice(run.end, run.opEnd), suffix = (right ? `${hex(right)} Tj\n` : '') + source.slice(run.opEnd)
  // The hidden control has exactly the old advance. It is used ONLY in a disposable visibility proof.
  const hidden = `${prefix}3 Tr\n${hex(find)}${show}\n0 Tr\n${suffix}`
  if (oldWidth === newWidth) return { hidden, edited: source.slice(0, run.start) + hex(left + replacement + right) + source.slice(run.end) }
  const fit = run.scale * oldWidth / newWidth
  if (!Number.isFinite(fit) || fit <= 0) refuse('新文字无法排入原位置，请缩短替换文字。')
  // Preserve the advance of JUST the changed glyphs, including before another relative Tj.
  return { hidden, edited: `${prefix}${numberToString(fit)} Tz\n${hex(replacement)}${show}\n${numberToString(run.scale)} Tz\n${suffix}` }
}

function setPrivateStream(page: PDFPage, index: number, program: string) {
  const contents = page.node.Contents(), ctx = page.doc.context, ref = ctx.register(ctx.flateStream(program))
  // Copy on write at BOTH levels: the stream and its /Contents array may each be shared.
  if (contents instanceof PDFArray) {
    const array = contents.clone(); array.set(index, ref)
    page.node.set(PDFName.Contents, array)
  } else page.node.set(PDFName.Contents, ref)
}

// Text extraction alone also returns white-on-white and overpainted text. Compare actual ink
// using only the target page, at bounded resolution. Nothing from this proof goes into the output.
async function verifyVisible(doc: PDFDocument, pageIndex: number, stream: number, hidden: string, edited: string, find: string, replacement: string) {
  const proof = await PDFDocument.create()
  const [control, before, after] = await proof.copyPages(doc, [pageIndex, pageIndex, pageIndex])
  for (const page of [control, before, after]) proof.addPage(page)
  setPrivateStream(control, stream, hidden); setPrivateStream(after, stream, edited)
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
  if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
  const task = getDocument({ data: await proof.save(), useSystemFonts: true, disableFontFace: false, isEvalSupported: false, stopAtErrors: true })
  try {
    const pdf = await task.promise
    // PDF.js types canvasFactory as Object; this is the public create/destroy pair on both Node and DOM factories.
    const canvases = pdf.canvasFactory as { create(w: number, h: number): { context: CanvasRenderingContext2D }; destroy(canvas: object): void }
    let blank: Uint8ClampedArray | undefined, expected = ''
    for (const i of [1, 2, 3]) {
      const page = await pdf.getPage(i), natural = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2, 1536 / Math.max(natural.width, natural.height)) })
      const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height), surface = canvases.create(w, h)
      try {
        await page.render({ viewport, canvasContext: surface.context }).promise
        const pixels = surface.context.getImageData(0, 0, w, h).data
        const reference = blank
        if (!reference) { blank = pixels; continue }
        if (!pixels.some((v, j) => v !== reference[j])) refuse('匹配文字在页面上不可见或被遮挡，请选择可见的正文。')
        const content = await page.getTextContent({ disableNormalization: true })
        const text = content.items.map(item => 'str' in item ? item.str : '').join('')
        if (i === 2) {
          const at = text.indexOf(find)
          if (at < 0 || text.indexOf(find, at + 1) !== -1) refuse('可见页文字与操作数不能唯一对应，请选择更明确的原文。')
          expected = text.slice(0, at) + replacement + text.slice(at + find.length)
        } else if (text !== expected) refuse('替换后文字提取与预期不符，请使用更短的文字或在源文档中编辑。')
      } finally { canvases.destroy(surface); page.cleanup() }
    }
  } finally { await task.destroy() }
}

/** Edit a unique, printable ASCII span within one painted Tj on a simple Latin page (zero-based).
 * Returns a new PDF. Old/unreferenced objects can remain in it: this is editing, NOT redaction. */
export async function rewritePdfText(bytes: Uint8Array, pageIndex: number, find: string, replacement: string): Promise<Uint8Array> {
  if (!(bytes instanceof Uint8Array) || !bytes.length) refuse('请提供有效的 PDF 文件数据。')
  if (!Number.isInteger(pageIndex) || pageIndex < 0) refuse('页码无效：请从第 0 页开始编号。')
  if (typeof find !== 'string' || typeof replacement !== 'string' || !find.trim() || !replacement.trim() ||
      !printable.test(find) || !printable.test(replacement)) refuse('请输入非空的可打印 ASCII 文字；中文、换行或删除请在源文档中编辑。')
  if (find === replacement) refuse('替换文字与原文相同，请输入不同的替换文字。')
  if (Math.max(find.length, replacement.length) > 4096) refuse('单次文字片段最多 4096 个字符，请分段编辑。')
  try {
    checkSingleRevision(bytes)
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
    checkProtection(doc)
    const pages = doc.getPages(), page = pages[pageIndex]
    if (!page) refuse(`页码超出范围：此 PDF 共 ${pages.length} 页，从 0 开始编号。`)
    if (pages.indexOf(page) !== pages.lastIndexOf(page) || page.node.Annots()?.size() || page.node.has(name('Group'))) {
      refuse('该页被重复引用或含批注、透明组，不能确认独立可见的文字。请在源文档中编辑。')
    }
    const contents = page.node.Contents()
    const objects = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
    const sources: string[] = []
    let budget = maxPageBytes
    for (const object of objects) {
      const stream = doc.context.lookup(object)
      if (!(stream instanceof PDFRawStream)) refuse('页面缺少有效的原生内容流，请从源文档重新导出。')
      const source = await readStream(stream, budget)
      // Streams can split a lexical token or a comment. Only parse independently at explicit EOLs.
      if (sources.length && !/[\r\n]$/.test(sources[sources.length - 1]) && !/^[\r\n]/.test(source)) refuse('页面内容流边界不明确，请从源文档重新导出。')
      sources.push(source); budget -= source.length
    }
    const runs = readRuns(sources, page), text = runs.map(r => r.text).join('')
    const index = text.indexOf(find)
    if (index < 0) refuse('此页未找到匹配的原生文字。请核对原文；扫描页请使用 OCR。')
    if (text.indexOf(find, index + 1) !== -1) refuse('此页有多处匹配，请提供更长且唯一的原文。')
    let offset = index
    for (const run of runs) {
      if (offset >= run.text.length) { offset -= run.text.length; continue }
      if (offset + find.length > run.text.length) refuse('原文跨越多个文字绘制指令，请缩小到单个文字片段。')
      const { hidden, edited } = patch(sources[run.stream], run, offset, find, replacement)
      await verifyVisible(doc, pageIndex, run.stream, hidden, edited, find, replacement)
      setPrivateStream(page, run.stream, edited)
      return await doc.save({ addDefaultPage: false, updateFieldAppearances: false })
    }
    refuse(syntaxError)
  } catch (error) {
    if (error instanceof RewriteError) throw error
    // pdf-lib 1.x downlevels Error subclasses; instanceof EncryptedPDFError is false even for its own error.
    if (error instanceof Error && error.message === new EncryptedPDFError().message) refuse('PDF 已加密，请使用未加密的原稿。')
    refuse('无法可靠解析或保存此 PDF。请使用完整、未加密的 PDF 原稿重新导出后再试。')
  }
}
