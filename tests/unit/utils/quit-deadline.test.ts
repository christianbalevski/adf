/**
 * R2A-4: Studio's quit deadline (main/index.ts runShutdownCleanup) on a
 * restart into Inside Studio. The 22 s wait for the daemon's exit starts
 * only once the daemon answered the quit; the deadline then moves to that
 * wait plus its margin, so it never cuts the wait short, and the sentence
 * when it fires names the budget it had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MovableDeadline } from '../../../src/main/utils/concurrency'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

describe('MovableDeadline', () => {
  it('a quit that answers after 5 s and a daemon that exits 21 s later: the wait completes (a fixed 25 s cut it at 25 s)', async () => {
    const fired: number[] = []
    const deadline = new MovableDeadline(8_000, (ms) => fired.push(ms))
    // Phase 1 (sessions end, the quit answers) takes 5 s; then the 22 s wait starts and the deadline moves.
    const cleanup = (async () => {
      await after(5_000, null)
      deadline.moveTo(22_000 + 3_000)
      return after(21_000, 'gone')
    })()
    const result = deadline.race(cleanup)
    await vi.advanceTimersByTimeAsync(26_000)
    expect(await result).toEqual({ timedOut: false, value: 'gone' })
    expect(fired).toEqual([])
  })

  it('fires at the moved deadline when the wait runs out, naming the whole budget', async () => {
    const fired: number[] = []
    const deadline = new MovableDeadline(8_000, (ms) => fired.push(ms))
    const cleanup = (async () => {
      await after(5_000, null)
      deadline.moveTo(25_000)
      return after(60_000, 'late')
    })()
    const result = deadline.race(cleanup)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ timedOut: true, value: undefined })
    expect(fired).toEqual([30_000])
  })

  it('without a move it is the plain budget, and its sentence says that budget', async () => {
    const fired: number[] = []
    const deadline = new MovableDeadline(8_000, (ms) => fired.push(ms))
    const result = deadline.race(after(10_000, 'x'))
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await result).toEqual({ timedOut: true, value: undefined })
    expect(fired).toEqual([8_000])
    // Fired is final: a later move does nothing.
    deadline.moveTo(60_000)
    expect(deadline.budgetMs).toBe(8_000)
  })
})
