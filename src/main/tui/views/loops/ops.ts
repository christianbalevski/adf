// Loop-manager actions shared by the tabs, slash commands and palette. Every
// destructive or config-writing step goes through a confirm first.

import { MAIN_LOOP, type LoopEntry, type Timer } from '../../api/types'
import type { TuiActions } from '../../state/store'
import type { TuiState } from '../../state/types'
import { agentName, loopStatusWord } from './common'
import { bumpLoopsData } from './hooks'
import { describeTimer, formatWhen, timerLoop, type TriggerTypeV3 } from './model'
import type { LoopWizardProps } from './LoopWizard'
import type { TimerDialogProps } from './TimerDialog'
import type { TriggerDialogProps } from './TriggerDialog'
import type { EntryDialogProps } from './EntryDialog'
import type { SendDialogProps } from './SendDialog'

export const OVERLAY = {
  loop: 'loops.loop',
  timer: 'loops.timer',
  trigger: 'loops.trigger',
  entry: 'loops.entry',
  send: 'loops.send',
} as const

export function openLoopWizard(actions: TuiActions, props: LoopWizardProps): void {
  actions.pushOverlay({ kind: OVERLAY.loop, props: { ...props } })
}

export function openTimerDialog(actions: TuiActions, props: TimerDialogProps): void {
  actions.pushOverlay({ kind: OVERLAY.timer, props: { ...props } })
}

export function openTriggerDialog(actions: TuiActions, props: TriggerDialogProps): void {
  actions.pushOverlay({ kind: OVERLAY.trigger, props: { ...props } })
}

export function openEntryDialog(actions: TuiActions, props: EntryDialogProps): void {
  actions.pushOverlay({ kind: OVERLAY.entry, props: { ...props } })
}

export function openSendDialog(actions: TuiActions, props: SendDialogProps): void {
  actions.pushOverlay({ kind: OVERLAY.send, props: { ...props } })
}

export function openChat(actions: TuiActions, agentId: string, loop: string): void {
  actions.selectLoop(agentId, loop)
  actions.setView('chat')
}

export async function confirmDeleteLoop(actions: TuiActions, state: TuiState, agentId: string, name: string): Promise<boolean> {
  if (name === MAIN_LOOP) {
    actions.toast('main is the agent itself and cannot be deleted', 'warn')
    return false
  }
  const loop = state.agents[agentId]?.loops?.find(l => l.info.name === name)
  if (state.agents[agentId]?.loops && !loop) {
    actions.toast(`No inner loop "${name}" on ${agentName(state, agentId)}`, 'warn')
    return false
  }
  const running = loop ? loopStatusWord(loop) !== 'idle' && loopStatusWord(loop) !== 'off' : false
  const rows = loop ? `${loop.info.entryCount} history entr${loop.info.entryCount === 1 ? 'y is' : 'ies are'}` : 'Its history is'
  const message = [
    `Delete inner loop "${name}" of ${agentName(state, agentId)}?`,
    `${rows} archived to the audit log (adf_audit, source loop:${name}) first, then the loop, its runtime and the timers that target it are removed.`,
    running ? 'It is running right now: its current turn is interrupted.' : '',
  ].filter(Boolean).join(' ')
  const ok = await actions.confirm({ title: 'Delete loop', message, confirmLabel: 'Delete', danger: true })
  if (!ok) return false
  const result = await actions.deleteLoop(agentId, name)
  bumpLoopsData(actions, state)
  return !!result
}

export async function toggleLoopEnabled(actions: TuiActions, state: TuiState, agentId: string, name: string, enabled?: boolean): Promise<void> {
  if (name === MAIN_LOOP) {
    actions.toast('main cannot be disabled: stop the agent instead', 'warn')
    return
  }
  const loop = state.agents[agentId]?.loops?.find(l => l.info.name === name)
  const next = enabled ?? !(loop?.info.enabled ?? false)
  if (!next && loop && loopStatusWord(loop) !== 'idle' && loopStatusWord(loop) !== 'off') {
    const ok = await actions.confirm({
      title: 'Disable loop',
      message: `${name} is running. Disabling stops it now: the in-flight turn is aborted. Its history is kept and it can be re-enabled.`,
      confirmLabel: 'Disable',
      danger: true,
    })
    if (!ok) return
  }
  await actions.setLoopEnabled(agentId, name, next)
}

export async function confirmDeleteTimer(actions: TuiActions, state: TuiState, agentId: string, timer: Timer): Promise<boolean> {
  const loop = timerLoop(timer)
  const ok = await actions.confirm({
    title: 'Delete timer',
    message: `Delete timer #${timer.id} of ${agentName(state, agentId)}: ${describeTimer(timer)}, ${loop ? `wakes ${loop}` : 'system scope'}${timer.expired ? ' (expired)' : `, next ${formatWhen(timer.next_wake_at)}`}?${timer.locked ? ' It is owner-locked.' : ''}`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return false
  const result = await actions.run('Delete timer', c => c.deleteTimer(agentId, timer.id))
  if (result?.success) actions.toast(`Timer #${timer.id} deleted`, 'success')
  else if (result) actions.toast(`Timer #${timer.id} was not deleted (already gone?)`, 'warn')
  bumpLoopsData(actions, state)
  return !!result?.success
}

export async function confirmClearHistory(actions: TuiActions, state: TuiState, agentId: string, loop: string): Promise<boolean> {
  const count = state.agents[agentId]?.loops?.find(l => l.info.name === loop)?.info.entryCount
  const ok = await actions.confirm({
    title: `Clear ${loop} history`,
    message: `Clear the ${loop} loop of ${agentName(state, agentId)}${count !== undefined ? ` (${count} entries)` : ''}? The loop starts over with no conversation history. Whether the cleared rows are archived depends on the agent's audit.loop setting.`,
    confirmLabel: 'Clear',
    danger: true,
  })
  if (!ok) return false
  await actions.clearLoopHistory(agentId, loop)
  bumpLoopsData(actions, state)
  return true
}

export type { TriggerTypeV3, LoopEntry }
