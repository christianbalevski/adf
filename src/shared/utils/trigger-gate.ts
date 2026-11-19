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
 * When a timer with these scopes, due at `dueAt`, fires (is settled), as the
 * runtime decides it from the same facts and config. Only the scopes on_timer
 * admits count; a row with none settles with nothing run. The agent part
 * decides a row that has one, because the whole row waits until its target
 * can receive: an inner-loop target must be enabled and, in error, offer a
 * recovery attempt by its own published fact. The agent part of a timer for
 * a loop that is not declared is dropped. A system-only row fires unless the
 * agent is off. Nothing fires while the agent is off, and
 * nothing is predicted before the config has loaded (`ctx` undefined).
 */
export function timerFireTime(scopes: readonly string[], facts: GateFacts, dueAt: number, loop: string | null | undefined, ctx: TimerContext | undefined): number | undefined {
  return timerFire(scopes, facts, dueAt, loop, ctx)?.at
}

/** timerFireTime's whole decision: when, which admitted scopes run, whether
 *  the agent part is dropped (undeclared loop), and whether the agent part is
 *  a recovery attempt (its target is in error). */
export function timerFire(scopes: readonly string[], facts: GateFacts, dueAt: number, loop: string | null | undefined, ctx: TimerContext | undefined): { at: number; scopes: TriggerScopeV3[]; dropsAgent: boolean; recovery: boolean } | undefined {
  if (!ctx || facts.state === 'off') return undefined
  let admitted = admittedTimerScopes(ctx.onTimer, scopes as TriggerScopeV3[])
  const dropsAgent = admitted.includes('agent') && !!loop && loop !== 'main' && !ctx.loops.some(l => l.name === loop)
  if (dropsAgent) admitted = admitted.filter(scope => scope !== 'agent')
  if (admitted.includes('agent')) {
    let at = fireTime('agent', 'on_timer', facts, dueAt, loop)
    const own = loop && loop !== 'main' ? ctx.loopFacts[loop] : facts
    if (at !== undefined && loop && loop !== 'main') {
      if (ctx.loops.find(l => l.name === loop)?.enabled === false) at = undefined
      else if (own?.state === 'error') at = fireTime('agent', 'on_timer', own, at)
    }
    return at === undefined ? undefined : { at, scopes: admitted, dropsAgent, recovery: own?.state === 'error' }
  }
  const at = admitted.includes('system') ? fireTime('system', 'on_timer', facts, dueAt) : dueAt
  return at === undefined ? undefined : { at, scopes: admitted, dropsAgent, recovery: false }
}

/** timerFireTime for an Upcoming row; a daemon from before `scopes` sends only `scope`. */
export function wakeFireTime(t: { at: number; scope: string; scopes?: readonly string[]; loop?: string | null }, facts: GateFacts, ctx: TimerContext | undefined): number | undefined {
  return timerFireTime(t.scopes ?? [t.scope], facts, t.at, t.loop, ctx)
}
