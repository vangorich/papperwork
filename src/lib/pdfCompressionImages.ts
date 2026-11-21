import { zlibSync } from 'fflate'
import type { PdfCompressionMode } from '../types/pdf'

// qpdf JSON v2: names start with '/', references are 'N G R', byte strings start with 'b:'.
export type PdfDict = Record<string, unknown>
export const MAX_IMAGE_PIXELS = 10_000_000
const allowedKeys = new Set(['/Type', '/Name', '/Subtype', '/Width', '/Height', '/BitsPerComponent', '/ColorSpace', '/Filter', '/DecodeParms', '/Interpolate', '/Length'])
const single = (v: unknown) => Array.isArray(v) && v.length === 1 ? v[0] : v
export function imageSpec(dict: PdfDict) {
  const w = dict['/Width'], h = dict['/Height'], bits = dict['/BitsPerComponent']
  const cs = dict['/ColorSpace'], channels = cs === '/DeviceGray' ? 1 : cs === '/DeviceRGB' ? 3 : 0
  const filter = single(dict['/Filter']), dp = single(dict['/DecodeParms']) as PdfDict | null | undefined
  if (dict['/Subtype'] !== '/Image' || !channels || (bits !== 8 && !(bits === 1 && channels === 1)) ||
      typeof w !== 'number' || typeof h !== 'number' || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) ||
      w <= 0 || h <= 0 || Math.max(w, h) > 10000 || w * h > MAX_IMAGE_PIXELS ||
      Object.keys(dict).some(k => !allowedKeys.has(k)) || (filter != null && filter !== '/FlateDecode' && filter !== '/DCTDecode')) return
  const predictor = dp?.['/Predictor'] ?? 1
  if (dp != null && (typeof dp !== 'object' || Array.isArray(dp) || filter !== '/FlateDecode' ||
      Object.keys(dp).some(k => !['/Predictor', '/Colors', '/BitsPerComponent', '/Columns'].includes(k)) ||
      (predictor !== 1 && ((dp['/Colors'] ?? 1) !== channels || (dp['/Columns'] ?? 1) !== w || (dp['/BitsPerComponent'] ?? 8) !== bits)))) return
  if (![1, 2, 10, 11, 12, 13, 14, 15].includes(Number(predictor)) || (bits === 1 && (predictor === 2 || filter === '/DCTDecode'))) return
  return { w, h, channels, bits, filter, predictor: Number(predictor) }
}
type Spec = NonNullable<ReturnType<typeof imageSpec>>
type Replacement = { dict: PdfDict; bytes: Uint8Array }

// Validate the zlib checksum and exact row count. Stop at the limit, not after allocating all output.
async function inflateExact(data: Uint8Array, expected: number) {
  const out = new Uint8Array(expected)
  let input = 0
  const reader = new ReadableStream<Uint8Array>({ pull(c) {
    if (input === data.length) c.close()
    else { const chunk = data.subarray(input, input + 4096); input += chunk.length; c.enqueue(chunk) }
  } }).pipeThrough(new DecompressionStream('deflate')).getReader()
  let pos = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return pos === expected ? out : undefined
      if (value.length > expected - pos) { await reader.cancel(); return }
      out.set(value, pos); pos += value.length
    }
  } catch { return } finally { reader.releaseLock() }
}

async function samples(src: Uint8Array, { w, h, channels, bits, filter, predictor }: Spec) {
  const row = Math.ceil(w * channels * bits / 8), bpp = Math.ceil(channels * bits / 8)
  const expected = (row + Number(predictor >= 10)) * h
  const data = filter ? await inflateExact(src, expected) : src
  if (!data || data.length !== expected) return
  if (predictor === 1) return data
  if (predictor === 2) {
    for (let y = 0; y < h; y++) for (let x = bpp; x < row; x++) data[y * row + x] += data[y * row + x - bpp]
    return data
  }
  // PNG scanlines include a filter byte. Reconstruct in-place, compacting away the filter bytes.
  let read = 0, write = 0
  for (let y = 0; y < h; y++) {
    const f = data[read++]
    if (f > 4) return
    for (let x = 0; x < row; x++, write++) {
      const a = x >= bpp ? data[write - bpp] : 0, b = y ? data[write - row] : 0, c = y && x >= bpp ? data[write - row - bpp] : 0
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
      const delta = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >>> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0
      data[write] = data[read++] + delta
    }
  }
  return data.subarray(0, write)
}

