import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import { Sidebar } from './Sidebar'

// Exercise real sidebar row selection and sortable markup without painting PDFs
// or introducing a DOM dependency. PdfPage owns viewport-based lazy painting.
vi.mock('./PdfPage', () => ({
  PdfPage: ({ compact, textLayer, interactive }: { compact: boolean; textLayer: boolean; interactive: boolean }) =>
    createElement('i', { 'data-lazy-thumbnail': compact && !textLayer && !interactive }),
}))

const source = (id: string): PdfSource => ({
  id, name: `${id}.pdf`, bytes: new Uint8Array(), pageCount: 2,
  pageText: [], pageSizes: [], textIndexed: false,
})
const page = (id: string, sourceId: string, groupId = sourceId): WorkspacePage => ({
  id, sourceId, groupId, sourcePage: 0, rotation: 0, annotations: [],
})
const noop = () => undefined
const sources = [source('first'), source('second')]
const pages = [page('first-1', 'first'), page('second-1', 'second'), page('second-2', 'second')]
const props: ComponentProps<typeof Sidebar> = {
  pages, sources, activeId: 'first-1', selectedIds: new Set(), multiSelect: false,
  canPaste: false, onClose: noop, onSelect: noop, onReorder: noop,
  onReorderSources: noop, onRenameSource: noop, onCompressSource: noop,
  onRotate: noop, onDelete: noop, onReplace: noop, onRemoveSource: noop,
  onImport: noop, onCopy: noop, onCut: noop, onPaste: noop,
  onInsertExternal: noop, onReplaceExternal: noop, onExportSelected: noop,
  onOutlineJump: noop,
}
const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(Sidebar, { ...props, ...overrides }))
const rowIds = (html: string) => [...html.matchAll(/data-page-id="([^"]+)"/g)].map((match) => match[1])

describe('Sidebar thumbnail scope', () => {
  it('keeps every appended job/file page in workspace order even when the first source stays active', () => {
    const html = render({ showAllPages: true })
    expect(rowIds(html)).toEqual(['first-1', 'second-1', 'second-2'])
    expect(html).toContain('aria-label="全部页面缩略图"')
    expect(html.match(/data-lazy-thumbnail="true"/g)).toHaveLength(3)
    expect(rowIds(render({ showAllPages: true, activeId: 'second-1' }))).toEqual(rowIds(html))
  })

  it('preserves editor file grouping, including pages pasted from another source', () => {
    const grouped = [...pages, page('pasted', 'second', 'first')]
    expect(rowIds(render({ pages: grouped }))).toEqual(['first-1', 'pasted'])
    expect(rowIds(render({ pages: grouped, activeId: 'second-1' }))).toEqual(['second-1', 'second-2'])
  })

  it('does not regroup interleaved workspace pages or discard blank and unavailable-source rows', () => {
    const ordered = [pages[2], page('blank-1', 'blank'), pages[0], page('unavailable', 'missing'), pages[1]]
    expect(rowIds(render({ pages: ordered, showAllPages: true }))).toEqual(ordered.map((item) => item.id))
  })
})
