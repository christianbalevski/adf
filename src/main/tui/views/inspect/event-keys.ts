import type { KeyHintSpec } from '../../ui/KeyHint'

/** The event tail's keys (Inspect › Events and Runtime › Events), for /help. */
export const EVENT_KEYS: KeyHintSpec[] = [
  { keys: 'up down', label: 'Move; ↑ stops following (the wheel scrolls too)' },
  { keys: 'end', label: 'Follow the newest again (also G)' },
  { keys: 't', label: 'Type filter, e.g. tool. -turn.delta' },
  { keys: 'a', label: 'All agents / the selected agent (Runtime only)' },
  { keys: 'l', label: 'All loops / the selected loop' },
  { keys: '/', label: 'Search text (Esc clears)' },
  { keys: 'space', label: 'Pause / resume' },
  { keys: 'f', label: 'Follow on / off' },
  { keys: 'enter', label: 'Full event' },
  { keys: 'c', label: 'Clear' },
  { keys: 'x', label: 'Reset filters' },
]
