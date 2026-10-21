import { useEffect } from 'react'
import { create } from 'zustand'
import { CONNECTION_STATE_LABELS, type ConnectionsView, type RuntimeView } from '../../shared/types/connection.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
import { LOCAL_LABEL } from '../../shared/runtime-name'
import { startConnectionFeed, useConnectionStore } from './connection.store'

/**
 * The runtime set as this window sees it (docs/design/multi-runtime.md
 * §5.1), from CONNECTION_LIST and CONNECTION_CHANGED. Main lists the set
 * (`ConnectionsView.runtimes`) only while it has more than one runtime; until
 * then the set is the one runtime this window uses, under the id the renderer
 * calls it by (`local`: window.adfApi, untagged).
 *
 * Names, tags, the Settings picker and grouping depend on one selector,
 * useMultiRuntime().
 */

/** The runtime set of a connections view, in its fixed order (§3.1). */
export function runtimesOf(view: Pick<ConnectionsView, 'current' | 'runtimes'> | null): RuntimeView[] {
  if (!view) return []
  if (view.runtimes && view.runtimes.length > 0) return view.runtimes
  const c = view.current
  return [{ id: LOCAL_RUNTIME, kind: c.kind === 'remote' ? 'remote' : 'local', name: c.name, url: c.url, state: c.state }]
}

interface RuntimesState {
  runtimes: RuntimeView[]
  setRuntimes: (runtimes: RuntimeView[]) => void
}

export const useRuntimesStore = create<RuntimesState>((set) => ({
  runtimes: runtimesOf(useConnectionStore.getState().view),
  // Identity-stable: a connections push that leaves the set as it was keeps every selector warm.
  setRuntimes: (runtimes) => set((s) => (JSON.stringify(s.runtimes) === JSON.stringify(runtimes) ? s : { runtimes })),
}))

// The set follows the connections view, whoever loaded it.
useConnectionStore.subscribe((state, prev) => {
  if (state.view !== prev.view) useRuntimesStore.getState().setRuntimes(runtimesOf(state.view))
})

/** More than one runtime in the set (§1.3); a runtime counts while it is down. */
export function multiRuntime(runtimes: readonly RuntimeView[]): boolean {
  return runtimes.length > 1
}

/** Grouping, runtime names and tags are shown only while this is true. */
export function useMultiRuntime(): boolean {
  useEffect(() => { startConnectionFeed() }, [])
  return useRuntimesStore((s) => multiRuntime(s.runtimes))
}

/** The runtime set in its fixed order: This computer first, then the remotes in the order added. */
export function useRuntimes(): RuntimeView[] {
  useEffect(() => { startConnectionFeed() }, [])
  return useRuntimesStore((s) => s.runtimes)
}

export function useRuntime(id: RuntimeId | null | undefined): RuntimeView | null {
  return useRuntimesStore((s) => s.runtimes.find((r) => r.id === (id || LOCAL_RUNTIME)) ?? null)
}

/** The runtime's name (`<name> (Local)` for the local one, shared/runtime-name.ts); "Local" or the id while the set does not list it. */
export function runtimeName(id: RuntimeId | null | undefined, runtimes: readonly RuntimeView[] = useRuntimesStore.getState().runtimes): string {
  const key = id || LOCAL_RUNTIME
  return runtimes.find((r) => r.id === key)?.name ?? (key === LOCAL_RUNTIME ? LOCAL_LABEL : key.replace(/^remote:/, ''))
}

/** The runtime is in the set and not reachable now (connecting, retrying, failed). */
export function runtimeDown(id: RuntimeId | null | undefined, runtimes: readonly RuntimeView[] = useRuntimesStore.getState().runtimes): boolean {
  const r = runtimes.find((x) => x.id === (id || LOCAL_RUNTIME))
  return !!r && r.state !== 'connected'
}

/** A group header: the runtime name, plus its state while it is down (§3.6). */
export function runtimeHeader(runtime: RuntimeView): string {
  return runtime.state === 'connected' ? runtime.name : `${runtime.name} · ${CONNECTION_STATE_LABELS[runtime.state]}`
}

/**
 * The runtime label of a bell row, toast or switcher row (§6.1): its name
 * while there is more than one runtime, else null (nothing is shown).
 */
export function runtimeLabel(id: RuntimeId | null | undefined, runtimes: readonly RuntimeView[]): string | null {
  return multiRuntime(runtimes) ? runtimeName(id, runtimes) : null
}

/** The runtime is on another computer: its name shows with the remote icon (RemoteMark). */
export function runtimeRemote(id: RuntimeId | null | undefined, runtimes: readonly RuntimeView[] = useRuntimesStore.getState().runtimes): boolean {
  return runtimes.find((r) => r.id === (id || LOCAL_RUNTIME))?.kind === 'remote'
}

/** runtimeLabel for this window's set. */
export function useRuntimeLabel(id: RuntimeId | null | undefined): string | null {
  return useRuntimesStore((s) => runtimeLabel(id, s.runtimes))
}
