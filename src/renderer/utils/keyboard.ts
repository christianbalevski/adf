/**
 * Keyboard helpers shared by the app's shortcut handlers. Hook-free and
 * DOM-light, so tests can drive them with plain objects.
 */

type ModifierEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>

/**
 * The platform's command modifier, and only it: ⌘ on macOS, Ctrl elsewhere.
 * Ctrl+S on macOS and Win+S on Windows are not Save.
 */
export function isPrimaryModifier(e: ModifierEvent, isMac: boolean): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** The element-shaped part of an event target these checks read. */
interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** Elements that take typed keys: single-key shortcuts must leave them alone. */
const TYPING_SELECTOR = 'input, textarea, select, [role="combobox"], [role="textbox"], [contenteditable]:not([contenteditable="false"])'

/** True when keys typed at `target` belong to a text field, a select, a combobox or editable content. */
export function isTypingElement(target: unknown): boolean {
  const el = target as TargetLike | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return typeof el.closest === 'function' && el.closest(TYPING_SELECTOR) != null
}

/** Surfaces that own the keyboard while focus is in them (a modal, a menu, a list). */
const KEYBOARD_OWNER_SELECTOR = 'dialog[open], [role="dialog"], [role="menu"], [role="listbox"]'

/**
 * Whether a single-key map shortcut may act on a key typed at `target`: the
 * focus is on the map (inside `root`) or nowhere (the page itself), and not
 * in a field or a surface that owns the keyboard. Focus on a button in the
 * dock or the sidebar keeps its keys: Space there presses the button, it
 * does not also move the map.
 */
export function mapOwnsKey(target: unknown, root: { contains(node: unknown): boolean } | null, page: { body: unknown; documentElement: unknown }): boolean {
  if (isTypingElement(target)) return false
  if (!target || target === page.body || target === page.documentElement) return true
  if (!root || !root.contains(target)) return false
  const el = target as TargetLike
  return !(typeof el.closest === 'function' && el.closest(KEYBOARD_OWNER_SELECTOR) != null)
}

/** Shift+F10 or the Menu key: open the focused item's context menu. */
export function isContextMenuKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}
