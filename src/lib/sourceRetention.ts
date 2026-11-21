import type { WorkspacePage } from '../types/pdf'

/** A PDF may disappear from the sidebar yet still be needed by undo, redo,
 * an internal paste or an open print queue. Source and display group can differ. */
export function unreferencedSourceIds(candidates: Iterable<string>, histories: Iterable<readonly WorkspacePage[]>, pinned: Iterable<string>) {
  const unused = new Set(candidates)
  for (const id of pinned) unused.delete(id)
  for (const pages of histories) {
    if (!unused.size) break
    for (const page of pages) { unused.delete(page.sourceId); if (page.groupId) unused.delete(page.groupId) }
  }
  return unused
}
