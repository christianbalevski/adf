// Fleet-level data the shared store does not keep: per-agent timers (loop
// schedules), unread inbox counts, persisted token usage, and the daemon's
// runtime overview. One poller per store, shared by the sidebar and the
// dashboard (ref-counted), results kept in viewState so they survive view
// switches. Refreshes on a timer and on the events that change them.

import { useEffect } from 'react'
import { useStore, useTuiSelector } from '../../state/store'
import type { TuiStore } from '../../state/store'
import type { RuntimeOverview, Timer } from '../../api/types'

export const FLEET_DATA_KEY = 'fleet.data'

export interface AgentExtras {
  timers?: Timer[]
  unread?: number
  usageTotal?: number
  at: number
}

export interface FleetData {
  agents: Record<string, AgentExtras>
  runtime?: RuntimeOverview
  runtimeError?: string
  runtimeAt?: number
}

const EMPTY: FleetData = { agents: {} }
const AGENT_POLL_MS = 30_000
const RUNTIME_POLL_MS = 15_000
const EVENT_DEBOUNCE_MS = 300

const AGENT_EVENTS = /^(timer\.|message\.|inbox\.|turn\.completed|config\.changed)/
const RUNTIME_EVENTS = /^(agent\.loaded|agent\.unloaded|mesh\.|ws\.)/

interface Poller {
  refs: number
  refresh(agentId?: string): Promise<void>
  refreshRuntime(): Promise<void>
  stop(): void
}

const pollers = new WeakMap<TuiStore, Poller>()

export function readFleetData(store: TuiStore): FleetData {
  return (store.getState().viewState[FLEET_DATA_KEY] as FleetData | undefined) ?? EMPTY
}

function write(store: TuiStore, patch: (data: FleetData) => FleetData) {
  store.actions.setViewState(FLEET_DATA_KEY, patch(readFleetData(store)))
}

function createPoller(store: TuiStore): Poller {
  const client = store.client
  let stopped = false
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const refreshAgent = async (agentId: string) => {
    const [timerList, inbox, usage] = await Promise.all([
      client.timers(agentId).then(r => r.timers).catch(() => undefined),
      client.inbox(agentId, 'unread').then(r => r.messages.length).catch(() => undefined),
      client.agentUsage(agentId).then(r => r.totals?.total).catch(() => undefined),
    ])
    if (stopped) return
    write(store, data => ({
      ...data,
      agents: { ...data.agents, [agentId]: { timers: timerList, unread: inbox, usageTotal: usage, at: Date.now() } },
    }))
  }

  const refresh = async (agentId?: string) => {
    const ids = agentId ? [agentId] : store.getState().agentOrder
    await Promise.all(ids.map(refreshAgent))
  }

  const refreshRuntime = async () => {
    try {
      const runtime = await client.runtime()
      if (!stopped) write(store, data => ({ ...data, runtime, runtimeError: undefined, runtimeAt: Date.now() }))
    } catch (err) {
      if (!stopped) write(store, data => ({ ...data, runtimeError: err instanceof Error ? err.message : String(err), runtimeAt: Date.now() }))
    }
  }

  const later = (key: string, fn: () => void, ms = EVENT_DEBOUNCE_MS) => {
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(key, setTimeout(() => { timers.delete(key); if (!stopped) fn() }, ms))
  }

  let lastOrder = store.getState().agentOrder
  let lastEvent = store.getState().lastEvents[store.getState().lastEvents.length - 1]
  const unsubscribe = store.subscribe(() => {
    const state = store.getState()
    if (state.agentOrder !== lastOrder) {
      const known = new Set(lastOrder)
      lastOrder = state.agentOrder
      for (const id of state.agentOrder) if (!known.has(id)) later(`agent:${id}`, () => { void refresh(id) })
    }
    const events = state.lastEvents
    const newest = events[events.length - 1]
    if (newest === lastEvent) return
    let i = events.length - 1
    while (i >= 0 && events[i] !== lastEvent) i--
    const fresh = events.slice(i + 1)
    lastEvent = newest
    for (const event of fresh) {
      if (event.agent_id && AGENT_EVENTS.test(event.event_type)) {
        const id = event.agent_id
        later(`agent:${id}`, () => { void refresh(id) })
      }
      if (RUNTIME_EVENTS.test(event.event_type)) later('runtime', () => { void refreshRuntime() })
    }
  })

  const agentTick = setInterval(() => { void refresh() }, AGENT_POLL_MS)
  const runtimeTick = setInterval(() => { void refreshRuntime() }, RUNTIME_POLL_MS)
  void refresh()
  void refreshRuntime()

  return {
    refs: 0,
    refresh,
    refreshRuntime,
    stop() {
      stopped = true
      unsubscribe()
      clearInterval(agentTick)
      clearInterval(runtimeTick)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}

/** Keep the fleet poller running while a fleet surface is mounted. */
export function useFleetPoller(): void {
  const store = useStore()
  useEffect(() => {
    let poller = pollers.get(store)
    if (!poller) {
      poller = createPoller(store)
      pollers.set(store, poller)
    }
    poller.refs++
    const held = poller
    return () => {
      held.refs--
      if (held.refs <= 0) {
        held.stop()
        if (pollers.get(store) === held) pollers.delete(store)
      }
    }
  }, [store])
}

/** Re-read timers/inbox/usage (one agent or all) and the runtime overview. */
export async function refreshFleetData(store: TuiStore, agentId?: string): Promise<void> {
  const poller = pollers.get(store)
  if (!poller) return
  await Promise.all([poller.refresh(agentId), agentId ? Promise.resolve() : poller.refreshRuntime()])
}

export function useFleetData(): FleetData {
  return useTuiSelector(s => (s.viewState[FLEET_DATA_KEY] as FleetData | undefined) ?? EMPTY)
}

/** Last activity timestamp per agent, from the store's event log. */
export function useLastActivity(): Record<string, number> {
  return useTuiSelector(s => {
    const out: Record<string, number> = {}
    for (const entry of s.activity) if (entry.agentId) out[entry.agentId] = Math.max(out[entry.agentId] ?? 0, entry.at)
    return out
  }, (a, b) => {
    const ak = Object.keys(a)
    if (ak.length !== Object.keys(b).length) return false
    return ak.every(k => a[k] === b[k])
  })
}
