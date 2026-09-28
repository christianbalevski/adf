// Pure transcript model: persisted loop rows + live umbilical events → items.
//
// History (GET /agents/:id/loop) is authoritative for what the loop contains;
// live events fill in what has not been persisted yet (streaming text, running
// tools, HIL, asks, runtime notices). `mergeHistory` reconciles the two after a
// refetch without dropping anything the user has not seen persisted.

import * as loopParserNs from '../../../shared/utils/loop-parser'
import type { LoopEntry, UmbilicalEvent } from '../api/types'
import { cjs } from '../interop'
import type { AssistantItem, ThinkingItem, ToolItem, Transcript, TranscriptItem } from './types'

/** Local items kept per transcript before the oldest are dropped (history refetch restores them). */
export const MAX_TRANSCRIPT_ITEMS = 2000

const { parseLoopToDisplay } = cjs(loopParserNs)

let localCounter = 0

export function localId(prefix = 'l'): string {
  localCounter += 1
  return `${prefix}:${Date.now().toString(36)}:${localCounter}`
}

export function emptyTranscript(): Transcript {
  return { items: [], loaded: false, loading: false, total: 0, oldestOffset: 0, live: false }
}

/** The call asked to run in the background (`_async: true`, or the string the runtime also accepts). */
export function isAsyncInput(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const flag = (input as Record<string, unknown>)._async
  return flag === true || flag === 'true'
}

/** The immediate result of a backgrounded call: `{"task_id":…,"status":"running"|"pending_approval",…}`. */
export function isTaskRef(text: string | undefined): boolean {
  if (!text || !text.startsWith('{') || !text.includes('task_id')) return false
  try {
    const value = JSON.parse(text) as { task_id?: unknown; status?: unknown }
    return typeof value.task_id === 'string' && (value.status === 'running' || value.status === 'pending_approval')
  } catch {
    return false
  }
}

/** The question of an `ask` call's input. */
export function askQuestion(input: unknown): string {
  const q = input && typeof input === 'object' ? (input as { question?: unknown }).question : undefined
  return typeof q === 'string' ? q : ''
}

/** Persisted loop rows → transcript items, via the same parser Studio renders with. */
export function historyToItems(entries: LoopEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const toolsById = new Map<string, ToolItem>()
  for (const entry of parseLoopToDisplay(entries)) {
    const meta = entry.metadata ?? {}
    const base = { id: `h:${entry.id}`, at: entry.timestamp, seq: typeof meta.seq === 'number' ? meta.seq : undefined }
    switch (entry.type) {
      case 'user':
        items.push({ ...base, kind: 'user', text: entry.content, origin: 'owner' })
        break
      case 'trigger':
        items.push({ ...base, kind: 'user', text: entry.content, origin: 'runtime' })
        break
      case 'context':
        if (meta.category === 'loop' && typeof meta.fromLoop === 'string') {
          items.push({ ...base, kind: 'user', text: entry.content, origin: 'loop', from: meta.fromLoop })
        } else {
          items.push({ ...base, kind: 'context', category: String(meta.category ?? 'context'), text: entry.content })
        }
        break
      case 'compaction':
        items.push({ ...base, kind: 'context', category: 'compaction', text: entry.content })
        break
      case 'error':
        items.push({ ...base, kind: 'error', text: entry.content })
        break
      case 'text':
        items.push({ ...base, kind: 'assistant', text: entry.content, streaming: false, model: typeof meta.model === 'string' ? meta.model : undefined })
        break
      case 'thinking':
        items.push({ ...base, kind: 'thinking', text: entry.content, streaming: false })
        break
      case 'tool_call': {
        const tool: ToolItem = {
          ...base,
          kind: 'tool',
          toolUseId: typeof meta.tool_id === 'string' ? meta.tool_id : undefined,
          name: typeof meta.name === 'string' ? meta.name : 'tool',
          input: meta.input,
          status: 'running',
          ...(isAsyncInput(meta.input) ? { async: true } : {}),
        }
        if (tool.toolUseId) toolsById.set(tool.toolUseId, tool)
        items.push(tool)
        break
      }
      case 'tool_result': {
        const useId = typeof meta.tool_use_id === 'string' ? meta.tool_use_id : undefined
        const call = useId ? toolsById.get(useId) : undefined
        const status = meta.isError ? 'error' : 'ok'
        if (call) {
          call.status = status
          call.result = entry.content
          call.completedAt = entry.timestamp
          // A backgrounded call's row holds only the task reference; the real
          // result arrives later as tool.completed with the same tool_use id.
          if (!meta.isError && isTaskRef(entry.content)) {
            call.async = true
            call.taskRef = entry.content
          }
        } else {
          items.push({ ...base, kind: 'tool', toolUseId: useId, name: typeof meta.name === 'string' ? meta.name : 'tool', input: undefined, status, result: entry.content, completedAt: entry.timestamp })
        }
        break
      }
    }
  }
  return items
}

