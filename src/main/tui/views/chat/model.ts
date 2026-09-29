// Pure helpers for the chat view: per-loop view state, row heights, trigger
// labels, loop-scoped HIL filters, @path mentions and the clipboard.

import { MAIN_LOOP, type AskEntry, type TaskEntry, type TaskListEntry, type Timer, type UmbilicalEvent } from '../../api/types'
import { isBusyState } from '../../state/reducer'
import { askQuestion, isAsyncInput } from '../../state/transcript'
import { transcriptKey, type AgentEntry, type LoopState, type ToolItem, type TranscriptItem } from '../../state/types'
import { parseBlocks } from '../../ui/Markdown'
import { displayWidth, formatEveryMs, oneLine, truncate, wrappedHeight } from '../../ui/text'

export const CHAT_VIEW = 'chat'

/** Where a loop's transcript is scrolled: the item at the viewport bottom + rows of it hidden below. */
export interface ScrollPos {
  bottomKey: string | null
  clip: number
}

/** A live runtime marker kept for the session (timer/trigger wake, inbox arrival). */
export interface Marker {
  id: string
  at: number
  text: string
}

export interface ChatState {
  /** Per transcript key. */
  scroll: Record<string, ScrollPos>
  selected: Record<string, string | null>
  /** `${transcriptKey}|${itemId}` → expanded. */
  expanded: Record<string, boolean>
  showThinking: boolean
  /** Last time each (agent, loop) was on screen, for unseen-activity dots. */
  seen: Record<string, number>
  markers: Record<string, Marker[]>
  /** Current / last turn per (agent, loop), from state + llm events. */
  turns: Record<string, TurnStats>
  /** Newest event digested per agent (seq + time, so a daemon restart's reset seq still counts). */
  digested: Record<string, { seq: number; at: number }>
}

export interface TurnStats {
  startedAt: number
  endedAt?: number
  input: number
  output: number
  calls: number
  model?: string
  /** Input tokens of the loop's latest LLM call (its context size then); kept across turns, dropped on compact / clear. */
  lastInput?: number
}

export const INITIAL_CHAT_STATE: ChatState = { scroll: {}, selected: {}, expanded: {}, showThinking: false, seen: {}, markers: {}, turns: {}, digested: {} }

export const FOLLOW: ScrollPos = { bottomKey: null, clip: 0 }

const MAX_MARKERS = 200

// --- loops --------------------------------------------------------------------

export interface LoopTab {
  name: string
  isMain: boolean
  enabled: boolean
  running: boolean
  goal?: string
}

export function loopTabs(agent: AgentEntry | undefined): LoopTab[] {
  const loops = agent?.loops
  if (!loops || loops.length === 0) {
    return [{ name: MAIN_LOOP, isMain: true, enabled: true, running: isBusyState(agent?.executorState) }]
  }
  return loops.map(loop => ({
    name: loop.info.name,
    isMain: loop.info.isMain || loop.info.name === MAIN_LOOP,
    enabled: loop.info.enabled,
    running: loopRunning(agent, loop),
    goal: loop.info.isMain ? undefined : loop.info.goal,
  }))
}

export function loopRunning(agent: AgentEntry | undefined, loop: LoopState | undefined): boolean {
  if (!agent) return false
  if (!loop || loop.info.isMain || loop.info.name === MAIN_LOOP) return isBusyState(agent.executorState)
  return loop.executorState !== undefined ? isBusyState(loop.executorState) : loop.info.status === 'running'
}

export function loopStateLabel(agent: AgentEntry | undefined, loop: LoopState | undefined, loopName: string): string {
  if (loop && !loop.info.enabled) return 'disabled'
  if (loopName === MAIN_LOOP) return agent?.executorState ?? agent?.status?.runtimeState ?? 'idle'
  return loop?.executorState ?? loop?.info.status ?? 'idle'
}

/** Next/previous loop name, wrapping. */
export function cycleLoop(tabs: LoopTab[], current: string, delta: number): string {
  if (tabs.length === 0) return current
  const at = Math.max(0, tabs.findIndex(t => t.name === current))
  return tabs[(at + delta + tabs.length) % tabs.length].name
}

// --- HIL ------------------------------------------------------------------------

