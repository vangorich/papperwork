import { PDFDocument } from 'pdf-lib'
import { svgPathToOperators } from 'pdf-lib/es/api/svgPath'
import { ofdError } from './ofdArchive'

const numberPattern = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i
export function numeric(token: string | undefined) {
  if (!token || !numberPattern.test(token)) return ofdError('缺少或无法解析绘图坐标')
  const n = Number(token)
  if (!Number.isFinite(n) || Math.abs(n) > 1e6) ofdError('绘图坐标超过上限')
  return Math.round(n * 1e6) / 1e6
}
export function tuple(value: string | null | undefined, length: number) {
  const pieces = (value ?? '').trim().split(/\s+/)
  if (pieces.length !== length) return ofdError('绘图坐标数量有误')
  return pieces.map(numeric)
}
const pdfN = (value: number) => Math.round(value * 1e6) / 1e6
const arity: Record<string, number> = { M: 2, S: 2, L: 2, Q: 4, B: 6, A: 7, C: 0 }

export function ofdPath(data: string) {
  if (data.length > 384000) ofdError('单条矢量路径超过上限')
  const tokens = data.trim().split(/\s+/), ops: string[] = []
  let x = 0, y = 0, startX = 0, startY = 0
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++], n = arity[command]
    if (!Object.hasOwn(arity, command) || i + n > tokens.length) ofdError('不支持或损坏的矢量路径命令')
    const v = tokens.slice(i, i + n).map(numeric); i += n
    switch (command) {
      case 'M': case 'S': [startX, startY] = v; ops.push(`${v.join(' ')} m`); break
      case 'L': ops.push(`${v.join(' ')} l`); break
      case 'B': ops.push(`${v.join(' ')} c`); break
      case 'Q': ops.push(`${[x + (v[0] - x) * 2 / 3, y + (v[1] - y) * 2 / 3, v[2] + (v[0] - v[2]) * 2 / 3, v[3] + (v[1] - v[3]) * 2 / 3, v[2], v[3]].map(pdfN).join(' ')} c`); break
      case 'A':
        if (x === v[5] && y === v[6]) break
        if (!v[0] || !v[1]) { ops.push(`${v[5]} ${v[6]} l`); break }
        if (![0, 1].includes(v[3]) || ![0, 1].includes(v[4])) ofdError('椭圆弧标志无效')
        ops.push(...svgPathToOperators(`M ${x} ${y} A ${v.join(' ')}`).slice(1).map(op => op.toString())); break
      case 'C': ops.push('h'); x = startX; y = startY; continue
    }
    x = v[n - 2]; y = v[n - 1]
  }
  return ops.join('\n')
}

export function textDeltas(value: string | null, glyphs: number) {
  if (!value?.trim()) return []
  const tokens = value.trim().split(/\s+/), result: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const repeated = tokens[i].toLowerCase() === 'g'
    const count = repeated ? numeric(tokens[++i]) : 1
    if (count < 1 || !Number.isInteger(count) || result.length + count > glyphs) ofdError('文字间距数组无效或过长')
    const delta = numeric(tokens[repeated ? ++i : i])
    for (let j = 0; j < count; j++) result.push(delta)
  }
  return result
}

