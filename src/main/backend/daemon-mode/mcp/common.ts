import { DaemonError, type DaemonClient } from '../../../../shared/daemon-client'
import type { DaemonModeContext } from '../context'
import type { InstallChannel, InstallEnd } from './install-progress'
import { awaitDaemonJob, startDaemonJob } from './jobs'

/**
 * Pieces the W3-C handlers share: error text in the embedded handlers'
 * words, the path-addressed agent-file routes, and installs run as daemon
 * jobs with their progress pushes.
 */

/**
 * What a remote daemon's MCP credential read answers in place of a stored
 * value (as for provider keys, design §5): the value stays on the daemon's
 * machine. In local mode Studio reads the values themselves (revealValues).
 */
export const REDACTED_VALUE = '__redacted__'

/**
 * The stored values under `prefix` of an agent file, for Studio's own window
 * on the daemon's machine: POST /files/agent/identity/reveal (W3-B), which
 * answers local callers that present the local proof only (the client sends
 * it). Key material never comes back; a value the daemon cannot read here
 * is left out. Keyed by the part after the prefix.
 */
export async function revealValues(client: DaemonClient, filePath: string, prefix: string): Promise<Record<string, string>> {
  const { values } = await client.request<{ values: Record<string, string> }>('POST', '/files/agent/identity/reveal', { query: atPath(filePath), body: { prefix } })
  const out: Record<string, string> = {}
  for (const [purpose, value] of Object.entries(values ?? {})) if (purpose.startsWith(prefix)) out[purpose.slice(prefix.length)] = value
  return out
}

/**
 * Remote mode: a credential write whose value is or starts with the
 * placeholder. The untouched placeholder of a key the file stores keeps the
 * stored value (`keep`); anything else built from it cannot be saved, and
 * says so instead of storing the placeholder as the secret: an edited
 * placeholder (`__redacted__abc`), or the placeholder under a key the file
 * does not store (a renamed key). Null for an ordinary value.
 */
export function placeholderWrite(value: string, stored: boolean, envKey: string): { keep: true } | { error: string } | null {
  if (!value.startsWith(REDACTED_VALUE)) return null
  if (value === REDACTED_VALUE && stored) return { keep: true }
  return {
    error: value === REDACTED_VALUE
      ? `${envKey} has no stored value to keep: a remote ADF daemon never sends stored values, so its field showed a placeholder. Type the value for ${envKey}.`
      : `The value of ${envKey} was shown as a placeholder (a remote ADF daemon never sends stored values), so an edit of it cannot be saved. Clear the field and type the whole value.`,
  }
}

/**
 * Embedded handlers answer `String(error)` for a failure ("Error: <message>").
 * The daemon's answer carries the message; the prefix is the one an Error
 * gets, which is what the embedded installers and workspace calls throw.
 */
export function errorText(err: unknown): string {
  if (err instanceof DaemonError) return `Error: ${err.message}`
  return String(err)
}

/**
 * A credential write's failure: a refusal (409, e.g. a credentials envelope
 * this daemon cannot open) reads as embedded's refusals do, without the
 * Error prefix; anything else as `errorText`.
 */
export function refusalText(err: unknown): string {
  return err instanceof DaemonError && err.status === 409 ? err.message : errorText(err)
}

/** The daemon's `code` of a refused request, if any. */
export function errorCode(err: unknown): string | undefined {
  const body = err instanceof DaemonError ? err.body as { code?: unknown } | undefined : undefined
  return typeof body?.code === 'string' ? body.code : undefined
}

/** RuntimeIdentityMeta, as the credential routes answer it (metadata only). */
export interface CredentialMeta {
  present: boolean
  locked: boolean
}

/** An install that can take minutes: a daemon job, polled; the renderer awaits its result. */
const INSTALL_DEADLINE_MS = 30 * 60_000

export interface InstallJobSpec<R> {
  channel: InstallChannel
  /** The packages the install's progress pushes name. */
  packages: readonly string[]
  path: string
  body: unknown
  what: string
  /** The result when the wait ended without the job's (`reason` says why). */
  lost(reason: string): R
  /** Each package's end, from the result. */
  ends(result: R): InstallEnd[]
}

/**
 * Start the install job, follow it to its end and answer its result (the
 * embedded handler's answer). The progress pushes come from the client
 * stream's install topics; the relay sends only an end the stream lost. A
 * wait that ends without the job's end reports the reason as the install's
 * error and its end push.
 */
export async function runInstallJob<R>(ctx: DaemonModeContext, spec: InstallJobSpec<R>): Promise<R> {
  const watch = ctx.installs.begin(spec.channel, spec.packages)
  let result: R
  try {
    const client: DaemonClient = await ctx.ready()
    const { jobId, job } = await startDaemonJob(client, spec.path, spec.body)
    if (job.joined) ctx.log.log(`[Backend] ${spec.what} was already running in the daemon; waiting on that install`)
    const outcome = await awaitDaemonJob(() => ctx.ready(), jobId, {
      what: spec.what,
      deadlineMs: INSTALL_DEADLINE_MS,
      log: ctx.log,
    })
    if (outcome.kind === 'lost') {
      // Nothing on the stream will end this install: its end comes from here.
      watch.gapped = true
      result = spec.lost(outcome.reason)
    } else if (outcome.job.state === 'succeeded') {
      result = outcome.job.result as R
    } else {
      watch.gapped = true
      result = spec.lost(outcome.job.error ?? `The install ${outcome.job.state}`)
    }
  } catch (err) {
    watch.gapped = true
    result = spec.lost(errorText(err))
  }
  await watch.finish(spec.ends(result))
  return result
}

/** A single-package install's answer. */
export type InstallAnswer = { success: true; installed: unknown } | { success: false; error: string }

export function singleInstallEnds(pkg: string): (result: InstallAnswer) => InstallEnd[] {
  return (result) => [result.success ? { package: pkg, status: 'installed' } : { package: pkg, status: 'error', error: result.error }]
}

/** Query for the path-addressed agent file routes (/files/agent/*). */
export function atPath(filePath: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { path: filePath, ...extra }
}
