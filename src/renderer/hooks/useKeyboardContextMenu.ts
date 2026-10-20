import { useCallback, useRef } from 'react'
import { isContextMenuKey } from '../utils/keyboard'

type OpenMenu = (e: React.MouseEvent) => void

/**
 * A context menu that also opens from the keyboard: Shift+F10 or the Menu
 * key on the focused element (or inside it) opens it below the element.
 * Bind both handlers on the element that has `onContextMenu` today.
 */
export function useKeyboardContextMenu(open: OpenMenu): {
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent) => void
} {
  const openedAt = useRef(-Infinity)
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (!isContextMenuKey(e)) return
    e.preventDefault()
    e.stopPropagation()
    openedAt.current = performance.now()
    const r = e.currentTarget.getBoundingClientRect()
    // The menu handlers read the position and stop the event; nothing else.
    open({ clientX: r.left + 12, clientY: r.bottom, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent)
  }, [open])
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Some platforms also raise contextmenu for the same key press: one menu, where the key put it.
    if (performance.now() - openedAt.current < 500) { e.preventDefault(); return }
    open(e)
  }, [open])
  return { onKeyDown, onContextMenu }
}
