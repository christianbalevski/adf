/**
 * Subscription-provider sign-in against the daemon (ChatGPT, Grok, Claude), shared by
 * the one-shot CLI (`adf auth login`) and the TUI (`/login`). No UI here:
 * callers print or render what `onStart` hands them and the final outcome.
 *
 * - ChatGPT: OAuth with a loopback redirect. A local daemon runs the callback
 *   server itself ("loopback" mode, then we poll its status). A remote daemon
 *   cannot receive the browser's redirect, so the callback server runs here
 *   and the code is relayed to the daemon ("relay" mode).
 * - Grok: device code (RFC 8628): show the code + URL, poll until approved.
 * - Claude: ADF holds no Claude credentials. The daemon runs the Claude Code
 *   CLI on its host (`claude auth login`), which opens the browser there; the
 *   URL is shown as the fallback. If Claude's page shows a code, the user
 *   pastes it and it is relayed to the daemon (`submitClaudeCode`).
 *
 * The daemon keeps these sessions itself (separate from ADF Studio's).
 */

import { spawn as nodeSpawn } from 'child_process'
import { startCallbackServer as startLocalCallbackServer } from '../providers/chatgpt-subscription/callback-server'

export type AuthProvider = 'chatgpt' | 'grok' | 'claude'

export const AUTH_PROVIDERS: AuthProvider[] = ['chatgpt', 'grok', 'claude']

export const AUTH_PROVIDER_LABELS: Record<AuthProvider, string> = {
  chatgpt: 'ChatGPT',
  grok: 'Grok',
  claude: 'Claude',
}

export const RELAY_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
export const AUTH_POLL_INTERVAL_MS = 2_000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * `chatgpt|openai|codex` → chatgpt, `grok|xai` → grok, `claude|claude-code` →
 * claude, else null. Never `anthropic`: that is the API-key provider.
 */
export function normalizeAuthProvider(value: string | undefined): AuthProvider | null {
  switch (value?.toLowerCase()) {
    case 'chatgpt':
    case 'openai':
    case 'codex':
      return 'chatgpt'
    case 'grok':
    case 'xai':
      return 'grok'
    case 'claude':
    case 'claude-code':
      return 'claude'
    default:
      return null
  }
}

/** True when the daemon shares a host with this process (and so with the browser). */
export function daemonIsLocal(daemonUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(daemonUrl).hostname)
  } catch {
    return false
  }
}

/**
 * How to open `url` in the default browser. Never through `cmd /c start`:
 * cmd splits the command line at `&`, truncating OAuth URLs to their first
 * query parameter (OpenAI then shows "unknown_error"). The URL is always one
 * argv entry, untouched.
 */
export function browserLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => { on(event: 'error', fn: (err: Error) => void): unknown; unref(): void }

/** Best-effort browser launch. Silent on failure: callers always show the URL too. */
export function openBrowser(url: string, deps: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {}): void {
  const { command, args } = browserLaunchCommand(url, deps.platform)
  try {
    const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike)
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Headless box with no browser: showing the URL is the fallback.
  }
}

export interface AuthCallbackServer {
  port: number
  waitForCallback: () => Promise<{ code: string; state: string }>
  close: () => void
}

/** JSON call against the daemon (the CLI's requestJson, the TUI's DaemonClient.request). */
export type AuthRequest = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>

export interface AuthFlowDeps {
  request: AuthRequest
  sleep?: (ms: number) => Promise<void>
  openBrowser?: (url: string) => void
  /** Relay mode's local callback server (tests inject one). */
  startCallbackServer?: () => Promise<AuthCallbackServer>
  /** Aborting stops polling / the callback wait; the outcome is `cancelled`. */
  signal?: AbortSignal
}

export type AuthOutcome =
  | { ok: true; email?: string; raw?: unknown }
  | { ok: false; error: string; cancelled?: boolean; timedOut?: boolean; notInstalled?: boolean; installUrl?: string }