/**
 * Reconcile a fresh history page with what is on screen. History wins for
 * anything it contains; local items survive until history shows them
 * (optimistic sends, streaming text, running tools) or forever when history
 * never will (HIL, asks, notices, local errors).
 */
export function mergeHistory(existing: TranscriptItem[], incoming: TranscriptItem[]): TranscriptItem[] {
  // A backgrounded call's persisted result is only its task reference. The
  // real result came live (tool.completed with the same tool_use id) and is
  // not in the loop, so it is carried over instead of reverting to the ref.
  const finished = new Map<string, ToolItem>()
  for (const item of existing) {
    if (item.kind === 'tool' && item.toolUseId && item.status !== 'running' && item.result !== undefined) finished.set(item.toolUseId, item)
  }
  const history = incoming.map(item => {
    if (item.kind !== 'tool' || item.taskRef === undefined || !item.toolUseId) return item
    const live = finished.get(item.toolUseId)
    if (!live || live.result === item.taskRef) return item
    return { ...item, status: live.status, result: live.result, completedAt: live.completedAt }
  })
  const historyTools = new Set<string>()
  const historyTexts = new Map<string, number>()
  const countText = (key: string) => historyTexts.set(key, (historyTexts.get(key) ?? 0) + 1)
  for (const item of history) {
    if (item.kind === 'tool' && item.toolUseId) historyTools.add(item.toolUseId)
    if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'thinking') countText(`${item.kind}:${item.text.trim()}`)
    // An `ask` call in history shows its question; the live ask card for it goes.
    if (item.kind === 'tool' && item.name === 'ask') countText(`ask:${askQuestion(item.input).trim()}`)
  }
  const consume = (key: string): boolean => {
    const n = historyTexts.get(key) ?? 0
    if (n <= 0) return false
    historyTexts.set(key, n - 1)
    return true
  }
  const keep = existing.filter(item => {
    if (!item.local) return false
    switch (item.kind) {
      case 'tool':
        return !(item.toolUseId && historyTools.has(item.toolUseId))
      case 'user':
      case 'assistant':
      case 'thinking':
        return !consume(`${item.kind}:${item.text.trim()}`)
      case 'context':
        return false
      case 'ask':
        return !consume(`ask:${item.question.trim()}`)
      default:
        return true
    }
  })
  return sortByTime([...history, ...keep])
}

/**
 * Prepend an older history page, skipping rows already present. Pages are cut
 * by row count, so a tool call can land on the older page and its result on
 * the newer one: the result (shown on its own) is folded back into the call.
 */
export function prependHistory(existing: TranscriptItem[], older: TranscriptItem[]): TranscriptItem[] {
  const ids = new Set(existing.map(item => item.id))
  const orphans = new Map<string, ToolItem>()
  for (const item of existing) {
    if (item.kind === 'tool' && !item.local && item.toolUseId && item.status !== 'running') orphans.set(item.toolUseId, item)
  }
  const merged = new Set<TranscriptItem>()
  const page = older.filter(item => !ids.has(item.id)).map(item => {
    if (item.kind !== 'tool' || item.status !== 'running' || !item.toolUseId) return item
    const result = orphans.get(item.toolUseId)
    if (!result) return item
    merged.add(result)
    return { ...item, status: result.status, result: result.result, completedAt: result.completedAt }
  })
  return [...page, ...(merged.size ? existing.filter(item => !merged.has(item)) : existing)]
}

function sortByTime(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.at - b.item.at) || (a.index - b.index))
    .map(entry => entry.item)
}

export function finalizeStreaming(items: TranscriptItem[]): TranscriptItem[] {
  let changed = false
  const next = items.map(item => {
    if ((item.kind === 'assistant' || item.kind === 'thinking') && item.streaming) {
      changed = true
      return { ...item, streaming: false }
    }
    return item
  })
  return changed ? next : items
}

function cap(items: TranscriptItem[]): TranscriptItem[] {
  return items.length > MAX_TRANSCRIPT_ITEMS ? items.slice(items.length - MAX_TRANSCRIPT_ITEMS) : items
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function resultText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'content' in value) {
    const content = (value as { content?: unknown }).content
    return typeof content === 'string' ? content : content === undefined ? undefined : JSON.stringify(content)
  }
  return value === undefined ? undefined : JSON.stringify(value)
}

/**
 * Apply one live event to a transcript's items. Returns the same array when
 * the event does not touch the transcript.
 */
