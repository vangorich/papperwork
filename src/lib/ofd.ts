import { PDFDocument, type PDFImage } from 'pdf-lib'
import { ofdError, ofdLocation, openOfdArchive } from './ofdArchive'
import { openOutlineFont } from './ofdOutlineFont'
import { createOfdFonts, ofdFontStyle } from './ofdFont'
import { embedOfdImage, numeric, ofdPath, textDeltas, tuple } from './ofdGraphics'

const mm = 72 / 25.4
const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const kids = (parent: Element | undefined, name?: string) => parent ? Array.from(parent.children).filter(e => !name || e.localName === name && e.namespaceURI === parent.namespaceURI) : []
const child = (el: Element | undefined, name: string) => kids(el, name)[0]
const text = (el: Element | undefined) => el?.textContent?.trim() ?? ''
const attr = (el: Element | undefined, key: string) => el?.getAttribute(key) ?? undefined
const yes = (value: string | undefined, fallback = false) => value === undefined ? fallback : /^(true|1)$/i.test(value)
const fmt = (n: number) => Math.round(n * 1e6) / 1e6
const order = (value?: string) => value === 'Background' ? 0 : value === 'Foreground' ? 2 : 1
const areaOf = (page: Element) => text(child(child(page, 'Area'), 'PhysicalBox'))
type Resource = { node: Element; directory: string }

/** Only an independent PDF representation escapes this reader. No filesystem,
 * URI, script, signing or network capabilities are involved. */
