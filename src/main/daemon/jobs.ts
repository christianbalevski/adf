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
  /** Free-form progress the work reports while running. */
  progress?: string
}

interface Job extends JobView {
  controller: AbortController
}

export const FINISHED_TTL_MS = 10 * 60_000
export const MAX_FINISHED = 100

export interface JobContext {
  signal: AbortSignal
  id: string
  setProgress(progress: string): void
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>()

  start(kind: string, run: (ctx: JobContext) => Promise<unknown>): JobView {
    this.sweep()
    const job: Job = { id: randomUUID(), kind, state: 'running', createdAt: Date.now(), controller: new AbortController() }
    this.jobs.set(job.id, job)
    console.log(`[ADF Daemon] Job ${job.id} (${kind}) started`)
    void Promise.resolve()
      .then(() => run({ signal: job.controller.signal, id: job.id, setProgress: (p) => { job.progress = p } }))
      .then(
        (result) => this.finish(job, 'succeeded', { result }),
        (err) => this.finish(job, 'failed', { error: err instanceof Error ? err.message : String(err) }),
      )
    return this.view(job)
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

  /** Abort every running job (server close). */
  cancelAll(): void {
    for (const job of this.jobs.values()) if (job.state === 'running') this.cancel(job.id)
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
    const { controller: _controller, ...rest } = job
    return { ...rest }
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