export function applyEventToItems(items: TranscriptItem[], event: UmbilicalEvent): TranscriptItem[] {
  const p = event.payload ?? {}
  const at = event.timestamp || Date.now()
  switch (event.event_type) {
    case 'turn.delta': {
      const kind = p.kind === 'thinking' ? 'thinking' : 'assistant'
      const text = str(p.text) ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === kind && last.streaming) {
        const next = items.slice()
        next[next.length - 1] = { ...last, text: last.text + text }
        return next
      }
      const closed = finalizeStreaming(items)
      const item: AssistantItem | ThinkingItem = kind === 'thinking'
        ? { id: localId(), at, local: true, kind: 'thinking', text, streaming: true }
        : { id: localId(), at, local: true, kind: 'assistant', text, streaming: true }
      return cap([...closed, item])
    }
    case 'tool.started': {
      const toolUseId = str(p.id)
      if (toolUseId && items.some(item => item.kind === 'tool' && item.toolUseId === toolUseId)) return items
      const tool: ToolItem = { id: localId(), at, local: true, kind: 'tool', toolUseId, name: str(p.name) ?? 'tool', input: p.input, status: 'running' }
      if (tool.name === 'ask') {
        // The runtime emits an ask's tool.* pair once it is answered; the ask
        // card (ask.requested) becomes that call in place, as history shows it.
        const question = askQuestion(p.input).trim()
        let card = -1
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]
          if (item.kind === 'ask' && item.question.trim() === question) { card = i; break }
        }
        if (card >= 0) {
          const next = items.slice()
          next[card] = { ...tool, id: items[card].id, at: items[card].at }
          return next
        }
      }
      return cap([...finalizeStreaming(items), tool])
    }
    case 'tool.completed':
    case 'tool.failed': {
      const toolUseId = str(p.id)
      const name = str(p.name)
      let index = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind !== 'tool') continue
        if (toolUseId ? item.toolUseId === toolUseId : item.status === 'running' && item.name === name) {
          index = i
          break
        }
      }
      const failed = event.event_type === 'tool.failed' || p.isError === true
      const patch = { status: failed ? 'error' as const : 'ok' as const, result: resultText(p.result), completedAt: at }
      if (index < 0) {
        return cap([...items, { id: localId(), at, local: true, kind: 'tool', toolUseId, name: name ?? 'tool', input: p.input, ...patch }])
      }
      const next = items.slice()
      next[index] = { ...(next[index] as ToolItem), ...patch }
      return next
    }
    case 'turn.completed': {
      const closed = finalizeStreaming(items)
      const content = str(p.content)?.trim()
      if (!content) return closed
      let lastUser = -1
      for (let i = closed.length - 1; i >= 0; i--) if (closed[i].kind === 'user') { lastUser = i; break }
      const answered = closed.slice(lastUser + 1).some(item => item.kind === 'assistant')
      if (answered) return closed
      return cap([...closed, { id: localId(), at, local: true, kind: 'assistant', text: content, streaming: false }])
    }
    case 'hil.requested': {
      const taskId = str(p.task_id) ?? str(p.request_id)
      if (!taskId || items.some(item => item.kind === 'hil' && item.taskId === taskId)) return items
      return cap([...finalizeStreaming(items), { id: localId(), at, local: true, kind: 'hil', taskId, tool: str(p.tool) ?? 'tool', input: p.input, reason: str(p.reason), status: 'pending' }])
    }
    case 'hil.resolved': {
      const taskId = str(p.task_id) ?? str(p.request_id)
      const index = items.findIndex(item => item.kind === 'hil' && item.taskId === taskId)
      const status = p.approved === true ? 'approved' as const : 'denied' as const
      if (index < 0) {
        return cap([...items, { id: localId(), at, local: true, kind: 'notice', level: 'info', event: event.event_type, text: `Approval ${taskId ?? ''} ${status}${p.timed_out ? ' (timed out)' : ''}` }])
      }
      const next = items.slice()
      next[index] = { ...(next[index] as Extract<TranscriptItem, { kind: 'hil' }>), status, feedback: str(p.feedback) }
      return next
    }
    case 'ask.requested': {
      const requestId = str(p.request_id)
      if (!requestId || items.some(item => item.kind === 'ask' && item.requestId === requestId)) return items
      return cap([...finalizeStreaming(items), { id: localId(), at, local: true, kind: 'ask', requestId, question: str(p.question) ?? '', status: 'pending' }])
    }
    case 'ask.resolved': {
      const requestId = str(p.request_id)
      const index = items.findIndex(item => item.kind === 'ask' && item.requestId === requestId)
      if (index < 0) return items
      const next = items.slice()
      next[index] = { ...(next[index] as Extract<TranscriptItem, { kind: 'ask' }>), status: 'answered', answer: str(p.preview) }
      return next
    }
    case 'agent.error': {
      const text = describeAgentError(p)
      return cap([...finalizeStreaming(items), { id: localId(), at, local: true, kind: 'error', text }])
    }
    default: {
      const notice = noticeFor(event)
      if (!notice) return items
      return cap([...items, { id: localId(), at, local: true, kind: 'notice', event: event.event_type, ...notice }])
    }
  }
}

