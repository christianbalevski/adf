/**
 * Main-process event-loop stall monitor (development / diagnostic only).
 *
 * A perf audit found multi-second freezes of the Electron main process (sync
 * WASM instantiation, a ReDoS-prone regex, `Atomics.wait`) that nothing in the
 * app noticed: the UI simply stopped, and main.log held no trace. This watches
 * the main thread's event loop and logs one line per stall through the normal
 * console, which `main-log-file.ts` already mirrors into main.log.
 *
 * What it can and cannot tell you: a JS stack for the code that blocked the
 * loop *cannot* be captured after the fact from the same thread — by the time
 * the timer fires, the offending frame is gone. So attribution here is a
 * best-effort breadcrumb: hot paths call `markActivity(kind, detail)`, and a
 * stall report names the last activity marked before the loop went quiet.
 * Treat it as a hint, not proof.
 *
 * Cost when enabled: one unref'd interval (25-100 ms), one `IntervalHistogram`
 * sampled by libuv off-thread, and no per-tick allocation. Cost when disabled:
 * zero timers, zero histograms — `start` returns null before creating anything.
 */
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'perf_hooks'

/** Default stall threshold; anything shorter is normal scheduling jitter. */
const DEFAULT_THRESHOLD_MS = 200
/** At most one report per second, so a pathological loop can't flood main.log. */
const MIN_LOG_INTERVAL_MS = 1000
/** Activity breadcrumbs older than this are stale and not worth naming. */
const ACTIVITY_MAX_AGE_MS = 30_000

/** Injectable timer pair — the unit test asserts no timer is created when off. */
export interface StallMonitorScheduler {
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout
  clearInterval: (handle: NodeJS.Timeout) => void
}

export interface StallMonitorOptions {
  /** `app.isPackaged`. Kept as a parameter so this module never imports electron. */
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  /** Overrides both the default and `ADF_STALL_MONITOR_MS`. */
  thresholdMs?: number
  /** Poll interval; defaults to half the threshold, clamped to 25-100 ms. */
  intervalMs?: number
  /** Monotonic clock in ms. */
  now?: () => number
  /** Sink for report lines; defaults to `console.warn`. */
  log?: (line: string) => void
  scheduler?: StallMonitorScheduler
  /** Set false to skip the libuv histogram (durations then come from the poll delta only). */
  histogram?: boolean
}

export interface StallMonitorHandle {
  stop(): void
  /** Effective threshold, for logging/tests. */
  readonly thresholdMs: number
  /** Effective poll interval, for logging/tests. */
  readonly intervalMs: number
}

const defaultScheduler: StallMonitorScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle)
}

let active: StallMonitorHandle | null = null
let marking = false
let clock: () => number = () => performance.now()
let activityKind: string | null = null
let activityDetail: string | undefined
let activityAt = 0

/**
 * Record what the main thread is about to do, so a stall report can name it.
 *
 * Two string stores and a clock read, and a no-op when the monitor is off (so
 * production pays nothing). `kind` and `detail` stay separate deliberately:
 * callers pass existing strings and never build one, keeping the call site
 * allocation-free.
 */
export function markActivity(kind: string, detail?: string): void {
  if (!marking) return
  activityKind = kind
  activityDetail = detail
  activityAt = clock()
}

/** True when `start` would create timers, given the packaged flag and env. */
export function isStallMonitorEnabled(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ADF_STALL_MONITOR
  if (flag === '1') return true
  if (flag === '0') return false
  return !packaged
}

function resolveThreshold(options: StallMonitorOptions, env: NodeJS.ProcessEnv): number {
  if (typeof options.thresholdMs === 'number' && options.thresholdMs > 0) return options.thresholdMs
  const raw = Number(env.ADF_STALL_MONITOR_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return DEFAULT_THRESHOLD_MS
}

/**
 * Start watching the main thread. Returns null (and creates nothing) when the
 * monitor is disabled. Starting twice stops the previous monitor first.
 */
export function startStallMonitor(options: StallMonitorOptions = {}): StallMonitorHandle | null {
  const env = options.env ?? process.env
  if (!isStallMonitorEnabled(options.packaged ?? false, env)) return null

  stopStallMonitor()

  const thresholdMs = resolveThreshold(options, env)
  const intervalMs = options.intervalMs ?? Math.max(25, Math.min(100, Math.floor(thresholdMs / 2)))
  const now = options.now ?? (() => performance.now())
  const log = options.log ?? ((line: string) => console.warn(line))
  const scheduler = options.scheduler ?? defaultScheduler

  let histogram: IntervalHistogram | null = null
  if (options.histogram !== false) {
    try {
      histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()
    } catch {
      histogram = null // perf_hooks without libuv delay sampling; poll delta still works
    }
  }

  clock = now
  marking = true

  let last = now()
  let lastLogAt = -Infinity
  let suppressed = 0

  const tick = (): void => {
    const at = now()
    const blockedMs = at - last - intervalMs
    last = at
    // `histogram.max` is the worst single sample libuv saw, in nanoseconds. It
    // is read (and reset) unconditionally so a quiet window never carries its
    // peak into the next stall report.
    const loopMaxMs = histogram ? histogram.max / 1e6 : NaN
    if (histogram) histogram.reset()
    if (blockedMs < thresholdMs) return

    if (at - lastLogAt < MIN_LOG_INTERVAL_MS) {
      suppressed++
      return
    }
    lastLogAt = at

    let line = `[StallMonitor] main thread blocked ${blockedMs.toFixed(0)} ms`
    if (Number.isFinite(loopMaxMs)) line += ` (loop max ${loopMaxMs.toFixed(0)} ms)`
    line += ` at ${new Date().toISOString()}`
    const activityAge = at - activityAt
    if (activityKind && activityAge <= ACTIVITY_MAX_AGE_MS) {
      line += ` during ${activityKind}${activityDetail ? `:${activityDetail}` : ''}`
      line += ` (marked ${activityAge.toFixed(0)} ms earlier)`
    }
    if (suppressed > 0) {
      line += ` (+${suppressed} stall${suppressed === 1 ? '' : 's'} suppressed)`
      suppressed = 0
    }
    log(line)
  }

  const handle = scheduler.setInterval(tick, intervalMs)
  // Never keep the process alive: a diagnostic must not delay quit.
  handle?.unref?.()

  active = {
    thresholdMs,
    intervalMs,
    stop(): void {
      scheduler.clearInterval(handle)
      if (histogram) {
        try { histogram.disable() } catch { /* already disabled */ }
        histogram = null
      }
      marking = false
      activityKind = null
      activityDetail = undefined
      if (active === this) active = null
    }
  }
  return active
}

/** Stop the running monitor, if any. Safe to call when none is running. */
export function stopStallMonitor(): void {
  active?.stop()
  active = null
}
