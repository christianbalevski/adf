/**
 * Execution context — AsyncLocalStorage-backed provenance for umbilical events.
 *
 * Every event emitted via `emitUmbilicalEvent` carries a `source` field
 * identifying what caused it. The source is read from the current async
 * context at emit time, so every place work originates must wrap its body
 * in `withSource(...)`. Innermost wins for nested calls.
 *
 * Source format (tagged-union string, parseable by prefix):
 *   agent:<turn_id>              — LLM-driven action during a turn
 *   lambda:<file>:<function>     — action caused by a lambda invocation
 *   system:<subsystem>           — runtime itself (daemon, timer, lifecycle, ...)
 *
 * Dev-mode assertion: if currentSource() resolves to "system:unknown" in a
 * non-production build, throw loudly. Missing wraps degrade exclude_own_origin
 * silently in production, which is how this class of bug hides — so fail
 * fast during development.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ExecutionContext {
  source: string
  agentId?: string   // resolved agent runtime id when known
  /** Cognition loop the work runs on (see withLoop). Absent = main / not loop-scoped. */
  loop?: string
}

const store = new AsyncLocalStorage<ExecutionContext>()

export function withSource<T>(source: string, fn: () => T): T
export function withSource<T>(source: string, agentId: string | undefined, fn: () => T): T
export function withSource<T>(source: string, agentIdOrFn: string | undefined | (() => T), maybeFn?: () => T): T {
  const agentId = typeof agentIdOrFn === 'function' ? undefined : agentIdOrFn
  const fn = typeof agentIdOrFn === 'function' ? agentIdOrFn : maybeFn!
  // A nested origin (a lambda called from a loop's turn) inherits the loop,
  // but only within the same agent — another agent's work is not this loop's.
  const parent = store.getStore()
  const loop = parent?.loop && (agentId === undefined || agentId === parent.agentId) ? parent.loop : undefined
  return store.run(loop ? { source, agentId, loop } : { source, agentId }, fn)
}

/** Run `fn` with the current context bound to a cognition loop. */
export function withLoop<T>(loop: string, fn: () => T): T {
  const parent = store.getStore()
  return store.run({ source: parent?.source ?? 'system:unknown', agentId: parent?.agentId, loop }, fn)
}

export function currentLoop(): string | undefined {
  return store.getStore()?.loop
}

export function currentSource(): string {
  const ctx = store.getStore()
  if (!ctx) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        '[execution-context] currentSource() called outside any withSource() scope. ' +
        'Every origin of work (LLM turn, lambda dispatch, system-originated work) must be wrapped.'
      )
    }
    return 'system:unknown'
  }
  return ctx.source
}

export function currentAgentId(): string | undefined {
  return store.getStore()?.agentId
}

/**
 * Escape hatch for production code paths that legitimately run without a
 * wrapped origin (e.g. early daemon startup before any agent exists). Returns
 * 'system:unknown' without throwing. Use sparingly.
 */
export function currentSourceOrUnknown(): string {
  return store.getStore()?.source ?? 'system:unknown'
}
