/**
 * Long-running daemon work as jobs: a route that may take minutes (an MCP
 * registration test waiting on a browser sign-in, a uv / Python download)
 * answers `202 { jobId, job }` at once instead of holding the request open
 * past a client's or a proxy's timeout. The client polls GET /jobs/:id and
 * may cancel with POST /jobs/:id/cancel (routes/job-routes.ts).
 *
 * A job's `run` gets an AbortSignal; cancel aborts it and marks the job
 * `cancelled` at once. Work that cannot stop mid-way (a download) says so in
 * its own result; the job still reads `cancelled`. Finished jobs are kept
 * for FINISHED_TTL_MS so a slow poller still sees the result, and at most
 * MAX_FINISHED of them.
 *
 * At most MAX_RUNNING jobs run at once: a start past that throws
 * JobLimitError (routes answer 429 too_many_jobs). A job started with a
 * `key` (e.g. the package an install is for) is not started twice: while
 * one with the same kind and key runs, `start` answers that one
 * (`joined: true`), so two clients asking for the same install share it.
 * After a cancel the work may still run (an install cannot stop half-way):
 * a new job with that key starts, and waits for that work to settle before
 * its own begins.
 *
 * Generic: other route modules create jobs through `jobsFor(ctx)`.
 */

import { randomUUID } from 'crypto'

export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobView {
  id: string
  /** What the job does, e.g. `mcp.registration-test`. */
  kind: string
  state: JobState
  createdAt: number
  finishedAt?: number
  /** The work's answer (state `succeeded`). */
  result?: unknown
  /** Why it failed or was cancelled. */
  error?: string
  /** Free-form progress the work reports while running: its latest line. */
  progress?: string
  /** The last MAX_PROGRESS_LOG progress lines, oldest first, numbered from 1 per job. */
  progressLog?: JobProgressEntry[]
}

export interface JobProgressEntry {
  seq: number
  text: string
  /** What the line is about, e.g. `{ package }` for an install. */
  detail?: Record<string, unknown>
}

interface Job extends JobView {
  controller: AbortController
  /** Dedupe key within `kind` (see `start`). */
  key?: string
}

export const FINISHED_TTL_MS = 10 * 60_000
export const MAX_FINISHED = 100
/** Progress lines kept per job (JobView.progressLog). */
export const MAX_PROGRESS_LOG = 50
/** Jobs running at once; a start past it is refused. */
export const MAX_RUNNING = 128

/** Too many jobs run at once. Routes answer 429 `too_many_jobs`. */
export class JobLimitError extends Error {
  readonly code = 'too_many_jobs'
  constructor() { super(`Too many jobs are running on this daemon (${MAX_RUNNING}); try again when some have finished.`) }
}

export interface StartOptions {
  /** While a job of the same kind and key runs, `start` answers it instead of starting another. */
  key?: string
}

export interface JobContext {
  signal: AbortSignal
  id: string
  /** Report a progress line (`progress`, and appended to `progressLog`). */
  setProgress(progress: string, detail?: Record<string, unknown>): void
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>()
  /** Per kind and key: the work of the last job started with it, until it settles. */
  private readonly keyWork = new Map<string, Promise<void>>()

