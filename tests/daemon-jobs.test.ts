// daemon/jobs.ts: long-running work answered as 202 + GET /jobs/:id.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINISHED_TTL_MS, JobRegistry, MAX_FINISHED } from '../src/main/daemon/jobs'

afterEach(() => { vi.useRealTimers() })

describe('JobRegistry', () => {
  it('runs, succeeds with the result, fails with the message', async () => {
    const jobs = new JobRegistry()
    const ok = jobs.start('t.ok', async () => ({ answer: 42 }))
    expect(ok.state).toBe('running')
    const bad = jobs.start('t.bad', async () => { throw new Error('nope') })
    await vi.waitFor(() => expect(jobs.get(ok.id)?.state).toBe('succeeded'))
    expect(jobs.get(ok.id)).toMatchObject({ kind: 't.ok', result: { answer: 42 }, finishedAt: expect.any(Number) })
    await vi.waitFor(() => expect(jobs.get(bad.id)).toMatchObject({ state: 'failed', error: 'nope' }))
  })

  it('cancel aborts the signal and wins over a later result', async () => {
    const jobs = new JobRegistry()
    let signal!: AbortSignal
    let finish!: () => void
    const job = jobs.start('t.slow', async (ctx) => {
      signal = ctx.signal
      ctx.setProgress('working')
      await new Promise<void>((r) => { finish = r })
      return 'late'
    })
    await vi.waitFor(() => expect(jobs.get(job.id)?.progress).toBe('working'))
    expect(jobs.cancel(job.id)).toBe(true)
    expect(signal.aborted).toBe(true)
    finish()
    await new Promise((r) => setTimeout(r, 10))
    expect(jobs.get(job.id)).toMatchObject({ state: 'cancelled', error: 'Cancelled by the client' })
    expect(jobs.get(job.id)?.result).toBeUndefined()
    expect(jobs.cancel(job.id)).toBe(false)
    expect(jobs.cancel('unknown')).toBe(false)
  })

  it('forgets finished jobs after the TTL and keeps at most MAX_FINISHED', async () => {
    const jobs = new JobRegistry()
    const first = jobs.start('t', async () => 1)
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe('succeeded'))
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + FINISHED_TTL_MS + 1)
    expect(jobs.get(first.id)).toBeUndefined()
    vi.restoreAllMocks()
    const ids: string[] = []
    for (let i = 0; i < MAX_FINISHED + 5; i++) ids.push(jobs.start('t', async () => i).id)
    await vi.waitFor(() => expect(jobs.get(ids.at(-1)!)?.state).toBe('succeeded'))
    jobs.start('t', async () => 0) // sweeps
    expect(ids.filter((id) => jobs.get(id)).length).toBe(MAX_FINISHED)
  })
})
