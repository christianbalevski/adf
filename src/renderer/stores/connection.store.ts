import { create } from 'zustand'
import { useEffect } from 'react'
import { CONNECTION_STATE_LABELS, type ConnectionCurrent, type ConnectionsView } from '../../shared/types/connection.types'

/**
 * The connection this window uses and the Connection page's list
 * (docs/design/settings-scopes.md §4, §5). Main answers for the window that
 * asks (#149: one connection per window), so nothing here assumes there is
 * one connection for the app.
 */
interface ConnectionStoreState {
  view: ConnectionsView | null
  setView: (view: ConnectionsView) => void
}

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
  view: null,
  setView: (view) => set({ view }),
}))

/** The CONNECTION_CHANGED subscription while the feed runs; null before it starts or after a failed load. */
let unsubscribe: (() => void) | null = null

/** Load the list once and follow CONNECTION_CHANGED for the life of the window; a failed load drops its listener, so a retry adds exactly one. */
export function startConnectionFeed(): void {
  if (unsubscribe) return
  const api = window.adfApi
  if (!api?.listConnections) return
  const off = api.onConnectionChanged?.((view) => useConnectionStore.getState().setView(view)) ?? (() => {})
  unsubscribe = off
  api.listConnections().then((view) => useConnectionStore.getState().setView(view)).catch(() => {
    off()
    if (unsubscribe === off) unsubscribe = null
  })
}

/** The connection this window uses (null until main answers). */
export function useCurrentConnection(): ConnectionCurrent | null {
  useEffect(() => { startConnectionFeed() }, [])
  return useConnectionStore((s) => s.view?.current ?? null)
}

/**
 * At least one runtime on another computer is saved (or in use). Until then
 * Studio reads as plain ADF Studio: no runtime names in the sidebar or the
 * status bar, and Connections is one line with Add (settings-scopes.md §4).
 */
export function remoteConnectionsSaved(view: Pick<ConnectionsView, 'current' | 'rows'> | null): boolean {
  if (!view) return false
  return view.current.kind === 'remote' || view.rows.some((r) => r.kind === 'saved')
}

/** remoteConnectionsSaved for this window's list. */
export function useRemoteConnectionsSaved(): boolean {
  useEffect(() => { startConnectionFeed() }, [])
  return useConnectionStore((s) => remoteConnectionsSaved(s.view))
}

/** The runtime is not reachable now (connecting, retrying, failed). */
export function runtimeDown(current: ConnectionCurrent | null): boolean {
  return !!current && current.state !== 'connected'
}

/** The sidebar group label: "Runtime · rawl-hub", plus the state while it is not connected. */
export function runtimeGroupLabel(current: ConnectionCurrent | null): string {
  if (!current) return 'Runtime'
  const base = `Runtime · ${current.name}`
  return runtimeDown(current) ? `${base} · ${CONNECTION_STATE_LABELS[current.state]}` : base
}

/**
 * The status bar's runtime indicator (settings-scopes.md §4.1): nothing for
 * This computer or Inside Studio while connected; a remote's name, with the
 * state while it is not connected; This computer only while it is not.
 * With no remote saved (`showName` false) a problem shows without the name.
 */
export function runtimeIndicator(current: ConnectionCurrent | null, showName = true): { text: string; remote: boolean; tooltip: string | null; problem: boolean } | null {
  if (!current) return null
  const remote = current.kind === 'remote'
  const down = runtimeDown(current)
  if (!remote && !down) return null
  // No remote saved: only a problem shows, in the status line's words, with no runtime name.
  if (!showName && !remote) return { text: CONNECTION_STATE_LABELS[current.state], remote: false, tooltip: null, problem: true }
  return {
    text: down ? `${current.name} · ${CONNECTION_STATE_LABELS[current.state]}` : current.name,
    remote,
    tooltip: current.url,
    problem: down,
  }
}
