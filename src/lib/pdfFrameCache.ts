import type { PdfSource } from '../types/pdf'

// A close/undo or close/reopen creates a new lifetime. A render that finishes
// after close must never reinsert its old bitmap (or revive its PDF worker).
type FrameOwner = { live: boolean }
const owners = new WeakMap<PdfSource, FrameOwner>()
export function pdfFrameOwner(source: PdfSource) {
  let owner = owners.get(source)
  if (!owner) owners.set(source, owner = { live: true })
  return owner
}

/** Owns completed scratch canvases, never canvases attached to the DOM. */
export class PdfFrameCache {
  private readonly frames = new Map<string, { owner: FrameOwner; canvas: HTMLCanvasElement }>()
  private readonly recent = new Set<string>()
  private bytes = 0

  constructor(private readonly maxBytes: number, private readonly maxCount: number) {}

  private protect(key: string) {
    this.recent.delete(key)
    this.recent.add(key)
    if (this.recent.size > 2) this.recent.delete(this.recent.values().next().value!)
  }

  get(owner: FrameOwner, key: string, visible = false) {
    const frame = this.frames.get(key)
    if (!frame || frame.owner !== owner || !owner.live) return
    this.frames.delete(key)
    this.frames.set(key, frame)
    if (visible) this.protect(key)
    return frame.canvas
  }

  put(owner: FrameOwner, key: string, canvas: HTMLCanvasElement, visible = false) {
    const bytes = canvas.width * canvas.height * 4
    if (!owner.live || bytes > this.maxBytes) { canvas.width = canvas.height = 0; return }
    this.remove(key)
    this.frames.set(key, { owner, canvas })
    this.bytes += bytes
    if (visible) this.protect(key)
    while (this.bytes > this.maxBytes || this.frames.size > this.maxCount) {
      // Speculation may evict itself, not the last two actual views. If the
      // views alone exceed either limit, even they must yield to the hard cap.
      let oldest = this.frames.keys().next().value!
      for (const candidate of this.frames.keys()) {
        if (!this.recent.has(candidate)) { oldest = candidate; break }
      }
      this.remove(oldest)
    }
  }

  private remove(key: string) {
    const frame = this.frames.get(key)
    if (!frame) return
    this.frames.delete(key)
    this.recent.delete(key)
    this.bytes -= frame.canvas.width * frame.canvas.height * 4
    frame.canvas.width = frame.canvas.height = 0
  }

  release(owner: FrameOwner) {
    for (const [key, frame] of this.frames) if (frame.owner === owner) this.remove(key)
  }
}

// Two worst-case 24 MP stage frames fit; thumbnails cannot evict either one.
export const pageFrames = new PdfFrameCache(192 * 1024 ** 2, 32)
export const thumbnailFrames = new PdfFrameCache(24 * 1024 ** 2, 96)

export function releasePdfFrames(source: PdfSource) {
  const owner = owners.get(source)
  if (!owner) return
  owner.live = false
  owners.delete(source)
  pageFrames.release(owner)
  thumbnailFrames.release(owner)
}
