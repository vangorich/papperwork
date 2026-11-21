export const SHORTCUT_ACTIONS = [
  'rotatePageLeft',
  'rotatePageRight',
  'rotateDocumentLeft',
  'rotateDocumentRight',
  'previousPage',
  'nextPage',
  'save',
  'search',
  'zoomIn',
  'zoomOut',
  'ocrCurrentPage',
] as const

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]
export type ShortcutBindings = Record<ShortcutAction, string>

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = {
  rotatePageLeft: 'Ctrl+Shift+KeyL',
  rotatePageRight: 'Ctrl+Shift+KeyR',
  rotateDocumentLeft: 'Ctrl+Alt+KeyL',
  rotateDocumentRight: 'Ctrl+Alt+KeyR',
  previousPage: 'PageUp',
  nextPage: 'PageDown',
  save: 'Ctrl+KeyS',
  search: 'Ctrl+KeyF',
  zoomIn: 'Ctrl+Equal',
  zoomOut: 'Ctrl+Minus',
  ocrCurrentPage: 'Ctrl+Shift+KeyO',
}

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight',
  'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight',
])

export function shortcutFromEvent(event: KeyboardEvent) {
  if (MODIFIER_CODES.has(event.code)) return ''
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(event.code)
  return parts.join('+')
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  if (!shortcut) return false
  return shortcutFromEvent(event) === shortcut
}

export function shortcutWithShift(shortcut: string) {
  if (!shortcut || shortcut.split('+').includes('Shift')) return shortcut
  const parts = shortcut.split('+')
  parts.splice(Math.max(0, parts.length - 1), 0, 'Shift')
  return parts.join('+')
}

const RESERVED_COMMAND_CODES = new Set([
  'KeyA', 'KeyC', 'KeyP', 'KeyW', 'KeyX', 'KeyY', 'KeyZ', 'Digit0',
])

/** Keep editing, print, close, undo/redo and reader navigation deterministic. */
export function reservedShortcutReason(shortcut: string) {
  if (!shortcut) return undefined
  const parts = shortcut.split('+')
  const code = parts.at(-1) ?? ''
  if (code === 'Escape' || code === 'Delete' || code === 'ArrowLeft' || code === 'ArrowRight') {
    return '该按键由选择、删除或阅读导航保留'
  }
  if (parts.includes('Ctrl') && RESERVED_COMMAND_CODES.has(code)) {
    return '该组合键由复制、打印、关闭、撤销或选择等基础命令保留'
  }
  return undefined
}

export function assignShortcutBinding(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  shortcut: string,
): { bindings: ShortcutBindings; error?: string } {
  const reservedReason = reservedShortcutReason(shortcut)
  if (reservedReason) return { bindings, error: reservedReason }

  const currentSaveAs = shortcutWithShift(bindings.save)
  if (
    action !== 'save'
    && shortcut
    && currentSaveAs !== bindings.save
    && shortcut === currentSaveAs
  ) {
    return { bindings, error: '该组合键由“另存为”保留，请先修改保存快捷键' }
  }

  const next = { ...bindings }
  for (const other of SHORTCUT_ACTIONS) {
    if (other !== action && next[other] === shortcut) next[other] = ''
  }
  next[action] = shortcut

  // Saving also owns its Shift-derived Save As binding. If the save key changes,
  // clear an older configurable action that would otherwise appear to work but
  // is always intercepted by Save As at runtime.
  if (action === 'save') {
    const nextSaveAs = shortcutWithShift(shortcut)
    if (nextSaveAs !== shortcut) {
      for (const other of SHORTCUT_ACTIONS) {
        if (other !== action && next[other] === nextSaveAs) next[other] = ''
      }
    }
  }
  return { bindings: next }
}

const CODE_LABELS: Record<string, string> = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Equal: '+',
  Escape: 'Esc',
  Home: 'Home',
  Minus: '-',
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  Period: '.',
  Semicolon: ';',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
}

export function formatShortcut(shortcut: string) {
  if (!shortcut) return '未设置'
  return shortcut.split('+').map((part) => {
    if (part.startsWith('Key')) return part.slice(3)
    if (part.startsWith('Digit')) return part.slice(5)
    return CODE_LABELS[part] ?? part
  }).join(' + ')
}

export function loadShortcutBindings(raw: string | null): ShortcutBindings {
  if (!raw) return { ...DEFAULT_SHORTCUT_BINDINGS }
  try {
    const value = JSON.parse(raw) as Partial<Record<ShortcutAction, unknown>>
    return Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [
      action,
      typeof value[action] === 'string' ? value[action] : DEFAULT_SHORTCUT_BINDINGS[action],
    ])) as ShortcutBindings
  } catch {
    return { ...DEFAULT_SHORTCUT_BINDINGS }
  }
}