  start(kind: string, run: (ctx: JobContext) => Promise<unknown>, opts: StartOptions = {}): JobView & { joined?: true } {
    this.sweep()
    if (opts.key !== undefined) {
      const same = [...this.jobs.values()].find((j) => j.state === 'running' && j.kind === kind && j.key === opts.key)
      if (same) {
        console.log(`[ADF Daemon] Job ${same.id} (${kind}) already runs for ${opts.key}; the request joins it`)
        return { ...this.view(same), joined: true }
      }
    }
    if (this.runningCount() >= MAX_RUNNING) throw new JobLimitError()
    const job: Job = { id: randomUUID(), kind, state: 'running', createdAt: Date.now(), controller: new AbortController(), ...(opts.key !== undefined ? { key: opts.key } : {}) }
    this.jobs.set(job.id, job)
    console.log(`[ADF Daemon] Job ${job.id} (${kind}) started`)
    const ctx: JobContext = { signal: job.controller.signal, id: job.id, setProgress: (p, detail) => this.progress(job, p, detail) }
    // The key stays taken until the work of the last job with it has settled,
    // not only while that job reads `running`: a cancelled install keeps
    // installing, and a retry must not install into the same place meanwhile.
    const slot = opts.key !== undefined ? `${kind}|${opts.key}` : null
    const previous = slot ? this.keyWork.get(slot) : undefined
    const work = Promise.resolve().then(async () => {
      if (previous) {
        console.log(`[ADF Daemon] Job ${job.id} (${kind}) waits for the cancelled job's work for ${opts.key} to finish`)
        this.progress(job, 'Waiting for a cancelled run of the same work to finish')
        await previous
        if (job.controller.signal.aborted) throw new Error('Cancelled by the client')
      }
      return run(ctx)
    })
    work.then(
      (result) => this.finish(job, 'succeeded', { result }),
      (err) => this.finish(job, 'failed', { error: err instanceof Error ? err.message : String(err) }),
    )
    if (slot) {
      const settled = work.then(() => {}, () => {})
      this.keyWork.set(slot, settled)
      void settled.then(() => { if (this.keyWork.get(slot) === settled) this.keyWork.delete(slot) })
    }
    return this.view(job)
  }

  /** Whether the work of a job with this kind and key has not settled yet (running, or cancelled and still working). */
  keyBusy(kind: string, key: string): boolean {
    return this.keyWork.has(`${kind}|${key}`)
  }

  get(id: string): JobView | undefined {
    this.sweep()
    const job = this.jobs.get(id)
    return job ? this.view(job) : undefined
  }

  /** Abort a running job. False when it is unknown or already finished. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'running') return false
    job.controller.abort()
    this.finish(job, 'cancelled', { error: 'Cancelled by the client' })
    return true
  }

  runningCount(): number {
    let n = 0
    for (const job of this.jobs.values()) if (job.state === 'running') n++
    return n
  }

  /** Abort every running job (server close). */
  cancelAll(): void {
    for (const job of this.jobs.values()) if (job.state === 'running') this.cancel(job.id)
  }

  private progress(job: Job, text: string, detail?: Record<string, unknown>): void {
    job.progress = text
    const log = job.progressLog ?? (job.progressLog = [])
    const seq = (log.at(-1)?.seq ?? 0) + 1
    log.push({ seq, text, ...(detail ? { detail } : {}) })
    if (log.length > MAX_PROGRESS_LOG) log.splice(0, log.length - MAX_PROGRESS_LOG)
  }

  private finish(job: Job, state: Exclude<JobState, 'running'>, out: { result?: unknown; error?: string }): void {
    // A job cancelled first keeps that outcome; its work settling later is ignored.
    if (job.state !== 'running') return
    job.state = state
    job.finishedAt = Date.now()
    if (out.result !== undefined) job.result = out.result
    if (out.error !== undefined) job.error = out.error
    console.log(`[ADF Daemon] Job ${job.id} (${job.kind}) ${state}${out.error ? `: ${out.error}` : ''}`)
  }

  private view(job: Job): JobView {
    const { controller: _controller, key: _key, ...rest } = job
    return { ...rest, ...(rest.progressLog ? { progressLog: rest.progressLog.map((e) => ({ ...e })) } : {}) }
  }

  private sweep(): void {
    const now = Date.now()
    const finished = [...this.jobs.values()].filter((j) => j.state !== 'running')
    for (const job of finished) {
      if (now - (job.finishedAt ?? now) > FINISHED_TTL_MS) this.jobs.delete(job.id)
    }
    const left = finished.filter((j) => this.jobs.has(j.id)).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    while (left.length > MAX_FINISHED) this.jobs.delete(left.shift()!.id)
  }
}

const registries = new WeakMap<object, JobRegistry>()

/** The job registry of one HTTP API instance (keyed by its options object). */
export function jobsFor(key: object): JobRegistry {
  let registry = registries.get(key)
  if (!registry) {
    registry = new JobRegistry()
    registries.set(key, registry)
  }
  return registry
}
