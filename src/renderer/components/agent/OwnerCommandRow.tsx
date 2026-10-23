import { useId, useState } from 'react'
import type { AgentLogEntry } from '../../stores/agent.store'
import { formatOwnerCommandRow, type OwnerCommandHeader } from '../../../shared/utils/owner-command-row'
import { Tooltip } from '../common/Tooltip'
import { ShieldIcon, WarningIcon } from './config-panel-parts'

export function OwnerCommandRow({ entry }: { entry: AgentLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const [raw, setRaw] = useState(false)
  const bodyId = useId()
  const header = entry.metadata?.ownerCommand as OwnerCommandHeader | undefined
  if (!header) return null
  const status = header.status as string
  const label = status === 'denied' ? 'permission denied' : status
  const long = entry.content.split('\n').length > 5 || entry.content.length > 500
  const notice = entry.metadata?.unrecorded === true ? 'Agent stopped before this result could be recorded.'
    : entry.metadata?.deferred === true ? "Recorded after the agent's current step." : undefined
  const deniedHint = 'Run again with !authorize to allow restricted calls for this one run.'
  return <div className="min-w-0 rounded-lg border border-[var(--rule)] bg-[var(--paper-sunken)] px-2.5 py-2 text-xs text-[var(--ink)]">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`min-w-0 break-words font-mono ${status === 'running' ? 'adf-shimmer-text adf-shimmer-text--activity' : 'text-[var(--ink-muted)]'}`}>You ran {header.command}</span>
      <Tooltip tip={status === 'denied' ? deniedHint : label} disabled={status !== 'denied'}>
        <span tabIndex={status === 'denied' ? 0 : undefined} aria-label={status === 'denied' ? `Permission denied. ${deniedHint}` : undefined} className={`rounded-full px-1.5 py-px text-[10px] font-medium ${status === 'error' || status === 'denied' ? 'bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)]' : 'bg-[var(--adf-ui-surface-hover)] text-[var(--ink-muted)]'}`}>{label}</span>
      </Tooltip>
      {header.authorized && <Tooltip tip="Ran as authorized code for this invocation." className="inline-flex"><span tabIndex={0} role="img" aria-label="Authorized run" className="inline-flex text-[var(--adf-ui-warning)]"><ShieldIcon size={12} filled /></span></Tooltip>}
      {notice && <Tooltip tip={notice} className="inline-flex"><span tabIndex={0} role="img" aria-label={notice} className="inline-flex text-[var(--adf-ui-warning)]"><WarningIcon /></span></Tooltip>}
      {typeof entry.metadata?.seq === 'number' && <button type="button" aria-pressed={raw} aria-controls={bodyId} className={`ml-auto shrink-0 rounded-full border border-[var(--adf-ui-border)] px-2 py-0.5 text-[11px] font-medium transition-colors ${raw ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]' : 'text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)]'}`} onClick={() => setRaw(!raw)}>{raw ? 'Formatted' : 'Raw'}</button>}
    </div>
    {(entry.content || raw) && <pre id={bodyId} className={`mt-1.5 overflow-auto whitespace-pre-wrap break-words font-mono text-[var(--ink-muted)] ${!expanded && !raw ? 'max-h-28' : 'max-h-96'}`}>{raw ? formatOwnerCommandRow(header, entry.content) : entry.content}</pre>}
    {long && !raw && <button type="button" aria-expanded={expanded} aria-controls={bodyId} className="mt-1 text-[11px] text-[var(--ink-muted)] hover:text-[var(--ink)]" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}
  </div>
}
