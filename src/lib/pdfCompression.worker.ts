import { openEngine } from 'virtual:paperwork-qpdf'
import type { PdfCompressionMode, PdfCompressionProgress } from '../types/pdf'
import type { CompressionMessage } from './pdfCompression'
import { MAX_IMAGE_PIXELS, imageSpec, optimizeImage, type PdfDict } from './pdfCompressionImages'

type Entry = { value?: unknown; stream?: { dict: PdfDict; datafile?: string } }
type Inventory = Record<string, Entry>
const isDict = (v: unknown): v is PdfDict => !!v && typeof v === 'object' && !Array.isArray(v)
const post = (msg: CompressionMessage, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })
const MiB = 1024 * 1024
const inputName = 'source.pdf'
const unencrypted = '加密 PDF 无法安全压缩，请先解除密码保护'

function inspect(objects: Inventory) {
  if (!isDict(objects.trailer?.value)) throw new Error('缺少 PDF trailer，未生成副本')
  if (objects.trailer.value['/Encrypt']) throw new Error(unencrypted)
  const live = new Set<string>(['trailer']), masks = new Set<unknown>()
  const maps = new Map<PdfDict, string>(), used = new Set<unknown>(), maskScopes = new Set<PdfDict>()
  const dictionary = (v: unknown): PdfDict | undefined => {
    const entry = typeof v === 'string' ? objects['obj:' + v] : undefined
    const dict = entry?.stream?.dict ?? entry?.value ?? v
    return isDict(dict) ? dict : undefined
  }
  let managedColor = false
  // Only active references, including nested/inherited resources. Don't decode orphan data or follow cycles.
  const pending: [unknown, string][] = [[objects.trailer.value, 'trailer']]
  while (pending.length) {
    const [v, owner] = pending.pop()!
    if (typeof v === 'string') {
      const key = 'obj:' + v, entry = objects[key]
      if (entry && !live.has(key)) { live.add(key); pending.push([entry.stream?.dict ?? entry.value, key]) }
    } else if (Array.isArray(v)) {
      for (const child of v) pending.push([child, owner])
    } else if (isDict(v)) {
      if (v['/Type'] === '/Sig' || v['/Type'] === '/DocTimeStamp' || '/ByteRange' in v || (v['/FT'] === '/Sig' && v['/V'])) throw new Error('重写会使数字签名失效，请使用未签名的原稿')
      if ('/DefaultRGB' in v || '/DefaultGray' in v || '/OutputIntents' in v) managedColor = true
      if (v['/SMask']) masks.add(v['/SMask'])
      if (v['/Mask']) masks.add(v['/Mask'])
      const states = dictionary(v['/ExtGState'])
      if (states) for (const state of Object.values(states)) {
        const mask = dictionary(dictionary(state)?.['/SMask']), group = dictionary(mask?.['/G'])
        if (group) maskScopes.add(dictionary(group['/Resources']) ?? v) // a Form can inherit its caller's resources
      }
      const xo = v['/XObject'], ref = typeof xo === 'string' ? 'obj:' + xo : owner
      const map = typeof xo === 'string' ? objects[ref]?.value : xo
      if (isDict(map)) {
        for (const image of Object.values(map)) used.add(image)
        // Only edit value dictionaries for deduplication. Stream dictionaries/data remain paired.
        if (!objects[ref].stream) maps.set(map, ref)
      }
      for (const child of Object.values(v)) pending.push([child, owner])
    }
  }
  // Walk painting resources separately, before considering any ordinary page image. A mask can
  // paint the very same indirect image via Forms, tiling patterns or Type 3 glyphs. Set iteration
  // visits newly discovered scopes once, including cycles; omitted Form resources inherit this scope.
  for (const scope of maskScopes) for (const kind of ['/XObject', '/Pattern', '/Font']) {
    const resources = dictionary(scope[kind]); if (!resources) continue
    for (const ref of Object.values(resources)) {
      const obj = dictionary(ref)
      if (obj?.['/Subtype'] === '/Image') masks.add(ref)
      const nested = dictionary(obj?.['/Resources']); if (nested) maskScopes.add(nested)
    }
  }
  return { masks, maps, used, managedColor }
}

