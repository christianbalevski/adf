// Inspect › Tasks: pure model for the agent's adf_tasks (tool calls held for
// approval, async tool calls, their outcomes). Filtering, search, row fields
// and the detail lines; TasksTab.tsx renders them.

import { MAIN_LOOP, type TaskListEntry, type TaskStatus, type UmbilicalEvent } from '../../api/types'
import type { DaemonClient } from '../../api/client'
import { formatAgo, formatClock } from '../../ui/text'
import { blank, heading, plain, valueLines, type Line, type Tone } from './format'
import { alwaysBlocked } from '../chat/approvals'

export const TASK_FILTERS = ['pending', 'active', 'all'] as const
export type TaskFilter = typeof TASK_FILTERS[number]

/** Statuses each filter shows (all = every status). */
export const FILTER_STATUSES: Record<Exclude<TaskFilter, 'all'>, TaskStatus[]> = {
  pending: ['pending', 'pending_approval'],
  active: ['pending', 'pending_approval', 'running'],
}

export const TASK_LIMIT = 500

export function nextFilter(filter: TaskFilter): TaskFilter {
  return TASK_FILTERS[(TASK_FILTERS.indexOf(filter) + 1) % TASK_FILTERS.length]
}

export function matchesFilter(task: Pick<TaskListEntry, 'status'>, filter: TaskFilter): boolean {
  return filter === 'all' || FILTER_STATUSES[filter].includes(task.status)
}

/** Load for a filter: one call per status for pending/active (no old pending row is cut off by the limit). Newest first. */
export async function loadTasks(client: DaemonClient, agentId: string, filter: TaskFilter): Promise<TaskListEntry[]> {
  const lists = filter === 'all'
    ? [(await client.tasks(agentId, { limit: TASK_LIMIT })).tasks]
    : (await Promise.all(FILTER_STATUSES[filter].map(status => client.tasks(agentId, { status, limit: TASK_LIMIT })))).map(r => r.tasks)
  return sortTasks(lists.flat())
}

/** Newest first, one row per id. */
export function sortTasks(tasks: TaskListEntry[]): TaskListEntry[] {
  const byId = new Map<string, TaskListEntry>()
  for (const t of tasks) byId.set(t.id, t)
  return [...byId.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || (a.id < b.id ? 1 : -1))
}

export function parseTaskArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {}
  try { return JSON.parse(args) } catch { return args }
}

function parseMaybeJson(text: unknown): unknown {
  if (typeof text !== 'string') return text
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return text
  try { return JSON.parse(t) } catch { return text }
}

/** The call's `_reason` (the agent's own justification), when present. */
export function taskReason(task: Pick<TaskListEntry, 'args'>): string {
  const args = parseTaskArgs(task.args)
  const reason = args && typeof args === 'object' ? (args as Record<string, unknown>)._reason : undefined
  return typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : ''
}

/** The loop that made the call: a `loop` field, else origin `loop:<name>`, else main. */
export function taskLoop(task: TaskListEntry): string {
  const loop = (task as { loop?: unknown }).loop
  if (typeof loop === 'string' && loop) return loop
  const m = typeof task.origin === 'string' ? task.origin.match(/^loop:(.+)$/) : null
  return m ? m[1] : MAIN_LOOP
}

/** Last change: completion time, else creation. */
export function taskUpdated(task: TaskListEntry): number {
  return task.completed_at ?? task.created_at
}

export function searchText(task: TaskListEntry): string {
  return [task.id, task.status, task.tool, taskReason(task), taskLoop(task), task.origin ?? '', typeof task.args === 'string' ? task.args : '', task.error ?? ''].join(' ').toLowerCase()
}

export function searchTasks(tasks: TaskListEntry[], query: string): TaskListEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return tasks
  const terms = q.split(/\s+/)
  return tasks.filter(t => { const s = searchText(t); return terms.every(term => s.includes(term)) })
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'pending_approval': return 'warn'
    case 'pending': case 'running': return 'live'
    case 'completed': return 'success'
    case 'failed': return 'error'
    case 'denied': case 'cancelled': return 'muted'
    default: return 'text'
  }
}