function colorAt(bytes: Uint8Array, i: number, channels: number) {
  return channels === 1 ? bytes[i] : (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
}

/** PDF RunLength packets move long runs of bare paper out of the Deflate window.
 * Both encodings decode to the exact same packed pixels; keep the smaller one. */
function pdfRuns(src: Uint8Array) {
  const out = new Uint8Array(src.length + Math.ceil(src.length / 64) + 4)
  let pos = 0, literalStart = 0, written = 0
  const flushLiterals = (end: number) => {
    while (literalStart < end) {
      const length = Math.min(128, end - literalStart)
      out[written++] = length - 1
      out.set(src.subarray(literalStart, literalStart + length), written)
      written += length; literalStart += length
    }
  }
  while (pos < src.length) {
    let end = pos + 1
    while (end < src.length && src[end] === src[pos]) end++
    if (end - pos >= 4) {
      flushLiterals(pos)
      while (end - pos >= 2) {
        const length = Math.min(128, end - pos)
        out[written++] = 257 - length; out[written++] = src[pos]; pos += length
      }
      literalStart = pos // A single byte after a full 128-byte run starts the next literal packet.
    }
    pos = end
  }
  flushLiterals(src.length)
  out[written++] = 128 // EOD, PDF RunLengthDecode
  return out.subarray(0, written)
}

/** Exact indexed colors only, never threshold/dither. Restart packing at every row, including odd widths. */
function paletteImage(raw: Uint8Array, { channels, w, h }: Spec, tryRuns = false): Replacement | undefined {
  const colors = new Map<number, number>()
  for (let i = 0; i < raw.length; i += channels) {
    const color = colorAt(raw, i, channels)
    if (!colors.has(color)) {
      if (colors.size === (channels === 1 ? 16 : 256)) return
      colors.set(color, colors.size)
    }
  }
  const bits = colors.size <= 2 ? 1 : colors.size <= 4 ? 2 : colors.size <= 16 ? 4 : 8
  const stride = Math.ceil(w * bits / 8), packed = new Uint8Array(stride * h)
  const bw = channels === 1 && [...colors.keys()].every(v => v === 0 || v === 255)
  let pos = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++, pos += channels) {
    const index = bw ? Number(raw[pos] === 255) : colors.get(colorAt(raw, pos, channels))!
    const bit = x * bits
    packed[y * stride + (bit >>> 3)] |= index << (8 - bits - (bit & 7))
  }
  const lookup = [...colors.keys()].map(v => v.toString(16).padStart(channels * 2, '0')).join('')
  let bytes = zlibSync(packed, { level: 9 }), filter: string | string[] = '/FlateDecode'
  if (tryRuns) {
    const runs = zlibSync(pdfRuns(packed), { level: 9 })
    if (runs.length + 32 < bytes.length) { bytes = runs; filter = ['/FlateDecode', '/RunLengthDecode'] }
  }
  return { bytes, dict: { '/BitsPerComponent': bits, '/Filter': filter,
    '/ColorSpace': bw ? '/DeviceGray' : ['/Indexed', channels === 1 ? '/DeviceGray' : '/DeviceRGB', colors.size - 1, 'b:' + lookup] } }
}

// Inspect adjacent native pixels, not a thumbnail that could average away sparse strokes.
function photographic(bytes: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: number) {
  if (w < 96 || h < 96) return false
  const hist = new Uint32Array(32), step = Math.max(1, Math.floor(w * h / 65003))
  let n = 0, light = 0, extremes = 0, flat = 0
  for (let pixel = 1; pixel < w * h; pixel += step) {
    if (!(pixel % w)) continue
    const i = pixel * channels, r = bytes[i], g = bytes[i + 1], b = bytes[i + 2]
    const luma = (77 * r + 150 * g + 29 * b) >>> 8
    hist[luma >>> 3]++; n++
    if (Math.min(r, g, b) >= 235) light++
    if (luma <= 28 || luma >= 227) extremes++
    if (Math.max(Math.abs(r - bytes[i - channels]), Math.abs(g - bytes[i + 1 - channels]), Math.abs(b - bytes[i + 2 - channels])) <= 2) flat++
  }
  return n > 0 && light < n * .55 && extremes < n * .78 && flat < n * .84 &&
    Math.max(...hist) < n * .40 && hist.filter(v => v > n * .003).length >= 14
}

