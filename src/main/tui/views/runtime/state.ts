// Runtime view state (the store's viewState, so /status, /events and the
// palette can open a tab from anywhere and it survives view switches).

import { useViewState } from '../../state/hooks'
import type { TuiActions } from '../../state/store'
import type { TuiState } from '../../state/types'
import type { EventFilters } from '../inspect/state'

export const RUNTIME_VIEW = 'runtime'

export const RUNTIME_TABS = [
  { id: 'status', title: 'Status', description: 'Daemon health, version, uptime and every agent’s loops' },
  { id: 'folders', title: 'Folders', description: 'Tracked agent folders: a add, d stop tracking, r rescan' },
  { id: 'identity', title: 'Identity', description: 'Owner identity: status; Enter to create, restore, unlock or lock' },
  { id: 'auth', title: 'Sign-in', description: 'Provider sign-ins (ChatGPT, Grok) and API-key providers; Enter to sign in' },
  { id: 'providers', title: 'Providers', description: 'LLM providers and which agents use them' },
  { id: 'usage', title: 'Usage', description: 'Token usage across agents, by model' },
  { id: 'network', title: 'Network', description: 'Mesh, LAN, WebSocket; m mesh on/off, s server start/stop' },
  { id: 'compute', title: 'Compute', description: 'Container runtime and containers' },
  { id: 'mcp', title: 'MCP', description: 'MCP servers registered with the daemon' },
  { id: 'channels', title: 'Channels', description: 'Channels (channel adapters) available to agents; connect one per agent with /channels' },
  { id: 'settings', title: 'Settings', description: 'Daemon settings (secrets redacted)' },
  { id: 'events', title: 'Events', description: 'Every agent’s live umbilical events (tail -f), filter by type, agent and loop' },
] as const

export type RuntimeTab = typeof RUNTIME_TABS[number]['id']

export interface RuntimeState {
  tab: RuntimeTab
  events: EventFilters
}

export const DEFAULT_RUNTIME_STATE: RuntimeState = {
  tab: 'status',
  events: { types: '', agent: 'all', loop: 'all', follow: true },
}

type Patch = Partial<Omit<RuntimeState, 'events'>> & { events?: Partial<EventFilters> }

function merge(raw: Partial<RuntimeState> | undefined, patch: Patch = {}): RuntimeState {
  const current: RuntimeState = { ...DEFAULT_RUNTIME_STATE, ...raw, events: { ...DEFAULT_RUNTIME_STATE.events, ...raw?.events } }
  return { ...current, ...patch, events: { ...current.events, ...patch.events } }
}

export function readRuntimeState(state: TuiState): RuntimeState {
  return merge(state.viewState[RUNTIME_VIEW] as Partial<RuntimeState> | undefined)
}

/** Open a Runtime tab (optionally with event filters) and switch to the view. */
export function openRuntime(actions: TuiActions, state: TuiState, patch: Patch = {}): void {
  actions.setViewState(RUNTIME_VIEW, merge(state.viewState[RUNTIME_VIEW] as Partial<RuntimeState> | undefined, patch))
  actions.setView(RUNTIME_VIEW)
}

export function useRuntimeState(): [RuntimeState, (patch: Patch) => void] {
  const [raw, set] = useViewState<Partial<RuntimeState>>(RUNTIME_VIEW, DEFAULT_RUNTIME_STATE)
  return [merge(raw), patch => set(prev => merge(prev, patch))]
}

export function findRuntimeTab(name: string): RuntimeTab | undefined {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return undefined
  const aliases: Record<string, RuntimeTab> = { adapters: 'channels', adapter: 'channels', channel: 'channels', daemon: 'status', owner: 'identity', login: 'auth', signin: 'auth', 'sign-in': 'auth', model: 'usage', mesh: 'network', containers: 'compute', umbilical: 'events', event: 'events', tracked: 'folders', dirs: 'folders', directories: 'folders', folder: 'folders' }
  return RUNTIME_TABS.find(t => t.id === wanted)?.id ?? aliases[wanted] ?? RUNTIME_TABS.find(t => t.id.startsWith(wanted))?.id
}
