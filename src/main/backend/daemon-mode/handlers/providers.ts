import { dialog, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError, type DaemonClient } from '../../../../shared/daemon-client'
import { startCallbackServer } from '../../../providers/chatgpt-subscription/callback-server'
import { enc, type DaemonHandlerTable, type DaemonModeContext } from '../context'

/**
 * The daemon-mode handlers of providers, models and subscription sign-in
 * (tracker W3-B). Results have the embedded handlers' shapes
 * (src/main/ipc/index.ts); the daemon holds every key and session token.
 *
 * Secrets: an app provider's key reaches Studio only as `__redacted__`
 * (GET /settings, §4.2). "Copy app key" sends that placeholder back as an
 * agent's provider key; it is never stored as a key: the daemon copies the
 * real key itself (POST …/credential/copy-app-key). An agent's own provider
 * key is read for the override form through the local-only reveal route.
 * Subscription tokens stay in the daemon (`<provider>/auth.daemon.json`,
 * §5.1); Studio main only opens the sign-in pages in this machine's browser
 * and relays the ChatGPT callback.
 */

/** Stored values in remote mode (channel map: remote-unsupported): the daemon's reveal routes answer its own machine only. */
export const REMOTE_VALUES_UNSUPPORTED = 'Stored credential values stay on the daemon\'s machine: a remote daemon never sends them to Studio.'

/** GET /settings answers provider keys as this (daemon/http-api.ts). */
export const REDACTED_API_KEY = '__redacted__'

/** The embedded handlers' argument schemas: a bad call is refused the same way, and unknown fields are dropped. */
const credentialSetArgs = z.object({ filePath: z.string(), providerId: z.string(), value: z.string() })
const credentialGetArgs = z.object({ filePath: z.string(), providerId: z.string() })
const providerAttachArgs = z.object({
  filePath: z.string(),
  provider: z.object({
    id: z.string().min(1),
    type: z.enum(['anthropic', 'openai', 'openai-compatible', 'openrouter']),
    name: z.string(),
    baseUrl: z.string(),
    preset: z.string().optional(),
    defaultModel: z.string().optional(),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    requestDelayMs: z.number().optional(),
  }),
})
const providerDetachArgs = z.object({ filePath: z.string(), providerId: z.string() })
const keySourcesArgs = z.object({
  filePath: z.string(),
  providers: z.array(z.object({ id: z.string(), type: z.string(), baseUrl: z.string() })),
})

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** Embedded answers `String(error)` of a thrown Error: `Error: <message>`. */
const errorText = (err: unknown): string => String(new Error(message(err)))
const codeOf = (err: unknown): string | undefined => {
  const body = err instanceof DaemonError ? (err.body as { code?: unknown } | null) : null
  return body && typeof body.code === 'string' ? body.code : undefined
}

/**
 * A credential write the daemon refused because the agent's credentials
 * envelope is locked here (409 `credentials_locked`): the owner chooses, in a
 * native dialog, to replace (the daemon then stores it, discarding a locked
 * sealed value unread, and logs that in the agent's logs) or to cancel. The
 * same choices as the terminal app (src/main/tui/setup/LockedCredential.tsx).
 * True when the owner chose to replace.
 */
export async function confirmLockedReplace(ctx: DaemonModeContext, purpose: string, err: unknown): Promise<boolean> {
  const sealedRow = /can't be read or overwritten/.test(message(err))
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: sealedRow
      ? `The saved "${purpose}" of this agent is sealed, and its credentials are locked on this machine.`
      : `This agent's credentials are locked on this machine.`,
    detail: sealedRow
      ? 'It cannot be read or overwritten until the credentials unlock (the share password on the Identity tab, or your owner identity). Replace it anyway? The old value is discarded unread.'
      : `Store "${purpose}" unsealed anyway? It is sealed once the credentials unlock (the share password on the Identity tab, or your owner identity).`,
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  const replace = response === 0
  ctx.log.log(`[Backend] ${purpose}: the agent's credentials are locked in the daemon; the owner chose to ${replace ? 'replace' : 'cancel'}`)
  return replace
}

/** A path-addressed credential write, with the locked-envelope choice on 409 `credentials_locked`. */
async function writeWithLockedChoice(ctx: DaemonModeContext, purpose: string, write: (replace: boolean) => Promise<unknown>): Promise<void> {
  try {
    await write(false)
  } catch (err) {
    if (codeOf(err) !== 'credentials_locked') throw err
    if (!(await confirmLockedReplace(ctx, purpose, err))) throw err
    await write(true)
  }
}

