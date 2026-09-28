// Data the loops manager reads that the shared store does not keep: timers,
// runtime trigger state, model lists, history pages. Fetched per view mount,
// refetched on the relevant umbilical events and after every mutation the
// view (or a /timer command) makes. Read failures render inline.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useClient, useTuiSelector } from '../../state/store'
import { useViewState } from '../../state/hooks'
import type { TuiActions } from '../../state/store'
import type { TuiState } from '../../state/types'
import type { AgentTriggersDiagnostics, LoopPage, Timer } from '../../api/types'
import type { DaemonClient } from '../../api/client'

/** viewState slot bumped after any timer/trigger/loop mutation so open tabs refetch. */
export const LOOPS_REV_KEY = 'loops.rev'

let revCounter = 0

export function bumpLoopsData(actions: TuiActions, _state?: TuiState): void {
  actions.setViewState(LOOPS_REV_KEY, ++revCounter)
}

export function useLoopsRev(): number {
  const [rev] = useViewState<number>(LOOPS_REV_KEY, 0)
  return rev
}

/** Changes whenever an event of one of `types` arrives for `agentId` (null = any agent). */
export function useEventTick(agentId: string | null | undefined, types: string[]): string {
  const key = types.join('|')
  return useTuiSelector(s => {
    for (let i = s.lastEvents.length - 1; i >= 0; i--) {
      const e = s.lastEvents[i]
      if (agentId !== undefined && agentId !== null && e.agent_id !== agentId) continue
      if (key.split('|').includes(e.event_type)) return `${e.agent_id ?? ''}:${e.seq}:${e.timestamp}`
    }
    return ''
  })
}

/** Re-render every `ms` so relative times ("in 12m") stay honest. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

export interface AsyncData<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
}

export function useAsyncData<T>(load: ((client: DaemonClient) => Promise<T>) | null, deps: unknown[]): AsyncData<T> {
  const client = useClient()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    if (!load) { setData(undefined); setError(undefined); setLoading(false); return }
    const mine = ++seq.current
    setLoading(true)
    load(client).then(
      result => { if (seq.current === mine) { setData(result); setError(undefined); setLoading(false) } },
      err => { if (seq.current === mine) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) } },
    )
  }, [...deps, nonce, client])
  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { data, error, loading, reload }
}

const TIMER_EVENTS = ['timer.fired', 'config.changed', 'agent.loaded']

export function useAgentTimers(agentId: string | null | undefined): AsyncData<Timer[]> {
  const rev = useLoopsRev()
  const tick = useEventTick(agentId ?? null, TIMER_EVENTS)
  return useAsyncData(agentId ? async c => (await c.timers(agentId)).timers : null, [agentId, rev, tick])
}

export interface FleetTimer {
  agentId: string
  agentLabel: string
  timer: Timer
}

export function useFleetTimers(enabled: boolean): AsyncData<FleetTimer[]> & { failures: string[] } {
  const rev = useLoopsRev()
  const tick = useEventTick(undefined, TIMER_EVENTS)
  const agents = useTuiSelector(s => s.agentOrder.map(id => `${id}\u0000${s.agents[id]?.summary.handle || s.agents[id]?.summary.name || id}`).join('\n'))
  const [failures, setFailures] = useState<string[]>([])
  const result = useAsyncData<FleetTimer[]>(enabled ? async c => {
    const list = agents ? agents.split('\n').map(line => { const [id, label] = line.split('\u0000'); return { id, label } }) : []
    const pages = await Promise.all(list.map(async a => {
      try {
        return { a, timers: (await c.timers(a.id)).timers, error: undefined as string | undefined }
      } catch (err) {
        return { a, timers: [] as Timer[], error: `${a.label}: ${err instanceof Error ? err.message : String(err)}` }
      }
    }))
    setFailures(pages.flatMap(p => (p.error ? [p.error] : [])))
    return pages
      .flatMap(p => p.timers.map(timer => ({ agentId: p.a.id, agentLabel: p.a.label, timer })))
      .sort((x, y) => (x.timer.expired ? 1 : 0) - (y.timer.expired ? 1 : 0) || x.timer.next_wake_at - y.timer.next_wake_at)
  } : null, [enabled, agents, rev, tick])
  return { ...result, failures }
}

const TRIGGER_EVENTS = ['config.changed', 'trigger.fired', 'trigger.dropped', 'agent.loaded']

export function useRuntimeTriggers(agentId: string | null | undefined): AsyncData<AgentTriggersDiagnostics> {
  const rev = useLoopsRev()
  const tick = useEventTick(agentId ?? null, TRIGGER_EVENTS)
  return useAsyncData(agentId ? c => c.agentTriggers(agentId) : null, [agentId, rev, tick])
}

export function useModelList(agentId: string | null | undefined, provider: string | undefined): AsyncData<{ models: string[]; error?: string }> {
  return useAsyncData(agentId && provider ? async c => {
    const result = await c.models(provider, agentId)
    const models = (result.models ?? []).map(m => (typeof m === 'string' ? m : typeof m === 'object' && m && 'id' in m ? String((m as { id: unknown }).id) : String(m)))
    return { models, error: typeof result.error === 'string' ? result.error : undefined }
  } : null, [agentId, provider])
}

const HISTORY_EVENTS = ['turn.completed', 'loop.cleared', 'loop.compacted']

export function useHistoryPage(agentId: string | null | undefined, loop: string, offset: number | null, limit: number): AsyncData<LoopPage> {
  const rev = useLoopsRev()
  const tick = useEventTick(agentId ?? null, HISTORY_EVENTS)
  // Only follow live events on the newest page; an older page stays put while you read it.
  const liveTick = offset === null ? tick : ''
  return useAsyncData(agentId ? c => c.loopHistory(agentId, { loop, limit, ...(offset !== null ? { offset } : {}) }) : null, [agentId, loop, offset, limit, rev, liveTick])
}
