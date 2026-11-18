import type { TriggerConfig, TriggerScopeV3, TriggerTypeV3 } from '../types/adf-v02.types'

/** Executor states that mean "running a turn". The trigger gate treats them as
 *  `active`: agent-scope triggers arriving then are queued and run at the turn
 *  boundary. */
export const EXECUTOR_WORK_STATES: ReadonlySet<string> = new Set(['thinking', 'tool_use', 'awaiting_approval', 'awaiting_ask'])

/** The state triggers are gated on, from an executor or display state. */
export function gateStateOf(state: string): string {
  return EXECUTOR_WORK_STATES.has(state) ? 'active' : state
}

/**
 * What the gate reads: the gate state (gateStateOf) and, in `error`, the
 * recovery fact the executor publishes with its `state_changed` event
 * (`recovery_at`). The runtime and the UI read the same event, so they pass the
 * same facts here.
 */
export interface GateFacts {
  state: string
  /** In `error`: the earliest time a recovery attempt may start (0 = now).
   *  null or absent = parked (an auth error, a turn still holding the agent,
   *  or nothing published). */
  recoveryAt?: number | null
}

/**
 * When a trigger of this scope and type, due at `dueAt`, may fire under these
 * facts: `dueAt`, a later time, or undefined while the facts hold.
 *
 * System scope: fires in all states except `off`
 * Agent scope:
 *   active/idle → all triggers
 *   hibernate    → only on_timer (direct user chat is dispatched separately)
 *   error        → only for the main loop, as a recovery attempt: from
 *                  `recoveryAt` on (never when parked)
 *   suspended/off → nothing
 */
export function fireTime(scope: TriggerScopeV3, triggerType: TriggerTypeV3, facts: GateFacts, dueAt: number, loop?: string | null): number | undefined {
  if (scope === 'system') return facts.state !== 'off' ? dueAt : undefined
  switch (facts.state) {
    case 'active':
    case 'idle':
      return dueAt
    case 'hibernate':
      return triggerType === 'on_timer' ? dueAt : undefined
    case 'error':
      if ((loop ?? 'main') !== 'main' || facts.recoveryAt === null || facts.recoveryAt === undefined) return undefined
      return Math.max(dueAt, facts.recoveryAt)
    default:
      return undefined
  }
}

/** Whether a trigger of this scope and type fires now under these facts. */
export function scopeFires(scope: TriggerScopeV3, triggerType: TriggerTypeV3, facts: GateFacts, loop?: string | null, now: number = Date.now()): boolean {
  const at = fireTime(scope, triggerType, facts, now, loop)
  return at !== undefined && at <= now
}

/** The timer's scopes that `on_timer` admits: those with a target of that scope, none while it is disabled. */
export function admittedTimerScopes(onTimer: TriggerConfig | undefined, scopes: readonly TriggerScopeV3[]): TriggerScopeV3[] {
  if (!onTimer?.enabled) return []
  return scopes.filter(scope => (onTimer.targets ?? []).some(t => t.scope === scope))
}

/**
 * What decides whether a timer fires besides main's gate facts: the agent's
 * config and each inner loop's own published facts. The runtime reads the
 * same inputs (the evaluator's admission, the loop pool, the inner loop's
 * executor); the UI passes them here.
 */
export interface TimerContext {
  /** `on_timer` config (admittedTimerScopes). */
  onTimer: TriggerConfig | undefined
  /** Declared inner loops: a missing or disabled target cannot receive. */
  loops: ReadonlyArray<{ name: string; enabled?: boolean }>
  /** Each inner loop's published facts (its own state_changed). */
  loopFacts: Readonly<Record<string, GateFacts>>
}

/**
 * When a timer with these scopes, due at `dueAt`, fires (is settled): the
 * agent part decides a row that has one, because the whole row waits until
 * its target can receive. A system-only row fires unless the agent is off.
 * With a context: only admitted scopes count (a row with none settles with
 * nothing run, as the runtime does), and an inner-loop target must be
 * declared and enabled and, in error, offer a recovery attempt by its own
 * published fact.
 */
export function timerFireTime(scopes: readonly string[], facts: GateFacts, dueAt: number, loop?: string | null, ctx?: TimerContext): number | undefined {
  const admitted: readonly string[] = ctx ? admittedTimerScopes(ctx.onTimer, scopes as TriggerScopeV3[]) : scopes
  if (admitted.includes('agent')) {
    let at = fireTime('agent', 'on_timer', facts, dueAt, loop)
    if (at !== undefined && ctx && loop && loop !== 'main') {
      const declared = ctx.loops.find(l => l.name === loop)
      const own = ctx.loopFacts[loop]
      if (!declared || declared.enabled === false) at = undefined
      else if (own?.state === 'error') at = fireTime('agent', 'on_timer', own, at)
    }
    return at
  }
  if (admitted.includes('system')) return fireTime('system', 'on_timer', facts, dueAt)
  return ctx ? dueAt : undefined
}

/** timerFireTime for an Upcoming row; a daemon from before `scopes` sends only `scope`. */
export function wakeFireTime(t: { at: number; scope: string; scopes?: readonly string[]; loop?: string | null }, facts: GateFacts, ctx?: TimerContext): number | undefined {
  return timerFireTime(t.scopes ?? [t.scope], facts, t.at, t.loop, ctx)
}