/**
 * The auth managers' status shapes, with the fields JSON drops when they are
 * undefined put back (`flowError: undefined` while no flow failed), so the
 * renderer gets the same object.
 */
type AuthStatus = { authenticated: boolean } & Record<string, unknown>
function statusShape(status: AuthStatus, signedIn: readonly string[], signedOut: readonly string[]): AuthStatus {
  const out: AuthStatus = { ...status }
  for (const key of status.authenticated ? signedIn : signedOut) if (!(key in out)) out[key] = undefined
  return out
}

/** Where the daemon's sign-in pages may point: the providers' own sign-in hosts (auth-manager.ts of each). */
const CHATGPT_SIGN_IN_HOSTS = ['auth.openai.com']
const GROK_SIGN_IN_HOSTS = ['x.ai', '.x.ai']

/**
 * Open a sign-in page the daemon handed over in this machine's browser, only
 * when it is an https page of the provider's own sign-in hosts (an entry
 * starting with "." admits subdomains): a daemon, or anything that answers
 * on its port, never makes Studio open another address.
 */
export async function openSignInPage(url: string, hosts: readonly string[]): Promise<void> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('The ADF daemon sent a sign-in address that is not a URL; it was not opened.') }
  const host = parsed.hostname.toLowerCase()
  const allowed = hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h))
  if (parsed.protocol !== 'https:' || !allowed) {
    throw new Error(`The ADF daemon sent an unexpected sign-in address (${parsed.protocol}//${host}); it was not opened.`)
  }
  await shell.openExternal(parsed.toString())
}

/** One ChatGPT sign-in at a time per Studio, as the embedded auth manager runs one flow. */
const chatgptFlows = new WeakMap<DaemonModeContext, Promise<{ success: boolean; error?: string }>>()

/**
 * ChatGPT sign-in in relay mode, in both daemon modes: Studio main runs the
 * OAuth callback server on this machine (where the browser is), the daemon
 * keeps the PKCE verifier and exchanges the code, and the tokens are written
 * only by the daemon. Resolves, as embedded does, when the sign-in finished
 * or failed (the callback server waits 120 s).
 */
async function chatgptSignIn(ctx: DaemonModeContext, client: DaemonClient): Promise<{ success: boolean; error?: string }> {
  const server = await startCallbackServer()
  try {
    const redirectUri = `http://localhost:${server.port}/auth/callback`
    const flow = await client.request<{ flowId: string; authUrl: string; state: string }>('POST', '/auth/chatgpt/start', { body: { mode: 'relay', redirectUri } })
    ctx.log.log('[Backend] ChatGPT sign-in: opening the sign-in page in the browser')
    await openSignInPage(flow.authUrl, CHATGPT_SIGN_IN_HOSTS)
    const result = await server.waitForCallback()
    if (result.state !== flow.state) throw new Error('OAuth state mismatch — possible CSRF attack')
    await client.request('POST', '/auth/chatgpt/complete', { body: { flowId: flow.flowId, code: result.code, state: result.state }, timeoutMs: 60_000 })
    ctx.log.log('[Backend] ChatGPT sign-in completed in the daemon')
    return { success: true }
  } catch (err) {
    ctx.log.warn(`[Backend] ChatGPT sign-in failed: ${message(err)}`)
    return { success: false, error: message(err) }
  } finally {
    server.close()
  }
}

