import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  startStallMonitor,
  stopStallMonitor,
  markActivity,
  isStallMonitorEnabled,
  type StallMonitorScheduler
} from '../../../src/main/utils/stall-monitor'

/**
 * The monitor is a diagnostic, so the properties that matter are: it fires on a
 * real freeze, it creates nothing when disabled, and it cannot flood main.log.
 *
 * Only the first of those needs a real clock and a real busy loop. The rate
 * limiter is driven through an injected scheduler and clock, so it asserts on
 * arithmetic rather than on wall-clock timing and cannot flake.
 */

function busyLoop(ms: number): void {
  const end = Date.now() + ms
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

/** Captures the interval callback so the test can drive ticks by hand. */
function fakeScheduler(): StallMonitorScheduler & { fire(): void; created: number; cleared: number } {
  let tick: (() => void) | null = null
  const state = {
    created: 0,
    cleared: 0,
    setInterval(fn: () => void) {
      state.created++
      tick = fn
      return { unref() { /* no-op */ } } as unknown as NodeJS.Timeout
    },
    clearInterval() { state.cleared++ },
    fire() { tick?.() }
  }
  return state
}

afterEach(() => stopStallMonitor())

describe('stall monitor enablement', () => {
  it('is on in development and off in a packaged build', () => {
    expect(isStallMonitorEnabled(false, {})).toBe(true)
    expect(isStallMonitorEnabled(true, {})).toBe(false)
  })

  it('honours ADF_STALL_MONITOR as an explicit override both ways', () => {
    expect(isStallMonitorEnabled(true, { ADF_STALL_MONITOR: '1' })).toBe(true)
    expect(isStallMonitorEnabled(false, { ADF_STALL_MONITOR: '0' })).toBe(false)
  })

  it('creates no timers when disabled', () => {
    const scheduler = fakeScheduler()
    const log = vi.fn()
    const handle = startStallMonitor({ packaged: true, env: {}, scheduler, log })

    expect(handle).toBeNull()
    expect(scheduler.created).toBe(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('reads the threshold from ADF_STALL_MONITOR_MS', () => {
    const handle = startStallMonitor({
      packaged: false,
      env: { ADF_STALL_MONITOR_MS: '750' },
      scheduler: fakeScheduler(),
      histogram: false
    })
    expect(handle?.thresholdMs).toBe(750)
    // Poll interval is clamped to 25-100 ms regardless of the threshold.
    expect(handle?.intervalMs).toBe(100)
  })
})

describe('stall detection', () => {
  it('reports a deliberate 300 ms block exactly once', async () => {
    const lines: string[] = []
    const handle = startStallMonitor({
      packaged: false,
      env: {},
      thresholdMs: 50,
      log: (line) => lines.push(line)
    })
    expect(handle).not.toBeNull()

    // Let the interval tick at least once so its baseline is fresh.
    await new Promise((resolve) => setTimeout(resolve, 80))
    lines.length = 0

    markActivity('test', 'busy-loop')
    busyLoop(300)
    await new Promise((resolve) => setTimeout(resolve, 150))
    stopStallMonitor()

    expect(lines).toHaveLength(1)
    const durationMs = Number(/blocked (\d+) ms/.exec(lines[0])?.[1])
    expect(durationMs).toBeGreaterThanOrEqual(250)
    expect(lines[0]).toContain('during test:busy-loop')
  })

  it('stays silent while the loop is healthy', async () => {
    const log = vi.fn()
    startStallMonitor({ packaged: false, env: {}, thresholdMs: 200, log })
    await new Promise((resolve) => setTimeout(resolve, 300))
    stopStallMonitor()
    expect(log).not.toHaveBeenCalled()
  })
})

describe('rate limiting', () => {
  it('logs at most once per second and reports the suppressed count', () => {
    const scheduler = fakeScheduler()
    const lines: string[] = []
    let clock = 0
    startStallMonitor({
      packaged: false,
      env: {},
      thresholdMs: 100,
      intervalMs: 25,
      histogram: false,
      now: () => clock,
      scheduler,
      log: (line) => lines.push(line)
    })
    expect(scheduler.created).toBe(1)

    // Each tick is a 525 ms stall (550 ms elapsed minus the 25 ms interval).
    const stallTick = (): void => { clock += 550; scheduler.fire() }

    stallTick()
    expect(lines).toHaveLength(1)

    // The next two land inside the same 1 s window and are folded into a count.
    stallTick()
    expect(lines).toHaveLength(1)
    stallTick()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('+1 stall suppressed')

    stopStallMonitor()
    expect(scheduler.cleared).toBe(1)
  })

  it('does not report jitter below the threshold', () => {
    const scheduler = fakeScheduler()
    const log = vi.fn()
    let clock = 0
    startStallMonitor({
      packaged: false,
      env: {},
      thresholdMs: 200,
      intervalMs: 25,
      histogram: false,
      now: () => clock,
      scheduler,
      log
    })

    for (let i = 0; i < 20; i++) { clock += 40; scheduler.fire() }
    expect(log).not.toHaveBeenCalled()
  })
})

describe('markActivity', () => {
  it('is a no-op when no monitor is running', () => {
    stopStallMonitor()
    expect(() => markActivity('tool', 'sys_read')).not.toThrow()
  })
})
