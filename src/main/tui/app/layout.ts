// Shell layout choices that persist (tui-prefs.json): the fleet sidebar and
// mouse capture. Kept in the store's viewState so every component re-renders
// on a change; `savePrefs` carries them to the next launch.

import type { TuiStore } from '../state/store'
import type { TuiState } from '../state/types'
import { savePrefs } from './prefs'
import { setMouseWanted, terminalCaps } from './terminal'

export const LAYOUT_STATE_KEY = 'shell.layout'

export interface LayoutState {
  sidebarHidden: boolean
}

export function readLayout(state: TuiState): LayoutState {
  const raw = state.viewState[LAYOUT_STATE_KEY] as Partial<LayoutState> | undefined
  return { sidebarHidden: raw?.sidebarHidden === true }
}

type LayoutStore = Pick<TuiStore, 'getState' | 'actions'>

/** Show / hide the fleet sidebar (Ctrl+B, /sidebar). `hidden` omitted = toggle. */
export function setSidebarHidden(store: LayoutStore, hidden?: boolean, announce = true): boolean {
  const current = readLayout(store.getState())
  const next = hidden ?? !current.sidebarHidden
  store.actions.setViewState(LAYOUT_STATE_KEY, { ...current, sidebarHidden: next })
  savePrefs({ sidebar: !next })
  if (next && store.getState().focus === 'sidebar') store.actions.setFocus('main')
  if (announce) store.actions.toast(next ? 'Sidebar hidden: full-width view · Ctrl+B brings it back' : 'Sidebar shown · Ctrl+B hides it', 'info', 2000)
  return next
}

/** Mouse capture on/off (/mouse). Off = the terminal's own selection and wheel. */
export function setMouse(store: LayoutStore, on?: boolean): boolean {
  const next = on ?? !terminalCaps().mouseWanted
  setMouseWanted(next)
  savePrefs({ mouse: next })
  const caps = terminalCaps()
  store.actions.toast(
    next
      ? caps.altScreen ? 'Mouse mode on: click expands, drag selects and copies, right-click pastes, the wheel scrolls what is under the pointer · /mouse off' : 'Mouse wanted, but only works in the alternate screen (not with --no-alt-screen)'
      : 'Mouse mode off: the terminal selects, copies and pastes; the wheel scrolls the focused pane · /mouse on',
    'info',
    3000,
  )
  return next
}
