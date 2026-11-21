/**
 * Shared "recently used colors" store for every color picker in the app
 * (drawing tools, text annotations, watermarks, common phrases). Persisted
 * to localStorage; each ColorPalette instance reloads on open so all pickers
 * stay in sync without prop drilling.
 */
const STORAGE_KEY = 'paperwork-recent-colors'
const MAX_RECENT = 10

export function loadRecentColors(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((color): color is string => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color))
      .map((color) => color.toLowerCase())
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function rememberRecentColor(color: string): string[] {
  const normalized = color.toLowerCase()
  const next = [normalized, ...loadRecentColors().filter((item) => item !== normalized)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage may be unavailable (private mode); recents simply won't persist.
  }
  return next
}
