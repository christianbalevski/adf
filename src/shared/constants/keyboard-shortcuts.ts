/**
 * Studio's keyboard shortcuts, in one table. The application menu
 * (main/menu.ts) takes its accelerators from `ACCELERATORS`; Help → Keyboard
 * Shortcuts and the fleet map's command card list `SHORTCUT_SECTIONS` and
 * `FLEET_MAP_SECTIONS`.
 *
 * Keys use Electron's accelerator syntax: `CmdOrCtrl` is ⌘ on macOS and Ctrl
 * elsewhere; `Shift`, `Alt` and `Ctrl` are those keys. `formatKey` turns one
 * into what the platform's keyboard says.
 */

/** Accelerators the application menu binds. */
export const ACCELERATORS = {
  newAgent: 'CmdOrCtrl+N',
  openAgent: 'CmdOrCtrl+O',
  trackFolder: 'CmdOrCtrl+Shift+O',
  openInNewWindow: 'CmdOrCtrl+Shift+N',
  save: 'CmdOrCtrl+S',
  /** Shown in the menu only: the page handles it (closes the active tab). */
  closeTab: 'CmdOrCtrl+W',
  closeAgent: 'CmdOrCtrl+Shift+W',
  settings: 'CmdOrCtrl+,',
  goToAgent: 'CmdOrCtrl+K',
  home: 'CmdOrCtrl+Shift+H',
  fleetMap: 'CmdOrCtrl+Shift+M',
  toggleSidebar: 'CmdOrCtrl+Shift+E',
  togglePanel: 'CmdOrCtrl+J',
} as const

export interface ShortcutRow {
  /** One entry per key cap; each is formatted by `formatKey`. */
  keys: readonly string[]
  /** macOS keys when they differ (menu roles: full screen). */
  macKeys?: readonly string[]
  label: string
  /** macOS label when it differs. */
  macLabel?: string
  /** Offered in daemon mode only (agent windows). */
  agentWindowsOnly?: boolean
}

export interface ShortcutSection {
  title: string
  rows: readonly ShortcutRow[]
}

/** Every shortcut outside the fleet map, for Help → Keyboard Shortcuts. */
export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    title: 'Agents',
    rows: [
      { keys: [ACCELERATORS.goToAgent], label: 'Go to agent' },
      { keys: [ACCELERATORS.newAgent], label: 'New agent' },
      { keys: [ACCELERATORS.openAgent], label: 'Open agent file' },
      { keys: [ACCELERATORS.trackFolder], label: 'Track folder' },
      { keys: [ACCELERATORS.openInNewWindow], label: 'Open in new window', agentWindowsOnly: true },
      { keys: [ACCELERATORS.closeAgent], label: 'Close agent' },
      { keys: ['Shift+F10'], label: 'Row actions in the sidebar' },
    ],
  },
  {
    title: 'Files',
    rows: [
      { keys: [ACCELERATORS.save], label: 'Save' },
      { keys: [ACCELERATORS.closeTab], label: 'Close tab, or an agent window with no tabs' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: [ACCELERATORS.home], label: 'Home' },
      { keys: [ACCELERATORS.fleetMap], label: 'Mesh' },
      { keys: [ACCELERATORS.toggleSidebar], label: 'Toggle sidebar' },
      { keys: [ACCELERATORS.togglePanel], label: 'Toggle panel' },
      { keys: [ACCELERATORS.settings], label: 'Settings' },
      { keys: ['CmdOrCtrl+Plus', 'CmdOrCtrl+-'], label: 'Zoom in / out' },
      { keys: ['CmdOrCtrl+0'], label: 'Actual size' },
      { keys: ['F11'], macKeys: ['Ctrl+CmdOrCtrl+F'], label: 'Full screen' },
    ],
  },
  {
    title: 'Go to agent',
    rows: [
      { keys: ['↑', '↓'], label: 'Move' },
      { keys: ['Enter'], label: 'Open' },
      { keys: ['Esc'], label: 'Close' },
    ],
  },
  {
    title: 'Chat',
    rows: [
      { keys: ['Enter'], label: 'Send' },
      { keys: ['Shift+Enter'], label: 'New line' },
      { keys: ['Esc'], label: 'Stop the running turn' },
    ],
  },
  {
    title: 'Agent config',
    rows: [
      { keys: ['/'], label: 'Jump to a section' },
    ],
  },
]

