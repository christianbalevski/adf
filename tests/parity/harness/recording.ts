import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { LocalCallRecord, PushRecord } from './electron-fake'
import type { RecordedLlmRequest, StreamTiming } from './mock-llm'
import type { PersistedState } from './state-dump'

/**
 * What one scenario run produced, before normalization.
 *
 * - `steps`: every renderer→main call in call order, with its result and
 *   the global push watermark when it started and when it resolved
 *   (`pushes.before`/`after` = number of pushes sent so far). A result that
 *   resolves after its first events shows `after > before`.
 * - `pushes`: every main→renderer send, with global `seq` and run time `t`.
 * - `local`: native UI and OS calls (dialogs, shell, notifications, menu,
 *   tray, badge, recent docs).
 * - `llm`: the requests the backend sent to the mock LLM, in arrival order.
 * - `state`: what the run left on disk (see state-dump.ts).
 * - `timing`: streamed-reply write times. Raw only: never compared, never
 *   in golden files; the streaming assertions read it.
 */
export type StepRecord =
  | { kind: 'invoke'; channel: string; args: unknown[]; result: unknown; pushes: { before: number; after: number } }
  | { kind: 'invoke-error'; channel: string; args: unknown[]; error: { name: string; message: string; code?: unknown }; pushes: { before: number; after: number } }
  | { kind: 'send'; channel: string; args: unknown[]; pushes: { before: number } }
  | { kind: 'wait'; channel: string; description: string; pushes: { matched: number } }
  | { kind: 'shutdown'; pushes: { before: number; after: number } }

export interface RawRecording {
  scenario: string
  backend: string
  steps: StepRecord[]
  pushes: PushRecord[]
  local: LocalCallRecord[]
  llm: RecordedLlmRequest[]
  state: PersistedState
  timing: { streams: StreamTiming[] }
}

/**
 * The part of a recording two backends must agree on.
 *
 * - `pushes`: payloads grouped per channel, channels sorted by name; order
 *   compared exactly within a channel.
 * - `timelines`: per agent, every push that belongs to it across channels
 *   in global send order, interleaved with step start/resolve markers. This
 *   is where cross-channel order per agent and "result after events" show.
 *
 * Push times (`t`) and the backend name are not part of it.
 */
export interface ComparableRecording {
  scenario: string
  steps: StepRecord[]
  pushes: Record<string, unknown[]>
  timelines: Record<string, string[]>
  local: LocalCallRecord[]
  llm: RecordedLlmRequest[]
  state: PersistedState
}

type Payload = Record<string, unknown> | undefined

/** One line for a push in a timeline: channel, event type and (for state changes) the state. */
function describe(channel: string, payload: Payload): string {
  if (!payload || typeof payload !== 'object') return channel
  const type = typeof payload.type === 'string' ? ` ${payload.type}` : ''
  const inner = payload.payload as Payload
  const state = inner && typeof inner.state === 'string' ? `:${inner.state}` : ''
  return `${channel}${type}${state}`
}

/**
 * Which agent a push belongs to. AGENT_EVENT carries no file: it is the
 * foreground agent's, i.e. the file of the last FILE_OPEN that had started
 * before the push (FILE_CLOSE clears it). Background batches are split per
 * event. Anything else names its `filePath` or belongs to `app`.
 */
function attribute(raw: RawRecording): Map<string, { seq: number; line: string }[]> {
  const openings: { from: number; file: string | null }[] = []
  for (const step of raw.steps) {
    if (step.kind !== 'invoke' && step.kind !== 'invoke-error') continue
    if (step.channel === IPC.FILE_OPEN) {
      const file = (step.args[0] as { filePath?: string } | undefined)?.filePath ?? null
      openings.push({ from: step.pushes.before, file })
    } else if (step.channel === IPC.FILE_CLOSE) {
      openings.push({ from: step.pushes.before, file: null })
    }
  }
  const foregroundAt = (seq: number) => {
    let file: string | null = null
    for (const o of openings) if (o.from < seq) file = o.file
    return file
  }
  const out = new Map<string, { seq: number; line: string }[]>()
  const add = (agent: string, seq: number, line: string) => {
    const list = out.get(agent) ?? []
    list.push({ seq, line })
    out.set(agent, list)
  }
  for (const push of raw.pushes) {
    const payload = push.args[0] as Payload | Payload[]
    if (push.channel === IPC.BACKGROUND_AGENT_EVENT_BATCH && Array.isArray(payload)) {
      for (const ev of payload) add(String(ev?.filePath ?? 'app'), push.seq, describe(push.channel, ev))
      continue
    }
    const p = Array.isArray(payload) ? undefined : payload
    const file = push.channel === IPC.AGENT_EVENT
      ? foregroundAt(push.seq)
      : typeof p?.filePath === 'string' ? p.filePath : null
    add(file ?? 'app', push.seq, describe(push.channel, p))
  }
  return out
}

export function toComparable(raw: RawRecording): ComparableRecording {
  const byChannel = new Map<string, unknown[]>()
  for (const push of raw.pushes) {
    const list = byChannel.get(push.channel) ?? []
    // Every Studio push carries one payload argument; keep the array only when it does not.
    list.push(push.args.length === 1 ? push.args[0] : push.args)
    byChannel.set(push.channel, list)
  }
  const pushes: Record<string, unknown[]> = {}
  for (const channel of [...byChannel.keys()].sort()) pushes[channel] = byChannel.get(channel)!

  // Step markers: `> n channel` when a step starts, `< n` when it resolves,
  // placed by push watermark.
  const markers: { at: number; order: number; line: string }[] = []
  raw.steps.forEach((step, i) => {
    const n = i + 1
    if (step.kind === 'invoke' || step.kind === 'invoke-error') {
      markers.push({ at: step.pushes.before, order: markers.length, line: `> ${n} ${step.channel}` })
      markers.push({ at: step.pushes.after, order: markers.length, line: `< ${n}${step.kind === 'invoke-error' ? ' (threw)' : ''}` })
    } else if (step.kind === 'shutdown') {
      markers.push({ at: step.pushes.before, order: markers.length, line: `> ${n} shutdown` })
      markers.push({ at: step.pushes.after, order: markers.length, line: `< ${n}` })
    }
  })
  const timelines: Record<string, string[]> = {}
  const byAgent = attribute(raw)
  for (const agent of [...byAgent.keys()].sort()) {
    const events = byAgent.get(agent)!
    const lines: { at: number; order: number; line: string }[] = [
      ...markers,
      // Global seq numbers are not printed: other agents' pushes would shift them.
      ...events.map((e) => ({ at: e.seq - 1, order: Number.MAX_SAFE_INTEGER, line: `  ${e.line}` })),
    ]
    // A marker at watermark w sits after push w and before push w+1; markers keep step order.
    lines.sort((a, b) => a.at - b.at || a.order - b.order)
    timelines[agent] = lines.map((l) => l.line)
  }
  return { scenario: raw.scenario, steps: raw.steps, pushes, timelines, local: raw.local, llm: raw.llm, state: raw.state }
}