/** Only known, orientation-free Gray/RGB JPEGs. Validate dimensions before allocating a decoder. */
export async function plainRgbJpeg(bytes: Uint8Array, w: number, h: number, channels: 1 | 3 = 3) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  let p = 2, frame = false, profile = false
  while (p + 4 < bytes.length) {
    if (bytes[p++] !== 0xff) return false
    while (bytes[p] === 0xff) p++
    const marker = bytes[p++], len = (bytes[p] << 8) | bytes[p + 1]
    if (len < 2 || p + len > bytes.length) return false
    if (marker === 0xda) return frame
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || len !== 8 + 3 * channels || bytes[p + 2] !== 8 || ((bytes[p + 3] << 8) | bytes[p + 4]) !== h || ((bytes[p + 5] << 8) | bytes[p + 6]) !== w || bytes[p + 7] !== channels) return false
      frame = true
    } else if (marker === 0xe0) {
      if (len < 16 || String.fromCharCode(...bytes.subarray(p + 2, p + 7)) !== 'JFIF\0') return false
    } else if (marker === 0xe2) {
      // Exact Skia sRGB APP2 (including ICC_PROFILE header & chunk count), from Chromium's
      // default sRGB Canvas encoder. A matching label or color-space signature alone is not enough.
      if (channels !== 3 || profile || len !== 472) return false
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(p + 2, p + len)))
      if (Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') !== 'c3bb12de30d7357252ec3a5ec781bd2f8a6dd8c69dd7d3de97bbac262d9e1fd4') return false
      profile = true
    } else if (![0xdb, 0xc4, 0xdd, 0xfe].includes(marker)) return false
    p += len
  }
  return false
}

// A high-resolution JPEG scan is not a photograph: keep substantially more samples
// for small type, preserve colour seals, and never threshold the page to black/white.
function paperScan(pixels: Uint8Array | Uint8ClampedArray, w: number, h: number, stride: number) {
  if (Math.min(w,h)<600 || Math.max(w,h)<1600 || w*h<1_200_000) return false
  const step=Math.max(1,Math.floor(w*h/50021)); let paper=0, ink=0, count=0
  for(let p=0;p<w*h;p+=step){
    const i=p*stride, r=pixels[i], g=stride===1?r:pixels[i+1], b=stride===1?r:pixels[i+2]
    const lo=Math.min(r,g,b),hi=Math.max(r,g,b);count++
    if(lo>=216 && hi-lo<=28)paper++
    if(hi<178 || hi-lo>45)ink++
  }
  return paper>=.65*count && ink>=.0005*count
}

// Grayscale scanner PDFs should still print on the gray ink channel. Use multiple
// gray levels (especially near white), not the browser's three-component JPEG encoder.
async function grayScan(canvas: OffscreenCanvas, continuous = false): Promise<Replacement | undefined> {
  const ctx=canvas.getContext('2d');if(!ctx)return
  const {width:w,height:h}=canvas, rgba=ctx.getImageData(0,0,w,h).data
  if (continuous) {
    // /Interpolate applies to samples, not palette indices. Keep one continuous
    // gray component for interpolated scans, including their PDF colour space.
    const delta=new Uint8Array(w*h)
    for(let i=0;i<delta.length;i++)delta[i]=rgba[4*i]-(i%w?rgba[4*i-4]:0)
    return { bytes:zlibSync(delta,{level:9}),dict:{'/Width':w,'/Height':h,'/Filter':'/FlateDecode','/ColorSpace':'/DeviceGray','/BitsPerComponent':8,'/DecodeParms':{'/Predictor':2,'/Colors':1,'/BitsPerComponent':8,'/Columns':w}} }
  }
  const ramp=[0,20,40,60,80,100,120,140,160,180,198,214,228,240,249,255]
  const lut=Uint8Array.from({length:256},(_,v)=>ramp.reduce((best,g,i)=>Math.abs(v-g)<Math.abs(v-ramp[best])?i:best,0))
  const stride=Math.ceil(w/2),packed=new Uint8Array(stride*h)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)packed[y*stride+(x>>1)]|=lut[rgba[4*(y*w+x)]]<<(x%2?0:4)
  const stream=new Blob([packed]).stream().pipeThrough(new CompressionStream('deflate'))
  return {bytes:new Uint8Array(await new Response(stream).arrayBuffer()),dict:{'/Width':w,'/Height':h,'/Filter':'/FlateDecode','/BitsPerComponent':4,'/ColorSpace':['/Indexed','/DeviceGray',15,'b:'+ramp.map(v=>v.toString(16).padStart(2,'0')).join('')]}}
}