/** Loop a task belongs to: `origin: 'loop:<name>'`, else main. */
export function taskLoop(task: TaskEntry): string {
  const m = typeof task.origin === 'string' ? task.origin.match(/^loop:([a-z0-9][a-z0-9_-]{0,31})$/) : null
  return m ? m[1] : MAIN_LOOP
}

export function pendingTasksFor(agent: AgentEntry | undefined, loop: string): TaskListEntry[] {
  return (agent?.pendingTasks ?? []).filter(task => task.status === 'pending_approval' && taskLoop(task) === loop)
}

/**
 * An ask belongs to the loop the daemon reports (`ask.loop`). Older daemons
 * omit it: then the loop whose transcript shows it, else main.
 */
export function pendingAsksFor(agent: AgentEntry | undefined, loop: string, transcripts: Record<string, { items: TranscriptItem[] }>): AskEntry[] {
  if (!agent) return []
  const owner = new Map<string, string>()
  for (const name of agent.loops?.map(l => l.info.name) ?? [MAIN_LOOP]) {
    const t = transcripts[transcriptKey(agent.summary.id, name)]
    for (const item of t?.items ?? []) if (item.kind === 'ask') owner.set(item.requestId, name)
  }
  return agent.pendingAsks.filter(ask => (ask.loop ?? owner.get(ask.requestId) ?? MAIN_LOOP) === loop)
}

export function parseArgs(args: string): unknown {
  try { return JSON.parse(args) } catch { return args }
}

// --- triggers & markers -----------------------------------------------------------

/** What woke the loop, from the runtime's trigger message prefixes. */
export function triggerLabel(text: string): string {
  const inbox = text.match(/^You received a message from agent "([^"]+)"/)
  if (inbox) return `inbox ${'·'} from ${inbox[1]}`
  if (text.startsWith('A scheduled timer has fired')) {
    const payload = text.match(/Payload: (.*)/)
    return payload ? `timer ${'·'} ${payload[1]}` : 'timer'
  }
  if (text.startsWith('[Inbox notification]')) return 'inbox'
  if (text.startsWith('The user has edited the document.')) return 'document edited'
  if (text.startsWith('A file has been ')) return `file ${text.slice('A file has been '.length).split('\n')[0]}`
  if (text.startsWith('An outbound message was sent')) return 'outbox'
  if (text.startsWith('A tool call has been intercepted') || text.startsWith('A tool call was intercepted')) return 'tool call intercepted'
  if (text.startsWith('A task has completed')) return 'task completed'
  if (text.startsWith('Agent started.')) return 'startup'
  if (text === 'Go.') return 'autonomous start'
  return 'runtime'
}

/** Owner-origin rows that are really runtime wakes the parser does not classify. */
export function isRuntimeText(text: string): boolean {
  return text.startsWith('Agent started. Review your mind')
}

export function describeSchedule(timer: Timer): string {
  const s = timer.schedule
  switch (s.mode) {
    case 'interval': return `every ${formatEveryMs(s.every_ms)}`
    case 'cron': return `cron ${s.cron}`
    case 'once': return 'once'
  }
}

/**
 * Runtime events that explain why a loop woke (or what arrived), as markers
 * for the transcript. A timer's loop comes from the event (`loop`, stamped by
 * loop-aware daemons), else from the timer list.
 */
export function markerFor(event: UmbilicalEvent, timers: Timer[]): { loop: string; marker: Marker } | null {
  const p = event.payload ?? {}
  const id = `ev:${event.agent_id ?? ''}:${event.seq}:${event.event_type}`
  const at = event.timestamp || Date.now()
  const evLoop = typeof event.loop === 'string' && event.loop ? event.loop : MAIN_LOOP
  switch (event.event_type) {
    case 'timer.fired': {
      const timer = timers.find(t => t.id === Number(p.timer_id))
      const loop = event.loop ? evLoop : timer?.loop ?? MAIN_LOOP
      const what = timer ? ` (${describeSchedule(timer)}${timer.payload ? `, "${oneLine(timer.payload).slice(0, 60)}"` : ''})` : ''
      return { loop, marker: { id, at, text: `Woken by timer${what} ${'·'} run ${String(p.run_count ?? '?')}` } }
    }
    case 'trigger.fired':
      if (p.scope === 'system') return null
      return { loop: evLoop, marker: { id, at, text: `Trigger fired: ${String(p.trigger_type ?? '?')}` } }
    case 'trigger.dropped':
      return { loop: evLoop, marker: { id, at, text: `Trigger dropped${p.trigger_type ? ` (${String(p.trigger_type)})` : ''}: ${String(p.reason ?? '?')}` } }
    case 'message.received':
      return { loop: evLoop, marker: { id, at, text: `Inbox: message from ${String(p.from ?? '?')}${typeof p.size === 'number' ? ` (${p.size} B)` : ''}` } }
    default:
      return null
  }
}

