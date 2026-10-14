import type { LocalCallRecord, PushRecord } from './electron-fake'
import type { RecordedLlmRequest } from './mock-llm'

/**
 * What one scenario run produced, before normalization.
 *
 * - `steps`: every renderer→main call in call order, with its result.
 * - `pushes`: every main→renderer send in send order.
 * - `local`: native UI and OS calls (dialogs, shell, badge, recent docs).
 * - `llm`: the requests the backend sent to the mock LLM, in arrival order.
 */
export type StepRecord =
  | { kind: 'invoke'; channel: string; args: unknown[]; result: unknown }
  | { kind: 'invoke-error'; channel: string; args: unknown[]; error: string }
  | { kind: 'send'; channel: string; args: unknown[] }
  | { kind: 'wait'; channel: string; description: string }

export interface RawRecording {
  scenario: string
  backend: string
  steps: StepRecord[]
  pushes: PushRecord[]
  local: LocalCallRecord[]
  llm: RecordedLlmRequest[]
}

/**
 * The part of a recording two backends must agree on.
 *
 * Pushes are grouped per channel, channels sorted by name: order is compared
 * exactly within a channel, not across channels, because Electron gives no
 * ordering contract between two channels and the renderer has none either.
 * The backend name is not part of it.
 */
export interface ComparableRecording {
  scenario: string
  steps: StepRecord[]
  pushes: Record<string, unknown[]>
  local: LocalCallRecord[]
  llm: RecordedLlmRequest[]
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
  return { scenario: raw.scenario, steps: raw.steps, pushes, local: raw.local, llm: raw.llm }
}
