import type { StudioBackendMode } from '../../../../shared/types/backend.types'
import type { NotificationsSnapshot, PendingNotification } from '../../../../shared/types/ipc.types'

/**
 * Interactive MCP OAuth sign-in for agents running in the daemon (design §6.1,
 * W1-B): after the owner approves `mcp_oauth_signin`, the daemon cannot open
 * a browser, so it raises an `mcp_oauth_authorize` request whose input
 * carries `authorize_url`. Embedded Studio opens the browser itself at that
 * point; so does Studio in daemon mode, without a click, the first time the
 * request shows up in an approvals snapshot (the snapshot carries no inputs:
 * the URL is read from GET /approvals/input). The request stays listed until
 * the runtime settles it (the callback landed, or the flow ended), so the
 * page can be opened again from it.
 *
 * Each authorize URL opens once: the runtime re-raises the same request after
 * an "opened" answer, and a resync repeats the snapshot. Requests already
 * pending when Studio connects (raised while no Studio was attached) are not
 * opened unasked; they are logged and stay in the approvals panel. In remote
 * mode the loopback callback is on the daemon's machine, so the page goes
 * through the callback relay (§9.3, remote/oauth-relay.ts): https pages
 * only, the callback taken on this computer and handed to the daemon.
 */

export const MCP_OAUTH_AUTHORIZE = 'mcp_oauth_authorize'
/** Request ids and authorize URLs remembered. */
const KEPT = 200

export interface McpOAuthAuthorizeDeps {
  mode: Exclude<StudioBackendMode, 'embedded'>
  /**
   * The request's raw input (GET /approvals/input): the broadcast snapshot
   * carries no inputs (approval-hub.ts B8).
   */
  fetchInput(filePath: string, approvalId: string): Promise<unknown>
  openExternal(url: string): Promise<void> | void
  /** Remote mode: open through the callback relay (it checks the URL first). Without it remote mode opens nothing. */
  openRemote?(url: string, label: string): Promise<{ opened: boolean; relaying?: boolean; declined?: boolean; reason?: string }>
  /** A remote sign-in that was refused or is not relayed: shown to the user who approved it. */
  notify?(title: string, text: string): void
  log: Pick<Console, 'log' | 'warn'>
}

/** Only a web page is opened: http(s), nothing else an input could carry. */
function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** A bounded insertion-ordered set. */
class Recent {
  private readonly items = new Set<string>()
  has(key: string): boolean { return this.items.has(key) }
  add(key: string): void {
    this.items.add(key)
    if (this.items.size > KEPT) {
      const oldest = this.items.values().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
  }
}

export class McpOAuthAuthorizeOpener {
  /** Requests looked at (hub ids). */
  private readonly seen = new Recent()
  /** Pages opened (authorize URLs): a re-raised request has a new id and the same URL. */
  private readonly opened = new Recent()
  private seeded = false

  constructor(private readonly deps: McpOAuthAuthorizeDeps) {}

  /** One approvals snapshot (at connect, then every push and resync). Resolves once its new requests are handled (tests). */
  apply(snapshot: NotificationsSnapshot): Promise<void> {
    const requests = (snapshot.pending ?? []).filter((e) => e.kind === 'approval' && e.toolName === MCP_OAUTH_AUTHORIZE && !this.seen.has(e.id))
    for (const entry of requests) this.seen.add(entry.id)
    const seeding = !this.seeded
    this.seeded = true
    return Promise.all(requests.map((entry) => this.handle(entry, seeding))).then(() => {})
  }

  private async handle(entry: PendingNotification, seeding: boolean): Promise<void> {
    type AuthorizeInput = { server?: unknown; authorize_url?: unknown } | null | undefined
    let input: AuthorizeInput
    try {
      input = (await this.deps.fetchInput(entry.filePath, entry.id)) as AuthorizeInput
    } catch (err) {
      this.deps.log.warn(`[MCP] ${entry.agentName}: could not read an OAuth sign-in request: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const url = typeof input?.authorize_url === 'string' ? input.authorize_url : null
    if (!url) return
    const server = typeof input?.server === 'string' ? input.server : 'MCP server'
    if (this.opened.has(url)) return
    this.opened.add(url)
    if (seeding) {
      this.deps.log.log(`[MCP] ${entry.agentName}: an OAuth sign-in for "${server}" was waiting when Studio connected; its authorization page is in the approvals panel (not opened unasked)`)
      return
    }
    if (!isWebUrl(url)) {
      this.deps.log.warn(`[MCP] ${entry.agentName}: the OAuth sign-in for "${server}" carries an authorization URL that is not a web page; not opened`)
      return
    }
    if (this.deps.mode === 'remote') {
      if (!this.deps.openRemote) {
        this.deps.log.warn(`[MCP] ${entry.agentName}: OAuth sign-in for "${server}" waits for its authorization page; its callback is on the daemon's machine and no relay is set up, so Studio does not open it`)
        return
      }
      let result: { opened: boolean; declined?: boolean; reason?: string }
      try {
        result = await this.deps.openRemote(url, `${entry.agentName}: OAuth sign-in for "${server}"`)
      } catch (err) {
        result = { opened: false, reason: err instanceof Error ? err.message : String(err) }
      }
      if (!result.opened) this.deps.log.warn(`[MCP] ${entry.agentName}: the OAuth authorization page for "${server}" was not opened: ${result.reason ?? 'refused'}`)
      // Refused, or opened without the relay: the user who approved the sign-in sees why.
      if (result.reason && !result.declined) this.deps.notify?.(`${entry.agentName}: sign-in to "${server}"`, result.reason)
      return
    }
    this.deps.log.log(`[MCP] ${entry.agentName}: opening the OAuth authorization page for "${server}" in the browser`)
    try {
      await this.deps.openExternal(url)
    } catch (err) {
      this.deps.log.warn(`[MCP] Could not open the OAuth authorization page for "${server}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
