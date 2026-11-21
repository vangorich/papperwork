import { useCallback, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import type { DocumentWatermark, Markup, NoteReply, OcrPageResult, PdfSource, WorkspacePage, WorkspaceTransferContent } from '../types/pdf'
import { activatePersistedWatermark, extractPdfSelection, inheritPdfUnlockSession, inspectPdf, normalizeSourceDisplayName, pagesForSource, releasePdfDocument, type CropSelection } from '../lib/pdf'
import { uid } from '../lib/cn'
import { unreferencedSourceIds } from '../lib/sourceRetention'
import { cloneAnnotationsForPaste, rotateAnnotationCoordinates } from '../lib/annotations'
import { fitTextFontSize, rasterizeText } from '../lib/text'

// Undefined is the workspace-wide scope for merge/collector; editor keys are document group IDs.
export type Watermarks = ReadonlyMap<string | undefined, DocumentWatermark>
const NO_WATERMARKS: Watermarks = new Map()

export function updatedWatermarks(current: Watermarks, scope: string | undefined, next?: DocumentWatermark): Watermarks {
  const previous = current.get(scope)
  if (next === previous || (next && previous &&
    (Object.keys({ ...previous, ...next }) as (keyof DocumentWatermark)[]).every(key => previous[key] === next[key]))) return current
  const result = new Map(current)
  if (next) result.set(scope, next)
  else result.delete(scope)
  return result
}

function changedWatermarkGroups(before: Watermarks, after: Watermarks, pages: WorkspacePage[]) {
  const dirty = new Set<string>()
  if (before !== after) {
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(key) === after.get(key)) continue
      if (key === undefined) pages.forEach(page => dirty.add(pageGroupId(page)))
      else dirty.add(key)
    }
  }
  return dirty
}

interface HistoryEntry {
  pages: WorkspacePage[]
  /** Document watermark rides the same undo stack as page edits. */
  watermarks: Watermarks
  /** 仅来源整组排序需要同步恢复来源数组；普通页面编辑无需触碰来源。 */
  sourceOrder?: string[]
}

const pageGroupId = (page: WorkspacePage) => page.groupId ?? page.sourceId

function applySourceOrder(current: PdfSource[], order: string[]) {
  const byId = new Map(current.map((source) => [source.id, source]))
  const ordered = order.flatMap((id) => {
    const source = byId.get(id)
    if (!source) return []
    byId.delete(id)
    return [source]
  })
  return [...ordered, ...current.filter((source) => byId.has(source.id))]
}

export function cloneWorkspaceTransfer(transfer: WorkspaceTransferContent) {
  const uniqueSources = [...new Map(transfer.sources.map((source) => [source.id, source])).values()]
  const sources = uniqueSources.map((source) => inheritPdfUnlockSession(source, {
    ...source,
    id: uid(),
    pageText: [...source.pageText],
    pageSizes: source.pageSizes.map((size) => ({ ...size })),
    pageSizeLoaded: source.pageSizeLoaded ? [...source.pageSizeLoaded] : undefined,
    documentInfo: source.documentInfo ? { ...source.documentInfo } : undefined,
    fileInfo: source.fileInfo ? { ...source.fileInfo } : undefined,
  }))
  const sourceIds = new Map(uniqueSources.map((source, index) => [source.id, sources[index].id]))
  const pages = transfer.pages.flatMap((page) => {
    if (page.sourceId !== 'blank' && !sourceIds.has(page.sourceId)) return []
    const sourceId = page.sourceId === 'blank' ? 'blank' : sourceIds.get(page.sourceId)!
    return [{
      ...page,
      id: uid(),
      sourceId,
      groupId: sourceIds.get(pageGroupId(page)) ?? sourceId,
      annotations: cloneAnnotationsForPaste(page.annotations),
    }]
  })
  return { sources, pages }
}

/**
 * Clone clipboard pages for insertion at a paste anchor: fresh page/annotation
 * identities, and — crucially — the anchor's file group. Without the group
 * reassignment, a cross-file paste kept the source file's groupId, so
 * activating the inserted pages snapped the reading view back to the copy
 * source instead of staying at the paste location.
 */