export type TimerLookup = (agentId: string, timerId: number) => Timer | 'unknown' | 'wait'

/**
 * Fold new events into markers + turn stats. Stops early (returning
 * `waiting`) at a timer.fired whose timer the view has not fetched yet, so the
 * marker lands in the timer's loop once the list arrives.
 */
export function digestEvents(state: ChatState, events: UmbilicalEvent[], lookup: TimerLookup): { next: ChatState; waiting: boolean } {
  let next = state
  const edit = <K extends keyof ChatState>(field: K, value: ChatState[K]) => { next = { ...next, [field]: value } }
  for (const event of events) {
    const agentId = event.agent_id
    if (!agentId) continue
    const at = event.timestamp || 0
    const last = next.digested[agentId]
    if (last && event.seq <= last.seq && at <= last.at) continue
    const loop = typeof event.loop === 'string' && event.loop ? event.loop : MAIN_LOOP
    let timers: Timer[] = []
    if (event.event_type === 'timer.fired') {
      const found = lookup(agentId, Number(event.payload?.timer_id))
      if (found === 'wait' && !event.loop) return { next, waiting: true }
      if (found !== 'unknown' && found !== 'wait') timers = [found]
    }
    const marked = markerFor(event, timers)
    if (marked) {
      const key = transcriptKey(agentId, marked.loop)
      edit('markers', { ...next.markers, [key]: appendMarker(next.markers[key], marked.marker) })
    }
    const key = transcriptKey(agentId, loop)
    const turn = next.turns[key]
    const p = event.payload ?? {}
    switch (event.event_type) {
      case 'agent.state.changed': {
        const busy = isBusyState(typeof p.state === 'string' ? p.state : undefined)
        if (busy && (!turn || turn.endedAt !== undefined)) edit('turns', { ...next.turns, [key]: { startedAt: at, input: 0, output: 0, calls: 0, ...(turn?.lastInput !== undefined ? { lastInput: turn.lastInput } : {}) } })
        else if (!busy && turn && turn.endedAt === undefined) edit('turns', { ...next.turns, [key]: { ...turn, endedAt: at } })
        break
      }
      case 'llm.completed': {
        const base = turn ?? { startedAt: at, endedAt: at, input: 0, output: 0, calls: 0 }
        edit('turns', {
          ...next.turns,
          [key]: {
            ...base,
            input: base.input + num(p.input_tokens),
            output: base.output + num(p.output_tokens),
            calls: base.calls + 1,
            model: typeof p.model === 'string' ? p.model : base.model,
            ...(num(p.input_tokens) > 0 ? { lastInput: num(p.input_tokens) } : {}),
          },
        })
        break
      }
      case 'loop.compacted':
      case 'loop.cleared':
        if (turn?.lastInput !== undefined) {
          const { lastInput: _dropped, ...rest } = turn
          edit('turns', { ...next.turns, [key]: rest })
        }
        break
      case 'turn.completed':
        if (turn && turn.endedAt === undefined) edit('turns', { ...next.turns, [key]: { ...turn, endedAt: at } })
        break
    }
    edit('digested', { ...next.digested, [agentId]: { seq: event.seq, at } })
  }
  return { next, waiting: false }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function appendMarker(list: Marker[] | undefined, marker: Marker): Marker[] {
  const current = list ?? []
  if (current.some(m => m.id === marker.id)) return current
  const next = [...current, marker]
  return next.length > MAX_MARKERS ? next.slice(next.length - MAX_MARKERS) : next
}

/** Transcript items with markers merged in by time. */
export function withMarkers(items: TranscriptItem[], markers: Marker[] | undefined): TranscriptItem[] {
  if (!markers || markers.length === 0) return items
  const extra: TranscriptItem[] = markers.map(m => ({ id: m.id, at: m.at, local: true, kind: 'notice', level: 'info', text: m.text, event: 'marker' }))
  const out: TranscriptItem[] = []
  let j = 0
  for (const item of items) {
    while (j < extra.length && extra[j].at < item.at) out.push(extra[j++])
    out.push(item)
  }
  while (j < extra.length) out.push(extra[j++])
  return out
}

// --- queued messages -------------------------------------------------------------

/**
 * Owner messages sent while the loop was busy and not yet taken up by a turn.
 * A message with a turnId is queued until a turn carrying that id starts
 * (daemon turn correlation); without one (older daemon) until a turn starts after it was sent.
 */
export function queuedItems(items: TranscriptItem[], running: boolean, turnStartedAt: number | null): TranscriptItem[] {
  if (!running || turnStartedAt === null) return []
  return items.filter(item => item.kind === 'user' && item.pending && !item.answered
    && (item.turnId ? !item.taken : item.at > turnStartedAt))
}

// --- heights ------------------------------------------------------------------------

export interface RenderFlags {
  expanded: boolean
  showThinking: boolean
}

export function markdownHeight(text: string, width: number): number {
  let rows = 0
  for (const block of parseBlocks(text)) {
    switch (block.kind) {
      case 'para': rows += wrappedHeight(block.text, width); break
      case 'heading': rows += wrappedHeight(block.text, width); break
      case 'code': rows += (block.lang ? 1 : 0) + block.lines.reduce((n, l) => n + wrappedHeight(l || ' ', Math.max(4, width - 2)), 0); break
      case 'list': rows += block.items.reduce((n, it) => n + wrappedHeight(it.text, Math.max(4, width - 2 - it.indent * 2)), 0); break
      case 'quote': rows += wrappedHeight(block.text, Math.max(4, width - 2)); break
      default: rows += 1
    }
  }
  return Math.max(1, rows)
}

export const EXPANDED_TOOL_LINES = 400

// --- tool presentation (Studio AgentLoop parity) -------------------------------------

/** At most `max` lines of `text`, and how many were cut. */
export function capLines(text: string, max: number): { text: string; more: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, more: 0 }
  return { text: lines.slice(0, max).join('\n'), more: lines.length - max }
}

