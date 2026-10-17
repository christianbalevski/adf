import { DaemonError, type DaemonClient } from '../../../../shared/daemon-client'

/**
 * Waiting on a daemon job (daemon/jobs.ts: `202 { jobId }`, GET /jobs/:id,
 * POST /jobs/:id/cancel) for an invoke the renderer awaits as one promise.
 *
 * Each poll is a short request, so no request outlives the shared client's
 * timeout or undici's 300 s header limit, however long the work takes. A
 * daemon that cannot be reached is polled again for `unreachableMs` (a
 * reconnect, a busy daemon) before the wait gives up; a job the daemon no
 * longer knows (404: it restarted) ends the wait at once. Past `deadlineMs`
 * this wait ends; the job is cancelled only with `cancelOnDeadline`, for a
 * job no other client can have joined (one started without a key): another
 * client waiting on a shared install keeps its own deadline. Every outcome
 * other than a finished job is a sentence the handler shows, never a silent
 * hang.
 */

export interface DaemonJobProgress {
  seq: number
  text: string
  detail?: Record<string, unknown>
}

export interface DaemonJobView {
  id: string
  kind: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
  progress?: string
  progressLog?: DaemonJobProgress[]
  joined?: boolean
}

export type JobOutcome =
  | { kind: 'finished'; job: DaemonJobView }
  /** The wait ended without the job's end: `reason` says why, in a sentence. */
  | { kind: 'lost'; reason: string }

export interface AwaitJobOptions {
  /** Between polls. Default 250 ms. */
  pollMs?: number
  /** This wait ends after this long. */
  deadlineMs: number
  /** Cancel the job at the deadline: only for a job no other client shares. */
  cancelOnDeadline?: boolean
  /** How long the daemon may be unreachable before the wait gives up. Default 60 s. */
  unreachableMs?: number
  /** Called with every running view (progress) and once with the finished one. */
  onPoll?: (job: DaemonJobView) => void | Promise<void>
  /** What the job does, for the sentences ("the MCP package install"). */
  what: string
  log?: Pick<Console, 'warn'>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** POST a job-starting route; its 202 body. */
export async function startDaemonJob(client: DaemonClient, path: string, body?: unknown): Promise<{ jobId: string; job: DaemonJobView }> {
  return client.request<{ jobId: string; job: DaemonJobView }>('POST', path, body === undefined ? {} : { body })
}

export async function awaitDaemonJob(client: () => Promise<DaemonClient>, jobId: string, opts: AwaitJobOptions): Promise<JobOutcome> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 250
  const unreachableMs = opts.unreachableMs ?? 60_000
  const started = now()
  let reachedAt = started
  for (;;) {
    let job: DaemonJobView | null = null
    try {
      job = await (await client()).request<DaemonJobView>('GET', `/jobs/${encodeURIComponent(jobId)}`)
      reachedAt = now()
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404) {
        return { kind: 'lost', reason: `The ADF daemon no longer knows ${opts.what} (it restarted while it ran); nothing reports how it ended.` }
      }
      if (!(err instanceof DaemonError) || err.status !== null) throw err
      if (now() - reachedAt > unreachableMs) {
        return { kind: 'lost', reason: `The ADF daemon could not be reached for ${Math.round(unreachableMs / 1000)} s while ${opts.what} ran; it may still finish there.` }
      }
    }
    if (job) {
      await opts.onPoll?.(job)
      if (job.state !== 'running') return { kind: 'finished', job }
    }
    if (now() - started > opts.deadlineMs) {
      const minutes = Math.round(opts.deadlineMs / 60_000)
      if (!opts.cancelOnDeadline) {
        opts.log?.warn(`[Backend] ${opts.what} (job ${jobId}) ran past ${minutes} min; Studio stops waiting, the daemon keeps it`)
        return { kind: 'lost', reason: `${capitalize(opts.what)} did not finish within ${minutes} minutes; Studio stopped waiting, and it may still finish in the ADF daemon.` }
      }
      opts.log?.warn(`[Backend] ${opts.what} (job ${jobId}) ran past ${minutes} min; cancelling it`)
      try { await (await client()).request('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`) } catch { /* the daemon answers or not; the wait ends either way */ }
      return { kind: 'lost', reason: `${capitalize(opts.what)} did not finish within ${minutes} minutes; Studio cancelled it.` }
    }
    await sleep(pollMs)
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
