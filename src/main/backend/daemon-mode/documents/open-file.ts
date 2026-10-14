import type { DaemonClient } from '../../../../shared/daemon-client'
import { DaemonError } from '../../../../shared/daemon-client'
import { isNotFound, type DaemonModeContext } from '../context'
import { DaemonModeUnavailableError } from '../errors'

/**
 * How W3-A's handlers reach "the open file" (design D3, D4).
 *
 * Embedded handlers act on `currentWorkspace`, the workspace of the file the
 * renderer opened. In daemon mode that file is `ctx.session.filePath`, and
 * its agent in the daemon is `ctx.session.agentId`: the open document the
 * client session holds (W2-B hold), or the agent already running at that
 * path. Every `/agents/:id/*` resource route serves both (W2-A).
 *
 * Without a file open the handler answers exactly what embedded answers
 * without a workspace (`none`). A file that is open but neither held nor
 * running (the interim GET /events adapter cannot hold documents) is refused
 * with the visible W2-B error: nothing reads the file another way.
 */

/** The open file's agent id; null when no file is open. Throws the W2-B refusal when the file is open but unreachable. */
export function openFileAgent(ctx: DaemonModeContext, what: string): string | null {
  if (!ctx.session.filePath) return null
  const id = ctx.session.agentId
  if (id) return id
  throw new DaemonModeUnavailableError(what, 'W2-B', `${ctx.session.filePath} is not running in the daemon, and holding it open needs a client session`)
}

/** The open file's agent id, or the W2-B refusal: for handlers that only run with a file open. */
export function requireOpenAgent(ctx: DaemonModeContext, what: string): string {
  const id = openFileAgent(ctx, what)
  if (id) return id
  throw new DaemonModeUnavailableError(what, 'W2-B', 'no file is open')
}

/**
 * Run `fn` on the open file's agent. `none` is the embedded answer without a
 * workspace. A 404 from the daemon means the agent stopped and nothing holds
 * its document (only without W2-B holds): the W2-B refusal, never a
 * silently empty answer.
 */
export async function onOpenFile<T>(
  ctx: DaemonModeContext,
  what: string,
  none: T | (() => T),
  fn: (client: DaemonClient, agentId: string) => Promise<T>,
): Promise<T> {
  const agentId = openFileAgent(ctx, what)
  if (!agentId) return typeof none === 'function' ? (none as () => T)() : none
  const client = await ctx.ready()
  try {
    return await fn(client, agentId)
  } catch (err) {
    if (isAgentGone(err, agentId)) {
      throw new DaemonModeUnavailableError(what, 'W2-B', `${ctx.session.filePath} is no longer running in the daemon, and holding it open needs a client session`)
    }
    throw err
  }
}

/** The daemon's 404 for the agent itself (`Unknown agent "<id>"`), not for a resource of it (a file, a task, a timer). */
export function isAgentGone(err: unknown, agentId: string): boolean {
  if (!isNotFound(err)) return false
  const message = (err as Error).message
  return message.includes(`Unknown agent "${agentId}"`) || /^HTTP 404/.test(message)
}

/** A daemon answer's HTTP status, or null (unreachable / not a daemon error). */
export function daemonStatus(err: unknown): number | null {
  return err instanceof DaemonError ? err.status : null
}

/** The daemon's stable error code (`body.code`), when it sent one. */
export function daemonCode(err: unknown): string | undefined {
  const body = err instanceof DaemonError ? (err.body as { code?: unknown } | null) : null
  return body && typeof body === 'object' && typeof body.code === 'string' ? body.code : undefined
}

/** The message of a failure: the daemon's `error` sentence, or the error's own. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The failure as embedded's `String(error)` renders a thrown Error
 * ("Error: <message>"): the handlers whose embedded twin answers
 * `{ success: false, error: String(error) }` keep that form.
 */
export function errorString(err: unknown): string {
  return err instanceof Error ? `Error: ${err.message}` : String(err)
}
