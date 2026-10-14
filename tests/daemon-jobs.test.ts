// daemon/jobs.ts: long-running work answered as 202 + GET /jobs/:id.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINISHED_TTL_MS, JobLimitError, JobRegistry, MAX_FINISHED, MAX_PROGRESS_LOG, MAX_RUNNING } from '../src/main/daemon/jobs'

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

  it('a start with the key of a running job of the same kind joins it', async () => {
    const jobs = new JobRegistry()
    let finish!: () => void
    const run = vi.fn(async () => { await new Promise<void>((r) => { finish = r }); return 'done' })
    const first = jobs.start('t.install', run, { key: 'pkg-a' })
    const again = jobs.start('t.install', run, { key: 'pkg-a' })
    const other = jobs.start('t.install', async () => 'b', { key: 'pkg-b' })
    expect(again).toMatchObject({ id: first.id, joined: true })
    expect(other.id).not.toBe(first.id)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    finish()
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe('succeeded'))
    // Finished: the next start is a new job.
    expect(jobs.start('t.install', async () => 0, { key: 'pkg-a' }).id).not.toBe(first.id)
  })

  it('refuses a start past MAX_RUNNING running jobs', () => {
    const jobs = new JobRegistry()
    const never = () => new Promise<never>(() => {})
    for (let i = 0; i < MAX_RUNNING; i++) jobs.start('t.hold', never)
    expect(() => jobs.start('t.hold', never)).toThrow(JobLimitError)
    expect(jobs.runningCount()).toBe(MAX_RUNNING)
    jobs.cancelAll()
    expect(jobs.runningCount()).toBe(0)
    expect(() => jobs.start('t.hold', never)).not.toThrow()
    jobs.cancelAll()
  })

  it('keeps the last progress lines, numbered, with their detail', async () => {
    const jobs = new JobRegistry()
    const job = jobs.start('t.progress', async (ctx) => {
      for (let i = 1; i <= MAX_PROGRESS_LOG + 3; i++) ctx.setProgress(`line ${i}`, { package: 'p' })
    })
    await vi.waitFor(() => expect(jobs.get(job.id)?.state).toBe('succeeded'))
    const view = jobs.get(job.id)!
    expect(view.progress).toBe(`line ${MAX_PROGRESS_LOG + 3}`)
    expect(view.progressLog).toHaveLength(MAX_PROGRESS_LOG)
    expect(view.progressLog![0]).toEqual({ seq: 4, text: 'line 4', detail: { package: 'p' } })
    expect(view.progressLog!.at(-1)?.seq).toBe(MAX_PROGRESS_LOG + 3)
  })
})
