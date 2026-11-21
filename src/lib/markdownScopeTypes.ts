import type { WorkspacePage } from '../types/pdf'

/** Coordinates are fractions of the displayed, rotated page—not the whole stage. */
export interface MarkdownRegion { x:number; y:number; width:number; height:number }
export interface MarkdownFragment {
  pageId: string
  boxes: MarkdownRegion[]
  /** Exact reading-layer selection, not a page-level fallback. */
  text?: string
  table?: boolean
  /** Set only when reading a PDF annotation; its display-list paint must corroborate the region. */
  nativeHighlightId?: string
}
export type MarkdownScope = { kind:'full' } | { kind:'selection'; fragments: readonly MarkdownFragment[] } | { kind:'highlights' }
/** Used only inside the reader to avoid using a selection left behind on a different revision. */
export interface MarkdownSelectionSnapshot { entries: { page:WorkspacePage; fragment:MarkdownFragment }[] }