// Fit a small palette to the actual ink, not to the millions of white pixels.
// Different hues (including pale marks on paper) never compete for the same slot.
// This keeps readable antialiased contours without thresholding the page to black/white.
function compactScanPalette(canvas: OffscreenCanvas, spec: Spec) {
  const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d')
  if (!ctx) return
  const rgba = ctx.getImageData(0, 0, w, h).data, bright = new Uint32Array(256)
  const step = 4 * Math.max(1, Math.floor(w * h / 32003))
  for (let i = 0; i < rgba.length; i += step) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    if (g >= 224 && Math.max(r,g,b) - Math.min(r,g,b) <= 8) bright[g]++
  }
  let paper = 255
  for (let v = 224; v <= 255; v++) if (bright[v] > bright[paper]) paper = v
  if (!bright[paper]) return // No reliable paper tone: prefer continuous samples.
  const keys = new Uint8Array(w*h), count = new Uint32Array(5 + 6*3*4), sums = new Float64Array(count.length*3)
  for (let j=0, i=0; j<keys.length; j++, i+=4) {
    const r=rgba[i], g=rgba[i+1], b=rgba[i+2], l=(77*r+150*g+29*b+128)>>>8
    const hi=Math.max(r,g,b), c=hi-Math.min(r,g,b)
    let k = l<77 ? 0 : l<174 ? 1 : l<paper-13 ? 2 : l<=paper+7 ? 3 : 4
    if (spec.channels===3 && (c>=22 || (c>=8 && l>=paper-28))) {
      const hue=hi===r?(g-b)/c:hi===g?2+(b-r)/c:4+(r-g)/c
      k=5+((Math.round(hue)+6)%6)*12+(c<40?0:c<110?4:8)+(l<74?0:l<150?1:l<215?2:3)
    }
    keys[j]=k; count[k]++; const n=3*k; sums[n]+=r; sums[n+1]+=g; sums[n+2]+=b
  }
  // Downsampling lightens slender strokes. Retain a little extra optical density
  // in the three neutral ink bands; never shift the paper or the coloured seals.
  const lookup=Uint8Array.from(sums,(sum,i)=>{
    const band=Math.floor(i/3), mean=sum/(count[band]||1)
    return Math.round(Math.max(0,mean-(band<3?Math.min(17,mean*.15):0)))
  })
  // On flat shaded stock, one gray bin could turn a numeral into its background.
  // Keep a finer luminance ladder wherever there is no white paper or a low-
  // contrast mark would vanish. Extend protection one cell past each boundary.
  const cell=8, cols=Math.ceil(w/cell), rows=Math.ceil(h/cell), fine=new Uint8Array(cols*rows)
  for (let by=0;by<h;by+=cell) for (let bx=0;bx<w;bx+=cell) {
    let low=255,high=0,same=true
    const first=keys[by*w+bx]
    for(let y=by;y<Math.min(h,by+cell);y++) for(let x=bx;x<Math.min(w,bx+cell);x++){
      const j=y*w+x, v=rgba[4*j+1];low=Math.min(low,v);high=Math.max(high,v);if(keys[j]!==first)same=false
    }
    if ((high>=60 && high<paper-20) || (same && first<5 && high-low>=16)) {
      const cx=bx/cell,cy=by/cell
      for(let y=Math.max(0,cy-1);y<=Math.min(rows-1,cy+1);y++) fine.fill(1,y*cols+Math.max(0,cx-1),y*cols+Math.min(cols,cx+2))
    }
  }
  const raw=new Uint8Array(keys.length*spec.channels)
  let ink=0, severe=0
  for (let j=0, off=0; j<keys.length; j++) {
    const key=keys[j], n=3*key, i=4*j
    const detail=key<5 && fine[Math.floor(j/w/cell)*cols+Math.floor((j%w)/cell)]
    const tone=detail?Math.min(255,Math.round(((77*rgba[i]+150*rgba[i+1]+29*rgba[i+2])/256)/12)*12):0
    const r=detail?tone:lookup[n], g=detail?tone:lookup[n+1], b=detail?tone:lookup[n+2]
    raw[off++]=r; if (spec.channels===3) { raw[off++]=g; raw[off++]=b }
    if (key!==3) {
      ink++
      // Count errors across a patch of tone, not isolated antialiased pixels on a
      // letter edge. The latter deliberately gain some ink when downsampled.
      const delta=Math.max(Math.abs(r-rgba[i]),Math.abs(g-rgba[i+1]),Math.abs(b-rgba[i+2]))
      if (delta>40 && j%w>=2 && j%w<w-2 && j>=2*w && j<keys.length-2*w &&
          Math.abs(rgba[i-7]-rgba[i+1])<12 && Math.abs(rgba[i+9]-rgba[i+1])<12 &&
          Math.abs(rgba[i+1-w*8]-rgba[i+1])<12 && Math.abs(rgba[i+1+w*8]-rgba[i+1])<12) severe++
    }
  }
  // A document with a photograph or shaded diagram can also have a white margin.
  // Keep the continuous-tone candidate if the ink itself fits the palette poorly.
  if (!ink || severe>ink*.04) return
  const indexed = paletteImage(raw, { ...spec, w, h }, true)
  return indexed && { bytes:indexed.bytes, dict:{...indexed.dict,'/Width':w,'/Height':h} }
}

