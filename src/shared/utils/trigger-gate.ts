import type { TriggerScopeV3, TriggerTypeV3 } from '../types/adf-v02.types'

/** Executor states that mean "running a turn". The trigger gate treats them as
 *  `active`: agent-scope triggers arriving then are queued and run at the turn
 *  boundary. */
export const EXECUTOR_WORK_STATES: ReadonlySet<string> = new Set(['thinking', 'tool_use', 'awaiting_approval', 'awaiting_ask'])

/** The state triggers are gated on, from an executor or display state. */
export function gateStateOf(state: string): string {
  return EXECUTOR_WORK_STATES.has(state) ? 'active' : state
}

/**
 * Whether a trigger of this scope and type fires while the agent gates as
 * `gate` (see gateStateOf).
 *
 * System scope: fires in all states except `off`
 * Agent scope:
 *   active/idle → all triggers
 *   hibernate    → only on_timer (direct user chat is dispatched separately)
 *   suspended/error/off → nothing
 */
export function scopeFires(scope: TriggerScopeV3, triggerType: TriggerTypeV3, gate: string): boolean {
  if (scope === 'system') return gate !== 'off'
  switch (gate) {
    case 'active':
    case 'idle':
      return true
    case 'hibernate':
      return triggerType === 'on_timer'
    default:
      return false
  }
}

/** Whether a timer with these scopes fires on schedule: any of its scopes does. */
export function timerFires(scopes: readonly string[], gate: string): boolean {
  return scopes.some((scope) => (scope === 'system' || scope === 'agent') && scopeFires(scope, 'on_timer', gate))
}

/** timerFires for an Upcoming row; a daemon from before `scopes` sends only `scope`. */
export function wakeFires(t: { scope: string; scopes?: readonly string[] }, gate: string): boolean {
  return timerFires(t.scopes ?? [t.scope], gate)
}
