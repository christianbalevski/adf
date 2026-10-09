import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentState } from '../../../../shared/types/ipc.types'

const POLL_MS = 10_000

/** One main-process read for the overview. Returns undefined when the bridge lacks it. */
export type OverviewReader<T> = (filePath: string, force: boolean) => Promise<T> | undefined

/**
 * A cached main-process read the overview refetches on open, agent switch,
 * config change (debounced), when the main loop leaves 'active', and every
 * 10 s while the document is visible. Only a config change and a finished
 * turn force a fresh read; main rate-limits even those. `reader` must be stable (module level).
 * Results for another file never show.
 */
export function useOverviewRead<T>(
  filePath: string | null,
  state: AgentState,
  config: AgentConfig | null,
  reader: OverviewReader<T>
): T | null {
  const [entry, setEntry] = useState<{ path: string; value: T } | null>(null)
  const seq = useRef(0)

  const fetchNow = useCallback((force: boolean) => {
    if (!filePath) return
    const pending = reader(filePath, force)
    if (!pending) return
    const id = ++seq.current
    pending.then(
      (value) => {
        if (id === seq.current && value) setEntry({ path: filePath, value })
      },
      () => {}
    )
  }, [filePath, reader])

  // Panel open and agent switch: the cached read (main re-reads what moved).
  // A config change on the same agent (Studio edits and the runtime's own both
  // land in the store) forces one, debounced so a burst of saves is one read.
  const configSeen = useRef<{ path: string | null; config: AgentConfig | null } | null>(null)
  useEffect(() => {
    const prev = configSeen.current
    configSeen.current = { path: filePath, config }
    const force = prev !== null && prev.path === filePath && prev.config !== null && prev.config !== config
    const t = setTimeout(() => fetchNow(force), force ? 250 : 0)
    return () => clearTimeout(t)
  }, [fetchNow, filePath, config])

  // A turn just ended: loop rows, files and cost moved.
  const prevState = useRef(state)
  useEffect(() => {
    const was = prevState.current
    prevState.current = state
    if (was === 'active' && state !== 'active') fetchNow(true)
  }, [state, fetchNow])

  // Light poll while the panel is mounted (it only is while its tab shows).
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) fetchNow(false)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [fetchNow])

  return entry && entry.path === filePath ? entry.value : null
}
