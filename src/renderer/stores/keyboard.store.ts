import { create } from 'zustand'

/** The keyboard surfaces the application menu opens: Go to agent and the shortcuts sheet. */
interface KeyboardState {
  switcherOpen: boolean
  shortcutsOpen: boolean
  setSwitcherOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
}

export const useKeyboardStore = create<KeyboardState>((set) => ({
  switcherOpen: false,
  shortcutsOpen: false,
  // One modal at a time: opening one closes the other.
  setSwitcherOpen: (open) => set(open ? { switcherOpen: true, shortcutsOpen: false } : { switcherOpen: false }),
  setShortcutsOpen: (open) => set(open ? { shortcutsOpen: true, switcherOpen: false } : { shortcutsOpen: false }),
}))