export async function optimize(bytes: Uint8Array, mode: PdfCompressionMode, onProgress: (p: PdfCompressionProgress) => void, wasm: Uint8Array) {
  let skippedLargeImages = 0
  const progress = (stage: PdfCompressionProgress['stage'], current: number, total: number) => onProgress({ stage, current, total, skippedLargeImages })
  const engine = await openEngine(wasm)
  const run = (args: string[], outputs: string[], extra: Record<string,Uint8Array> = {}) =>
    engine.run({[inputName]:bytes,...extra}, ['--suppress-recovery',...args], outputs)
  try {
    const json = ['--json-output', '--decode-level=none']
    // No stream bodies in the inventory, not even fonts/images. qpdf resolves the current xref/revision.
    const meta = (await run([...json, '--json-stream-data=none', '--', inputName, 'meta.json'], ['meta.json']))['meta.json']
    if (meta.length > 16 * MiB) throw new Error('PDF 对象索引超过安全上限')
    const [header, objects] = JSON.parse(new TextDecoder().decode(meta)).qpdf as [{ pdfversion: string; jsonversion: number }, Inventory]
    if (header.jsonversion !== 2 || Object.keys(objects).length > 60000) throw new Error('PDF 对象数超过安全上限')
    const { masks, maps, used, managedColor } = inspect(objects)
    type ImageEntry = {key:string;ref:string;id:string;file:string;dict:PdfDict;spec:NonNullable<ReturnType<typeof imageSpec>>;size:number}
    const images: ImageEntry[] = []
    const scalar = (v: unknown) => typeof v === 'string' ? objects['obj:' + v]?.value : v
    let encoded = 0, rawPixels = 0, jpegPixels = 0
    for (const ref of used) {
      if (typeof ref !== 'string' || !/^\d+ \d+ R$/.test(ref)) continue
      const key = 'obj:' + ref, dict = objects[key]?.stream?.dict
      if (dict?.['/Subtype'] !== '/Image') continue
      const w = scalar(dict['/Width']), h = scalar(dict['/Height'])
      if (typeof w === 'number' && typeof h === 'number' && Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 &&
          (w * h > MAX_IMAGE_PIXELS || Math.max(w, h) > 10_000)) { skippedLargeImages++; continue }
      if (managedColor || masks.has(ref)) continue
      const spec = imageSpec(dict); if (!spec) continue
      const size = scalar(dict['/Length'])
      const count = spec.w * spec.h, jpeg = spec.filter === '/DCTDecode'
      // A 300-dpi book is processed a page at a time. Keep separate limits on
      // total work and *live* allocations; the old 64 MP sum skipped page eight onward.
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 256 || size > 32 * MiB ||
          encoded + size > 80 * MiB || images.length >= 256 || (jpeg ? jpegPixels+count>640_000_000 : rawPixels+count>64_000_000)) continue
      const [num, gen] = ref.split(' ')
      images.push({ key, ref, id: `${num},${gen}`, file: 'asset-' + num, dict, spec, size })
      encoded += size
      if (jpeg) jpegPixels += count; else rawPixels += count
    }
    progress('loading', 1, 1)
    const patch: Inventory = {}, extras: Record<string,Uint8Array> = {}
    if (images.length) {
      const load = (group: ImageEntry[]) => run([...json, '--json-stream-data=file', '--json-stream-prefix=asset', ...group.map(i => '--json-object=' + i.id),
        '--', inputName, 'assets.json'], ['assets.json', ...group.map(i => i.file)])
      const unique = new Map<string, ImageEntry>(), redirects = new Map<string, string>()
      for (let start=0; start<images.length;) {
        let end=start+1, batchBytes=images[start].size
        while(end<images.length && end-start<12 && batchBytes+images[end].size<=8*MiB) batchBytes+=images[end++].size
        // Only this batch of encoded streams and one decoded image are needed at once.
        const raws=await load(images.slice(start,end))
        for(let n=start;n<end;n++) {
          const img=images[n],data=raws[img.file]
          if (data.length !== img.size) throw new Error('PDF 图像流长度不一致，未生成副本')
          const semantic = { ...img.dict }; delete semantic['/Length']
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
          const key = JSON.stringify(semantic) + hash.join(','), same=unique.get(key)
          if(same && same.size===data.length){
            const original=raws[same.file] ?? (await load([same]))[same.file]
            if(original.length===data.length && original.every((v,i)=>v===data[i])) redirects.set(img.ref,same.ref)
          }
          if(!redirects.has(img.ref)){
            unique.set(key,img)
            const replacement=await optimizeImage(img.dict,data,img.spec,mode)
            if(replacement){const datafile='new-'+n;patch[img.key]={stream:{dict:replacement.dict,datafile}};extras[datafile]=replacement.bytes}
          }
          progress('optimizing',n+1,images.length)
        }
        start=end
      }
      for (const [map, owner] of maps) for (const [name, ref] of Object.entries(map)) {
        const canonical = typeof ref === 'string' && redirects.get(ref)
        if (canonical) { map[name] = canonical; patch[owner] = objects[owner] }
      }
    } else progress('optimizing', 1, 1)
    const args: string[] = []
    if (Object.keys(patch).length) {
      extras['patch.json'] = new TextEncoder().encode(JSON.stringify({ qpdf: [{ jsonversion: 2 }, patch] }))
      args.push('--update-from-json=patch.json')
    }
    progress('saving', 0, 1)
    // Preserve unknown filters and live resource names (including form appearances). qpdf drops
    // unreachable objects and deflates unfiltered streams; no --optimize-images or blind Flate expansion.
    const out = await run([...args, '--decode-level=none', '--compress-streams=y', '--compression-level=9',
      '--object-streams=' + (Number(header.pdfversion) >= 1.5 ? 'generate' : 'preserve'), '--remove-unreferenced-resources=no',
      '--deterministic-id', '--', inputName, 'out.pdf'], ['out.pdf'], extras)
    progress('saving', 1, 1)
    return { bytes: out['out.pdf'], skippedLargeImages }
  } catch (error) {
    if (/password|encrypted/i.test((error as { stderr?: string[] }).stderr?.join(' ') ?? '')) throw new Error(unencrypted)
    throw error
  }
}

if (typeof self !== 'undefined') self.onmessage = async ({ data }: MessageEvent<{ bytes: Uint8Array; mode: PdfCompressionMode; wasm: Uint8Array }>) => {
  try {
    const result = await optimize(data.bytes, data.mode, p => post({ progress: p }), data.wasm)
    post(result, [result.bytes.buffer])
  } catch (e) { post({ error: e instanceof Error ? e.message : '压缩失败，未生成副本' }) }
}
