/**
 * Shared umbilical event filter.
 *
 * One implementation of the matching rules that both umbilical taps
 * (tap-manager) and umbilical stream-bind endpoints (stream-binding-manager)
 * consume. Before this module each had its own copy, and they had drifted:
 * taps had rate limiting and own-origin exclusion, stream bindings had neither.
 *
 * Evaluation order (fixed — callers depend on it):
 *   1. `suppress` predicate — structural veto (e.g. a binding refusing to see
 *      its own `binding.*` events). Never consumes a rate-limit token.
 *   2. `exclude_source` — drop events published by a known origin.
 *   3. event_type match — exact / `prefix.*` / `*`.
 *   4. `when` expression — compiled once, evaluated in a locked-down vm context.
 *   5. rate limit — token bucket; overruns invoke `onRateLimited` and drop.
 *
 * The `when` sandbox: a fresh context per evaluation with a JSON-cloned `event`
 * as the only binding, 10 ms timeout, and code generation from strings/wasm
 * disabled. Any throw (including timeout) evaluates to false — filters fail
 * closed, they never crash the publisher.
 */

import { Script } from 'node:vm'
import type { UmbilicalEvent } from './umbilical-bus'

/**
 * The filter inputs shared by taps and stream bindings. Both
 * `UmbilicalTapConfig['filter']` (+ its sibling `exclude_own_origin` /
 * `max_rate_per_sec` fields) and `UmbilicalFilter` narrow to this shape.
 */
export interface UmbilicalFilterSpec {
  /** Empty/absent means "all event types". */
  event_types?: string[]
  /** JS expression over `event`; absent means "no predicate". */
  when?: string
  /** Token-bucket ceiling. Absent or <= 0 means unlimited. */
  max_rate_per_sec?: number
  /** Drop events whose `source` equals this value. Absent means no exclusion. */
  exclude_source?: string
}

export interface UmbilicalFilterOptions {
  /** `filename` handed to the vm Script — shows up in stack traces. */
  whenFilename: string
  /** Wraps a `when` compile error before it propagates to the caller. */
  wrapCompileError?: (err: unknown) => Error
  /** Invoked once per event dropped by the token bucket. */
  onRateLimited?: () => void
  /** Structural veto evaluated before anything else. */
  suppress?: (event: UmbilicalEvent) => boolean
}

/** True when any entry is `*` or a bare `prefix.*` wildcard. */
export function hasWildcardEventTypes(eventTypes: readonly string[]): boolean {
  return eventTypes.some(type => type === '*' || type.endsWith('.*'))
}

/**
 * Compile a `when` expression into a predicate. Throws if the expression is
 * not parseable; the returned predicate never throws.
 */
export function compileWhenExpression(
  expression: string,
  whenFilename: string,
  wrapCompileError?: (err: unknown) => Error,
): (event: UmbilicalEvent) => boolean {
  let script: Script
  try {
    script = new Script(`Boolean(${expression})`, { filename: whenFilename })
  } catch (err) {
    throw wrapCompileError ? wrapCompileError(err) : (err instanceof Error ? err : new Error(String(err)))
  }

  return (event: UmbilicalEvent) => {
    try {
      const clonedEvent = JSON.parse(JSON.stringify(event)) as UmbilicalEvent
      return Boolean(script.runInNewContext(
        { event: clonedEvent },
        {
          timeout: 10,
          contextCodeGeneration: { strings: false, wasm: false },
        },
      ))
    } catch {
      return false
    }
  }
}

/** Compile event_types into a matcher. Empty/absent matches everything. */
export function compileEventTypeMatcher(eventTypes?: readonly string[]): (eventType: string) => boolean {
  const types = eventTypes && eventTypes.length > 0 ? eventTypes : ['*']
  const exact = new Set<string>()
  const prefixes: string[] = []
  let any = false
  for (const type of types) {
    if (type === '*') any = true
    else if (type.endsWith('.*')) prefixes.push(type.slice(0, -1))  // keep trailing dot
    else exact.add(type)
  }
  if (any) return () => true
  return (eventType: string) => exact.has(eventType) || prefixes.some(prefix => eventType.startsWith(prefix))
}

export class UmbilicalEventFilter {
  private readonly matchesTypeFn: (eventType: string) => boolean
  private readonly whenFn: ((event: UmbilicalEvent) => boolean) | null
  private readonly excludeSource: string | null
  private readonly suppress: ((event: UmbilicalEvent) => boolean) | null
  private readonly onRateLimited: (() => void) | null
  private readonly maxRatePerSec: number
  private tokens: number
  private lastRefillAt: number

  constructor(spec: UmbilicalFilterSpec, options: UmbilicalFilterOptions) {
    this.matchesTypeFn = compileEventTypeMatcher(spec.event_types)
    this.whenFn = spec.when
      ? compileWhenExpression(spec.when, options.whenFilename, options.wrapCompileError)
      : null
    this.excludeSource = spec.exclude_source ?? null
    this.suppress = options.suppress ?? null
    this.onRateLimited = options.onRateLimited ?? null
    this.maxRatePerSec = typeof spec.max_rate_per_sec === 'number' && spec.max_rate_per_sec > 0
      ? spec.max_rate_per_sec
      : 0
    this.tokens = this.maxRatePerSec
    this.lastRefillAt = Date.now()
  }

  matchesType(eventType: string): boolean {
    return this.matchesTypeFn(eventType)
  }

  /** Full evaluation. Returns true when the event should be delivered. */
  test(event: UmbilicalEvent): boolean {
    if (this.suppress?.(event)) return false
    if (this.excludeSource !== null && event.source === this.excludeSource) return false
    if (!this.matchesTypeFn(event.event_type)) return false
    if (this.whenFn && !this.whenFn(event)) return false
    return this.consumeToken()
  }

  /** Token bucket. No-op (always true) when no rate is configured. */
  private consumeToken(): boolean {
    if (this.maxRatePerSec <= 0) return true
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillAt) / 1000
    this.tokens = Math.min(this.maxRatePerSec, this.tokens + elapsedSec * this.maxRatePerSec)
    this.lastRefillAt = now
    if (this.tokens < 1) {
      this.onRateLimited?.()
      return false
    }
    this.tokens -= 1
    return true
  }
}

export function compileUmbilicalFilter(
  spec: UmbilicalFilterSpec | undefined,
  options: UmbilicalFilterOptions,
): UmbilicalEventFilter {
  return new UmbilicalEventFilter(spec ?? {}, options)
}