/** An async call's task reference, when its real result has replaced it (shown as its own section). */
export function shownTaskRef(item: ToolItem): string | undefined {
  return item.taskRef !== undefined && item.taskRef !== item.result ? item.taskRef : undefined
}

/** Runtime flags on a call's input: shown in the expanded input, never in the one-line args preview. */
const TOOL_FLAGS = ['_reason', '_async'] as const

function inputRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
}

/** Why the agent made the call (`_reason`), trimmed; '' when absent. */
export function toolReason(item: ToolItem): string {
  const raw = inputRecord(item.input)?._reason
  if (raw === undefined || raw === null) return ''
  return oneLine(typeof raw === 'string' ? raw : String(raw))
}

/** The call ran in the background (`_async: true` on the input, or a task-reference result). */
export function isAsyncTool(item: ToolItem): boolean {
  return !!item.async || isAsyncInput(item.input)
}

/** Input without `_reason` / `_async`, for the collapsed args preview. */
export function toolArgs(input: unknown): unknown {
  const record = inputRecord(input)
  if (!record) return input
  const rest = { ...record }
  for (const flag of TOOL_FLAGS) delete rest[flag]
  return rest
}

/**
 * How a tool item renders: `say` as an assistant message, `ask` as the ask
 * card, a successful `sys_set_meta status` / `sys_set_state` as a one-line
 * status, everything else as a tool row.
 */
export type ToolView = 'say' | 'ask' | 'status' | 'row'

export function toolView(item: ToolItem): ToolView {
  if (item.name === 'say') return 'say'
  if (item.name === 'ask') return 'ask'
  if (item.status === 'ok' && statusLineText(item)) return 'status'
  return 'row'
}

/** The text a `say` call shows: its message, else its input. */
export function sayText(item: ToolItem): string {
  const message = inputRecord(item.input)?.message
  return typeof message === 'string' ? message : prettyJson(item.input)
}

/** The owner's answer inside an `ask` call's result. */
export function askAnswer(item: ToolItem): string | undefined {
  if (item.result === undefined) return undefined
  return item.result.startsWith('Human answered: ') ? item.result.slice('Human answered: '.length) : item.result
}

