import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import type { DaemonClient } from '../../api/client'

export interface DaemonData<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  /** Epoch ms of the last successful load. */
  loadedAt: number | undefined
  reload: () => void
}

/**
 * Fetch from the daemon while mounted. Errors are returned (and rendered
 * inline by the caller), never swallowed. `key` changes refetch.
 */
export function useDaemonData<T>(key: string | null, load: (client: DaemonClient) => Promise<T>): DaemonData<T> {
  const store = useStore()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (key === null) { setData(undefined); setError(undefined); return }
    let cancelled = false
    setLoading(true)
    loadRef.current(store.client).then(
      value => { if (!cancelled) { setData(value); setError(undefined); setLoadedAt(Date.now()); setLoading(false) } },
      err => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) } },
    )
    return () => { cancelled = true }
  }, [store, key, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { data, error, loading, loadedAt, reload }
}

/** Handle (or name) for an agent id, read at render time. */
export function useAgentName(): (agentId: string | null | undefined) => string {
  const store = useStore()
  return useCallback((agentId: string | null | undefined) => {
    if (!agentId) return 'daemon'
    const summary = store.getState().agents[agentId]?.summary
    return summary?.handle || summary?.name || agentId.slice(0, 8)
  }, [store])
}
