import type { AgentLogEntry } from '../stores/agent.store'

/** The one thing an error row offers the owner, chosen by what went wrong. */
export type LoopErrorAction = 'provider' | 'compact' | 'retry'

export const LOOP_ERROR_ACTION_LABELS: Record<LoopErrorAction, string> = {
  provider: 'Open provider',
  compact: 'Compact',
  retry: 'Retry now',
}

const CONTEXT_OVERFLOW = /context[_ ]length|context window|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (model's )?context/i
const PROVIDER_SETUP = /isn't authenticated|not authenticated|api[ _]key|\b40[13]\b|unauthori[sz]ed|authentication|insufficient[_ ](quota|credits|balance)|billing|provider "[^"]*" not found|provider not configured|no provider|no model/i
const TRANSIENT = /\b(408|429|500|502|503|504|529)\b|rate[ _]limit|too many requests|overloaded|timed? ?out|econnreset|socket hang up|network|service[ _]unavailable|\bterminated\b/i

/**
 * The action for an error row's text. Rows a send wrote ("Not sent: …") have
 * none: the composer already holds the message again.
 */
export function errorAction(content: string): LoopErrorAction | null {
  if (content.startsWith('Not sent: ')) return null
  // The executor's own classification of a transient failure.
  if (content.startsWith('Provider unavailable:')) return 'retry'
  if (CONTEXT_OVERFLOW.test(content)) return 'compact'
  if (PROVIDER_SETUP.test(content)) return 'provider'
  if (TRANSIENT.test(content)) return 'retry'
  return null
}

/** Whether the row names a missing provider or model, not bad credentials. */
export function isMissingProvider(content: string): boolean {
  return /provider "[^"]*" not found|provider not configured|no provider|no model/i.test(content)
}

/**
 * The error row that may still offer its action: the latest one, while
 * nothing the agent did has come after it. An old error the agent has since
 * moved past gets no button.
 */
export function actionableErrorId(log: AgentLogEntry[]): string | null {
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]
    if (entry.type === 'error') return entry.id
    if (entry.type === 'text' || entry.type === 'thinking' || entry.type === 'tool_call'
      || entry.type === 'tool_result' || entry.type === 'compaction') return null
  }
  return null
}
