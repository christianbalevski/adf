/**
 * The open agent's adf_tasks rows, newest first. Reads `getTasks` on open and
 * agent switch, then again on each `tasks` workspace data-change signal
 * (every task insert and status change, coalesced in main). No polling.
 * getTasks reads the foreground workspace, so a read started for another
 * agent is dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { openApi, openAgentKey, useOpenAgentKey } from '../utils/runtime-api'
import { captureAgentView, isCurrentAgentView } from '../utils/agent-view'
import type { TaskEntry } from '../../shared/types/adf-v02.types'

const FETCH_LIMIT = 200
/** Stable, so an effect keyed on the list does not refire each render. */
const EMPTY: TaskEntry[] = []

export function useTasks(): TaskEntry[] {
  const key = useOpenAgentKey()
  const [entry, setEntry] = useState<{ key: string; tasks: TaskEntry[] } | null>(null)
  const seq = useRef(0)

  const fetchNow = useCallback(() => {
    if (!key || key !== openAgentKey()) return
    const view = captureAgentView()
    const pending = openApi()?.getTasks(FETCH_LIMIT)
    if (!pending) return
    const id = ++seq.current
    pending.then(
      ({ tasks }) => {
        if (id === seq.current && isCurrentAgentView(view)) setEntry({ key, tasks })
      },
      () => {}
    )
  }, [key])

  useEffect(() => {
    fetchNow()
    return openApi()?.onWorkspaceDataChanged?.(({ scope }) => {
      if (scope === 'tasks') fetchNow()
    })
  }, [fetchNow])

  return entry && entry.key === key ? entry.tasks : EMPTY
}
