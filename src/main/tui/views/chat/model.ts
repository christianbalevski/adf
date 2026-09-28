// Pure helpers for the chat view: per-loop view state, row heights, trigger
// labels, loop-scoped HIL filters, @path mentions and the clipboard.

import { spawn } from 'node:child_process'
import { MAIN_LOOP, type AskEntry, type TaskEntry, type Timer, type UmbilicalEvent } from '../../api/types'
import { isBusyState } from '../../state/reducer'
import { transcriptKey, type AgentEntry, type LoopState, type TranscriptItem } from '../../state/types'
import { parseBlocks } from '../../ui/Markdown'
import { formatEveryMs, oneLine, wrappedHeight } from '../../ui/text'

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

export function pendingTasksFor(agent: AgentEntry | undefined, loop: string): TaskEntry[] {
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
      return { loop, marker: { id, at, text: `Woken by timer #${String(p.timer_id ?? '?')}${what} ${'·'} run ${String(p.run_count ?? '?')}` } }
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
        if (busy && (!turn || turn.endedAt !== undefined)) edit('turns', { ...next.turns, [key]: { startedAt: at, input: 0, output: 0, calls: 0 } })
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
          },
        })
        break
      }
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

/** Owner messages sent while the loop was busy and not yet taken up by a turn. */
export function queuedItems(items: TranscriptItem[], running: boolean, turnStartedAt: number | null): TranscriptItem[] {
  if (!running || turnStartedAt === null) return []
  return items.filter(item => item.kind === 'user' && item.pending && item.at > turnStartedAt)
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
      if (!flags.expanded) return 1 + (item.result !== undefined ? 1 : 0) + 1
      const input = prettyJson(item.input)
      const result = item.result ?? ''
      const cap = (text: string) => Math.min(EXPANDED_TOOL_LINES + 1, wrappedHeight(text, w - 4))
      return 1 + (input ? 1 + cap(input) : 0) + (item.result !== undefined ? 1 + cap(result || ' ') : 0) + 1
    }
    case 'hil':
      return 2 + (item.reason ? 1 : 0) + (item.feedback ? 1 : 0) + (flags.expanded ? wrappedHeight(prettyJson(item.input), w - 4) : 0) + 1
    case 'ask':
      return 1 + wrappedHeight(item.question || ' ', w - 2) + (item.answer ? 1 : 0) + 1
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
    case 'tool': return [`${item.name} ${prettyJson(item.input)}`, item.result ?? ''].filter(Boolean).join('\n\n')
    case 'hil': return `${item.tool} ${prettyJson(item.input)}`
    case 'ask': return item.answer ? `${item.question}\n\n${item.answer}` : item.question
    default: return item.text
  }
}

export function lastReply(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'assistant' && item.text.trim()) return item.text
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

// --- clipboard ---------------------------------------------------------------------

type ClipboardWriter = (text: string) => Promise<boolean>

function pipeTo(command: string, args: string[], data: Buffer): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', code => resolve(code === 0))
      child.stdin.end(data)
    } catch {
      resolve(false)
    }
  })
}

const systemClipboard: ClipboardWriter = async text => {
  if (process.platform === 'win32') {
    // clip.exe reads UTF-16LE with a BOM losslessly.
    return pipeTo('clip', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  }
  const data = Buffer.from(text, 'utf8')
  if (process.platform === 'darwin') return pipeTo('pbcopy', [], data)
  for (const [cmd, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]] as const) {
    if (await pipeTo(cmd, [...args], data)) return true
  }
  return false
}

let clipboardWriter: ClipboardWriter = systemClipboard

/** Tests swap the clipboard for a recorder. */
export function setClipboardWriter(writer: ClipboardWriter | null): void {
  clipboardWriter = writer ?? systemClipboard
}

export function copyToClipboard(text: string): Promise<boolean> {
  return clipboardWriter(text)
}
