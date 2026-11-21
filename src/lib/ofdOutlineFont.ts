import { ofdError } from './ofdArchive'

// OFD producers often embed PDF-style TrueType subsets with no Unicode cmap
// or name table. CGTransform already names the exact GIDs. Read just their
// contours; do not install a font, run hint programs, or guess Unicode glyphs.
type Point = { x: number; y: number; on: boolean }
type Contours = Point[][]
export type GlyphShape = { width: number; advance: number; bounds: number[]; shape: string }
const bad = (why = '结构无效'): never => ofdError(`嵌入 TrueType 字形${why}`)
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true })
export function openOutlineFont(data: Uint8Array, spend: (amount: number) => void) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength),
    length = data.length
  if (length < 12 || ![0x00010000, 0x74727565].includes(v.getUint32(0)))
    return bad('不是受支持的 TrueType 轮廓')
  const count = v.getUint16(4),
    spans = new Map<string, [number, number]>()
  if (!count || count > 256 || 12 + 16 * count > length) return bad()
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16,
      tag = String.fromCharCode(...data.subarray(at, at + 4)),
      off = v.getUint32(at + 8),
      n = v.getUint32(at + 12)
    if (off + n > length || spans.has(tag)) return bad()
    spans.set(tag, [off, n])
  }
  const table = (name: string, min: number) => {
    const s = spans.get(name)
    return s && s[1] >= min ? s : bad()
  }
  const head = table('head', 54)[0],
    em = v.getUint16(head + 18),
    fmt = v.getInt16(head + 50),
    ng = v.getUint16(table('maxp', 6)[0] + 4),
    nm = v.getUint16(table('hhea', 36)[0] + 34)
  if (em < 16 || em > 16384 || ![0, 1].includes(fmt) || !ng || !nm || nm > ng) return bad()
  const loc = table('loca', (ng + 1) * (fmt ? 4 : 2))[0],
    glyf = table('glyf', 0),
    metrics = table('hmtx', 4 * nm + 2 * (ng - nm))[0]
  const offset = (gid: number) => (fmt ? v.getUint32(loc + gid * 4) : 2 * v.getUint16(loc + gid * 2))
  function contours(
    gid: number,
    stack: Set<number>,
    budget: { points: number; parts: number },
  ): Contours {
    if (
      !Number.isInteger(gid) ||
      gid < 0 ||
      gid >= ng ||
      stack.has(gid) ||
      stack.size > 14 ||
      ++budget.parts > 300
    )
      return bad('索引、复合层级或引用无效')
    const a = offset(gid),
      b = offset(gid + 1)
    if (a > b || b > glyf[1]) return bad()
    if (a === b) return []
    let p = glyf[0] + a
    const end = glyf[0] + b,
      take = (n: number) => {
        if (p + n > end) return bad()
        p += n
        return p - n
      }
    const u8 = () => v.getUint8(take(1)),
      s8 = () => v.getInt8(take(1)),
      u16 = () => v.getUint16(take(2)),
      s16 = () => v.getInt16(take(2))
    const n = s16()
    take(8)
    if (n >= 0) {
      if (n > 1024) return bad('轮廓数量过多')
      if (!n) return []
      const ends = Array.from({ length: n }, u16),
        size = ends[n - 1] + 1
      if (ends.some((e, i) => i && e <= ends[i - 1]) || (budget.points += size) > 32000)
        return bad('轮廓点数量无效')
      spend(size)
      take(u16())
      const flags: number[] = []
      while (flags.length < size) {
        const f = u8(),
          runs = f & 8 ? u8() + 1 : 1
        if (flags.length + runs > size) return bad()
        for (let i = 0; i < runs; ++i) flags.push(f)
      }
      let x = 0,
        y = 0
      const pts = flags.map((f) => {
        x += f & 2 ? (f & 16 ? 1 : -1) * u8() : f & 16 ? 0 : s16()
        return { x, y: 0, on: !!(f & 1) }
      })
      flags.forEach((f, i) => {
        y += f & 4 ? (f & 32 ? 1 : -1) * u8() : f & 32 ? 0 : s16()
        pts[i].y = y
      })
      return ends.map((e, i) => pts.slice(i ? ends[i - 1] + 1 : 0, e + 1))
    }
    if (n !== -1) return bad()
    const result: Contours = [],
      attached: Point[] = []
    stack.add(gid)
    let flags = 0
    do {
      flags = u16()
      const child = u16(),
        xy = !!(flags & 2),
        word = !!(flags & 1),
        arg = word ? (xy ? s16 : u16) : xy ? s8 : u8,
        u = arg(),
        w = arg()
      let xx = 1,
        yy = 1,
        yx = 0,
        xxY = 0
      if ([8, 64, 128].filter((bit) => flags & bit).length > 1 || (flags & 0x1800) === 0x1800)
        return bad()
      const fract = () => s16() / 16384
      if (flags & 8) {
        xx = yy = fract()
      } else if (flags & 64) {
        xx = fract()
        yy = fract()
      } else if (flags & 128) {
        xx = fract()
        yx = fract()
        xxY = fract()
        yy = fract()
      }
      const src = contours(child, stack, budget).map((c) =>
        c.map((p) => ({ x: xx * p.x + xxY * p.y, y: yx * p.x + yy * p.y, on: p.on })),
      )
      const points = src.flat()
      spend(points.length + 1)
      let dx = u,
        dy = w
      if (!xy) {
        if (!attached[u] || !points[w]) return bad()
        dx = attached[u].x - points[w].x
        dy = attached[u].y - points[w].y
      } else if (flags & 0x0800) {
        dx = xx * u + xxY * w
        dy = yx * u + yy * w
      }
      if (flags & 4) {
        dx = Math.round(dx)
        dy = Math.round(dy)
      }
      for (const pt of points) {
        pt.x += dx
        pt.y += dy
        if (Math.abs(pt.x) > 1e6 || Math.abs(pt.y) > 1e6) return bad()
        attached.push(pt)
      }
      for (const c of src) result.push(c)
    } while (flags & 32)
    if (flags & 256) take(u16())
    stack.delete(gid)
    return result
  }
  const unit = (n: number) => Math.round((n * 100000) / em) / 100
  return (gid: number): GlyphShape => {
    const cs = contours(gid, new Set(), { points: 0, parts: 0 }),
      aw = v.getUint16(metrics + 4 * Math.min(gid, nm - 1)),
      width = unit(aw)
    const bounds = [0, 0, 0, 0],
      ops: string[] = []
    for (const c of cs) {
      if (!c.length) continue
      for (const pt of c) {
        const x = unit(pt.x),
          y = unit(pt.y)
        bounds[0] = Math.min(bounds[0], x)
        bounds[1] = Math.min(bounds[1], y)
        bounds[2] = Math.max(bounds[2], x)
        bounds[3] = Math.max(bounds[3], y)
      }
      const first = c[0],
        last = c[c.length - 1],
        start = first.on ? first : last.on ? last : mid(last, first)
      let here = start
      ops.push(`${unit(start.x)} ${unit(start.y)} m`)
      for (let i = first.on ? 1 : 0; i < c.length; i++) {
        const q = c[i]
        if (q.on) {
          ops.push(`${unit(q.x)} ${unit(q.y)} l`)
          here = q
          continue
        }
        const next = c[i + 1] ?? start,
          end = next.on ? next : mid(q, next)
        if (next.on) i++
        ops.push(
          `${unit(here.x + ((q.x - here.x) * 2) / 3)} ${unit(here.y + ((q.y - here.y) * 2) / 3)} ${unit(end.x + ((q.x - end.x) * 2) / 3)} ${unit(end.y + ((q.y - end.y) * 2) / 3)} ${unit(end.x)} ${unit(end.y)} c`,
        )
        here = end
      }
      ops.push('h')
    }
    return {
      width,
      advance: aw / em,
      bounds,
      shape: `${width} 0 ${bounds.join(' ')} d1\n${ops.join('\n')}${ops.length ? '\nf' : ''}`,
    }
  }
}