export const PROVIDER_HANDLERS: DaemonHandlerTable = {
  // --- models ------------------------------------------------------------------------
  [IPC.MODELS_LIST]: async (ctx, _event, args: { provider: string; filePath?: string }) => {
    const client = await ctx.ready()
    const list = (filePath?: string) => client.request<{ models: string[]; error?: string }>('GET', '/runtime/models', { query: { provider: args.provider, filePath } })
    let answer: { models: string[]; error?: string }
    try {
      answer = await list(args.filePath)
    } catch (err) {
      // Embedded looks at app providers first and ignores a file it cannot open.
      if (!(err instanceof DaemonError) || err.status !== 400 || !args.filePath) throw err
      answer = await list(undefined)
    }
    if (answer.error === `Provider "${args.provider}" not found.`) {
      return { models: [], error: `Provider "${args.provider}" not found in settings.` }
    }
    return answer.error !== undefined ? { models: answer.models, error: answer.error } : { models: answer.models }
  },

  [IPC.PROVIDER_TEST]: async (ctx, _event, args: { providerId: string; force?: boolean }) => {
    if (!args?.providerId) return { status: 'unconfigured' }
    const client = await ctx.ready()
    return client.request('POST', `/runtime/providers/${enc(args.providerId)}/test`, { body: { force: args.force === true }, timeoutMs: 60_000 })
  },

  // --- per-agent provider copies (path-addressed: any file, open or not) ------------
  [IPC.PROVIDER_CREDENTIAL_SET]: async (ctx, _event, rawArgs: unknown) => {
    const args = credentialSetArgs.parse(rawArgs)
    const purpose = `provider:${args.providerId}:apiKey`
    try {
      const client = await ctx.ready()
      const query = { path: args.filePath }
      await writeWithLockedChoice(ctx, purpose, (replace) => args.value === REDACTED_API_KEY
        // "Copy app key": the placeholder stands for the app provider's key, which only the daemon holds.
        ? client.request('POST', `/files/agent/providers/${enc(args.providerId)}/credential/copy-app-key`, { query, body: replace ? { replace } : {} })
        : client.request('PUT', `/files/agent/providers/${enc(args.providerId)}/credential`, { query, body: { value: args.value, ...(replace ? { replace } : {}) } }))
      return { success: true }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  },

  /** Values for the override form's key field (local-only reveal route) plus the file's provider entry. */
  [IPC.PROVIDER_CREDENTIAL_GET]: async (ctx, _event, rawArgs: unknown) => {
    const args = credentialGetArgs.parse(rawArgs)
    const prefix = `provider:${args.providerId}:`
    if (ctx.mode === 'remote') return { credentials: {}, error: REMOTE_VALUES_UNSUPPORTED }
    try {
      const client = await ctx.ready()
      const query = { path: args.filePath }
      const [meta, revealed] = await Promise.all([
        client.request<{ providerConfig?: { defaultModel?: string; params?: unknown; requestDelayMs?: number } }>('GET', `/files/agent/providers/${enc(args.providerId)}/credentials`, { query }),
        client.request<{ values: Record<string, string> }>('POST', '/files/agent/identity/reveal', { query, body: { prefix } }),
      ])
      const credentials: Record<string, string> = {}
      for (const [purpose, value] of Object.entries(revealed.values)) if (value) credentials[purpose.slice(prefix.length)] = value
      const p = meta.providerConfig
      return {
        credentials,
        providerConfig: p ? { defaultModel: p.defaultModel, params: p.params, requestDelayMs: p.requestDelayMs } : undefined,
      }
    } catch (err) {
      return { credentials: {}, error: errorText(err) }
    }
  },

  [IPC.PROVIDER_CREDENTIAL_LIST_FILES]: async (ctx, _event, rawArgs: unknown) => {
    const args = z.object({ providerId: z.string() }).parse(rawArgs)
    const client = await ctx.ready()
    return client.request('GET', '/credentials/providers/files', { query: { providerId: args.providerId } })
  },

  [IPC.PROVIDER_ATTACH]: async (ctx, _event, rawArgs: unknown) => {
    const args = providerAttachArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      const result = await client.request<{ alreadyAttached?: boolean }>('POST', '/files/agent/providers', { query: { path: args.filePath }, body: { provider: args.provider } })
      return result.alreadyAttached ? { success: true, alreadyAttached: true } : { success: true }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  },

  [IPC.PROVIDER_DETACH]: async (ctx, _event, rawArgs: unknown) => {
    const args = providerDetachArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      await client.request('DELETE', `/files/agent/providers/${enc(args.providerId)}`, { query: { path: args.filePath } })
      return { success: true }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  },

  [IPC.PROVIDER_AGENT_KEY_SOURCES]: async (ctx, _event, rawArgs: unknown) => {
    const args = keySourcesArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      const answer = await client.request<{ sources: Record<string, string>; error?: string }>('POST', '/credentials/providers/key-sources', { body: args })
      return answer.error !== undefined ? { sources: answer.sources, error: answer.error } : { sources: answer.sources }
    } catch (err) {
      return { sources: {}, error: errorText(err) }
    }
  },

  // --- ChatGPT -------------------------------------------------------------------------
  [IPC.CHATGPT_AUTH_START]: async (ctx) => {
    const running = chatgptFlows.get(ctx)
    if (running) return running
    const flow = (async () => {
      try {
        return await chatgptSignIn(ctx, await ctx.ready())
      } catch (err) {
        return { success: false, error: message(err) }
      }
    })()
    chatgptFlows.set(ctx, flow)
    try {
      return await flow
    } finally {
      chatgptFlows.delete(ctx)
    }
  },

  [IPC.CHATGPT_AUTH_STATUS]: async (ctx) => {
    try {
      return statusShape(await (await ctx.ready()).request<AuthStatus>('GET', '/auth/chatgpt/status'), ['email', 'expiresAt'], [])
    } catch {
      return { authenticated: false }
    }
  },

  [IPC.CHATGPT_AUTH_LOGOUT]: async (ctx) => {
    try {
      await (await ctx.ready()).request('POST', '/auth/chatgpt/logout')
    } catch (err) {
      ctx.log.warn(`[Backend] ChatGPT sign-out failed in the daemon: ${message(err)}`)
    }
    return { success: true }
  },

  // --- Grok (device code) ----------------------------------------------------------------
  /** The daemon polls xAI for the approval; Studio opens the approval page in this machine's browser, as embedded does. */
  [IPC.GROK_AUTH_START]: async (ctx) => {
    try {
      const client = await ctx.ready()
      const flow = await client.request<{ userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }>('POST', '/auth/grok/start', { timeoutMs: 60_000 })
      ctx.log.log('[Backend] Grok sign-in: opening the approval page in the browser')
      await openSignInPage(flow.verificationUriComplete ?? flow.verificationUri, GROK_SIGN_IN_HOSTS)
      return {
        success: true,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        verificationUriComplete: flow.verificationUriComplete,
        expiresIn: flow.expiresIn,
      }
    } catch (err) {
      return { success: false, error: message(err) }
    }
  },

  [IPC.GROK_AUTH_STATUS]: async (ctx) => {
    try {
      return statusShape(await (await ctx.ready()).request<AuthStatus>('GET', '/auth/grok/status'), ['email', 'expiresAt'], ['flowPending', 'flowError'])
    } catch {
      return { authenticated: false }
    }
  },

  [IPC.GROK_AUTH_LOGOUT]: async (ctx) => {
    try {
      await (await ctx.ready()).request('POST', '/auth/grok/logout')
    } catch (err) {
      ctx.log.warn(`[Backend] Grok sign-out failed in the daemon: ${message(err)}`)
    }
    return { success: true }
  },

  // --- Claude (Claude Code on the daemon host) ------------------------------------------
  /**
   * Claude Code on the daemon host runs the sign-in and opens the browser
   * itself; in local mode that host is this machine. `url` is the fallback
   * (remote mode, W4-B).
   */
  [IPC.CLAUDE_AUTH_START]: async (ctx) => {
    try {
      const client = await ctx.ready()
      const flow = await client.request<{ url?: string }>('POST', '/auth/claude/start', { timeoutMs: 60_000 })
      return { success: true, url: flow.url }
    } catch (err) {
      const body = err instanceof DaemonError ? (err.body as { code?: unknown; installUrl?: unknown } | null) : null
      if (ctx.mode === 'local' && body?.code === 'claude_code_not_installed' && typeof body.installUrl === 'string') {
        // The daemon host is this machine: say it as embedded does.
        return { success: false, error: `Claude Code is not installed. Install it (${body.installUrl}), then sign in with Claude.` }
      }
      return { success: false, error: message(err) }
    }
  },

  [IPC.CLAUDE_AUTH_STATUS]: async (ctx, _event, args?: { recheck?: boolean }) => {
    try {
      return await (await ctx.ready()).request('GET', '/auth/claude/status', { query: { recheck: args?.recheck === true ? 1 : undefined }, timeoutMs: 60_000 })
    } catch (err) {
      return { authenticated: false, installed: true, version: '', flowError: message(err) }
    }
  },

  [IPC.CLAUDE_AUTH_SUBMIT_CODE]: async (ctx, _event, args: { code: string }) => {
    try {
      const client = await ctx.ready()
      const code = args?.code ?? ''
      if (!code.trim()) {
        // The daemon refuses a blank code before it looks for a sign-in; embedded looks first.
        const status = await client.request<{ flowPending?: boolean }>('GET', '/auth/claude/status')
        return { success: false, error: status.flowPending ? 'Paste the code shown on the Claude sign-in page.' : 'No Claude sign-in is in progress.' }
      }
      await client.request('POST', '/auth/claude/code', { body: { code } })
      return { success: true }
    } catch (err) {
      return { success: false, error: message(err) }
    }
  },

  [IPC.CLAUDE_AUTH_CANCEL]: async (ctx) => {
    try {
      await (await ctx.ready()).request('POST', '/auth/claude/cancel')
    } catch { /* nothing to cancel */ }
    return { success: true }
  },

  [IPC.CLAUDE_AUTH_LOGOUT]: async (ctx) => {
    try {
      await (await ctx.ready()).request('POST', '/auth/claude/logout', { timeoutMs: 60_000 })
      return { success: true }
    } catch (err) {
      return { success: false, error: message(err) }
    }
  },
}