/** `status · <value>` for sys_set_meta key=status, `state → <state>` for sys_set_state; '' otherwise. */
export function statusLineText(item: ToolItem, sep = '·', arrow = '→'): string {
  const input = inputRecord(item.input)
  if (!input) return ''
  if (item.name === 'sys_set_meta' && input.key === 'status' && typeof input.value === 'string' && input.value.trim()) return `status ${sep} ${oneLine(input.value)}`
  if (item.name === 'sys_set_state' && typeof input.state === 'string' && input.state.trim()) return `state ${arrow} ${input.state.trim()}`
  return ''
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/** Rows an item takes at `width` (the view's inner width, gutter included). */
export function itemHeight(item: TranscriptItem, width: number, flags: RenderFlags): number {
  const w = Math.max(8, width - 3)
  switch (item.kind) {
    case 'user':
      if (item.origin === 'loop') return 1 + markdownHeight(item.text, w - 2) + 1
      if (item.origin === 'runtime' || isRuntimeText(item.text)) return (flags.expanded ? 1 + wrappedHeight(item.text, w - 2) : 1) + 1
      return wrappedHeight(item.text, w) + 1
    case 'assistant':
      return markdownHeight(item.text || ' ', w) + 1
    case 'thinking':
      return (flags.expanded || flags.showThinking ? 1 + wrappedHeight(item.text || ' ', w - 2) : 1) + 1
    case 'tool': {
      const view = toolView(item)
      if (flags.expanded && isExpandable(item)) {
        // Sections are indented 2 + 2 columns inside the body.
        const cap = (text: string) => {
          const capped = capLines(text, EXPANDED_TOOL_LINES)
          return wrappedHeight(capped.text, w - 2) + (capped.more ? 1 : 0)
        }
        const input = prettyJson(item.input)
        const ref = shownTaskRef(item)
        return 1 + (input ? 1 + cap(input) : 0) + (ref !== undefined ? 1 + cap(ref || ' ') : 0) + (item.result !== undefined ? 1 + cap(item.result || ' ') : 0) + 1
      }
      switch (view) {
        case 'say': return markdownHeight(sayText(item) || ' ', w) + (item.status === 'error' ? 1 : 0) + 1
        case 'ask': return 1 + wrappedHeight(askQuestion(item.input) || ' ', w) + (item.result !== undefined ? 1 : 0) + 1
        case 'status': return 1 + 1
        case 'row': return 1 + (item.result !== undefined ? 1 : 0) + 1
      }
      return 2
    }
    case 'hil':
      return 2 + (item.reason ? 1 : 0) + (item.feedback ? 1 : 0) + (flags.expanded ? wrappedHeight(prettyJson(item.input), w - 4) : 0) + 1
    case 'ask':
      // Left border + 1 padding inside the body: the text gets `w` columns.
      return 1 + wrappedHeight(item.question || ' ', w) + (item.answer ? 1 : 0) + 1
    case 'notice':
      return 1
    case 'context':
      return flags.expanded ? 1 + wrappedHeight(item.text || ' ', w - 2) + 1 : 1
    case 'error':
      return wrappedHeight(item.text, w - 2) + 1
  }
}

export function isExpandable(item: TranscriptItem): boolean {
  switch (item.kind) {
    case 'tool':
      // A say is a message; only a failed one has details to open.
      return toolView(item) !== 'say' || item.status === 'error'
    case 'thinking':
    case 'context':
    case 'hil':
      return true
    case 'user':
      return item.origin === 'runtime' || isRuntimeText(item.text)
    default:
      return false
  }
}

/** Plain text of an item, for copying. */
export function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'tool':
      switch (toolView(item)) {
        case 'say': return sayText(item)
        case 'ask': {
          const answer = askAnswer(item)
          return answer ? `${askQuestion(item.input)}\n\n${answer}` : askQuestion(item.input)
        }
        default: return [`${item.name} ${prettyJson(item.input)}`, item.result ?? ''].filter(Boolean).join('\n\n')
      }
    case 'hil': return `${item.tool} ${prettyJson(item.input)}`
    case 'ask': return item.answer ? `${item.question}\n\n${item.answer}` : item.question
    default: return item.text
  }
}

export function lastReply(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'assistant' && item.text.trim()) return item.text
    if (item.kind === 'tool' && item.name === 'say' && sayText(item).trim()) return sayText(item)
  }
  return undefined
}