/** The fleet map's keys: its command card (?) and the Help sheet. */
export const FLEET_MAP_SECTIONS: readonly ShortcutSection[] = [
  {
    title: 'Camera',
    rows: [
      { keys: ['↑', '↓', '←', '→'], label: 'pan the map' },
      { keys: ['drag'], label: 'right- or middle-drag to pan' },
      { keys: ['scroll'], label: 'two-finger pan · pinch or Ctrl+scroll to zoom', macLabel: 'two-finger pan · pinch or ⌃scroll to zoom' },
      { keys: ['+', '-'], label: 'zoom in / out' },
      { keys: ['Space'], label: 'jump to selection / fit world' },
      { keys: ['F'], label: 'full screen — cursor at edge pans' },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { keys: ['A'], label: 'select all running agents' },
      { keys: ['Shift', 'click'], label: 'add or remove from selection' },
      { keys: ['drag'], label: 'marquee select' },
      { keys: ['CmdOrCtrl+1-9'], label: 'assign control group' },
      { keys: ['Shift+1-9'], label: 'add selection to group' },
      { keys: ['1-9'], label: 'recall group · tap twice to jump there' },
      { keys: ['Esc'], label: 'clear selection' },
    ],
  },
  {
    title: 'Command',
    rows: [
      { keys: ['M'], label: 'message the selection' },
      { keys: ['G'], label: 'start selected (offline)' },
      { keys: ['Shift', 'S'], label: 'stop selected (shut down)' },
      { keys: ['Enter'], label: 'open focused agent' },
      { keys: ['I'], label: 'inspect — full agent readout' },
      { keys: ['2×click'], label: 'open agent + panel' },
      { keys: ['R-click'], label: 'message that agent' },
    ],
  },
  {
    title: 'Move',
    rows: [
      { keys: ['drag tile'], label: 'move agent to a free hex (stays there)' },
      { keys: ['Alt', 'drag'], label: 'move its whole group' },
      { keys: ['CmdOrCtrl', 'drag'], label: 'move its whole territory' },
      { keys: ['drag base'], label: 'move a runtime or channel platform' },
      { keys: ['2×click', 'land'], label: 'found a new agent on an empty hex' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: ['L'], label: 'cycle lens (terrain · burn · model · health · lineage)' },
      { keys: ['V'], label: 'toggle voices (group status chips)' },
      { keys: ['.'], label: 'next agent needing you' },
      { keys: [','], label: 'next idle agent' },
      { keys: ['?'], label: 'this card' },
    ],
  },
]

const MAC_GLYPHS: Record<string, string> = { CmdOrCtrl: '⌘', Cmd: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Plus: '+' }
const OTHER_NAMES: Record<string, string> = { CmdOrCtrl: 'Ctrl', Cmd: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Plus: '+' }

/**
 * One key cap as the platform's keyboard labels it: `CmdOrCtrl+Shift+N` is
 * ⌘⇧N on macOS and Ctrl+Shift+N elsewhere. A lone `+` is the plus key.
 */
export function formatKey(key: string, isMac: boolean): string {
  if (key === '+' || !key.includes('+')) return (isMac ? MAC_GLYPHS : OTHER_NAMES)[key] ?? key
  const parts = key.split('+').map((p) => (isMac ? MAC_GLYPHS : OTHER_NAMES)[p] ?? p)
  return isMac ? parts.join('') : parts.join('+')
}

/** A row's key caps and label on this platform. */
export function rowFor(row: ShortcutRow, isMac: boolean): { keys: string[]; label: string } {
  return {
    keys: ((isMac && row.macKeys) || row.keys).map((k) => formatKey(k, isMac)),
    label: (isMac && row.macLabel) || row.label,
  }
}
