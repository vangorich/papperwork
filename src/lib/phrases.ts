import type { CommonPhrase } from '../types/pdf'

export const COMMON_PHRASES_STORAGE_KEY = 'paperwork-common-phrases-v2'
export const LEGACY_COMMON_PHRASES_STORAGE_KEY = 'paperwork-common-phrases-v1'

export const DEFAULT_COMMON_PHRASES: CommonPhrase[] = [
  { id: 'built-in-reviewed', text: '已阅', fontFamily: 'Microsoft YaHei', fontSize: 16, color: '#18324a', bold: false, italic: false, builtIn: true },
  { id: 'built-in-approved', text: '同意', fontFamily: 'Microsoft YaHei', fontSize: 16, color: '#18324a', bold: false, italic: false, builtIn: true },
  { id: 'built-in-revise', text: '请修改', fontFamily: 'Microsoft YaHei', fontSize: 16, color: '#b42318', bold: true, italic: false, builtIn: true },
  { id: 'built-in-check', text: '请核对', fontFamily: 'Microsoft YaHei', fontSize: 16, color: '#18324a', bold: false, italic: false, builtIn: true },
  { id: 'built-in-important', text: '重要', fontFamily: 'Microsoft YaHei', fontSize: 18, color: '#b42318', bold: true, italic: false, builtIn: true },
  { id: 'built-in-completed', text: '已处理', fontFamily: 'KaiTi', fontSize: 16, color: '#176b50', bold: false, italic: false, builtIn: true },
]

const defaults = () => DEFAULT_COMMON_PHRASES.map((phrase) => ({ ...phrase }))

function validPhrases(value: unknown): CommonPhrase[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const phrase = item as Partial<CommonPhrase>
    const text = typeof phrase.text === 'string' ? phrase.text.trim() : ''
    if (
      typeof phrase.id !== 'string' || !phrase.id || ids.has(phrase.id) || !text
      || typeof phrase.fontFamily !== 'string' || !Number.isFinite(phrase.fontSize)
      || typeof phrase.color !== 'string' || typeof phrase.bold !== 'boolean'
      || typeof phrase.italic !== 'boolean'
    ) return []
    ids.add(phrase.id)
    return [{
      id: phrase.id,
      text,
      fontFamily: phrase.fontFamily,
      fontSize: Math.min(96, Math.max(8, Number(phrase.fontSize))),
      color: phrase.color,
      bold: phrase.bold,
      italic: phrase.italic,
      builtIn: phrase.builtIn === true,
    }]
  })
}

export function loadCommonPhrases(v2Raw: string | null, legacyRaw: string | null): CommonPhrase[] {
  if (v2Raw !== null) {
    try {
      const store = JSON.parse(v2Raw) as { version?: unknown; items?: unknown }
      return store?.version === 2 && Array.isArray(store.items) ? validPhrases(store.items) : defaults()
    } catch {
      return defaults()
    }
  }

  if (legacyRaw === null) return defaults()
  try {
    const items = validPhrases(JSON.parse(legacyRaw))
    if (!items.length) return defaults()
    return items.some((phrase) => phrase.builtIn || phrase.id.startsWith('built-in-'))
      ? items
      : [...defaults(), ...items]
  } catch {
    return defaults()
  }
}

export const serializeCommonPhrases = (items: CommonPhrase[]) => JSON.stringify({ version: 2, items })

export function reorderCommonPhrases(items: CommonPhrase[], activeId: string, overId: string) {
  const from = items.findIndex((phrase) => phrase.id === activeId)
  const to = items.findIndex((phrase) => phrase.id === overId)
  if (from < 0 || to < 0 || from === to) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function moveCommonPhrase(items: CommonPhrase[], id: string, delta: -1 | 1) {
  const index = items.findIndex((phrase) => phrase.id === id)
  const target = Math.min(items.length - 1, Math.max(0, index + delta))
  if (index < 0 || target === index) return items
  return reorderCommonPhrases(items, id, items[target].id)
}