// --- scrolling --------------------------------------------------------------------

export function offsetOf(pos: ScrollPos | undefined, keys: string[], heights: number[]): number {
  if (!pos || pos.bottomKey === null) return 0
  const at = keys.indexOf(pos.bottomKey)
  if (at < 0) return 0
  let below = 0
  for (let i = at + 1; i < heights.length; i++) below += heights[i]
  return below + Math.max(0, Math.min(pos.clip, heights[at] - 1))
}

export function posAt(offset: number, keys: string[], heights: number[], viewport: number): ScrollPos {
  const total = heights.reduce((a, b) => a + b, 0)
  const clamped = Math.max(0, Math.min(offset, total - viewport))
  if (clamped <= 0) return FOLLOW
  let acc = 0
  for (let i = heights.length - 1; i >= 0; i--) {
    if (acc + heights[i] > clamped) return { bottomKey: keys[i], clip: clamped - acc }
    acc += heights[i]
  }
  return { bottomKey: keys[0] ?? null, clip: 0 }
}

export interface Window {
  start: number
  end: number
  clip: number
  hiddenAbove: boolean
  offset: number
  total: number
}

/** Which items fill a viewport of `height` rows at `offset` rows up from the bottom. */
export function windowAt(heights: number[], offset: number, height: number): Window {
  const total = heights.reduce((a, b) => a + b, 0)
  if (heights.length === 0) return { start: 0, end: -1, clip: 0, hiddenAbove: false, offset: 0, total }
  let acc = 0
  let end = heights.length - 1
  while (end > 0 && acc + heights[end] <= offset) { acc += heights[end]; end-- }
  const clip = Math.max(0, Math.min(offset - acc, heights[end] - 1))
  let rows = heights[end] - clip
  let start = end
  while (start > 0 && rows < height) { start--; rows += heights[start] }
  return { start, end, clip, hiddenAbove: start > 0 || rows > height, offset, total }
}

/** Scroll so item `index` is visible (its top when it is taller than the viewport). */
export function revealOffset(index: number, heights: number[], offset: number, viewport: number): number {
  let below = 0
  for (let i = index + 1; i < heights.length; i++) below += heights[i]
  const top = below + heights[index]
  if (below < offset) return below
  if (top > offset + viewport) return Math.min(below, top - viewport)
  return offset
}

/** Where ↑/↓ item navigation lands. */
export interface NavResult {
  /** The item to select; 'follow' = past the newest item (back to the live end, no selection). */
  index: number | 'follow'
  offset: number
  /** Moved up past the oldest loaded item: page in older history. */
  loadOlder?: boolean
}

/**
 * ↑/↓ over transcript items (`dir` -1 = up / older, +1 = down / newer).
 * A selected item taller than the viewport scrolls by `step` rows inside
 * itself first; only once its edge is on screen does the selection move to
 * the neighbour. Moving up into a tall item shows its bottom, moving down its
 * top. With nothing selected, ↑ picks the newest item on screen and ↓ goes
 * back to the live end. `offset` counts rows hidden below the viewport.
 */
export function navigate(heights: number[], selected: number, offset: number, viewport: number, dir: -1 | 1, step: number, visibleEnd = heights.length - 1): NavResult {
  const n = heights.length
  if (n === 0) return { index: 'follow', offset: 0 }
  const total = heights.reduce((a, b) => a + b, 0)
  const clamp = (value: number) => Math.max(0, Math.min(value, Math.max(0, total - viewport)))
  const below = (i: number) => { let sum = 0; for (let j = i + 1; j < n; j++) sum += heights[j]; return sum }
  const place = (i: number, up: boolean): number => {
    const bottom = below(i)
    const top = bottom + heights[i]
    if (heights[i] > viewport) return clamp(up ? bottom : top - viewport)
    if (bottom < offset) return clamp(bottom)
    if (top > offset + viewport) return clamp(top - viewport)
    return offset
  }
  if (selected < 0 || selected >= n) {
    if (dir > 0) return { index: 'follow', offset: 0 }
    const i = Math.max(0, Math.min(n - 1, visibleEnd))
    return { index: i, offset: place(i, true) }
  }
  const bottom = below(selected)
  const top = bottom + heights[selected]
  if (dir < 0) {
    // Scroll up inside the selected item while its top is above the viewport.
    if (top > offset + viewport) return { index: selected, offset: clamp(Math.min(top - viewport, offset + step)) }
    if (selected === 0) return { index: 0, offset, loadOlder: true }
    return { index: selected - 1, offset: place(selected - 1, true) }
  }
  if (bottom < offset) return { index: selected, offset: clamp(Math.max(bottom, offset - step)) }
  if (selected >= n - 1) return { index: 'follow', offset: 0 }
  return { index: selected + 1, offset: place(selected + 1, false) }
}

