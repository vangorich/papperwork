import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHORTCUT_BINDINGS,
  assignShortcutBinding,
  formatShortcut,
  loadShortcutBindings,
  matchesShortcut,
  reservedShortcutReason,
  shortcutFromEvent,
  shortcutWithShift,
} from './shortcuts'

const keyboardEvent = (code: string, options: KeyboardEventInit = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...options,
}) as KeyboardEvent

describe('configurable shortcuts', () => {
  it('serializes modifiers in a stable order and ignores modifier-only keys', () => {
    expect(shortcutFromEvent(keyboardEvent('KeyL', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+KeyL')
    expect(shortcutFromEvent(keyboardEvent('ControlLeft', { ctrlKey: true }))).toBe('')
  })

  it('matches exact shortcuts without triggering on extra modifiers', () => {
    expect(matchesShortcut(keyboardEvent('KeyR', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+KeyR')).toBe(true)
    expect(matchesShortcut(keyboardEvent('KeyR', { ctrlKey: true, shiftKey: true, altKey: true }), 'Ctrl+Shift+KeyR')).toBe(false)
  })

  it('derives and formats the save-as variant', () => {
    expect(shortcutWithShift('Ctrl+KeyS')).toBe('Ctrl+Shift+KeyS')
    expect(formatShortcut('Ctrl+Shift+KeyS')).toBe('Ctrl + Shift + S')
  })

  it('protects fixed editor commands and the derived Save As binding', () => {
    expect(reservedShortcutReason('Ctrl+KeyC')).toContain('基础命令')
    expect(reservedShortcutReason('Ctrl+Shift+KeyZ')).toContain('基础命令')
    expect(reservedShortcutReason('ArrowLeft')).toContain('导航')
    expect(reservedShortcutReason('Alt+KeyQ')).toBeUndefined()

    const reserved = assignShortcutBinding(DEFAULT_SHORTCUT_BINDINGS, 'rotatePageLeft', 'Ctrl+KeyP')
    expect(reserved.error).toBeTruthy()
    expect(reserved.bindings).toBe(DEFAULT_SHORTCUT_BINDINGS)

    const saveAs = assignShortcutBinding(DEFAULT_SHORTCUT_BINDINGS, 'rotatePageLeft', 'Ctrl+Shift+KeyS')
    expect(saveAs.error).toContain('另存为')
  })

  it('clears duplicate configurable bindings, including a new Save As variant', () => {
    const duplicate = assignShortcutBinding(DEFAULT_SHORTCUT_BINDINGS, 'rotatePageLeft', DEFAULT_SHORTCUT_BINDINGS.zoomIn)
    expect(duplicate.error).toBeUndefined()
    expect(duplicate.bindings.rotatePageLeft).toBe(DEFAULT_SHORTCUT_BINDINGS.zoomIn)
    expect(duplicate.bindings.zoomIn).toBe('')

    const withDerivedConflict = {
      ...DEFAULT_SHORTCUT_BINDINGS,
      rotatePageLeft: 'Alt+Shift+KeyS',
    }
    const save = assignShortcutBinding(withDerivedConflict, 'save', 'Alt+KeyS')
    expect(save.bindings.save).toBe('Alt+KeyS')
    expect(save.bindings.rotatePageLeft).toBe('')
  })

  it('merges persisted partial settings with defaults', () => {
    const loaded = loadShortcutBindings(JSON.stringify({ rotatePageLeft: 'Alt+KeyQ' }))
    expect(loaded.rotatePageLeft).toBe('Alt+KeyQ')
    expect(loaded.nextPage).toBe(DEFAULT_SHORTCUT_BINDINGS.nextPage)
  })
})
