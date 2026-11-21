import { describe, expect, it } from 'vitest'
import { documentPathKey, planEditorOpen } from './editorDocuments'
import { updatedWatermarks, type Watermarks } from '../hooks/useWorkspace'
import type { DocumentWatermark, PdfSource, WorkspacePage } from '../types/pdf'

function source(id: string, path?: string): PdfSource {
  return { id, path, name: 'report.pdf', bytes: new Uint8Array(), pageCount: 1, pageText: [], pageSizes: [], textIndexed: false }
}
const page = (sourceId: string, groupId = sourceId): WorkspacePage => ({ id: `p-${groupId}`, sourceId, groupId, sourcePage: 0, rotation: 0, annotations: [] })

describe('editor document identity', () => {
  it('compares host Windows paths, not display names, and keeps POSIX case sensitivity', () => {
    expect(documentPathKey('C:/A/report.pdf')).toBe(documentPathKey('\\\\?\\c:\\a\\REPORT.pdf'))
    expect(documentPathKey('\\\\?\\UNC\\server\\share\\a.pdf')).toBe(documentPathKey('//SERVER/share/A.pdf'))
    expect(documentPathKey('/a/report.pdf')).not.toBe(documentPathKey('/A/report.pdf'))
    expect(documentPathKey('report.pdf')).toBeUndefined()
    const a = source('a', 'C:/A/report.pdf'), b = { path: 'C:/B/report.pdf' }
    expect(planEditorOpen([b, { path: 'c:\\B\\REPORT.pdf' }, { path: 'C:/A/report.pdf' }], [a], [page('a')]))
      .toEqual({ activate: a, files: [b] })
  })
  it('never identifies pathless files or hidden backing sources as editable tabs', () => {
    const old = source('a', 'C:/A/report.pdf'), moved = page('a', 'another-document'), unknown = { path: '', name: old.name }
    const files = [unknown, unknown, { path: old.path! }]
    expect(planEditorOpen(files, [old], [moved])).toEqual({ activate: undefined, files })
  })
  it('can recognize a converted input without making its original writable', () => {
    const ofd = { ...source('a'), originalPath: 'C:/Forms/report.ofd' }
    expect(planEditorOpen([{ path: 'c:\\forms\\REPORT.ofd' }], [ofd], [page('a')])).toEqual({ activate: ofd, files: [] })
    expect(ofd.path).toBeUndefined()
  })
})

describe('watermark history snapshots', () => {
  const stamp: DocumentWatermark = { kind: 'text', text: 'A', opacity: .4, rotation: -17, tiled: true, x: .2, y: .1, width: .3, height: .15, gapX: .1, gapY: .2 }
  it('isolates all geometry, edits and removals without mutating undo entries or adding no-op steps', () => {
    const a = updatedWatermarks(new Map(), 'a', stamp)
    const b = updatedWatermarks(a, 'b', { ...stamp, text: 'B', rotation: 21 })
    const resized = updatedWatermarks(b, 'a', { ...stamp, x: .7, width: .2 })
    expect(updatedWatermarks(b, 'a', { ...stamp })).toBe(b)
    expect(a.has('b')).toBe(false); expect(b.get('a')).toBe(stamp)
    expect(resized.get('a')).toMatchObject({ x: .7, width: .2, gapX: .1 }); expect(resized.get('b')).toBe(b.get('b'))
    const removed = updatedWatermarks(resized, 'a'); expect(removed.has('a')).toBe(false); expect(removed.get('b')).toBe(b.get('b'))
    expect(updatedWatermarks(removed, 'a')).toBe(removed)
  })
  it('keeps the merge and collector workspace-wide slot independent of document scope', () => {
    const workspace: Watermarks = updatedWatermarks(new Map(), undefined, stamp)
    expect(workspace.get(undefined)).toBe(stamp); expect(workspace.get('a')).toBeUndefined()
    expect(updatedWatermarks(workspace, 'a', { ...stamp, text: 'other' }).get(undefined)).toBe(stamp)
  })
})
