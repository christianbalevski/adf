// Read hooks over the store. Views use these (and `useActions`) — never the
// raw state tree — so the contract stays stable while the tree evolves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAIN_LOOP } from '../api/types'
import { emptyTranscript } from './transcript'
import { shallowEqual, useStore, useTuiSelector } from './store'
import { transcriptKey, type AgentEntry, type FocusZone, type LoopState, type Transcript, type TuiState } from './types'
import type { ConnectionInfo } from '../api/sse'
import { authNeedOf } from '../auth/model'

const EMPTY_TRANSCRIPT: Transcript = Object.freeze(emptyTranscript()) as Transcript

export function useConnection(): { info: ConnectionInfo; reachable: boolean | null; url: string } {
  const info = useTuiSelector(s => s.connection)
  const reachable = useTuiSelector(s => s.daemonReachable)
  const url = useTuiSelector(s => s.daemonUrl)
  return useMemo(() => ({ info, reachable, url }), [info, reachable, url])
}

/** The daemon's owner identity status; null until read or on daemons without identity routes. */
export function useIdentity() {
  return useTuiSelector(s => s.identity)
}

/** The subscription (chatgpt | grok) this agent needs and the daemon is not signed in to, else null. */
export function useAuthNeed(agentId: string | null | undefined) {
  return useTuiSelector(s => authNeedOf(s, agentId))
}

/** Agents in display order. */
export function useAgents(): AgentEntry[] {
  return useTuiSelector(s => s.agentOrder.map(id => s.agents[id]).filter(Boolean), shallowEqual)
}

export function useAgent(agentId: string | null | undefined): AgentEntry | undefined {
  return useTuiSelector(s => (agentId ? s.agents[agentId] : undefined))
}

export function useSelectedAgentId(): string | null {
  return useTuiSelector(s => s.selectedAgentId)
}

export function useSelectedAgent(): AgentEntry | undefined {
  return useTuiSelector(s => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined))
}

/** The selected loop of an agent (default: the selected agent); `main` when none chosen. */
export function useSelectedLoop(agentId?: string | null): string {
  return useTuiSelector(s => {
    const id = agentId === undefined ? s.selectedAgentId : agentId
    return id ? s.selectedLoop[id] ?? MAIN_LOOP : MAIN_LOOP
  })
}

/** Selected loop per agent id (absent = main). */
export function useSelectedLoops(): Record<string, string> {
  return useTuiSelector(s => s.selectedLoop)
}

/** Loops of an agent (main first), or undefined until fetched. */
export function useLoops(agentId: string | null | undefined): LoopState[] | undefined {
  return useTuiSelector(s => (agentId ? s.agents[agentId]?.loops : undefined))
}

export function useLoop(agentId: string | null | undefined, loop: string): LoopState | undefined {
  return useTuiSelector(s => (agentId ? s.agents[agentId]?.loops?.find(l => l.info.name === loop) : undefined))
}

export function useTranscript(agentId: string | null | undefined, loop: string): Transcript {
  return useTuiSelector(s => (agentId ? s.transcripts[transcriptKey(agentId, loop)] ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT))
}

export function useActiveView(): string {
  return useTuiSelector(s => s.activeView)
}

export function useFocus(): FocusZone {
  return useTuiSelector(s => s.focus)
}

export function useToasts() {
  return useTuiSelector(s => s.toasts)
}

export function useOverlays() {
  return useTuiSelector(s => s.overlays)
}

export function useTopOverlay() {
  return useTuiSelector(s => s.overlays[s.overlays.length - 1])
}

export function useActivity() {
  return useTuiSelector(s => s.activity)
}

/** Total pending approvals + asks across the fleet. */
export function usePendingHilCount(): number {
  return useTuiSelector(s => {
    let n = 0
    for (const id of s.agentOrder) {
      const agent = s.agents[id]
      if (agent) n += agent.pendingTasks.length + agent.pendingAsks.length
    }
    return n
  })
}

/**
 * View-scoped state that survives view switches (cursor positions, filters,
 * expanded rows). Each view owns the slice under its own id.
 */
export function useViewState<T>(viewId: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const store = useStore()
  const value = useTuiSelector(s => (viewId in s.viewState ? s.viewState[viewId] as T : initial))
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const current = store.getState().viewState
    const prev = viewId in current ? current[viewId] as T : initial
    store.actions.setViewState(viewId, typeof next === 'function' ? (next as (prev: T) => T)(prev) : next)
  }, [store, viewId, initial])
  return [value, set]
}

/**
 * Like `useTuiSelector`, but re-renders at most once per `ms` while the value
 * keeps changing (a busy event stream): the first change shows after at most
 * `ms`, bursts coalesce. For views that show a firehose (the event tail).
 */
export function useThrottledSelector<T>(selector: (state: TuiState) => T, ms = 100): T {
  const store = useStore()
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const [value, setValue] = useState(() => selector(store.getState()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let latest = selectorRef.current(store.getState())
    setValue(latest)
    const flush = () => { timer = null; setValue(latest) }
    const unsubscribe = store.subscribe(() => {
      const next = selectorRef.current(store.getState())
      if (Object.is(next, latest)) return
      latest = next
      if (!timer) timer = setTimeout(flush, ms)
    })
    return () => { unsubscribe(); if (timer) clearTimeout(timer) }
  }, [store, ms])
  return value
}