export function isAwaitingApproval(task: TaskListEntry | undefined): task is TaskListEntry {
  return task?.status === 'pending_approval'
}

/** Umbilical events that may change this agent's task rows. */
export function isTaskEvent(event: UmbilicalEvent, agentId: string): boolean {
  if (event.agent_id !== agentId) return false
  const t = event.event_type
  return t.startsWith('hil.') || t.startsWith('task') || t === 'tool.completed' || t === 'tool.failed' || (t === 'loop.recovered' && event.payload?.reason === 'orphaned_tasks')
}

function row(key: string, value: string, tone: Tone = 'text'): Line {
  return [{ text: `  ${key.padEnd(12)}`, tone: 'key' }, { text: value, tone }]
}

function when(at: number | undefined, now: number): string {
  return at ? `${formatClock(at)} (${formatAgo(at, now)} ago)` : '-'
}

/** Detail view: everything the row carries. Values are redacted like every inspector value. */
export function taskDetailLines(task: TaskListEntry, now = Date.now()): Line[] {
  const out: Line[] = [heading(`Task ${task.id}`)]
  out.push(row('status', task.status, statusTone(task.status)))
  out.push(row('tool', task.tool, 'accent'))
  out.push(row('loop', taskLoop(task), 'loop'))
  out.push(row('origin', task.origin || '-'))
  out.push(row('created', when(task.created_at, now)))
  out.push(row(task.status === 'pending' || task.status === 'pending_approval' || task.status === 'running' ? 'updated' : 'finished', when(task.completed_at, now)))
  if (task.requires_authorization) out.push(row('authorized', 'required: only authorized code may resolve it', 'warn'))
  if (task.executor_managed) out.push(row('executor', 'a loop is waiting on this call', 'muted'))
  const meta = parseMaybeJson(task.approval_meta) as { reason?: string; protection?: { kind?: string; target?: string; level?: string; description?: string } } | undefined
  if (meta && typeof meta === 'object') {
    const p = meta.protection
    out.push(row('approval', meta.reason === 'protection' && p ? `protection override: ${p.description || `${p.kind ?? ''} ${p.target ?? ''} (${p.level ?? ''})`.trim()}` : meta.reason === 'restricted' ? 'restricted tool (needs your approval)' : String(meta.reason ?? '-')))
  }
  if (task.status === 'pending_approval') {
    const blocked = alwaysBlocked(task)
    out.push(row('always', blocked ? `not offered: ${blocked}` : 'available (a)', blocked ? 'muted' : 'text'))
  }
  const outcome = resolutionText(task)
  if (outcome) out.push(row('resolution', outcome, statusTone(task.status)))
  out.push(blank(), heading('Arguments'))
  out.push(...valueLines(parseTaskArgs(task.args), true))
  if (task.result !== undefined && task.result !== null) {
    out.push(blank(), heading('Result'))
    const parsed = parseMaybeJson(task.result)
    out.push(...(typeof parsed === 'string' ? parsed.split('\n').map(l => plain(l)) : valueLines(parsed, true)))
  }
  if (task.error) {
    out.push(blank(), heading(task.status === 'denied' ? 'Denied: feedback / reason' : 'Error'))
    out.push(...task.error.split('\n').map(l => plain(l, task.status === 'denied' ? 'warn' : 'error')))
  }
  return out
}

/** What the row says about how it ended (the daemon records the outcome, not who decided). */
export function resolutionText(task: TaskListEntry): string {
  switch (task.status) {
    case 'completed': return task.requires_authorization || task.approval_meta ? 'approved and ran' : 'ran'
    case 'denied': return task.error ? `rejected: ${task.error.replace(/\s+/g, ' ')}` : 'rejected'
    case 'cancelled': return 'cancelled (no decision, e.g. swept after a restart)'
    case 'failed': return 'failed'
    default: return ''
  }
}
