import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMMON_PHRASES,
  loadCommonPhrases,
  moveCommonPhrase,
  reorderCommonPhrases,
  serializeCommonPhrases,
} from './phrases'
import type { CommonPhrase } from '../types/pdf'

const custom = (id: string): CommonPhrase => ({
  id, text: id, fontFamily: 'Microsoft YaHei', fontSize: 16,
  color: '#123456', bold: false, italic: false, builtIn: false,
})

describe('common phrases', () => {
  it('preserves v2 order and an intentionally empty library', () => {
    const mixed = [custom('custom'), DEFAULT_COMMON_PHRASES[0]]
    expect(loadCommonPhrases(serializeCommonPhrases(mixed), null).map((item) => item.id))
      .toEqual(['custom', 'built-in-reviewed'])
    expect(loadCommonPhrases('{"version":2,"items":[]}', null)).toEqual([])
  })

  it('migrates legacy custom phrases without losing defaults', () => {
    const migrated = loadCommonPhrases(null, JSON.stringify([custom('legacy')]))
    expect(migrated.at(-1)?.id).toBe('legacy')
    expect(migrated).toHaveLength(DEFAULT_COMMON_PHRASES.length + 1)
  })

  it('reorders and bounds keyboard moves immutably', () => {
    const items = [custom('a'), custom('b'), custom('c')]
    expect(reorderCommonPhrases(items, 'a', 'c').map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(moveCommonPhrase(items, 'b', -1).map((item) => item.id)).toEqual(['b', 'a', 'c'])
    expect(moveCommonPhrase(items, 'a', -1)).toBe(items)
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})