// Read dimensions BEFORE calling an image decoder. Only recognized, bounded
// raster formats enter the native decoder; no SVG, HTML, URLs or object URLs.
function rasterHeader(data: Uint8Array) {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length >= 33 && d.getUint32(0) === 0x89504e47 && d.getUint32(4) === 0x0d0a1a0a && d.getUint32(12) === 0x49484452) {
    return { type: 'image/png', width: d.getUint32(16), height: d.getUint32(20) }
  }
  if (data.length >= 4 && d.getUint16(0) === 0xffd8) {
    for (let i = 2; i + 9 <= data.length;) {
      if (data[i++] !== 255) break
      while (data[i] === 255) i++
      const marker = data[i++]
      if (i + 7 > data.length || marker === 0xda || marker === 0xd9) break
      const length = d.getUint16(i)
      if (length < 2 || i + length > data.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { type: 'image/jpeg', width: d.getUint16(i + 5), height: d.getUint16(i + 3) }
      i += length
    }
  }
  if (data.length >= 54 && d.getUint16(0) === 0x424d) {
    if(d.getUint32(14,true)!==40 || d.getUint16(26,true)!==1 || d.getUint32(30,true)!==0 || ![1,4,8,24,32].includes(d.getUint16(28,true))) return ofdError('仅支持未压缩的 Windows BMP 位图')
    return {type:'image/bmp',width:d.getInt32(18,true),height:Math.abs(d.getInt32(22,true))}
  }
  return ofdError('不支持或损坏的图像；当前支持 PNG、JPEG 和未压缩 BMP，不支持 JBIG2、印章容器或 SVG')
}

export async function embedOfdImage(pdf: PDFDocument, data: Uint8Array, reservePixels: (n: number) => void) {
  const { type, width, height } = rasterHeader(data)
  if (width<=0 || height<=0 || width > 16384 || height > 16384 || width * height > 12_000_000) ofdError('图像尺寸超过 1200 万像素上限')
  reservePixels(width * height)
  if(type==='image/bmp') {
    // BI_RGB rows are DWORD-aligned; a negative height is top-down. Read
    // pixels ourselves so a file extension cannot select a different codec.
    const d=new DataView(data.buffer,data.byteOffset,data.byteLength),off=d.getUint32(10,true),bpp=d.getUint16(28,true)
    const stride=Math.ceil(width*bpp/32)*4,colors=bpp<=8?(d.getUint32(46,true)||2**bpp):0
    if(colors>2**bpp||off<54+colors*4||off+stride*height>data.length)ofdError('BMP 像素或调色板不完整')
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
    try {const ctx=canvas.getContext('2d')??ofdError('无法初始化位图画布'), rgba=ctx.createImageData(width,height),topDown=d.getInt32(22,true)<0
      for(let y=0;y<height;y++){const row=off+(topDown?y:height-1-y)*stride;for(let x=0;x<width;x++){
        let pos=row+x*(bpp>>3)
        if(colors){const bit=x*bpp,index=(data[row+(bit>>3)]>>(8-bpp-bit%8))&((1<<bpp)-1);if(index>=colors)ofdError('BMP 调色板下标越界');pos=54+index*4}
        const i=(y*width+x)*4;rgba.data[i]=data[pos+2];rgba.data[i+1]=data[pos+1];rgba.data[i+2]=data[pos];rgba.data[i+3]=255
      }}ctx.putImageData(rgba,0,0);const blob=await new Promise<Blob>((ok,no)=>canvas.toBlob(v=>v?ok(v):no(Error('OFD：位图编码失败')),'image/png'));const image=await pdf.embedPng(await blob.arrayBuffer());await image.embed();return image
    }finally{canvas.width=canvas.height=1}
  }
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(new Blob([data], { type }), { imageOrientation: 'none' }) } catch { return ofdError('无法解码包内图像') }
  const canvas = document.createElement('canvas')
  try {
    if (bitmap.width !== width || bitmap.height !== height) ofdError('图像尺寸与文件头不符')
    // JPEG needs no conversion. Normalise PNG before passing it to pdf-lib's
    // JS decoder so auxiliary chunks, embedded profiles etc. are never parsed.
    if (type === 'image/jpeg') return await pdf.embedJpg(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice())
    canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d') ?? ofdError('无法初始化图像解码器')
    ctx.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('OFD：图像编码失败')), 'image/png'))
    const image = await pdf.embedPng(await png.arrayBuffer())
    await image.embed() // release the decoded PNG before processing the next resource
    return image
  } finally { bitmap.close(); canvas.width = canvas.height = 0 }
}
