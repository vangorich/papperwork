import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CropOverlay, adjustCropSelection, canStartPdfRender, normalizeTextHighlightRects, pdfFramePlan, pdfPageDisplayRatio, pdfPageRenderProfile, pdfPageUsesCompactProfile, preparePdfCanvas, resizeAnnotationBox } from './PdfPage'

describe('PdfPage rendering', () => {
  it('starts crop mode without a selection and leaves cancel available before drawing', () => {
    const html = renderToStaticMarkup(createElement(CropOverlay, { onApply: vi.fn(), onExtract: vi.fn(), onCancel: vi.fn() }))
    expect(html).not.toContain('class="crop-box"')
    expect(html).not.toContain('crop-handle')
    expect(html).toContain('<button type="button" disabled="">拆分页面</button>')
    expect(html).toContain('<button type="button" disabled="">应用裁剪</button>')
    expect(html).toContain('<button type="button">取消</button>')
  })

  it('opens an existing crop as an editable selection with all four handles', () => {
    const html = renderToStaticMarkup(createElement(CropOverlay, {
      initial: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, onApply: vi.fn(), onExtract: vi.fn(),
    }))
    expect(html).toContain('class="crop-box"')
    expect(html).toContain('left:10%;top:20%;width:30%;height:40%')
    for (const dir of ['nw', 'ne', 'sw', 'se']) expect(html).toContain(`crop-handle--${dir}`)
    expect(html).toContain('<button type="button">拆分页面</button>')
    expect(html).toContain('<button type="button">重置</button>')
  })
  it('moves crop selections within the page and resizes every corner about its opposite anchor', () => {
    const box = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 }
    expect(adjustCropSelection(box, -2, 2, 'move')).toEqual({ ...box, x: 0, y: 0.5 })
    for (const dir of ['nw', 'ne', 'sw', 'se'] as const) {
      const resized = adjustCropSelection(box, dir.includes('w') ? -2 : 2, dir.includes('n') ? -2 : 2, dir)
      expect(resized.x).toBeGreaterThanOrEqual(0)
      expect(resized.y).toBeGreaterThanOrEqual(0)
      expect(resized.x + resized.width).toBeLessThanOrEqual(1)
      expect(resized.y + resized.height).toBeLessThanOrEqual(1)
      expect(dir.includes('w') ? resized.x + resized.width : resized.x).toBeCloseTo(dir.includes('w') ? 0.6 : 0.2)
      expect(dir.includes('n') ? resized.y + resized.height : resized.y).toBeCloseTo(dir.includes('n') ? 0.8 : 0.3)
      const crossed = adjustCropSelection(box, dir.includes('w') ? 2 : -2, dir.includes('n') ? 2 : -2, dir)
      expect(crossed.width).toBeCloseTo(0.01)
      expect(crossed.height).toBeCloseTo(0.01)
    }
    expect(box).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 })
  })

  it('keeps a burst render slot available for newly visible pages', () => {
    expect(canStartPdfRender(1, 2, 2)).toBe(true)
    expect(canStartPdfRender(1, 3, 3)).toBe(false)
    expect(canStartPdfRender(0, 3, 3)).toBe(true)
    expect(canStartPdfRender(0, 4, 3)).toBe(false)
  })

  it('sizes the canvas before applying the high-quality context settings', () => {
    const operations: string[] = []
    const context = {
      set imageSmoothingEnabled(value: boolean) { operations.push(`enabled:${value}`) },
      set imageSmoothingQuality(value: ImageSmoothingQuality) { operations.push(`quality:${value}`) },
    }
    let width = 0
    let height = 0
    const canvas = {
      get width() { return width },
      set width(value: number) { width = value; operations.push(`width:${value}`) },
      get height() { return height },
      set height(value: number) { height = value; operations.push(`height:${value}`) },
      style: { width: '', height: '' },
      getContext: vi.fn(() => {
        operations.push('context')
        return context
      }),
    } as unknown as HTMLCanvasElement

    expect(preparePdfCanvas(canvas, 1200.2, 1600.1, 'high')).toBe(context)
    expect(operations).toEqual([
      'width:1201',
      'height:1601',
      'context',
      'enabled:true',
      'quality:high',
    ])
    // The canvas is never pinned to inline pixel sizes: the stylesheet keeps it
    // stretched to the page box so the previous frame survives a re-render.
    expect(canvas.style.width).toBe('')
    expect(canvas.style.height).toBe('')
  })

  it('uses bounded quality tiers for compact, preload and visible pages', () => {
    expect(pdfPageRenderProfile('visible', true, 'sharp', 3)).toMatchObject({
      maxPixels: 420_000,
      maxOutput: 1.25,
    })
    expect(pdfPageRenderProfile('preload', false, 'sharp', 3)).toMatchObject({
      maxPixels: 2_000_000,
      maxOutput: 1.5,
    })
    expect(pdfPageRenderProfile('visible', false, 'sharp', 4)).toMatchObject({
      pixelRatio: 4,
      maxPixels: 24_000_000,
      maxOutput: 8,
    })
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1).pixelRatio).toBe(2)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1.25).pixelRatio).toBe(2)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1.5).pixelRatio).toBe(2)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 3).pixelRatio).toBe(3)
  })

  it('keys raster identity by orientation, physical pixels and sampling profile', () => {
    const size = { width: 612, height: 792 }, key = 'page:sample:1:0'
    const plan = (width: number, dpr = 1, quality: 'sharp' | 'smooth' = 'sharp') =>
      pdfFramePlan(key, size, width, 'visible', false, quality, dpr)
    const base = plan(816)
    // Detail floor: exact same source detail at fit width / 100%, no re-raster.
    expect(plan(816.125).key).toBe(base.key)
    expect(plan(408).key).toBe(base.key)
    expect(plan(816, 3).width).toBeGreaterThan(base.width)
    expect(plan(816, 3).key).not.toBe(base.key)
    expect(plan(816, 1, 'smooth').key).not.toBe(base.key)
    expect(pdfFramePlan('page:sample:1:180', size, 816, 'visible', false, 'sharp', 1).key).not.toBe(base.key)
    const poster = plan(24000, 3)
    expect(poster.width * poster.height).toBeLessThan(24_020_000)
  })

  it('preserves source detail when the visible page is zoomed out', () => {
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1, 1).pixelRatio).toBe(2)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1, 0.5).pixelRatio).toBe(4)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 1, 0.25).pixelRatio).toBe(8)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 2, 2).pixelRatio).toBe(2)
    expect(pdfPageRenderProfile('visible', false, 'sharp', 4, 0.1).pixelRatio).toBe(8)
  })

  it('restores full DPI when a folded document page becomes visible', () => {
    expect(pdfPageUsesCompactProfile(false, false, 'preload')).toBe(true)
    expect(pdfPageUsesCompactProfile(false, false, 'visible')).toBe(false)
    expect(pdfPageUsesCompactProfile(true, false, 'visible')).toBe(true)
  })

  it('uses known source geometry before a landscape page becomes visible', () => {
    expect(pdfPageDisplayRatio({ width: 842, height: 595 }, 0)).toBeCloseTo(595 / 842)
    expect(pdfPageDisplayRatio({ width: 842, height: 595 }, 90)).toBeCloseTo(842 / 595)
    expect(pdfPageDisplayRatio(undefined, 0)).toBe(1.414)
  })

  it('merges adjacent selected words into clipped page-relative line highlights', () => {
    const page = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }
    const boxes = normalizeTextHighlightRects([
      { left: 100, top: 80, right: 160, bottom: 100, width: 60, height: 20 },
      { left: 166, top: 80, right: 240, bottom: 100, width: 74, height: 20 },
      { left: 100, top: 112, right: 180, bottom: 132, width: 80, height: 20 },
      { left: -20, top: 150, right: 30, bottom: 170, width: 50, height: 20 },
    ], page)

    expect(boxes).toHaveLength(3)
    expect(boxes[0]).toEqual({ x: 0.1, y: 0.1, width: 0.14, height: 0.025 })
    expect(boxes[1]).toEqual({ x: 0.1, y: 0.14, width: 0.08, height: 0.025 })
    expect(boxes[2]).toEqual({ x: 0, y: 0.1875, width: 0.03, height: 0.025 })
  })

  it('keeps selection highlight coordinates stable across display zoom', () => {
    const atOne = normalizeTextHighlightRects([
      { left: 120, top: 80, right: 320, bottom: 120, width: 200, height: 40 },
    ], { left: 20, top: 20, right: 1020, bottom: 820, width: 1000, height: 800 })
    const atTwo = normalizeTextHighlightRects([
      { left: 240, top: 160, right: 640, bottom: 240, width: 400, height: 80 },
    ], { left: 40, top: 40, right: 2040, bottom: 1640, width: 2000, height: 1600 })
    expect(atTwo).toEqual(atOne)
  })

  it('supports proportional and free image resizing within page bounds', () => {
    const initial = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }
    const proportional = resizeAnnotationBox(initial, 0.1, 0.01, true)
    expect(proportional.width).toBeCloseTo(0.3)
    expect(proportional.height).toBeCloseTo(0.15)
    const free = resizeAnnotationBox(initial, 0.1, 0.01, false)
    expect(free.width).toBeCloseTo(0.3)
    expect(free.height).toBeCloseTo(0.11)

    const bounded = resizeAnnotationBox({ x: 0.8, y: 0.85, width: 0.1, height: 0.05 }, 0.5, 0.5, true)
    expect(bounded.width).toBeCloseTo(0.2)
    expect(bounded.height).toBeCloseTo(0.1)

    const restored = resizeAnnotationBox(initial, 0.1, 0, true, 0.05, 0.035, 1.5)
    expect(restored.width / restored.height).toBeCloseTo(1.5)
  })

  it('anchors the opposite edge during directional resizes', () => {
    const initial = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 }
    // West edge: right side stays anchored at x + width = 0.5.
    const west = resizeAnnotationBox(initial, 0.05, 0.4, false, 0.05, 0.035, 1.5, 'w')
    expect(west.x).toBeCloseTo(0.25)
    expect(west.width).toBeCloseTo(0.25)
    expect(west.y).toBeCloseTo(initial.y)
    expect(west.height).toBeCloseTo(initial.height)

    // North edge: bottom stays anchored at y + height = 0.4.
    const north = resizeAnnotationBox(initial, 0.4, 0.05, false, 0.05, 0.035, 1.5, 'n')
    expect(north.y).toBeCloseTo(0.25)
    expect(north.height).toBeCloseTo(0.15)
    expect(north.x).toBeCloseTo(initial.x)
    expect(north.width).toBeCloseTo(initial.width)

    // West drag across the anchored edge clamps to the minimum width.
    const westClamp = resizeAnnotationBox(initial, 0.6, 0, false, 0.05, 0.035, 1.5, 'w')
    expect(westClamp.width).toBeCloseTo(0.05)
    expect(westClamp.x).toBeCloseTo(0.45)

    // Pure edge drags are single-axis even when aspect preservation is on.
    const edgeLocked = resizeAnnotationBox(initial, 0, 0.1, true, 0.05, 0.035, 1.5, 's')
    expect(edgeLocked.width).toBeCloseTo(initial.width)
    expect(edgeLocked.height).toBeCloseTo(0.3)
  })

  it('locks the aspect ratio only for corner drags and re-anchors the moved corner', () => {
    const initial = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 }
    // NW corner with ratio lock: the SE corner (0.5, 0.4) stays put.
    const nw = resizeAnnotationBox(initial, 0.1, 0.1, true, 0.05, 0.035, 1.5, 'nw')
    expect(nw.width / nw.height).toBeCloseTo(1.5)
    expect(nw.x + nw.width).toBeCloseTo(0.5)
    expect(nw.y + nw.height).toBeCloseTo(0.4)

    // Same drag without the lock moves each axis independently.
    const nwFree = resizeAnnotationBox(initial, 0.1, 0.1, false, 0.05, 0.035, 1.5, 'nw')
    expect(nwFree.x).toBeCloseTo(0.3)
    expect(nwFree.y).toBeCloseTo(0.3)
    expect(nwFree.width).toBeCloseTo(0.2)
    expect(nwFree.height).toBeCloseTo(0.1)
  })
})
