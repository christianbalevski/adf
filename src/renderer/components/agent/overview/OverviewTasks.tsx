/**
 * The overview's Tasks section: async tool calls the agent has running
 * (adf_tasks rows, mostly sys_code / sys_lambda scripts), each with its
 * `_reason`, what it runs, a live elapsed time and, for scripts, a bar toward
 * the timeout that kills it. Tasks finished in the last two minutes stay as
 * muted rows, and a summary line covers the last hour. Hidden when nothing
 * runs or just finished.
 *
 * Rows come from useTasks, refetched on each `tasks` data-change signal; no
 * polling. Elapsed times tick locally.
 */

import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useTasks } from '../../../hooks/useTasks'
import { Tooltip } from '../../common/Tooltip'
import { AGENT_DEFAULTS } from '../../../../shared/types/adf-v02.types'
import { OVERVIEW_ROW_LIMIT, visibleItems } from './agent-overview-model'
import { Section } from './OverviewActivity'
import {
  TIMEOUT_WARN_AT,
  finishedText,
  formatElapsed,
  taskRows,
  taskSummary,
  timeoutShare,
  type TaskRow
} from './overview-tasks-model'

const MONO = 'font-mono text-[11.5px]'

const openTasksPanel = (): void => {
  const app = useAppStore.getState()
  app.setBottomPanelTab('tasks')
  if (!app.showLogsPanel) app.toggleLogsPanel()
}

export function OverviewTasks() {
  const tasks = useTasks()
  const timeoutMs = useAgentStore((s) => s.config?.limits?.execution_timeout_ms) ?? AGENT_DEFAULTS.limits.execution_timeout_ms
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)

  const rows = useMemo(() => taskRows(tasks, timeoutMs, now), [tasks, timeoutMs, now])
  const runningCount = rows.filter((r) => !r.finished).length
  const live = rows.length > 0

  // Elapsed times tick each second, only while something is listed.
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  // A fresh read can list a task the ticker has not seen yet.
  useEffect(() => setNow(Date.now()), [tasks])

  if (!live) return null
  const summary = taskSummary(tasks, now)
  const { shown, hidden } = visibleItems(rows, expanded, OVERVIEW_ROW_LIMIT)

  return (
    <Section
      title="Tasks"
      aside={
        <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums">
          {runningCount > 0 ? `${runningCount} running` : 'none running'}
        </span>
      }
    >
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.id}><TaskBlock row={r} now={now} /></li>
        ))}
      </ul>
      {(hidden > 0 || summary) && (
        <div className="flex items-baseline justify-between gap-2 text-[11.5px] leading-4 text-[var(--ink-faint)] tabular-nums">
          <span className="min-w-0 truncate">{summary}</span>
          {hidden > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="shrink-0 text-[var(--ink-muted)] hover:text-[var(--ink)]">
              +{hidden} more
            </button>
          )}
        </div>
      )}
    </Section>
  )
}

function TaskBlock({ row, now }: { row: TaskRow; now: number }) {
  const share = row.finished ? null : timeoutShare(row, now)
  const warn = share !== null && share >= TIMEOUT_WARN_AT
  const failed = row.finished && row.finished.status !== 'completed'
  const tip = [
    row.title !== row.tool ? row.title : '',
    row.full ?? (row.detail ? `${row.tool} · ${row.detail}` : ''),
    row.timeoutMs ? `Times out after ${formatElapsed(row.timeoutMs)}` : '',
    `Started ${new Date(row.startedAt).toLocaleTimeString()}`
  ].filter(Boolean).join('\n')

  return (
    <Tooltip tip={tip} className="block">
      <button
        type="button"
        onClick={openTasksPanel}
        className={`-mx-1.5 w-[calc(100%+12px)] rounded px-1.5 py-0.5 text-left hover:bg-[var(--paper-sunken)] ${row.finished ? 'opacity-60' : ''}`}
      >
        <div className="flex items-baseline gap-2 text-[13px] leading-[18px]">
          <span
            aria-hidden
            className={`shrink-0 self-center h-1.5 w-1.5 rounded-full ${
              row.finished ? (failed ? 'bg-red-500' : 'bg-[var(--ink-faint)]') : 'bg-blue-500 animate-pulse'
            }`}
          />
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          <span className={`shrink-0 text-[11.5px] tabular-nums ${failed ? 'text-red-600 dark:text-red-400' : 'text-[var(--ink-faint)]'}`}>
            {row.finished ? finishedText(row, now) : formatElapsed(now - row.startedAt)}
          </span>
        </div>
        <div className="truncate pl-3.5 text-[11.5px] leading-4 text-[var(--ink-muted)]">
          <span className={MONO}>{row.tool}</span>
          {row.detail && <span className={MONO}>{' · '}{row.detail}</span>}
        </div>
        {share !== null && (
          <div className="ml-3.5 mt-0.5 flex items-center gap-2">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[var(--paper-sunken)]">
              <div
                className={`h-full rounded-full ${warn ? 'bg-amber-500' : 'bg-blue-500/70'}`}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </div>
            <span className={`shrink-0 text-[10.5px] leading-3 tabular-nums ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--ink-faint)]'}`}>
              {formatElapsed(row.timeoutMs!)}
            </span>
          </div>
        )}
      </button>
    </Tooltip>
  )
}
