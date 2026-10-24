// Answering an `ask` form from the chat prompt, one question at a time: each
// reply is kept in view state until the last question, then every answer goes
// to the daemon together.

import type { AskAnswer } from '../../../../shared/utils/ask-form'
import type { AskEntry } from '../../api/types'
import type { TuiStore } from '../../state/store'
import { transcriptKey, type TuiState } from '../../state/types'
import { topCard } from './Dock'
import { askStep, pendingAsksFor, pendingTasksFor, readAskReply } from './model'

/** viewState slot: answers given so far, per pending ask. */
export const ASK_PROGRESS_KEY = 'chat:askProgress'

type AskProgress = Record<string, AskAnswer[]>

/** Ask ids repeat across agents and loops (`ask_1`), so the key holds all three. */
function progressKey(agentId: string, loop: string, requestId: string): string {
  return `${transcriptKey(agentId, loop)}\u0000${requestId}`
}

/** Answers given so far to an ask (empty before the first). */
export function askProgress(state: TuiState, agentId: string, loop: string, ask: AskEntry): AskAnswer[] {
  const progress = state.viewState[ASK_PROGRESS_KEY] as AskProgress | undefined
  return progress?.[progressKey(agentId, loop, ask.requestId)] ?? []
}

function setProgress(store: Pick<TuiStore, 'actions' | 'getState'>, key: string, answers: AskAnswer[] | null): void {
  const next = { ...(store.getState().viewState[ASK_PROGRESS_KEY] as AskProgress | undefined) }
  if (answers) next[key] = answers
  else delete next[key]
  store.actions.setViewState(ASK_PROGRESS_KEY, next)
}

/** The ask the chat prompt answers: the selected loop's first pending one, while the dock shows it (no approval ahead). */
export function pendingAskFor(state: TuiState, agentId: string | null, loop: string): AskEntry | undefined {
  if (!agentId) return undefined
  const agent = state.agents[agentId]
  const asks = pendingAsksFor(agent, loop, state.transcripts)
  return topCard({ tasks: pendingTasksFor(agent, loop), asks, suspended: false, queued: [] }) === 'ask' ? asks[0] : undefined
}

/** Answer the question the dock shows; sends the form after its last question. */
export async function replyToAsk(store: Pick<TuiStore, 'actions' | 'getState'>, agentId: string, loop: string, ask: AskEntry, text: string): Promise<void> {
  const key = progressKey(agentId, loop, ask.requestId)
  const sofar = askProgress(store.getState(), agentId, loop, ask)
  const { index, question } = askStep(ask, sofar)
  const read = readAskReply(question, text)
  if ('error' in read) { store.actions.toast(read.error, 'warn'); return }
  const answers = [...sofar.slice(0, index), read.answer]
  if (answers.length < ask.questions.length) { setProgress(store, key, answers); return }
  await store.actions.answerAsk(agentId, ask.requestId, answers, ask.loop ?? loop)
  setProgress(store, key, null)
}

/** Skip the questions not answered yet and send the form (all of them when none is). */
export async function skipAsk(store: Pick<TuiStore, 'actions' | 'getState'>, agentId: string, loop: string, ask: AskEntry): Promise<void> {
  const sofar = askProgress(store.getState(), agentId, loop, ask)
  await store.actions.answerAsk(agentId, ask.requestId, ask.questions.map((_, i) => sofar[i] ?? null), ask.loop ?? loop)
  setProgress(store, progressKey(agentId, loop, ask.requestId), null)
}
