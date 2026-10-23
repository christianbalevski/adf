import type { DaemonModeContext } from './context'

/**
 * The Kills this Studio sent to a runtime, counted per connection (every
 * window of the runtime shares it). A start that began before a Kill can
 * reach the daemon after it, where it reads as a new, deliberate start: the
 * start takes the count first and refuses, or stops what it started, when a
 * Kill was sent in between.
 */
const kills = new WeakMap<object, number>()

const keyOf = (ctx: DaemonModeContext): object => ctx.connection ?? ctx

export function noteKill(ctx: DaemonModeContext): void {
  kills.set(keyOf(ctx), killCount(ctx) + 1)
}

export function killCount(ctx: DaemonModeContext): number {
  return kills.get(keyOf(ctx)) ?? 0
}
