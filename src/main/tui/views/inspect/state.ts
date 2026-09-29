// Inspect view state (kept in the store's viewState so it survives view
// switches and so /json and /inspect can set it from anywhere). Inspect is
// about the selected agent only; the daemon-wide pages live in the Runtime
// view (views/runtime).

import { useViewState } from '../../state/hooks'
import type { TuiActions } from '../../state/store'
import type { TuiState } from '../../state/types'
import type { TaskFilter } from './tasks'

export const INSPECT_VIEW = 'inspect'

export const TABS = [
  { id: 'diag', title: 'Status', description: 'This agent: state, loops, triggers and WebSocket diagnostics' },
  { id: 'config', title: 'Config', description: 'Agent config; e opens it in $EDITOR and saves it back after validation' },
  { id: 'usage', title: 'Usage', description: 'Token usage by model (this agent) and this session' },
  { id: 'mcp', title: 'MCP', description: 'This agent’s MCP servers: configured, live state, recent logs' },
  { id: 'channels', title: 'Channels', description: 'This agent’s channels (Telegram, Discord, Slack, email, WhatsApp): configured and live state; /channels to add or remove' },
  { id: 'identity', title: 'Identities', description: 'The agent’s identity entries (metadata only, never values)' },
  { id: 'logs', title: 'Logs', description: 'Agent log tail with follow' },
  { id: 'tables', title: 'Tables', description: 'Local tables: list and browse rows' },
  { id: 'tasks', title: 'Tasks', description: 'The agent’s tasks: approvals and async tool calls; approve / reject here' },
  { id: 'events', title: 'Events', description: 'This agent’s live umbilical events (every agent: Runtime › Events)' },
] as const

export type InspectTab = typeof TABS[number]['id']

export interface EventFilters {
  /** Comma-separated event_type prefixes/substrings; empty = all. */
  types: string
  /** 'all' agents or only the selected one. */
  agent: 'all' | 'selected'
  /** 'all' loops or only the selected agent's selected loop. */
  loop: 'all' | 'selected'
  follow: boolean
}

export interface InspectState {
  tab: InspectTab
  /** Render structured data as raw JSON instead of the tree (/json). */
  json: boolean
  events: EventFilters
  logsFollow: boolean
  /** Tasks tab: which statuses show (f cycles). */
  tasksFilter: TaskFilter
  /** /config edit: the Config tab opens $EDITOR once for this request (a timestamp). */
  editRequest?: number
}

export const DEFAULT_INSPECT_STATE: InspectState = {
  tab: 'diag',
  json: false,
  events: { types: '', agent: 'selected', loop: 'all', follow: true },
  logsFollow: true,
  tasksFilter: 'all',
}

export function readInspectState(state: TuiState): InspectState {
  const raw = state.viewState[INSPECT_VIEW] as Partial<InspectState> | undefined
  return { ...DEFAULT_INSPECT_STATE, ...raw, events: { ...DEFAULT_INSPECT_STATE.events, ...raw?.events } }
}

export function patchInspectState(actions: TuiActions, state: TuiState, patch: Partial<Omit<InspectState, 'events'>> & { events?: Partial<EventFilters> }): InspectState {
  const current = readInspectState(state)
  const next: InspectState = { ...current, ...patch, events: { ...current.events, ...patch.events } }
  actions.setViewState(INSPECT_VIEW, next)
  return next
}

export function useInspectState(): [InspectState, (patch: Partial<Omit<InspectState, 'events'>> & { events?: Partial<EventFilters> }) => void] {
  const [raw, set] = useViewState<Partial<InspectState>>(INSPECT_VIEW, DEFAULT_INSPECT_STATE)
  const value: InspectState = { ...DEFAULT_INSPECT_STATE, ...raw, events: { ...DEFAULT_INSPECT_STATE.events, ...raw.events } }
  const update = (patch: Partial<Omit<InspectState, 'events'>> & { events?: Partial<EventFilters> }) => {
    set(prev => {
      const cur: InspectState = { ...DEFAULT_INSPECT_STATE, ...prev, events: { ...DEFAULT_INSPECT_STATE.events, ...prev.events } }
      return { ...cur, ...patch, events: { ...cur.events, ...patch.events } }
    })
  }
  return [value, update]
}

export function findTab(name: string): InspectTab | undefined {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return undefined
  const aliases: Record<string, InspectTab> = { adapters: 'channels', adapter: 'channels', channel: 'channels', umbilical: 'events', event: 'events', status: 'diag', runtime: 'diag', diagnostics: 'diag', identities: 'identity', log: 'logs', table: 'tables', db: 'tables', task: 'tasks', approvals: 'tasks', hil: 'tasks' }
  return (TABS.find(t => t.id === wanted)?.id) ?? aliases[wanted] ?? TABS.find(t => t.id.startsWith(wanted))?.id
}