/** The item a viewport row shows (row 0 = top of the viewport), or -1. */
export function itemAtRow(heights: number[], offset: number, viewport: number, row: number): number {
  if (row < 0 || row >= viewport) return -1
  // Rows counted up from the bottom of the content.
  let fromBottom = offset + (viewport - 1 - row)
  for (let i = heights.length - 1; i >= 0; i--) {
    if (fromBottom < heights[i]) return i
    fromBottom -= heights[i]
  }
  return -1
}

// --- @path mentions -----------------------------------------------------------------

/** The `@partial` token ending at the cursor, if any. */
export function mentionAt(value: string, cursor = value.length): { start: number; partial: string } | null {
  const before = value.slice(0, cursor)
  const m = before.match(/(^|\s)@([^\s@]*)$/)
  if (!m) return null
  return { start: before.length - m[2].length - 1, partial: m[2] }
}

/** Agent file paths matching `partial` (prefix first, then substring), capped. */
export function completeMention(partial: string, paths: string[], limit = 8): string[] {
  const p = partial.toLowerCase()
  const prefix = paths.filter(path => path.toLowerCase().startsWith(p))
  const inner = paths.filter(path => !path.toLowerCase().startsWith(p) && path.toLowerCase().includes(p))
  return [...prefix, ...inner].slice(0, limit)
}

/** Replace the mention at the cursor with `@path `. */
export function applyMention(value: string, cursor: number, path: string): { value: string; cursor: number } {
  const m = mentionAt(value, cursor)
  if (!m) return { value, cursor }
  const next = `${value.slice(0, m.start)}@${path} ${value.slice(cursor)}`
  return { value: next, cursor: m.start + path.length + 2 }
}

// --- clipboard (app/clipboard.ts; re-exported for existing callers) --------------------

export { copyToClipboard, setClipboardWriter } from '../../app/clipboard'

// --- the info line under the loop tabs --------------------------------------------

/** One piece of the chat info line. Lower `priority` survives a narrow pane; `order` is where it shows. */
export interface InfoSegment {
  key: string
  text: string
  order: number
  priority: number
  /** May be cut (with an ellipsis) to what is left, down to `INFO_FLEX_MIN` columns. */
  flex?: boolean
}

export const INFO_FLEX_MIN = 12

/** Keep the most important segments that fit `width` (joined by a 3-column separator), shown in `order`. */
export function fitInfoSegments(segments: InfoSegment[], width: number, sepWidth = 3): InfoSegment[] {
  const kept: InfoSegment[] = []
  let used = 0
  for (const seg of [...segments].sort((a, b) => a.priority - b.priority)) {
    const gap = kept.length ? sepWidth : 0
    const w = displayWidth(seg.text)
    if (used + gap + w <= width) { kept.push(seg); used += gap + w; continue }
    const room = width - used - gap
    if (seg.flex && room >= INFO_FLEX_MIN) { kept.push({ ...seg, text: truncate(seg.text, room) }); used += gap + room }
  }
  return kept.sort((a, b) => a.order - b.order)
}

/** `14:30` today, `Tue 14:30` within a week, else `3 Oct 14:30`. */
export function formatNextFire(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date(now).toDateString()) return hm
  if (at > now && at - now < 6 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${hm}`
}

/** `wakes every 1h · next 14:30` for a loop's live timers (no timer ids: the Timers tab has those). */
export function wakesText(timers: Timer[], now = Date.now(), sep = '·'): string {
  const live = timers.filter(t => !t.expired)
  if (!live.length) return ''
  const schedules = [...new Set(live.map(describeSchedule))].join(', ')
  const next = Math.min(...live.map(t => t.next_wake_at).filter(n => Number.isFinite(n) && n > 0))
  return `wakes ${schedules}${Number.isFinite(next) ? ` ${sep} next ${formatNextFire(next, now)}` : ''}`
}
