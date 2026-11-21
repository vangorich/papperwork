import { describe, expect, it } from 'vitest'
import { clonePagesForPaste, cloneWorkspaceTransfer, diffDirtyGroups, pruneDirtyGroups, rotateWorkspacePage } from './useWorkspace'
import { composePdf } from '../lib/pdf'
import { PDFDocument, degrees } from 'pdf-lib'
import type { PdfSource, WorkspacePage, WorkspaceTransferContent } from '../types/pdf'

describe('crop rotation shared by rotate and rotateMany', () => {
  it.each([0, 90, 180, 270])('preserves the selected source-space rectangle at source rotation %s', async (sourceRotation) => {
    const input = await PDFDocument.create()
    const sourcePage = input.addPage([600, 800])
    sourcePage.setCropBox(40, 60, 400, 600)
    sourcePage.setRotation(degrees(sourceRotation))
    const source: PdfSource = {
      id: 'rotation-source', name: 'rotation.pdf', bytes: await input.save(), pageCount: 1,
      pageText: [''], pageSizes: [{ width: 400, height: 600 }], textIndexed: true,
    }
    const original: WorkspacePage = {
      id: 'original', sourceId: source.id, sourcePage: 0, rotation: 0,
      crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, annotations: [],
    }
    const baseline = (await PDFDocument.load(await composePdf([original], [source]))).getPage(0).getCropBox()
    for (const delta of [-270, -180, -90, 0, 90, 180, 270, 360]) {
      const rotated = rotateWorkspacePage(original, delta)
      const bounds = (await PDFDocument.load(await composePdf([rotated], [source]))).getPage(0).getCropBox()
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(bounds[key]).toBeCloseTo(baseline[key])
      expect(original.crop).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    }
    let fullTurn = original
    for (let i = 0; i < 4; i += 1) fullTurn = rotateWorkspacePage(fullTurn, 90)
    expect(fullTurn.rotation).toBe(0)
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(fullTurn.crop![key]).toBeCloseTo(original.crop![key])
  })

  it('moves a left-half crop to the top half after clockwise rotation, along with annotations', () => {
    const crop = { x: 0, y: 0, width: 0.5, height: 1 }
    const rotated = rotateWorkspacePage({
      id: 'left', sourceId: 'blank', sourcePage: 0, rotation: 0, crop,
      annotations: [{ id: 'highlight', type: 'highlight', ...crop }],
    }, 90)
    expect(rotated.crop).toEqual({ x: 0, y: 0, width: 1, height: 0.5 })
    expect(rotated.annotations[0]).toMatchObject(rotated.crop!)
    expect(rotateWorkspacePage({ ...rotated, crop: undefined }, 90).crop).toBeUndefined()
  })
})

describe('workspace transfer', () => {
  it('preserves page edits while isolating source, page and annotation identities', () => {
    const source: PdfSource = {
      id: 'source-a', name: '合同.pdf', bytes: new Uint8Array([1, 2, 3]), pageCount: 1,
      pageText: ['正文'], pageSizes: [{ width: 595, height: 842 }], textIndexed: true,
    }
    const transfer: WorkspaceTransferContent = {
      sources: [source], suggestedName: '合同', scopeLabel: '当前页面',
      pages: [{
        id: 'page-a', sourceId: source.id, sourcePage: 0, rotation: 90,
        annotations: [{ id: 'note-a', type: 'note', x: 0.1, y: 0.2, width: 0.1, height: 0.1, text: '复核' }],
      }],
    }

    const cloned = cloneWorkspaceTransfer(transfer)
    expect(cloned.sources).toHaveLength(1)
    expect(cloned.pages).toHaveLength(1)
    expect(cloned.sources[0].id).not.toBe(source.id)
    expect(cloned.sources[0].bytes).toBe(source.bytes)
    expect(cloned.pages[0]).toMatchObject({ sourceId: cloned.sources[0].id, rotation: 90 })
    expect(cloned.pages[0].id).not.toBe(transfer.pages[0].id)
    expect(cloned.pages[0].annotations[0].id).not.toBe('note-a')
  })
})

describe('clonePagesForPaste', () => {
  const clipboardPage: WorkspacePage = {
    id: 'copied-page',
    sourceId: 'source-a',
    groupId: 'group-a',
    sourcePage: 2,
    rotation: 0,
    annotations: [{ id: 'ann-1', type: 'note', x: 0.1, y: 0.1, width: 0.1, height: 0.1, replies: [{ id: 'r-1', author: 'a', text: 't', createdAt: '' }] }],
  }

  it('assigns the anchor group so cross-file pastes stay at the paste location', () => {
    const [inserted] = clonePagesForPaste([clipboardPage], 'group-b')
    expect(inserted.groupId).toBe('group-b')
    expect(inserted.sourceId).toBe('source-a')
    expect(inserted.id).not.toBe(clipboardPage.id)
    expect(inserted.annotations[0].id).not.toBe('ann-1')
    expect(inserted.annotations[0].replies?.[0].id).not.toBe('r-1')
  })

  it('keeps the original group when no anchor group applies', () => {
    const [inserted] = clonePagesForPaste([clipboardPage], undefined)
    expect(inserted.groupId).toBe('group-a')
  })
})

describe('per-group dirty tracking', () => {
  const page = (id: string, groupId: string): WorkspacePage => ({
    id, sourceId: groupId, groupId, sourcePage: 0, rotation: 0, annotations: [],
  })

  it('attributes an edit to exactly the group whose pages changed', () => {
    const before = [page('a1', 'group-a'), page('b1', 'group-b')]
    const after = [before[0], { ...before[1], rotation: 90 }]
    expect([...diffDirtyGroups(before, after)]).toEqual(['group-b'])
  })

  it('marks both groups when a page moves across groups', () => {
    const before = [page('a1', 'group-a'), page('b1', 'group-b')]
    const after = [{ ...before[0], groupId: 'group-b' }, before[1]]
    const touched = diffDirtyGroups(before, after)
    expect(touched.has('group-a')).toBe(true)
    expect(touched.has('group-b')).toBe(true)
  })

  it('marks a group whose pages were all removed, and ignores pure group reordering', () => {
    const before = [page('a1', 'group-a'), page('b1', 'group-b')]
    expect([...diffDirtyGroups(before, [before[1]])].sort()).toEqual(['group-a'])
    expect(diffDirtyGroups(before, [before[1], before[0]]).size).toBe(0)
  })

  it('prunes the saved group and dead entries on markSaved', () => {
    const current = new Set(['group-a', 'group-b', 'group-gone'])
    const next = pruneDirtyGroups(current, 'group-a', new Set(['group-b']))
    expect([...next]).toEqual(['group-b'])
  })
})
