import { IS_MAC } from './platform'

/**
 * A key combination as this platform writes it: "⌘⇧W" on macOS,
 * "Ctrl+Shift+W" elsewhere. `mod` is ⌘ / Ctrl.
 */
export function shortcutLabel(key: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}, mac: boolean = IS_MAC): string {
  const parts: string[] = []
  if (mac) {
    if (mods.alt) parts.push('⌥')
    if (mods.shift) parts.push('⇧')
    if (mods.mod) parts.push('⌘')
    return parts.join('') + key
  }
  if (mods.mod) parts.push('Ctrl')
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  return [...parts, key].join('+')
}

/** Settings (App.tsx, the app menu). */
export const SETTINGS_SHORTCUT = shortcutLabel(',', { mod: true })
/** Close Agent (the app menu). */
export const CLOSE_AGENT_SHORTCUT = shortcutLabel('W', { mod: true, shift: true })