export interface ChatGptStartInfo {
  mode: 'loopback' | 'relay'
  authUrl: string
  /** Relay mode: where the browser is sent back to (this machine). */
  redirectUri?: string
  raw: unknown
}

export interface GrokStartInfo {
  userCode: string
  verificationUri: string
  expiresInSec: number
  raw: unknown
}

export interface ClaudeStartInfo {
  /** Sign-in URL; Claude Code on the daemon host opens it itself, this is the fallback. */
  url: string
  raw: unknown
}

/** Claude Code's own login timeout (10 min), plus slack. */
export const CLAUDE_AUTH_TIMEOUT_MS = 11 * 60 * 1000

const CANCELLED: AuthOutcome = { ok: false, error: 'Sign-in cancelled', cancelled: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Sign in to ChatGPT. `mode` auto = loopback for a local daemon, relay for a
 * remote one. `onStart` gets the URL to show (and the browser is opened).
 */
export async function loginChatGpt(
  deps: AuthFlowDeps,
  opts: { daemonUrl: string; mode?: 'auto' | 'relay' | 'loopback'; onStart: (info: ChatGptStartInfo) => void },
): Promise<AuthOutcome> {
  const relay = opts.mode === 'relay' ? true : opts.mode === 'loopback' ? false : !daemonIsLocal(opts.daemonUrl)
  const open = deps.openBrowser ?? openBrowser

  if (!relay) {
    const data = await deps.request('POST', '/auth/chatgpt/start', { mode: 'loopback' })
    const authUrl = isRecord(data) && typeof data.authUrl === 'string' ? data.authUrl : ''
    opts.onStart({ mode: 'loopback', authUrl, raw: data })
    if (deps.signal?.aborted) return CANCELLED
    if (authUrl) open(authUrl)
    return waitForAuth(deps, 'chatgpt', RELAY_CALLBACK_TIMEOUT_MS)
  }

  const server = await (deps.startCallbackServer ?? (() => startLocalCallbackServer(RELAY_CALLBACK_TIMEOUT_MS)))()
  try {
    const redirectUri = `http://localhost:${server.port}/auth/callback`
    const started = await deps.request('POST', '/auth/chatgpt/start', { mode: 'relay', redirectUri })
    if (!isRecord(started) || typeof started.flowId !== 'string' || typeof started.authUrl !== 'string') {
      throw new Error('Daemon did not return a relay auth flow — it may be running an older build')
    }
    opts.onStart({ mode: 'relay', authUrl: started.authUrl, redirectUri, raw: started })
    if (deps.signal?.aborted) return CANCELLED
    open(started.authUrl)

    const callback = await raceAbort(server.waitForCallback(), deps.signal)
    if (!callback) return CANCELLED
    const done = await deps.request('POST', '/auth/chatgpt/complete', { flowId: started.flowId, code: callback.code, state: callback.state })
    const status = isRecord(done) && isRecord(done.status) ? done.status : {}
    return { ok: true, email: typeof status.email === 'string' ? status.email : undefined, raw: done }
  } finally {
    server.close()
  }
}

/** Sign in to Grok with a device code. `onStart` gets the code and URL to show. */
export async function loginGrok(deps: AuthFlowDeps, opts: { onStart: (info: GrokStartInfo) => void }): Promise<AuthOutcome> {
  const data = await deps.request('POST', '/auth/grok/start')
  if (!isRecord(data)) throw new Error('Unexpected response from /auth/grok/start')
  const userCode = typeof data.userCode === 'string' ? data.userCode : ''
  const verificationUri = typeof data.verificationUriComplete === 'string' && data.verificationUriComplete
    ? data.verificationUriComplete
    : typeof data.verificationUri === 'string' ? data.verificationUri : ''
  const expiresInSec = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 900
  opts.onStart({ userCode, verificationUri, expiresInSec, raw: data })
  if (deps.signal?.aborted) return CANCELLED
  if (verificationUri) (deps.openBrowser ?? openBrowser)(verificationUri)
  return waitForAuth(deps, 'grok', expiresInSec * 1000)
}

/**
 * Sign in to Claude through the daemon host's Claude Code. Fails fast (no
 * flow) when Claude Code is not installed there. While this polls, the caller
 * may relay a code the page shows with `submitClaudeCode`. Cancelling (the
 * signal) stops the waiting `claude auth login` on the daemon.
 */
export async function loginClaude(deps: AuthFlowDeps, opts: { onStart: (info: ClaudeStartInfo) => void }): Promise<AuthOutcome> {
  const before = await deps.request('GET', '/auth/claude/status')
  if (isRecord(before) && before.installed === false) {
    const installUrl = typeof before.installUrl === 'string' ? before.installUrl : ''
    return { ok: false, error: `Claude Code is not installed on the daemon host.${installUrl ? ` Install it from ${installUrl}, then sign in again.` : ''}`, notInstalled: true, installUrl }
  }
  const data = await deps.request('POST', '/auth/claude/start')
  const url = isRecord(data) && typeof data.url === 'string' ? data.url : ''
  opts.onStart({ url, raw: data })
  const outcome = deps.signal?.aborted ? CANCELLED : await waitForClaude(deps)
  if (!outcome.ok && (outcome.cancelled || outcome.timedOut)) {
    await deps.request('POST', '/auth/claude/cancel').catch(() => {})
  }
  return outcome
}

/** Relay the code shown on Claude's sign-in page to the daemon's waiting Claude Code. */
export async function submitClaudeCode(deps: Pick<AuthFlowDeps, 'request'>, code: string): Promise<void> {
  await deps.request('POST', '/auth/claude/code', { code: code.trim() })
}

/**
 * Like waitForAuth, but nothing ends the wait while a flow is pending: Claude's
 * status can carry a standing error (e.g. Claude Code signed in with a Console
 * key) or the previous account's sign-in while the new sign-in still runs.
 */
async function waitForClaude(deps: AuthFlowDeps): Promise<AuthOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => abortableSleep(ms, deps.signal))
  const deadline = Date.now() + CLAUDE_AUTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS)
    if (deps.signal?.aborted) return CANCELLED
    const status = await deps.request('GET', '/auth/claude/status')
    if (deps.signal?.aborted) return CANCELLED
    if (!isRecord(status)) continue
    if (status.flowPending === true) continue
    if (status.authenticated === true) return { ok: true, email: typeof status.email === 'string' ? status.email : undefined, raw: status }
    if (typeof status.flowError === 'string' && status.flowError) return { ok: false, error: status.flowError }
    if (status.installed === false) return { ok: false, error: 'Claude Code is not installed on the daemon host.' }
  }
  return { ok: false, error: 'Timed out waiting for Claude sign-in', timedOut: true }
}

/** Poll `/auth/<provider>/status` until the daemon-side flow settles. */
export async function waitForAuth(deps: AuthFlowDeps, provider: AuthProvider, timeoutMs: number): Promise<AuthOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => abortableSleep(ms, deps.signal))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS)
    if (deps.signal?.aborted) return CANCELLED
    const status = await deps.request('GET', `/auth/${provider}/status`)
    if (deps.signal?.aborted) return CANCELLED
    if (!isRecord(status)) continue
    if (status.authenticated === true) return { ok: true, email: typeof status.email === 'string' ? status.email : undefined, raw: status }
    if (typeof status.flowError === 'string' && status.flowError) return { ok: false, error: status.flowError }
  }
  return { ok: false, error: `Timed out waiting for ${AUTH_PROVIDER_LABELS[provider]} sign-in`, timedOut: true }
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise
  if (signal.aborted) return null
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      err => { signal.removeEventListener('abort', onAbort); if (signal.aborted) resolve(null); else reject(err) },
    )
  })
}