export function clonePagesForPaste(templates: WorkspacePage[], targetGroupId?: string) {
  return templates.map((page) => ({
    ...page,
    id: uid(),
    groupId: targetGroupId ?? page.groupId,
    annotations: page.annotations.map((annotation) => ({
      ...annotation,
      id: uid(),
      replies: annotation.replies?.map((reply) => ({ ...reply, id: uid() })),
    })),
  }))
}

/** Group ids whose page list (membership, order or page refs) differs. */
export function diffDirtyGroups(before: WorkspacePage[], after: WorkspacePage[]) {
  const touched = new Set<string>()
  if (before === after) return touched
  const groupBy = (list: WorkspacePage[]) => {
    const map = new Map<string, WorkspacePage[]>()
    for (const page of list) {
      const id = pageGroupId(page)
      const group = map.get(id)
      if (group) group.push(page)
      else map.set(id, [page])
    }
    return map
  }
  const beforeGroups = groupBy(before)
  const afterGroups = groupBy(after)
  for (const [id, group] of afterGroups) {
    const previous = beforeGroups.get(id)
    if (!previous || previous.length !== group.length || group.some((page, index) => page !== previous[index])) touched.add(id)
  }
  for (const id of beforeGroups.keys()) if (!afterGroups.has(id)) touched.add(id)
  return touched
}

/**
 * markSaved(groupId) reducer: drops the saved group plus any dead entries
 * (closed sources / groups with no pages left — nothing writable remains for
 * them, and they must not block the "everything saved" revision sync).
 */
export function pruneDirtyGroups(current: ReadonlySet<string>, savedGroupId: string, liveGroupIds: ReadonlySet<string>) {
  return new Set([...current].filter((id) => id !== savedGroupId && liveGroupIds.has(id)))
}

export function rotateWorkspacePage(
  page: WorkspacePage,
  delta: number,
  rotateAnnotation = rotateAnnotationCoordinates,
): WorkspacePage {
  let crop = page.crop
  const turns = ((Math.round(delta / 90) % 4) + 4) % 4
  for (let turn = 0; crop && turn < turns; turn += 1) {
    crop = { x: 1 - crop.y - crop.height, y: crop.x, width: crop.height, height: crop.width }
  }
  return {
    ...page,
    rotation: ((page.rotation + delta) % 360 + 360) % 360,
    crop,
    annotations: page.annotations.map((annotation) => rotateAnnotation(annotation, delta)),
  }
}

