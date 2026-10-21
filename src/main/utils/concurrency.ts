/**
 * Small concurrency helpers shared by startup (bounded-parallel agent
 * start) and shutdown (budgeted teardown). No external deps.
 */

/**
 * Map items with at most `limit` in flight. Preserves input order in
 * the result. Rejections are captured per item (never throws), so one
 * failing item cannot abort the batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (err) {
        results[i] = { status: 'rejected', reason: err }
      }
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Race a promise against a deadline. On timeout, resolves with
 * `fallback` (default undefined) rather than rejecting — shutdown and
 * degraded-start paths want "carry on", not an exception. The
 * underlying work is NOT cancelled; callers that need cancellation
 * should pass an AbortSignal to the work itself.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void
): Promise<{ timedOut: boolean; value: T | undefined }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true; value: undefined }>((resolve) => {
    timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* ignore */ }
      resolve({ timedOut: true, value: undefined })
    }, ms)
    timer.unref?.()
  })
  try {
    const value = await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout])
    return value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A deadline that can move (Studio's quit, R2A-4): it fires `onTimeout`
 * `ms` after it starts, unless `moveTo` set it again, to that many ms from
 * then. `race` resolves as withDeadline does. `budgetMs` is the time from
 * the start to the deadline now, for the sentence when it fires.
 */
export class MovableDeadline {
  private readonly started = Date.now()
  private due: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private fired = false
  private readonly waiters = new Set<() => void>()

  constructor(ms: number, private readonly onTimeout?: (budgetMs: number) => void) {
    this.due = this.started + ms
    this.arm(ms)
  }

  get budgetMs(): number {
    return this.due - this.started
  }

  /** The deadline is now `ms` from this moment (later or earlier); a fired deadline stays fired. */
  moveTo(ms: number): void {
    if (this.fired) return
    this.due = Date.now() + ms
    this.arm(ms)
  }

  async race<T>(promise: Promise<T>): Promise<{ timedOut: boolean; value: T | undefined }> {
    let wake!: () => void
    const timeout = new Promise<{ timedOut: true; value: undefined }>((resolve) => {
      wake = () => resolve({ timedOut: true, value: undefined })
      if (this.fired) wake()
      else this.waiters.add(wake)
    })
    try {
      return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout])
    } finally {
      this.waiters.delete(wake)
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    }
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.fired = true
      this.timer = null
      try { this.onTimeout?.(this.budgetMs) } catch { /* ignore */ }
      for (const wake of this.waiters) wake()
    }, Math.max(0, ms))
    this.timer.unref?.()
  }
}