export async function convertOfd(input:Uint8Array):Promise<Uint8Array>{return (await readOfd(input,false)).bytes}
export const previewOfd=(input:Uint8Array)=>readOfd(input,true)
async function readOfd(input:Uint8Array, preview:boolean):Promise<{bytes:Uint8Array;signature:'unverified'|'none'}> {
  const archive = openOfdArchive(input)
  const manifest = await archive.xml('OFD.xml', 'OFD')
  if ((attr(manifest, 'DocType') ?? 'OFD') !== 'OFD' || !['1.0', '1.1','1.2','1.3'].includes(attr(manifest, 'Version') ?? '1.0')) ofdError('不支持此文档类型或版本')
  const bodies = kids(manifest, 'DocBody')
  if (bodies.length !== 1) ofdError('仅支持单文档 OFD 包；未导入不完整的副本')
  const body = bodies[0]
  const signRef=child(body,'Signatures'), signed=Boolean(signRef || archive.hasSignatureList)
  if(signed){
    if(!preview)ofdError('文档包含电子签章；仅可作为未验签阅览副本打开')
    if(!signRef || kids(body,'Signatures').length!==1)ofdError('签章索引引用不明确，无法确认外观')
    const listPath=ofdLocation('',text(signRef))
    if(archive.signatureLists.some(path=>path!==listPath))ofdError('包含未引用的签章索引，未生成副本')
    const list=await archive.xml(listPath,'Signatures'), refs=kids(list,'Signature')
    if(!refs.length||refs.length>32 || kids(list).some(e=>!['MaxSignId','Signature'].includes(e.localName)))ofdError('签章索引无效或含未知内容')
    for(const ref of refs){
      if(kids(ref).length || attr(ref,'Type')!=='Sign')ofdError('此文件带有可见印章或未知签章类型，尚不能完整显示')
      const path=ofdLocation(dir(listPath),attr(ref,'BaseLoc')||''), sig=await archive.xml(path,'Signature')
      if(!child(sig,'SignedInfo') || Array.from(sig.getElementsByTagName('*')).some(e=>['StampAnnot','Seal','Appearance'].includes(e.localName)))ofdError('暂不能还原此签章外观，不会生成缺失印章的副本')
      const value=await archive.read(ofdLocation(dir(path),text(child(sig,'SignedValue'))),8*1024*1024)
      if(!value.length)ofdError('签名值为空')
    }
  }
  if (child(body, 'Encryptions') || child(body, 'EncryptLoc')) ofdError('暂不支持加密 OFD')
  const docPath = ofdLocation('', text(child(body, 'DocRoot'))), docDir = dir(docPath)
  const doc = await archive.xml(docPath, 'Document'), common = child(doc, 'CommonData')
  const pages = kids(child(doc, 'Pages'), 'Page')
  if (!pages.length || pages.length > 1000) ofdError('页数无效或超过 1000 页导入上限')
  const defaultArea = text(child(child(common, 'PageArea'), 'PhysicalBox'))
  const defaultCS = text(child(common, 'DefaultCS'))
  const permissions = child(doc, 'Permissions')
  for (const flag of ['Edit', 'Export']) if (child(permissions, flag) && !yes(text(child(permissions, flag)), true)) ofdError('该文档限制编辑或导出，不生成 PDF 副本')
  const annotationLoc = text(child(doc, 'Annotations'))
  if (annotationLoc) {
    const annotations = await archive.xml(ofdLocation(docDir, annotationLoc), 'Annotations')
    if (kids(annotations, 'Page').length) ofdError('暂不支持含有 OFD 批注层的文档，未生成缺失内容的副本')
  }
  const pdf = await PDFDocument.create()
  pdf.setTitle(text(child(child(body, 'DocInfo'), 'Title')).slice(0, 512) || 'OFD 文档')
  pdf.setCreator('Paperwork · OFD 本地导入'); pdf.setSubject(signed?'含数字签名的 OFD 阅览副本；原件未验签，本 PDF 不携带原签名或附件。':'OFD 的 PDF 副本，不含原文件的签章或验证信息')
  const resources = new Map<string, Resource>(), loadedResources = new Set<string>()
  const lookup = (id: string, kind: string) => {
    const r = resources.get(id)
    return r?.node.localName === kind ? r : ofdError(`缺少 ${kind} 资源：${id.slice(0, 64)}`)
  }
  async function loadResources(path: string) {
    if (loadedResources.has(path)) return
    const root = await archive.xml(path, 'Res'), base = ofdLocation(dir(path), attr(root, 'BaseLoc') || '.')
    for (const group of kids(root)) for (const node of kids(group)) {
      const id = attr(node, 'ID')
      if (!id) continue
      if (resources.size >= 12000 || resources.has(id)) ofdError('资源数量超过上限或标识重复')
      resources.set(id, { node, directory: base })
    }
    loadedResources.add(path)
  }
  for (const ref of kids(common)) if (['PublicRes', 'DocumentRes'].includes(ref.localName)) await loadResources(ofdLocation(docDir, text(ref)))
  const definitions = new Map(kids(common, 'TemplatePage').map(el => [attr(el, 'ID'), el]))
  const templateCache = new Map<string, Element>()
  async function pageXml(path: string) {
    const root = await archive.xml(path, 'Page')
    for (const ref of kids(root, 'PageRes')) await loadResources(ofdLocation(dir(path), text(ref)))
    return root
  }
  const fonts = createOfdFonts(pdf), loadedFonts = new Map<string, string>(), faces: FontFace[] = []
  let fontBytes = 0, imagePixels = 0, work = 0, outputLength = 0
  const images = new Map<string, PDFImage>()
  function spend(n: number) { if ((work += n) > 800000) ofdError('页面绘制操作超过上限') }
  const outlineFonts=new Map<string,ReturnType<typeof openOutlineFont>>()
  async function mappedFontFor(el:Element){
    const res=lookup(attr(el,'Font')||'','Font'),loc=text(child(res.node,'FontFile'));if(!loc)ofdError('自定义字形映射没有对应的嵌入字体')
    const key=ofdLocation(res.directory,loc);let outline=outlineFonts.get(key)
    if(!outline){const bytes=await archive.read(key,12*1024*1024);if((fontBytes+=bytes.length)>32*1024*1024||outlineFonts.size>=64)ofdError('嵌入字体超过导入上限');outline=openOutlineFont(bytes,spend);outlineFonts.set(key,outline)}
    return {key,outline}
  }
  async function fontFor(el: Element) {
    const id = attr(el, 'Font'), res = id ? lookup(id, 'Font') : undefined
    let family = attr(res?.node, 'FontName') || attr(res?.node, 'FamilyName') || 'sans-serif'
    const location = text(child(res?.node, 'FontFile'))
    if (res && location) {
      const path = ofdLocation(res.directory, location)
      let alias = loadedFonts.get(path)
      if (!alias) {
        const bytes = await archive.read(path, 12 * 1024 * 1024)
        if ((fontBytes += bytes.length) > 32 * 1024 * 1024 || faces.length >= 64) ofdError('嵌入字体超过导入上限')
        if (bytes.length < 12 || ![0x00010000, 0x4f54544f, 0x74727565].includes(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0))) ofdError('嵌入字体不是受支持的 TrueType/OpenType 字体')
        alias = `OFD-${crypto.randomUUID()}`
        const face = new FontFace(alias, bytes)
        try { await face.load() } catch { return ofdError('嵌入字体损坏或无法使用') }
        document.fonts.add(face); faces.push(face); loadedFonts.set(path, alias)
      }
      family = alias
    }
    return ofdFontStyle(family, Number(attr(el, 'Weight') ?? 400) >= 600 || yes(attr(res?.node, 'Bold')), yes(attr(el, 'Italic')) || yes(attr(res?.node, 'Italic')), yes(attr(res?.node, 'Serif')))
  }
  function styles(el: Element, inherited: Element[]) {
    const roots = [el], seen = new Set<string>()
    let id = attr(el, 'DrawParam')
    while (id) {
      if (seen.has(id) || seen.size >= 16) ofdError('绘制参数递归引用')
      seen.add(id); const { node } = lookup(id, 'DrawParam'); roots.push(node); id = attr(node, 'Relative')
    }
    return [...roots, ...inherited]
  }
  function paint(color: Element | undefined, stroke: boolean) {
    if (!color) return { op: stroke ? '0 G' : '0 g', alpha: 1 }
    if (kids(color).length) ofdError('暂不支持渐变或图案填充')
    const cs = attr(color, 'ColorSpace') || defaultCS, space = cs ? lookup(cs, 'ColorSpace').node : undefined
    const type = attr(space, 'Type')?.toUpperCase(), max = 2 ** numeric(attr(space, 'BitsPerComponent') || '8') - 1
    let value = attr(color, 'Value')
    if (!value && attr(color, 'Index') !== undefined) value = text(kids(child(space, 'Palette'), 'CV')[numeric(attr(color, 'Index'))])
    if (!value || !Number.isFinite(max) || max < 1 || max > 65535) ofdError('色彩值或色彩空间无效')
    const parts = value.trim().split(/\s+/).map(s => Math.min(1, Math.max(0, fmt((/^#[\da-f]+$/i.test(s) ? parseInt(s.slice(1), 16) : numeric(s)) / max))))
    const op = parts.length === 1 && (!type || type === 'GRAY') ? 'g' : parts.length === 3 && (!type || type === 'RGB') ? 'rg' : parts.length === 4 && (!type || type === 'CMYK') ? 'k' : ofdError('暂不支持此颜色空间')
    return { op: `${parts.join(' ')} ${stroke ? op.toUpperCase() : op}`, alpha: Math.min(1, Math.max(0, numeric(attr(color, 'Alpha') || '255') / 255)) }
  }
  try {
    for (const pageRef of pages) {
      const pageRoot = await pageXml(ofdLocation(docDir, attr(pageRef, 'BaseLoc') || ''))
      const tpls: { root: Element; order: number }[] = []
      for (const ref of kids(pageRoot, 'Template')) {
        if (tpls.length >= 32) ofdError('单页模板过多')
        const definition = definitions.get(attr(ref, 'TemplateID')) ?? ofdError('未找到页面模板')
        const path = ofdLocation(docDir, attr(definition, 'BaseLoc') || '')
        const root = templateCache.get(path) ?? await pageXml(path)
        templateCache.set(path, root); tpls.push({ root, order: order(attr(ref, 'ZOrder') || attr(definition, 'ZOrder') || 'Background') })
      }
      const [px, py, width, height] = tuple(areaOf(pageRoot) || tpls.map(t => areaOf(t.root)).find(Boolean) || defaultArea, 4)
      if (width <= 0 || height <= 0 || width > 5000 || height > 5000) ofdError('页面物理尺寸无效或超过 5 米上限')
      const page = pdf.addPage([width * mm, height * mm]), ops: string[] = []
      function put(op: string) {
        if ((outputLength += op.length) > 48 * 1024 * 1024) ofdError('生成的页面内容超过导入上限')
        ops.push(op)
      }
      const opacities = new Map<string, string>(), pageFonts = new Set<string>(), pageImages = new Map<PDFImage, string>()
      function opacity(fill: number, stroke: number) {
        const key = `${fill}/${stroke}`
        let name = opacities.get(key)
        if (!name) {
          name = page.node.newExtGState('OFDa', pdf.context.obj({ Type: 'ExtGState', ca: fill, CA: stroke })).toString()
          opacities.set(key, name)
        }
        put(`${name} gs`)
      }
      async function draw(el: Element, inherited: Element[], depth = 0) {
        if (depth > 24) ofdError('图元层级过深或存在循环引用')
        spend(1)
        if (!yes(attr(el, 'Visible'), true)) return
        const s = styles(el, inherited), get = (name: string) => s.map(n => attr(n, name)).find(v => v !== undefined)
        const first = (name: string) => s.map(n => child(n, name)).find(Boolean)
        const kind = el.localName
        if (kind === 'PageBlock' || kind === 'Layer') {
          for (const obj of kids(el)) await draw(obj, s, depth + 1)
          return
        }
        if (!['PathObject', 'TextObject', 'ImageObject', 'CompositeObject'].includes(kind)) ofdError(`暂不支持页面图元 ${kind}`)
        const [x, y, w, h] = tuple(attr(el, 'Boundary'), 4)
        if (w < 0 || h < 0) ofdError('图元边界无效')
        const ctm = attr(el, 'CTM')
        put(`q 1 0 0 1 ${x} ${y} cm`)
        if (w && h) put(`0 0 ${w} ${h} re W n`)
        if (ctm) put(`${tuple(ctm, 6).join(' ')} cm`)
        for (const clip of kids(child(el, 'Clips'), 'Clip')) {
          // Successive clips intersect. Don't approximate arbitrary unions:
          // PDF winding cancellation could erase overlaps or expose content.
          const areas = kids(clip, 'Area')
          if (!areas.length) continue
          const path = child(areas[0], 'Path')
          if (areas.length !== 1 || !path || attr(areas[0], 'DrawParam') || attr(areas[0], 'CTM') || attr(path, 'CTM') || attr(path, 'Boundary')) ofdError('暂不支持复合、文字或带变换的裁剪路径')
          put(ofdPath(text(child(path, 'AbbreviatedData')))); put(attr(path, 'Rule') === 'Even-Odd' ? 'W* n' : 'W n')
        }
        const alpha = Math.min(1, Math.max(0, numeric(attr(el, 'Alpha') || '255') / 255))
        if (kind === 'ImageObject') {
          if (child(el, 'Border') || attr(el, 'ImageMask')) ofdError('暂不支持带附加边框或蒙版的图像')
          const res = lookup(attr(el, 'ResourceID') || '', 'MultiMedia'), path = ofdLocation(res.directory, text(child(res.node, 'MediaFile')))
          let image = images.get(path)
          if (!image) {
            image = await embedOfdImage(pdf, await archive.read(path), n => { if ((imagePixels += n) > 50_000_000) ofdError('图像总像素超过导入上限') }); images.set(path, image)
          }
          let name = pageImages.get(image)
          if (!name) { name = page.node.newXObject('OFDimg', image.ref).toString(); pageImages.set(image, name) }
          if (alpha !== 1) opacity(alpha, alpha)
          put(ctm ? '1 0 0 -1 0 1 cm' : `${w} 0 0 ${-h} 0 ${h} cm`); put(`${name} Do`)
        } else if (kind === 'CompositeObject') {
          const res = lookup(attr(el, 'ResourceID') || '', 'CompositeGraphicUnit')
          if (alpha !== 1) ofdError('暂不支持半透明复合图元')
          for (const obj of kids(child(res.node, 'Content'))) await draw(obj, s, depth + 1)
        } else {
          const isText = kind === 'TextObject', filled = yes(attr(el, 'Fill'), isText), stroked = yes(attr(el, 'Stroke'), !isText)
          const fill = paint(first('FillColor'), false), stroke = paint(first('StrokeColor'), true)
          if (alpha * fill.alpha !== 1 || alpha * stroke.alpha !== 1) opacity(alpha * fill.alpha, alpha * stroke.alpha)
          put(`${fill.op} ${stroke.op}`)
          if (stroked) {
            put(`${Math.max(0, numeric(get('LineWidth') || '0.353'))} w`)
            const joins = ['Miter', 'Round', 'Bevel'], caps = ['Butt', 'Round', 'Square']
            put(`${Math.max(0, joins.indexOf(get('Join') || 'Miter'))} j ${Math.max(0, caps.indexOf(get('Cap') || 'Butt'))} J`)
            if (get('DashPattern')) {
              const dash = get('DashPattern')!.trim().split(/\s+/).map(numeric)
              if (dash.length > 128 || dash.some(n => n < 0) || !dash.some(n => n > 0)) ofdError('虚线参数无效')
              put(`[${dash.join(' ')}] ${numeric(get('DashOffset') || '0')} d`)
            }
          }
          if (isText) {
            if (['ReadDirection', 'CharDirection'].some(name => Number(attr(el, name) ?? 0) !== 0) || stroked) ofdError('暂不支持旋转字形或描边文字')
            const size = numeric(attr(el, 'Size')), stretch = numeric(attr(el, 'HScale') || '1')
            const runs=kids(el,'TextCode'), transforms=kids(el,'CGTransform'), ids=new Map<number,number>()
            const total=runs.reduce((a,v)=>a+Array.from(v.textContent??'').length,0)
            if(total>64000)ofdError('单个文字对象过长');spend(transforms.length)
            for(const trans of transforms){
              const start=numeric(attr(trans,'CodePosition')??'0'),count=numeric(attr(trans,'CodeCount')??'1'),gc=numeric(attr(trans,'GlyphCount')??'1')
              if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<=0||gc!==count||start+count>total)ofdError('暂不支持非一对一或越界的字形映射')
              const gs=text(child(trans,'Glyphs')).split(/\s+/);if(gs.length!==count)ofdError('自定义字形数目不一致')
              gs.forEach((s,i)=>{const gid=numeric(s);if(ids.has(start+i)||!Number.isInteger(gid)||gid<0||gid>65535)ofdError('字形标识无效或重复');ids.set(start+i,gid)})
            }
            const mapped=ids.size ? await mappedFontFor(el):undefined, style=ids.size<total?await fontFor(el):''
            let codePosition=0
            if (size <= 0 || stretch <= 0) ofdError('字号或文字缩放无效')
            let prevX = 0, prevY = 0, lastFont = ''
            if (filled) put('BT')
            for (const run of runs) {
              if (kids(run).length) ofdError('文字节点中包含非文本元素')
              const chars = Array.from(run.textContent ?? ''); spend(chars.length)
              if (chars.length > 32000) ofdError('单个文字对象过长')
              const dx = textDeltas(run.getAttribute('DeltaX'), chars.length), dy = textDeltas(run.getAttribute('DeltaY'), chars.length)
              let x = prevX = numeric(attr(run, 'X') || String(prevX)), y = prevY = numeric(attr(run, 'Y') || String(prevY))
              if (!filled) continue
              for (let i = 0; i < chars.length; i++) {
                const gid=ids.get(codePosition++);const g=mapped&&gid!==undefined?fonts.mapped(mapped.key,chars[i],gid,mapped.outline):fonts.glyph(style,chars[i]), name = g.font.toString()
                if (!pageFonts.has(name)) { page.node.setFontDictionary(g.font, g.ref); pageFonts.add(name) }
                if (lastFont !== name) { put(`${name} ${size} Tf`); lastFont = name }
                put(`${stretch} 0 0 -1 ${fmt(x)} ${fmt(y)} Tm ${g.code} Tj`)
                x += dx[i] ?? (dy.length ? 0 : g.advance * size * stretch); y += dy[i] ?? 0
              }
            }
            if (filled) put('ET')
          } else {
            const path = text(child(el, 'AbbreviatedData')); if (!path) ofdError('矢量路径为空')
            put(ofdPath(path))
            const even = attr(el, 'Rule') === 'Even-Odd'
            put(filled ? (stroked ? 'B' : 'f') + (even ? '*' : '') : stroked ? 'S' : 'n')
          }
        }
        put('Q')
      }
      put(`q ${fmt(mm)} 0 0 ${fmt(-mm)} ${fmt(-px * mm)} ${fmt((py + height) * mm)} cm`)
      for (const group of [...tpls, { root: pageRoot, order: 1 }].sort((a, b) => a.order - b.order)) {
        const layers = kids(child(group.root, 'Content')).sort((a, b) => order(attr(a, 'Type')) - order(attr(b, 'Type')))
        for (const layer of layers) await draw(layer, [])
      }
      put('Q'); page.node.addContentStream(pdf.context.register(pdf.context.flateStream(ops.join('\n'))))
      if (pages.length > 4) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    fonts.finish()
    return {bytes:await pdf.save(),signature:signed?'unverified':'none'}
  } finally { for (const face of faces) document.fonts.delete(face) }
}