export function useWorkspace() {
  const [sources, setSources] = useState<PdfSource[]>([])
  const [pages, setPages] = useState<WorkspacePage[]>([])
  const [watermarks, setWatermarkState] = useState(NO_WATERMARKS)
  const [activeId, setActiveId] = useState<string>()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const past = useRef<HistoryEntry[]>([])
  const future = useRef<HistoryEntry[]>([])
  const sourcesRef = useRef(sources)
  const pagesRef = useRef(pages)
  const watermarkRef = useRef(watermarks)
  sourcesRef.current = sources
  pagesRef.current = pages
  watermarkRef.current = watermarks
  // Unsaved-changes tracking: a monotonically increasing revision bumped by
  // every content mutation, compared against the revision at the last save.
  // `savedRevision` is state so markSaved() re-renders observers (the App
  // effect that mirrors dirty state to the main process for close prompts).
  const revision = useRef(0)
  const [savedRevision, setSavedRevision] = useState(0)
  // Per-group attribution of the same dirty state: the editor saves (and the
  // close guard prompts) one source file at a time, so it needs to know WHICH
  // groups changed since their own last save. A group id here is
  // page.groupId ?? page.sourceId — the same key sourcesById uses.
  const [dirtyGroupIds, setDirtyGroupIds] = useState<ReadonlySet<string>>(() => new Set())
  const dirtyGroupIdsRef = useRef(dirtyGroupIds)

  const markGroupsDirty = useCallback((touched: ReadonlySet<string>) => {
    if (!touched.size) return
    const next = new Set(dirtyGroupIdsRef.current)
    touched.forEach((id) => next.add(id))
    dirtyGroupIdsRef.current = next
    setDirtyGroupIds(next)
  }, [])

  const markDocumentMetadataDirty = useCallback((groupId: string) => {
    revision.current += 1
    markGroupsDirty(new Set([groupId]))
  }, [markGroupsDirty])

  const commit = useCallback((
    update: (current: WorkspacePage[]) => WorkspacePage[],
    cleanGroupIds?: ReadonlySet<string>,
  ) => {
    const previousWatermarks = watermarkRef.current
    setPages((current) => {
      const next = update(current)
      if (next === current) return current
      past.current = [...past.current.slice(-49), { pages: current, watermarks: previousWatermarks }]
      if (next.length < current.length && previousWatermarks.size) {
        // Keep a removed document's stamp in undo, not in the live workspace
        // (in particular the next unnamed document reuses the 'blank' group).
        const live = new Set(next.map(pageGroupId))
        const kept = new Map(previousWatermarks)
        for (const group of kept.keys()) if (group !== undefined && !live.has(group)) kept.delete(group)
        if (kept.size !== previousWatermarks.size) {
          watermarkRef.current = kept
          setWatermarkState(kept)
        }
      }
      future.current = []
      pagesRef.current = next
      revision.current += 1
      const touched = diffDirtyGroups(current, next)
      cleanGroupIds?.forEach((id) => touched.delete(id))
      markGroupsDirty(touched)
      return next
    })
  }, [markGroupsDirty])

  /** Document-level watermark edits are single undoable steps. */
  const setWatermark = useCallback((next?: DocumentWatermark, scope?: string) => {
    const updated = updatedWatermarks(watermarkRef.current, scope, next)
    if (updated === watermarkRef.current) return
    past.current = [...past.current.slice(-49), { pages: pagesRef.current, watermarks: watermarkRef.current }]
    future.current = []
    revision.current += 1
    markGroupsDirty(changedWatermarkGroups(watermarkRef.current, updated, pagesRef.current))
    watermarkRef.current = updated
    setWatermarkState(updated)
  }, [markGroupsDirty])

  /** Load sources; returns the first new page id so callers can navigate to it
   *  (page ids are generated here — a second pagesForSource call would mint
   *  different ids that exist nowhere in the workspace). */
  const load = useCallback((incoming: PdfSource[], append = false, appendedAsClean = false) => {
    // The editor passes true for independent, clean source groups. Collector,
    // merge and external-print imports must keep the original baked artwork.
    let loadedMarks = append ? watermarkRef.current : NO_WATERMARKS
    if (appendedAsClean) for (const source of incoming) {
      const mark = activatePersistedWatermark(source)
      if (mark) loadedMarks = updatedWatermarks(loadedMarks, source.id, mark)
    }
    const incomingPages = incoming.flatMap(pagesForSource)
    setSources((current) => {
      const next = append ? [...current, ...incoming] : incoming
      sourcesRef.current = next
      return next
    })
    if (append) {
      const cleanGroupIds = appendedAsClean
        ? new Set(incomingPages.map(pageGroupId))
        : undefined
      commit((current) => [...current, ...incomingPages], cleanGroupIds)
    } else {
      past.current = []
      future.current = []
      revision.current = 0
      setSavedRevision(0)
      dirtyGroupIdsRef.current = new Set()
      setDirtyGroupIds(new Set())
      pagesRef.current = incomingPages
      setPages(incomingPages)
    }
    // commit() already captured the previous map for append/undo. Do not
    // record a second edit or mark a freshly opened file dirty for hydration.
    if (loadedMarks !== watermarkRef.current) {
      watermarkRef.current = loadedMarks
      setWatermarkState(loadedMarks)
    }
    const first = incomingPages[0]?.id
    if (!append || !activeId) setActiveId(first)
    setSelectedIds(first ? new Set([first]) : new Set())
    return first
  }, [activeId, commit])

  const appendTransfer = useCallback((transfer: WorkspaceTransferContent) => {
    if (!transfer.pages.length) return 0
    const { sources: clonedSources, pages: inserted } = cloneWorkspaceTransfer(transfer)
    if (!inserted.length) return 0
    setSources((current) => {
      const next = [...current, ...clonedSources]
      sourcesRef.current = next
      return next
    })
    commit((current) => [...current, ...inserted])
    setActiveId(inserted[0].id)
    setSelectedIds(new Set(inserted.map((page) => page.id)))
    return inserted.length
  }, [commit])

  const undo = useCallback(() => {
    const previous = past.current.pop()
    if (!previous) return
    revision.current += 1
    future.current.push({
      pages: pagesRef.current,
      watermarks: watermarkRef.current,
      sourceOrder: previous.sourceOrder ? sourcesRef.current.map((source) => source.id) : undefined,
    })
    if (previous.sourceOrder) {
      setSources((current) => {
        const next = applySourceOrder(current, previous.sourceOrder ?? [])
        sourcesRef.current = next
        return next
      })
    }
    markGroupsDirty(diffDirtyGroups(pagesRef.current, previous.pages))
    markGroupsDirty(changedWatermarkGroups(watermarkRef.current, previous.watermarks, previous.pages))
    pagesRef.current = previous.pages
    setPages(previous.pages)
    watermarkRef.current = previous.watermarks
    setWatermarkState(previous.watermarks)
  }, [markGroupsDirty])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    revision.current += 1
    past.current.push({
      pages: pagesRef.current,
      watermarks: watermarkRef.current,
      sourceOrder: next.sourceOrder ? sourcesRef.current.map((source) => source.id) : undefined,
    })
    if (next.sourceOrder) {
      setSources((current) => {
        const reordered = applySourceOrder(current, next.sourceOrder ?? [])
        sourcesRef.current = reordered
        return reordered
      })
    }
    markGroupsDirty(diffDirtyGroups(pagesRef.current, next.pages))
    markGroupsDirty(changedWatermarkGroups(watermarkRef.current, next.watermarks, next.pages))
    pagesRef.current = next.pages
    setPages(next.pages)
    watermarkRef.current = next.watermarks
    setWatermarkState(next.watermarks)
  }, [markGroupsDirty])

  const select = useCallback((id: string, additive = false, range = false) => {
    if (range && activeId) {
      const anchor = pages.findIndex((page) => page.id === activeId)
      const target = pages.findIndex((page) => page.id === id)
      if (anchor >= 0 && target >= 0) {
        const [start, end] = anchor < target ? [anchor, target] : [target, anchor]
        setSelectedIds(new Set(pages.slice(start, end + 1).map((page) => page.id)))
        setActiveId(id)
        return
      }
    }
    setActiveId(id)
    setSelectedIds((current) => {
      if (!additive) return new Set([id])
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [activeId, pages])

  const selectAll = useCallback((scope = pages) => {
    setSelectedIds(new Set(scope.map((page) => page.id)))
    setActiveId((current) => current ?? scope[0]?.id)
  }, [pages])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const reorder = useCallback((active: string, over: string) => {
    if (active === over) return
    commit((current) => {
      const activeIndex = current.findIndex((page) => page.id === active)
      const overIndex = current.findIndex((page) => page.id === over)
      if (activeIndex < 0 || overIndex < 0) return current
      const target = current[overIndex]
      const grouped = current.map((page, index) => index === activeIndex
        ? { ...page, groupId: target.groupId ?? target.sourceId }
        : page)
      return arrayMove(grouped, activeIndex, overIndex)
    })
  }, [commit])

  const reorderSources = useCallback((activeSourceId: string, overSourceId: string) => {
    if (activeSourceId === overSourceId) return

    const currentSources = sourcesRef.current
    const sourceFrom = currentSources.findIndex((source) => source.id === activeSourceId)
    const sourceTo = currentSources.findIndex((source) => source.id === overSourceId)
    if (sourceFrom < 0 || sourceTo < 0) return

    const currentPages = pagesRef.current
    const groupOrder = [...new Set(currentPages.map(pageGroupId))]
    const groupFrom = groupOrder.indexOf(activeSourceId)
    const groupTo = groupOrder.indexOf(overSourceId)
    if (groupFrom < 0 || groupTo < 0) return

    const nextSources = arrayMove(currentSources, sourceFrom, sourceTo)
    const nextGroupOrder = arrayMove(groupOrder, groupFrom, groupTo)
    const pagesByGroup = new Map<string, WorkspacePage[]>()
    currentPages.forEach((page) => {
      const groupId = pageGroupId(page)
      const group = pagesByGroup.get(groupId)
      if (group) group.push(page)
      else pagesByGroup.set(groupId, [page])
    })
    const nextPages = nextGroupOrder.flatMap((groupId) => pagesByGroup.get(groupId) ?? [])

    // 来源排序是一个原子操作：来源标题与导出页序共用同一条历史记录。
    past.current = [
      ...past.current.slice(-49),
      { pages: currentPages, watermarks: watermarkRef.current, sourceOrder: currentSources.map((source) => source.id) },
    ]
    future.current = []
    revision.current += 1
    sourcesRef.current = nextSources
    pagesRef.current = nextPages
    setSources(nextSources)
    setPages(nextPages)
  }, [])

  const renameSource = useCallback((sourceId: string, rawName: string) => {
    const name = normalizeSourceDisplayName(rawName)
    if (!name) return false
    const source = sourcesRef.current.find((item) => item.id === sourceId)
    if (!source) return false
    const nextName = name === source.name ? undefined : name
    if (source.displayName === nextName) return false

    // Keep object identity: PDF.js document/text caches use PdfSource as a WeakMap key.
    source.displayName = nextName
    const next = [...sourcesRef.current]
    sourcesRef.current = next
    setSources(next)
    return true
  }, [])

  const rotateAnnotation = useCallback((annotation: Markup, delta: number) => {
    const rotated = rotateAnnotationCoordinates(annotation, delta)
    if (rotated.type !== 'text') return rotated
    const pageHeight = rotated.pageHeight ?? 120
    const pageWidth = pageHeight * (rotated.pageAspectRatio ?? 1 / 1.414)
    const next = rotated.autoFit
      ? {
          ...rotated,
          fontSize: fitTextFontSize(
            rotated.text ?? '',
            rotated.width * pageWidth - 6,
            rotated.height * pageHeight - 6,
            rotated.autoFitMaxSize ?? 28,
            4,
          ),
        }
      : rotated
    return { ...next, imageData: rasterizeText(next) }
  }, [])

  const rotate = useCallback((id: string, delta = 90) => {
    commit((current) => current.map((page) =>
      page.id === id ? rotateWorkspacePage(page, delta, rotateAnnotation) : page,
    ))
  }, [commit, rotateAnnotation])

  const rotateMany = useCallback((ids: Set<string>, delta = 90) => {
    commit((current) => current.map((page) =>
      ids.has(page.id) ? rotateWorkspacePage(page, delta, rotateAnnotation) : page,
    ))
  }, [commit, rotateAnnotation])

  const remove = useCallback((ids: Set<string>) => {
    commit((current) => current.filter((page) => !ids.has(page.id)))
    setSelectedIds(new Set())
    setActiveId((current) => {
      const remaining = pages.filter((page) => !ids.has(page.id))
      return ids.has(current ?? '') ? remaining[0]?.id : current
    })
  }, [commit, pages])

  const reverse = useCallback(() => commit((current) => [...current].reverse()), [commit])
  const clear = useCallback(() => {
    commit(() => [])
    setActiveId(undefined)
    setSelectedIds(new Set())
    watermarkRef.current = NO_WATERMARKS
    setWatermarkState(NO_WATERMARKS)
  }, [commit])

  /** Hard reset with no undo entry: every document closed, history dropped.
   *  Used by 「关闭所有文件」 and the window-close session reset. */
  const reset = useCallback(() => {
    past.current = []
    future.current = []
    revision.current = 0
    setSavedRevision(0)
    dirtyGroupIdsRef.current = new Set()
    setDirtyGroupIds(new Set())
    sourcesRef.current = []
    pagesRef.current = []
    watermarkRef.current = NO_WATERMARKS
    setSources([])
    setPages([])
    setWatermarkState(NO_WATERMARKS)
    setActiveId(undefined)
    setSelectedIds(new Set())
  }, [])

  const insertBlank = useCallback(() => {
    const active = pages.find((page) => page.id === activeId)
    const blank: WorkspacePage = {
      id: uid(), sourceId: 'blank', groupId: active?.groupId ?? active?.sourceId, sourcePage: 0, rotation: 0, annotations: [],
    }
    commit((current) => {
      const index = current.findIndex((page) => page.id === activeId)
      const next = [...current]
      next.splice(index < 0 ? current.length : index + 1, 0, blank)
      return next
    })
    setActiveId(blank.id)
    setSelectedIds(new Set([blank.id]))
  }, [activeId, commit, pages])

  const duplicateSelected = useCallback((ids: Set<string>) => {
    const duplicateIds = new Map(
      pages.filter((page) => ids.has(page.id)).map((page) => [page.id, uid()]),
    )
    const firstDuplicate = duplicateIds.values().next().value as string | undefined
    commit((current) => current.flatMap((page) => {
      if (!ids.has(page.id)) return [page]
      const duplicate = {
        ...page,
        id: duplicateIds.get(page.id) ?? uid(),
        annotations: page.annotations.map((annotation) => ({
          ...annotation,
          id: uid(),
          replies: annotation.replies?.map((reply) => ({ ...reply, id: uid() })),
        })),
      }
      return [page, duplicate]
    }))
    if (firstDuplicate) {
      setActiveId(firstDuplicate)
      setSelectedIds(new Set([firstDuplicate]))
    }
  }, [commit, pages])

  const insertPagesAfter = useCallback((anchorId: string | undefined, templates: WorkspacePage[]) => {
    // Pasted pages join the anchor's file group (see clonePagesForPaste).
    const anchorPage = anchorId ? pagesRef.current.find((page) => page.id === anchorId) : undefined
    const targetGroupId = anchorPage ? pageGroupId(anchorPage) : undefined
    const inserted = clonePagesForPaste(templates, targetGroupId)
    if (!inserted.length) return
    commit((current) => {
      const anchor = current.findIndex((page) => page.id === anchorId)
      const next = [...current]
      next.splice(anchor < 0 ? current.length : anchor + 1, 0, ...inserted)
      return next
    })
    setActiveId(inserted[0].id)
    setSelectedIds(new Set(inserted.map((page) => page.id)))
  }, [commit])

  const addAnnotation = useCallback((pageId: string, annotation: Omit<Markup, 'id'>) => {
    if (!pagesRef.current.some((page) => page.id === pageId)) return undefined
    const id = uid()
    commit((current) => {
      if (!current.some((page) => page.id === pageId)) return current
      return current.map((page) => page.id === pageId
        ? { ...page, annotations: [...page.annotations, { ...annotation, id }] }
        : page,
      )
    })
    return id
  }, [commit])

  const addAnnotations = useCallback((pageId: string, templates: Markup[]) => {
    if (!templates.length || !pagesRef.current.some((page) => page.id === pageId)) return []
    const inserted = cloneAnnotationsForPaste(templates)
    commit((current) => current.map((page) => page.id === pageId
      ? { ...page, annotations: [...page.annotations, ...inserted] }
      : page,
    ))
    return inserted.map((annotation) => annotation.id)
  }, [commit])

  const removeAnnotation = useCallback((pageId: string, annotationId: string) => {
    commit((current) => current.map((page) => page.id === pageId
      ? { ...page, annotations: page.annotations.filter((item) => item.id !== annotationId) }
      : page,
    ))
  }, [commit])

  const removeAnnotations = useCallback((pageId: string, annotationIds: Set<string>) => {
    if (!annotationIds.size) return
    commit((current) => {
      let changed = false
      const next = current.map((page) => {
        if (page.id !== pageId) return page
        const annotations = page.annotations.filter((item) => !annotationIds.has(item.id))
        if (annotations.length === page.annotations.length) return page
        changed = true
        return { ...page, annotations }
      })
      return changed ? next : current
    })
  }, [commit])

  const updateAnnotation = useCallback((pageId: string, annotationId: string, patch: Partial<Markup>) => {
    commit((current) => {
      let changed = false
      const next = current.map((page) => page.id === pageId
        ? {
            ...page,
            annotations: page.annotations.map((item) => {
              if (item.id !== annotationId) return item
              if (Object.entries(patch).every(([key, value]) => Object.is(item[key as keyof Markup], value))) return item
              changed = true
              return { ...item, ...patch }
            }),
          }
        : page)
      return changed ? next : current
    })
  }, [commit])

  const addNoteReply = useCallback((
    pageId: string,
    noteId: string,
    reply: Omit<NoteReply, 'id'>,
  ) => {
    commit((current) => current.map((page) => page.id === pageId
      ? {
          ...page,
          annotations: page.annotations.map((annotation) => annotation.id === noteId && annotation.type === 'note'
            ? { ...annotation, replies: [...(annotation.replies ?? []), { ...reply, id: uid() }] }
            : annotation),
        }
      : page,
    ))
  }, [commit])

  const setCrop = useCallback((pageId: string, crop?: WorkspacePage['crop']) => {
    commit((current) => current.map((page) => page.id === pageId ? { ...page, crop } : page))
  }, [commit])

  const setPageSize = useCallback((pageId: string, pageSize?: WorkspacePage['pageSize']) => {
    commit((current) => current.map((page) => page.id === pageId ? { ...page, pageSize } : page))
  }, [commit])

  /** Apply a complete OCR batch as one undoable workspace operation. */
  const applyOcrResults = useCallback((results: OcrPageResult[]) => {
    if (!results.length) return
    const bySourcePage = new Map(results.map((result) => [
      `${result.sourceId}\u0000${result.sourcePage}`,
      result.ocr,
    ]))
    commit((current) => {
      let changed = false
      const next = current.map((page) => {
        const ocr = bySourcePage.get(`${page.sourceId}\u0000${page.sourcePage}`)
        if (!ocr || page.ocr === ocr) return page
        changed = true
        return { ...page, ocr }
      })
      return changed ? next : current
    })
  }, [commit])

  /** Clearing one duplicate also clears all pages sharing its source page. */
  const clearOcr = useCallback((ids?: Set<string>) => {
    commit((current) => {
      const sourcePages = ids
        ? new Set(current.filter((page) => ids.has(page.id)).map((page) => `${page.sourceId}\u0000${page.sourcePage}`))
        : undefined
      let changed = false
      const next = current.map((page) => {
        if (!page.ocr || (sourcePages && !sourcePages.has(`${page.sourceId}\u0000${page.sourcePage}`))) return page
        changed = true
        const { ocr: _ocr, ...withoutOcr } = page
        return withoutOcr
      })
      return changed ? next : current
    })
  }, [commit])

  const insertSourcePages = useCallback((
    anchorId: string,
    source: PdfSource,
    position: 'before' | 'after',
    pageIndices: number[],
  ) => {
    const wanted = new Set(pageIndices)
    const anchorPage = pagesRef.current.find((page) => page.id === anchorId)
    const targetGroupId = anchorPage ? pageGroupId(anchorPage) : source.id
    const inserted = pagesForSource(source)
      .filter((page) => wanted.has(page.sourcePage))
      .map((page) => ({ ...page, groupId: targetGroupId }))
    if (!inserted.length) return
    setSources((current) => [...current, source])
    commit((current) => {
      const anchor = current.findIndex((page) => page.id === anchorId)
      const index = anchor < 0 ? current.length : anchor + (position === 'after' ? 1 : 0)
      const next = [...current]
      next.splice(index, 0, ...inserted)
      return next
    })
    setActiveId(inserted[0]?.id)
    setSelectedIds(new Set(inserted.map((page) => page.id)))
    return inserted[0]?.id
  }, [commit])

  /** Extract into a new vector-backed page in the same group, as one undo step. */
  const extractCrop = useCallback(async (pageId: string, crop: CropSelection) => {
    const original = pagesRef.current.find((page) => page.id === pageId)
    if (!original) throw new Error('原页面已被移除')
    const bytes = await extractPdfSelection(original, sourcesRef.current, crop)
    const source = await inspectPdf(bytes, '拆分页面.pdf')
    // Never insert stale output after an edit, close, undo, or document switch.
    if (pagesRef.current.find((page) => page.id === pageId) !== original) {
      releasePdfDocument(source)
      throw new Error('原页面已发生变化，请重新选择区域')
    }
    return insertSourcePages(pageId, source, 'after', [0])
  }, [insertSourcePages])

  const replacePagesWithSource = useCallback((
    ids: Set<string>,
    source: PdfSource,
    pageIndices: number[],
  ) => {
    const wanted = new Set(pageIndices)
    const firstReplaced = pagesRef.current.find((page) => ids.has(page.id))
    const targetGroupId = firstReplaced ? pageGroupId(firstReplaced) : source.id
    const inserted = pagesForSource(source)
      .filter((page) => wanted.has(page.sourcePage))
      .map((page) => ({ ...page, groupId: targetGroupId }))
    if (!inserted.length || !ids.size) return
    setSources((current) => [...current, source])
    commit((current) => {
      const insertionIndex = current.findIndex((page) => ids.has(page.id))
      if (insertionIndex < 0) return current
      const next = current.filter((page) => !ids.has(page.id))
      next.splice(insertionIndex, 0, ...inserted)
      return next
    })
    setActiveId(inserted[0].id)
    setSelectedIds(new Set(inserted.map((page) => page.id)))
  }, [commit])

  /** Content changed since the last successful save (or fresh load). */
  const collectClosedSources = useCallback((candidates: string[], pinned: Set<string>) => {
    const unused = unreferencedSourceIds(candidates, [pagesRef.current, ...past.current.map(h => h.pages), ...future.current.map(h => h.pages)], pinned)
    if (!unused.size) return
    const previous = sourcesRef.current
    const next = previous.filter(source => !unused.has(source.id))
    if (next.length === previous.length) return
    sourcesRef.current = next
    setSources(next)
    for (const source of previous) if (unused.has(source.id)) void releasePdfDocument(source)
  }, [])
  const dirty = revision.current !== savedRevision
  /**
   * Record content as saved. Without an argument the whole workspace is
   * marked (merge/collector export everything at once). The editor exports
   * one group at a time and passes its group id: only that group is cleared,
   * so unsaved edits in OTHER open files still prompt later. When the last
   * dirty group clears, the global revision is synced as well.
   */
  const markSaved = useCallback((groupId?: string) => {
    if (!groupId) {
      dirtyGroupIdsRef.current = new Set()
      setDirtyGroupIds(new Set())
      setSavedRevision(revision.current)
      return
    }
    // Dead entries (group closed or all its pages deleted) are pruned here:
    // there is nothing left to write for them, and they must not block the
    // "everything saved" revision sync.
    const liveGroups = new Set(pagesRef.current.map(pageGroupId))
    const next = pruneDirtyGroups(dirtyGroupIdsRef.current, groupId, liveGroups)
    if (next.size === dirtyGroupIdsRef.current.size && !dirtyGroupIdsRef.current.has(groupId)) return
    dirtyGroupIdsRef.current = next
    setDirtyGroupIds(next)
    if (!next.size) setSavedRevision(revision.current)
  }, [])

  /** Atomically publish a live client edit in exactly one document. The identities
   * captured before any async PDF rewrite must still match. One call = one undo. */
  const applyMcpPages = useCallback((group: string, before: readonly WorkspacePage[], replacement: WorkspacePage[], staged?: PdfSource) => {
    const current=pagesRef.current, own=current.filter(page=>pageGroupId(page)===group)
    if(!replacement.length || own.length!==before.length || own.some((p,i)=>p!==before[i]) || replacement.some(p=>pageGroupId(p)!==group)) return false
    let i=0, last=-1
    const next:WorkspacePage[]=[]
    for(const p of current){ if(pageGroupId(p)!==group) next.push(p); else { if(i<replacement.length)next.push(replacement[i++]); last=next.length } }
    if(last<0)return false
    if(i<replacement.length)next.splice(last,0,...replacement.slice(i))
    if(staged){ const list=[...sourcesRef.current,staged];sourcesRef.current=list;setSources(list) }
    past.current=[...past.current.slice(-49),{pages:current,watermarks:watermarkRef.current}]; future.current=[];revision.current++
    pagesRef.current=next;setPages(next);markGroupsDirty(new Set([group]))
    const ids=new Set(next.map(p=>p.id));setActiveId(id=>id&&!ids.has(id)?replacement[0].id:id)
    setSelectedIds(prior=>[...prior].every(id=>ids.has(id))?prior:new Set([...prior].filter(id=>ids.has(id))))
    return true
  },[markGroupsDirty])

  return {
    applyMcpPages,
    sources, pages, watermarks, activeId, selectedIds,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    dirty, dirtyGroupIds, markSaved, markDocumentMetadataDirty, collectClosedSources,
    load, appendTransfer, select, selectAll, clearSelection, reorder, reorderSources, renameSource, rotate, rotateMany, remove, reverse, clear, reset,
    insertBlank, duplicateSelected, insertPagesAfter,
    addAnnotation, addAnnotations, removeAnnotation, removeAnnotations, updateAnnotation, addNoteReply, setCrop, setPageSize, applyOcrResults, clearOcr,
    insertSourcePages, extractCrop, replacePagesWithSource, setWatermark, undo, redo,
  }
}
