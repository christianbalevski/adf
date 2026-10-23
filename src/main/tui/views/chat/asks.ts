// Answering an `ask` form from the chat prompt, one question at a time: each
// reply is kept on the pending ask (`ask/progress`) until the last question,
// then every answer goes to the daemon together.

import type { TuiStore } from '../../state/store'
import type { PendingAsk, TuiState } from '../../state/types'
import { askStep, pendingAsksFor, readAskReply } from './model'

/** The ask the chat prompt answers: the selected loop's first pending one. */
export function pendingAskFor(state: TuiState, agentId: string | null, loop: string): PendingAsk | undefined {
  if (!agentId) return undefined
  return pendingAsksFor(state.agents[agentId], loop, state.transcripts)[0]
}

/**
 * Answer the question the dock shows; sends the form after its last question.
 * `loop` is the chat's loop, for daemons that do not report the ask's own.
 */
export async function replyToAsk(store: Pick<TuiStore, 'actions' | 'dispatch'>, agentId: string, ask: PendingAsk, text: string, loop?: string): Promise<void> {
  const { index, question } = askStep(ask)
  const read = readAskReply(question, text)
  if ('error' in read) { store.actions.toast(read.error, 'warn'); return }
  const answers = [...ask.answers.slice(0, index), read.answer]
  if (answers.length < ask.questions.length) {
    store.dispatch({ type: 'ask/progress', agentId, requestId: ask.requestId, loop: ask.loop, answers })
    return
  }
  await store.actions.answerAsk(agentId, ask.requestId, answers, ask.loop ?? loop)
}

/** Skip the questions not answered yet and send the form (all of them when none is). */
export async function skipAsk(store: Pick<TuiStore, 'actions'>, agentId: string, ask: PendingAsk, loop?: string): Promise<void> {
  const answers = ask.questions.map((_, i) => ask.answers[i] ?? null)
  await store.actions.answerAsk(agentId, ask.requestId, answers, ask.loop ?? loop)
}
