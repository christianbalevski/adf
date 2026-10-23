import { useState } from 'react'
import type { AgentLogEntry } from '../../stores/agent.store'
import { formatOwnerCommandRow, type OwnerCommandHeader } from '../../../shared/utils/owner-command-row'

export function OwnerCommandRow({ entry }: { entry: AgentLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const [raw, setRaw] = useState(false)
  const header = entry.metadata?.ownerCommand as OwnerCommandHeader | undefined
  if (!header) return null
  const status = header.status as string
  const label = status === 'denied' ? 'permission denied' : status
  const long = entry.content.split('\n').length > 5 || entry.content.length > 500
  return <div className="rounded-lg border border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">You ran {header.command}</span>
      <span className={status === 'error' || status === 'denied' ? 'text-red-500' : 'text-[var(--ink-muted)]'}>{label}</span>
      {header.authorized && <span className="text-amber-600">authorized</span>}
      {typeof entry.metadata?.seq === 'number' && <button className="ml-auto text-[var(--ink-muted)]" onClick={() => setRaw(!raw)}>{raw ? 'Result' : 'Raw'}</button>}
    </div>
    <pre className={`mt-2 overflow-auto whitespace-pre-wrap break-words font-mono ${!expanded && !raw ? 'max-h-28' : 'max-h-96'}`}>{raw ? formatOwnerCommandRow(header, entry.content) : entry.content}</pre>
    {long && !raw && <button className="mt-1 text-[var(--ink-muted)]" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}
    {entry.metadata?.deferred === true && <p className="mt-2 text-[var(--ink-muted)]">Recorded after the agent's current step.</p>}
    {entry.metadata?.unrecorded === true && <p className="mt-2 text-[var(--ink-muted)]">Agent stopped before this result could be recorded.</p>}
    {status === 'denied' && <p className="mt-2 text-amber-600">Run again with !authorize to allow restricted calls for this one run.</p>}
  </div>
}
