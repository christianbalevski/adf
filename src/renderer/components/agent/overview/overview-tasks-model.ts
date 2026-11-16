/**
 * The overview's Tasks section: async tool calls (`_async: true`, adf_tasks
 * rows) the agent has running, mostly sys_code and sys_lambda scripts. Pure
 * helpers, so the rows and summary are testable without the panel.
 */

import type { TaskEntry } from '../../../../shared/types/adf-v02.types'

/** Finished tasks stay listed this long, so a fast one is seen at all. */
export const RECENT_MS = 2 * 60_000
/** The summary line's window. */
export const SUMMARY_WINDOW_MS = 60 * 60_000
/** Past this share of its timeout, a script's bar warns. */
export const TIMEOUT_WARN_AT = 0.8

/** Finished runs; a denied approval never ran. */
const FINISHED = new Set<string>(['completed', 'failed', 'cancelled'])

/**
 * Genuine async runs. adf_tasks also holds approval rows for blocking calls
 * (origin `hil:…`), which never ran as tasks.
 */
const isAsyncRun = (t: TaskEntry): boolean => t.origin === 'agent' || t.origin === 'lambda'

/** Script tools whose run is cut at `timeout ?? limits.execution_timeout_ms`. */
const SCRIPT_TOOLS = new Set(['sys_code', 'sys_lambda'])

export interface TaskRow {
  id: string
  /** The agent's `_reason` for the call, or the tool name. */
  title: string
  tool: string
  /** What the script runs: a lambda's source, or the first line of code. */
  detail: string
  /** The full code or source, for the tooltip, when `detail` shortens it. */
  full?: string
  startedAt: number
  /** Scripts only: when the run is killed, in ms after start. */
  timeoutMs?: number
  /** Set on a finished task still listed as recent. */
  finished?: { status: 'completed' | 'failed' | 'cancelled'; at: number }
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function firstLine(code: string): string {
  const line = code.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//')) ?? ''
  return line
}

export function taskRow(task: TaskEntry, defaultTimeoutMs: number): TaskRow {
  const args = parseArgs(task.args)
  const reason = str(args._reason)
  let detail = ''
  let full: string | undefined
  if (task.tool === 'sys_lambda') {
    detail = str(args.source)
  } else if (task.tool === 'sys_code') {
    const code = str(args.code)
    detail = firstLine(code)
    if (code && code !== detail) full = code
  }
  const row: TaskRow = {
    id: task.id,
    title: reason || task.tool,
    tool: task.tool,
    detail,
    ...(full ? { full } : {}),
    startedAt: task.created_at
  }
  // A run that waited on an approval started after created_at (the request),
  // so its bar would start pre-filled: no bar.
  if (SCRIPT_TOOLS.has(task.tool) && task.approval_meta == null) {
    row.timeoutMs = Math.min(typeof args.timeout === 'number' ? args.timeout : defaultTimeoutMs, defaultTimeoutMs)
  }
  if (FINISHED.has(task.status) && task.completed_at) {
    row.finished = { status: task.status as NonNullable<TaskRow['finished']>['status'], at: task.completed_at }
  }
  return row
}

/**
 * Running tasks, oldest first, then tasks finished within RECENT_MS, newest
 * first. Approval-waiting and queued tasks are left out: Upcoming lists
 * approvals, and nothing is running yet.
 */
export function taskRows(tasks: readonly TaskEntry[], defaultTimeoutMs: number, now: number): TaskRow[] {
  const runs = tasks.filter(isAsyncRun)
  const running = runs
    .filter((t) => t.status === 'running')
    .sort((a, b) => a.created_at - b.created_at)
  const recent = runs
    .filter((t) => FINISHED.has(t.status) && !!t.completed_at && now - t.completed_at < RECENT_MS)
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
  return [...running, ...recent].map((t) => taskRow(t, defaultTimeoutMs))
}

/** "0:07", "4:12", "1:05:12". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Share of the timeout used, 0..1, or null for a task with no timeout. */
export function timeoutShare(row: TaskRow, now: number): number | null {
  if (!row.timeoutMs) return null
  return Math.min(1, Math.max(0, (now - row.startedAt) / row.timeoutMs))
}

/** "done 0:52 ago", "failed 1:10 ago". */
export function finishedText(row: TaskRow, now: number): string {
  if (!row.finished) return ''
  const word = row.finished.status === 'completed' ? 'done' : row.finished.status
  return `${word} ${formatElapsed(now - row.finished.at)} ago`
}

/**
 * "Last hour: 5 done · 1 failed · avg 1:40" over async runs that finished in
 * the window. Runs that waited on an approval count but stay out of the
 * average, since their created_at is the request. Null when none finished.
 */
export function taskSummary(tasks: readonly TaskEntry[], now: number): string | null {
  let done = 0
  let failed = 0
  let timed = 0
  let total = 0
  for (const t of tasks) {
    if (!isAsyncRun(t) || !t.completed_at || now - t.completed_at > SUMMARY_WINDOW_MS) continue
    if (t.status === 'completed') {
      done++
      if (t.approval_meta == null) {
        timed++
        total += t.completed_at - t.created_at
      }
    } else if (t.status === 'failed') {
      failed++
    }
  }
  if (done + failed === 0) return null
  const parts = [`${done} done`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (timed > 0) parts.push(`avg ${formatElapsed(total / timed)}`)
  return `Last hour: ${parts.join(' · ')}`
}
