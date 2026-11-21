import type { PdfSource, WorkspacePage } from '../types/pdf'

/** An inserted page may belong to a different editor group from its backing PDF. */
export const pageGroupId = (page: WorkspacePage) => page.groupId ?? page.sourceId

/** Compare only real paths supplied by the desktop host. Browser filenames are not identities. */
export function documentPathKey(path?: string) {
  if (!path) return undefined
  const windows = path.replaceAll('\\', '/')
  if (/^(?:[a-z]:\/|\/\/)/i.test(windows)) {
    return windows.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').toLowerCase()
  }
  return path.startsWith('/') ? path : undefined
}

/** Ignore closed groups and backend sources used only by inserted pages. Never dedup pathless inputs. */
export function planEditorOpen<T extends { path: string }>(incoming: T[], sources: PdfSource[], pages: WorkspacePage[]) {
  const groups = new Set(pages.map(pageGroupId))
  const existing = new Map<string, PdfSource>()
  for (const source of sources) {
    const key = documentPathKey(source.originalPath ?? source.path)
    if (key && groups.has(source.id)) existing.set(key, source)
  }
  const seen = new Set<string>(), files: T[] = []
  let activate: PdfSource | undefined
  for (const file of incoming) {
    const key = documentPathKey(file.path)
    if (key) {
      const open = existing.get(key)
      if (open) { activate ??= open; continue }
      if (seen.has(key)) continue
      seen.add(key)
    }
    files.push(file)
  }
  return { files, activate }
}