// Dots, punctuation and very small glyphs need more samples than normal body
// text. Test the original pixels in four directions, independent of page rotation.
function hasFinePrint(pixels: Uint8Array | Uint8ClampedArray, w: number, h: number, stride: number) {
  const radius=Math.max(2,Math.round(Math.max(w,h)/600)), step=Math.max(1,Math.floor(w*h/96013)), channel=stride===1?0:1
  let ink=0,isolated=0
  for(let p=radius*w+radius;p<(h-radius)*w-radius;p+=step){
    if(p%w<radius || p%w>=w-radius)continue
    const i=p*stride+channel, dx=radius*stride, dy=w*dx
    if(pixels[i]>=152)continue
    ink++
    if(pixels[i-dx]>219 && pixels[i+dx]>219 && pixels[i-dy]>219 && pixels[i+dy]>219)isolated++
  }
  return ink>=32 && isolated>ink*.27
}

async function imageCandidate(src: Uint8Array, spec: Spec, jpeg: boolean, mode: Exclude<PdfCompressionMode, 'lossless'>, interpolate: boolean): Promise<Replacement | undefined> {
  const { w, h, channels } = spec, compact = mode === 'compact'
  if ((channels !== 1 && channels !== 3) || typeof OffscreenCanvas === 'undefined' || (jpeg && !await plainRgbJpeg(src, w, h, channels))) return
  let scan = !jpeg && compact && paperScan(src, w, h, channels)
  let finePrint = scan && hasFinePrint(src, w, h, channels)
  if (!jpeg && !scan && (channels !== 3 || !photographic(src, w, h, 3))) return
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: jpeg })
  if (!ctx) return
  let small: OffscreenCanvas | undefined
  try {
    if (jpeg) {
      const bitmap = await createImageBitmap(new Blob([src], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', imageOrientation: 'none' })
      try { if (bitmap.width !== w || bitmap.height !== h) return; ctx.drawImage(bitmap, 0, 0) } finally { bitmap.close() }
      const samples = ctx.getImageData(0, 0, w, h).data
      scan = paperScan(samples, w, h, 4)
      finePrint = compact && scan && hasFinePrint(samples,w,h,4)
      if (!scan && (channels === 1 || !photographic(samples, w, h, 4))) return
    } else {
      const image = ctx.createImageData(w, h)
      for (let i = 0, j = 0; i < src.length; i += channels, j += 4) {
        image.data[j] = src[i]; image.data[j + 1] = channels === 1 ? src[i] : src[i + 1]
        image.data[j + 2] = channels === 1 ? src[i] : src[i + 2]; image.data[j + 3] = 255
      }
      ctx.putImageData(image, 0, 0)
    }
    const balanced = mode === 'balanced', long = Math.max(w, h)
    // Reserve detail for punctuation/dense tiny type; do not increase a scan's size.
    const scanScale = Math.max(balanced ? .68 : compact ? (finePrint ? .72 : .53) : .54, (balanced ? 2350 : 1800) / long,
      compact ? 1100 / Math.min(w, h) : 0)
    const scale = Math.min(1, scan ? scanScale : (balanced ? 1600 : 1120) / long)
    if (scale < 1) {
      small = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
      const out = small.getContext('2d', { alpha: false }); if (!out) return
      out.imageSmoothingEnabled = true; out.imageSmoothingQuality = 'high'; out.drawImage(canvas, 0, 0, small.width, small.height)
    }
    const dest = small ?? canvas
    const palette = compact && scan && !interpolate ? compactScanPalette(dest, spec) : undefined
    if (channels === 1) return palette ?? await grayScan(dest, compact && interpolate)
    const quality = balanced ? .74 : compact ? (scan ? .62 : .58) : .65
    const blob = await dest.convertToBlob({ type: 'image/jpeg', quality })
    if (blob.type !== 'image/jpeg' || (palette && palette.bytes.length + JSON.stringify(palette.dict).length < blob.size)) return palette
    return { bytes: new Uint8Array(await blob.arrayBuffer()), dict: { '/Width': dest.width, '/Height': dest.height, '/Filter': '/DCTDecode' } }
  } finally { canvas.width = canvas.height = 1; if (small) small.width = small.height = 1 }
}

export async function optimizeImage(dict: PdfDict, src: Uint8Array, spec: Spec, mode: PdfCompressionMode): Promise<Replacement | undefined> {
  const { w, h, bits, channels, filter } = spec
  const base = { ...dict }; delete base['/Length']; delete base['/DecodeParms']
  let best: Replacement | undefined, cost = src.length + JSON.stringify(dict).length
  const offer = (r: Replacement | undefined, lossy = false) => {
    if (!r) return
    const dict = { ...base, ...r.dict }, size = r.bytes.length + JSON.stringify(dict).length
    // Do not trade away pixels for marginal savings over the best exact candidate.
    if (size + 32 < cost * (lossy ? .83 : 1)) { best = { bytes: r.bytes, dict }; cost = size }
  }
  const jpeg = filter === '/DCTDecode'
  if (jpeg && (mode === 'lossless' || (Math.max(w, h) <= (mode === 'balanced' ? 1600 : 1120) && src.length < w * h * .20))) return
  const raw = jpeg ? src : await samples(src, spec)
  if (!raw) return
  let indexed: Replacement | undefined
  if (!jpeg) {
    offer({ bytes: zlibSync(raw, { level: 9 }), dict: { '/Filter': '/FlateDecode' } })
    if (bits === 8) {
      if (!dict['/Interpolate']) { indexed = paletteImage(raw, spec); offer(indexed) }
      const delta = raw.slice(), row = w * channels
      for (let i = raw.length - 1; i >= 0; i--) if (i % row >= channels) delta[i] -= raw[i - channels]
      offer({ bytes: zlibSync(delta, { level: 9 }), dict: { '/Filter': '/FlateDecode', '/DecodeParms': {
        '/Predictor': 2, '/BitsPerComponent': 8, '/Colors': channels, '/Columns': w,
      } } })
    }
  }
  if (mode !== 'lossless' && !indexed && bits === 8 && (channels === 3 || jpeg || mode === 'compact')) {
    try { offer(await imageCandidate(raw, spec, jpeg, mode, !!dict['/Interpolate']), true) } catch { /* Unsupported codec or canvas: keep the untouched stream/exact candidate. */ }
  }
  return best
}