/** The runtime transitions that deserve a line in the conversation itself. */
export function noticeFor(event: UmbilicalEvent): { text: string; level: 'info' | 'warn' } | null {
  const p = event.payload ?? {}
  switch (event.event_type) {
    case 'agent.state.changed': {
      const state = str(p.state)
      if (state === 'suspended' || state === 'error' || state === 'stopped' || state === 'off' || state === 'hibernate') {
        return { text: `State → ${state}`, level: state === 'error' ? 'warn' : 'info' }
      }
      return null
    }
    case 'loop.compacted':
      return { text: `Compacted${p.reason ? ` (${String(p.reason)})` : ''}${typeof p.new_token_count === 'number' ? ` → ${p.new_token_count} tokens` : ''}`, level: 'info' }
    case 'loop.compaction_failed':
      return { text: `Compaction failed${p.reason ? `: ${String(p.reason)}` : ''} — history kept`, level: 'warn' }
    case 'loop.compaction_superseded':
      return { text: 'Compaction superseded by a newer one', level: 'info' }
    case 'loop.cleared':
      return { text: `Loop ${p.method === 'replace' ? 'rewritten' : 'cleared'}`, level: 'info' }
    case 'loop.recovered':
      return { text: `Recovered: ${String(p.reason ?? 'checkpoint')}`, level: 'warn' }
    case 'suspend.requested':
      return { text: `Suspended${p.reason ? `: ${String(p.reason)}` : ''} — resume or shut down`, level: 'warn' }
    case 'suspend.resolved':
      return { text: p.resumed ? 'Resumed' : `Shut down${p.timed_out ? ' (suspend timed out)' : ''}`, level: 'info' }
    case 'provider.retry_scheduled':
      return { text: `Provider error — retrying${typeof p.delay_ms === 'number' ? ` in ${Math.round(p.delay_ms / 1000)}s` : ''}`, level: 'warn' }
    case 'provider.retry_cancelled':
      return { text: 'Provider retry cancelled', level: 'info' }
    case 'llm.failed':
      return { text: `Model call failed${p.model ? ` (${String(p.model)})` : ''}`, level: 'warn' }
    case 'error.recovery_suppressed':
      return { text: 'Error recovery suppressed — triggers are being dropped', level: 'warn' }
    default:
      return null
  }
}

function describeAgentError(p: Record<string, unknown>): string {
  const inner = p.event as { payload?: { error?: unknown; message?: unknown } } | undefined
  const detail = inner?.payload?.error ?? inner?.payload?.message
  return typeof detail === 'string' && detail ? detail : 'Agent error'
}

/** One-line summary of any event, for the activity feed. */
export function summarizeEvent(event: UmbilicalEvent): string {
  const p = event.payload ?? {}
  switch (event.event_type) {
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return `${event.event_type.slice(5)} ${str(p.name) ?? ''}`.trim()
    case 'agent.state.changed':
      return `state ${str(p.state) ?? '?'}`
    case 'llm.completed':
      return `${str(p.model) ?? 'model'} in ${p.input_tokens ?? '?'} out ${p.output_tokens ?? '?'}`
    case 'turn.completed':
      return 'turn completed'
    case 'hil.requested':
      return `approval requested: ${str(p.tool) ?? ''}`
    case 'ask.requested':
      return `ask: ${(str(p.question) ?? '').slice(0, 60)}`
    case 'message.received':
      return `inbox from ${str(p.from) ?? '?'}`
    case 'message.sent':
      return 'message sent'
    case 'timer.fired':
      return `timer ${String(p.timer_id ?? '')} fired`
    case 'trigger.fired':
      return `trigger ${str(p.trigger_type) ?? ''}`
    case 'config.changed':
      return `config changed: ${Array.isArray(p.changed_keys) ? p.changed_keys.join(', ') : ''}`
    case 'file.written':
      return `wrote ${str(p.path) ?? ''}`
    case 'file.deleted':
      return `deleted ${str(p.path) ?? ''}`
    default: {
      const notice = noticeFor(event)
      return notice?.text ?? event.event_type
    }
  }
}
