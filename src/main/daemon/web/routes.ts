import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerResponse } from 'node:http'
import { isLoopbackName, type DaemonRequestGuard } from '../request-guard'
import { hasProxyHeaders, isLoopbackAddress, LOCAL_PROOF_HEADER } from '../local-access'
import { tokensEqual } from '../daemon-token'
import { APPROVED_COLLECT_MS } from '../remote-access/pairing'
import { cleanDisplayName } from '../remote-access/config'
import type { RemoteAccessService } from '../remote-access/service'
import { remoteListenerOf } from '../remote-access/listeners'
import { CHAT_BODY_LIMIT_BYTES } from '../../../shared/constants/chat-limits'
import { IPC } from '../../../shared/constants/ipc-channels'
import type { WebTab, WebTabOptions } from './context'
import { findWebRoot } from './assets'
export { findWebRoot } from './assets'

const COOKIE = 'adf_web_session'
const TICKET_MS = 60_000
const PAIR_COOKIE = 'adf_web_pair'
const DEVICE_COOKIE = 'adf_web_device'
const DEVICE_COOKIE_SECONDS = 30 * 24 * 60 * 60
const SESSION_MS = 8 * 60 * 60_000
const TAB_IDLE_MS = 5 * 60_000
const MAX_SESSIONS = 128
const MAX_TABS = 16
const MAX_PENDING_BYTES = 1024 * 1024
const CLIENT_ID = /^[a-zA-Z0-9_-]{16,128}$/

interface TabEntry {
  generation: string
  tab: Promise<WebTab>
  responses: Set<ServerResponse>
  pending: string[]
  bytes: number
  needsResync: boolean
  lastUsed: number
  closed: boolean
  closing?: Promise<void>
}
interface BrowserSession {
  deviceId: string | null
  storageScope: string
  recoveryScope: string
  token: string
  expires: number
  remote: boolean
  tabs: Map<string, TabEntry>
  settings: Record<string, unknown>
  requests: { remaining: number; at: number }
  inFlight: number
}
export interface WebStudioOptions {
  /** Set false to disable the browser entry points altogether. */
  enabled?: boolean
  /** Compiled Vite renderer; default ADF_WEB_ROOT, then packaged/source out/web. */
  root?: string
  version?: string
  localProof?: string | null
  remoteAccess?: Pick<RemoteAccessService, 'enabled' | 'claim' | 'poll' | 'wrongCodeDelayMs'> | null
  /** Dependency injection for bounded transport tests. */
  createTab?: (options: WebTabOptions) => Promise<WebTab>
}

/** Only these routes bypass the ordinary bearer hook; this module authenticates them. */
export function isWebStudioRoute(path: string): boolean {
  return path === '/studio' || path === '/studio/' || path.startsWith('/studio/') ||
    path === '/web/launch' || path === '/web/pair' || path === '/web/session' || path === '/web/invoke' || path === '/web/events' || path === '/web/file' || path === '/web/snapshot'
}

/** Cookies ignore ports. Include the validated request authority in the name so
 * two daemons on localhost keep independent sessions and logout behavior. */
function cookieName(request: FastifyRequest, prefix = COOKIE): string {
  const authority = (request.headers.host ?? '').toLowerCase()
  return `${prefix}_${createHash('sha256').update(authority).digest('hex').slice(0, 24)}`
}
function cookieValue(request: FastifyRequest, prefix = COOKIE): string | null {
  const name = cookieName(request, prefix)
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`))
  if (values.length !== 1) return null
  return values[0].slice(name.length + 1)
}
function cookieId(request: FastifyRequest, prefix = COOKIE): string | null {
  const value = cookieValue(request, prefix)
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null
}
function cookie(request: FastifyRequest, value: string, maxAge: number, prefix = COOKIE): string {
  // Proxy TLS hints can only add Secure, never relax it; no trustProxy/IP trust.
  const forwardedProto = request.headers['x-forwarded-proto']
  const secure = request.protocol === 'https' || request.headers.origin?.startsWith('https://') ||
    (typeof forwardedProto === 'string' && forwardedProto.split(',').some(value => value.trim().toLowerCase() === 'https')) ||
    /(?:^|[;,]\s*)proto="?https(?:"|;|,|$)/i.test(String(request.headers.forwarded ?? ''))
  return `${cookieName(request, prefix)}=${value}; Path=/web; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
function reject(reply: FastifyReply, status: number, error: string, code = 'web_session_required'): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error, code })
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp', '.wasm': 'application/wasm',
}

/** Master tokens stay server-side. Paired device credentials use HttpOnly cookies only. */
export function registerWebStudio(server: FastifyInstance, guard: DaemonRequestGuard, options: WebStudioOptions = {}): void {
  if (options.enabled === false) return
  const sessions = new Map<string, BrowserSession>()
  // A remembered credential can be presented by concurrent requests even
  // after the browser clears its cookie. Keep logout tombstones for its full
  // cookie lifetime and invalidate all sessions renewed from that principal.
  // This is browser logout only, not revocation of the daemon's device token.
  const signedOutDevices = new Map<string, number>()
  const deviceSignedOut = (id: string | null): boolean => id !== null && (signedOutDevices.get(id) ?? 0) > Date.now()
  let pairClaimsInFlight = 0
  const tickets = new Map<string, { token: string; authority: string; expires: number }>()
  const pairs = new Map<string, { claimId: string; collectSecret: string; expires: number; approvalExpires: string; remote: boolean; polling: boolean }>()
  const loginAttempts = new Map<string, { count: number; until: number }>()
  const root = findWebRoot(options.root)
  const createTab = options.createTab ?? (async (opts: WebTabOptions) => (await import('./context')).createWebTab(opts))
  const endTab = (entry: TabEntry): void => {
    if (entry.closed) return
    entry.closed = true
    for (const response of entry.responses) response.end()
    entry.responses.clear()
    entry.pending = []; entry.bytes = 0
    entry.closing = entry.tab.then(tab => tab.close()).catch(() => {})
  }
  const endSession = (id: string): void => {
    const session = sessions.get(id)
    sessions.delete(id)
    if (session) for (const entry of session.tabs.values()) endTab(entry)
  }
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, until] of signedOutDevices) if (until <= now) signedOutDevices.delete(id)
    for (const [id, ticket] of tickets) if (ticket.expires <= now) tickets.delete(id)
    for (const [id, pair] of pairs) if (pair.expires <= now) pairs.delete(id)
    for (const [ip, bucket] of loginAttempts) if (bucket.until <= now) loginAttempts.delete(ip)
    for (const [id, session] of sessions) {
      // Device revocation or remote-access-off also closes existing streams.
      const verdict = guard.authenticate('POST', '/web/invoke', { authorization: `Bearer ${session.token}`, host: loopbackHost() }, { remoteListener: session.remote })
      if (session.expires <= now || deviceSignedOut(session.deviceId) || verdict.rejection) { endSession(id); continue }
      for (const [key, entry] of session.tabs) {
        if (entry.responses.size === 0 && entry.lastUsed + TAB_IDLE_MS < now) { session.tabs.delete(key); endTab(entry) }
        else for (const response of entry.responses) {
          if (response.writableLength > MAX_PENDING_BYTES) response.destroy()
          else response.write(': heartbeat\n\n')
        }
      }
    }
  }, 15_000)
  sweep.unref()
  let closing: Promise<void> | null = null
  const closeSessions = (): Promise<void> => closing ??= (async () => {
    clearInterval(sweep)
    tickets.clear(); pairs.clear()
    const tabs = [...sessions.values()].flatMap(session => [...session.tabs.values()])
    for (const id of sessions.keys()) endSession(id)
    await Promise.allSettled(tabs.map(entry => entry.closing))
  })()
  // onClose runs only after http.Server.close finishes. An active SSE response
  // would keep that callback waiting forever, so end streams in preClose.
  // Both hooks retain the same cleanup promise rather than closing tabs twice.
  server.addHook('preClose', closeSessions)
  server.addHook('onClose', closeSessions)
  function loopbackHost(): string {
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('The daemon HTTP listener is not ready.')
    const bound = address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address
    const host = address.family === 'IPv6' ? `[${bound}]` : bound
    return `${host}:${address.port}`
  }
  function authorize(request: FastifyRequest, reply: FastifyReply, requireScope = false): BrowserSession | null {
    const id = cookieId(request)
    const session = id ? sessions.get(id) : undefined
    if (!session || session.expires <= Date.now() || deviceSignedOut(session.deviceId)) {
      if (id) endSession(id)
      reject(reply, 401, 'Sign in to browser Studio again.')
      return null
    }
    // A replacement login changes the shared cookie in every browser tab. An
    // older tab must never replay queued edits using the new login's authority.
    const scope = request.method === 'POST'
      ? (request.body as { storageScope?: unknown } | null)?.storageScope
      : (request.query as { storageScope?: unknown }).storageScope
    if (requireScope && scope !== session.storageScope) {
      reject(reply, 401, 'This browser tab belongs to a previous sign-in. Reload Studio.')
      return null
    }
    const verdict = guard.authenticate(request.method, request.routeOptions.url ?? request.url.split('?')[0],
      { ...request.headers, authorization: `Bearer ${session.token}` },
      { remoteListener: session.remote || remoteListenerOf(request.raw.socket) !== null })
    if (verdict.rejection) { endSession(id!); reply.header('Set-Cookie', cookie(request, '', 0, DEVICE_COOKIE)); reject(reply, verdict.rejection.status, verdict.rejection.body.error, verdict.rejection.body.code); return null }
    return session
  }
  // Count every expensive browser request, including downloads and snapshot
  // generation. Keep its concurrency slot until the response stream closes.
  function takeRequest(session: BrowserSession, reply: FastifyReply): boolean {
    const now = Date.now()
    session.requests.remaining = Math.min(120, session.requests.remaining + Math.max(0, now - session.requests.at) / 100)
    session.requests.at = now
    if (session.requests.remaining < 1 || session.inFlight >= 64) {
      reject(reply, 429, 'Too many Studio requests. Try again shortly.', 'web_rate_limited')
      return false
    }
    session.requests.remaining--
    session.inFlight++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      session.inFlight--
      reply.raw.off('finish', release)
      reply.raw.off('close', release)
    }
    reply.raw.once('finish', release)
    reply.raw.once('close', release)
    return true
  }
  async function readyTab(entry: TabEntry): Promise<WebTab> {
    const tab = await entry.tab
    if (entry.closed) throw Object.assign(new Error('Sign in to browser Studio again.'), { status: 401, code: 'web_session_required' })
    return tab
  }
  function sendTab(entry: TabEntry, channel: string, ...args: unknown[]): void {
    if (entry.closed) return
    const data = `data: ${JSON.stringify({ channel, args })}\n\n`
    const bytes = Buffer.byteLength(data)
    if (entry.responses.size > 0) {
      for (const response of entry.responses) {
        if (response.writableLength + bytes > MAX_PENDING_BYTES) { entry.needsResync = true; response.destroy(); continue }
        response.write(data)
      }
    } else {
      if (entry.bytes + bytes > MAX_PENDING_BYTES) { entry.pending = []; entry.bytes = 0; entry.needsResync = true }
      if (bytes <= MAX_PENDING_BYTES) { entry.pending.push(data); entry.bytes += bytes }
    }
  }
  function getTab(session: BrowserSession, clientId: unknown, reply: FastifyReply): TabEntry | null {
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) { reject(reply, 400, 'A valid per-tab clientId is required.', 'invalid_client_id'); return null }
    let entry = session.tabs.get(clientId)
    if (!entry) {
      if (session.tabs.size >= MAX_TABS) { reject(reply, 429, 'Too many Studio tabs. Close unused tabs and try again.', 'too_many_tabs'); return null }
      const created: TabEntry = { generation: randomBytes(16).toString('hex'), tab: null!, responses: new Set(), pending: [], bytes: 0, needsResync: false, lastUsed: Date.now(), closed: false }
      created.tab = createTab({
        baseUrl: `http://${loopbackHost()}`, token: session.token, version: options.version ?? process.env.ADF_VERSION ?? '0.0.0', settings: session.settings,
        send: (channel, ...args) => sendTab(created, channel, ...args),
        appearanceChanged: (changed) => {
          if (created.closed) return
          for (const sibling of session.tabs.values()) {
            if (sibling !== created) sendTab(sibling, IPC.APPEARANCE_CHANGED, changed)
          }
        },
      })
      created.tab.catch(() => { if (session.tabs.get(clientId) === created) { session.tabs.delete(clientId); endTab(created) } })
      session.tabs.set(clientId, created)
      entry = created
    }
    entry.lastUsed = Date.now()
    return entry
  }

  // Keep Host/Origin checks even for the public login screen. Exact Origin/Host
  // matching also protects cookie requests when several hosts are allow-listed.
  server.addHook('onRequest', (request, reply, done) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0]
    if (!isWebStudioRoute(path)) { done(); return }
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
    const publicVerdict = guard.authenticate('GET', '/health', request.headers, { remoteListener: remoteListenerOf(request.raw.socket) !== null })
    if (publicVerdict.rejection) { reject(reply, publicVerdict.rejection.status, publicVerdict.rejection.body.error, publicVerdict.rejection.body.code); return }
    if (request.headers.origin) {
      let same = false
      try { same = new URL(request.headers.origin).host === request.headers.host } catch { /* malformed */ }
      if (!same) { reject(reply, 403, 'Browser Studio accepts only same-origin requests.', 'cross_origin'); return }
    }
    // RPC accepts large attachment bodies. Authenticate the cookie before
    // Fastify buffers/parses them, then bind the tab scope in the handler.
    if (path === '/web/invoke' && !authorize(request, reply)) return
    done()
  })

  server.get('/studio', async (_request, reply) => reply.redirect('/studio/'))
  server.get('/studio/*', async (request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if (!root) return reject(reply, 503, 'Browser Studio has not been built. Run npm run build:web and restart the daemon.', 'web_build_missing')
    const path = (request.params as { '*': string })['*'] || 'index.html'
    if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) return reject(reply, 404, 'Not found.', 'not_found')
    try {
      const rootPath = await realpath(root)
      const file = await realpath(resolve(rootPath, path))
      const rel = relative(rootPath, file)
      if (rel.startsWith('..') || isAbsolute(rel)) return reject(reply, 404, 'Not found.', 'not_found')
      const contentType = MIME[extname(file)]
      if (!contentType) return reject(reply, 404, 'Not found.', 'not_found')
      const bytes = await readFile(file)
      return reply.type(contentType).send(bytes)
    } catch { return reject(reply, 404, 'Not found.', 'not_found') }
  })
  function permitLogin(request: FastifyRequest, reply: FastifyReply): boolean {
    const now = Date.now()
    let attempts = loginAttempts.get(request.ip)
    if (!attempts || attempts.until <= now) {
      if (loginAttempts.size >= 1024 && !attempts) { reject(reply, 429, 'Too many sign-in attempts. Try again in one minute.', 'web_rate_limited'); return false }
      attempts = { count: 0, until: now + 60_000 }
      loginAttempts.set(request.ip, attempts)
    }
    if (++attempts.count > 20) { reply.header('Retry-After', '60'); reject(reply, 429, 'Too many sign-in attempts. Try again in one minute.', 'web_rate_limited'); return false }
    return true
  }
  function directLocal(request: FastifyRequest): boolean {
    return isLoopbackAddress(request.raw.socket.remoteAddress) && remoteListenerOf(request.raw.socket) === null && !hasProxyHeaders(request.headers)
  }
  function createSession(request: FastifyRequest, reply: FastifyReply, token: string, remote: boolean, kind: 'launch' | 'paired' | 'remembered' = 'launch'): FastifyReply {
    const verdict = guard.authenticate('POST', '/web/invoke', { ...request.headers, authorization: `Bearer ${token}` }, { remoteListener: remote })
    if (verdict.rejection) return reject(reply, verdict.rejection.status, verdict.rejection.body.error, verdict.rejection.body.code)
    if (kind !== 'launch' && verdict.auth.kind !== 'device') return reject(reply, 401, 'Pair this browser with Studio again.', 'invalid_device')
    const deviceId = verdict.auth.kind === 'device' ? verdict.auth.deviceId : null
    if (kind === 'remembered' && deviceSignedOut(deviceId)) {
      reply.header('Set-Cookie', [cookie(request, '', 0), cookie(request, '', 0, DEVICE_COOKIE)])
      return reject(reply, 401, 'This browser was signed out. Pair it with Studio again.', 'web_device_signed_out')
    }
    // Only a new host-approved pairing may clear browser logout state.
    if (kind === 'paired' && deviceId) signedOutDevices.delete(deviceId)
    if (!guard.requiresToken) return reject(reply, 503, 'The daemon is not configured for browser sessions.', 'web_token_unconfigured')
    const previous = cookieId(request)
    if (previous) endSession(previous)
    if (sessions.size >= MAX_SESSIONS) return reject(reply, 429, 'Too many browser sessions. Try again later.', 'too_many_sessions')
    const id = randomBytes(32).toString('hex')
    const storageScope = randomBytes(16).toString('hex')
    const principal = verdict.auth.kind === 'device' ? `device:${verdict.auth.deviceId}` : 'master'
    // Nonsecret principal identity, never an offline verifier of a user token.
    const recoveryScope = createHash('sha256').update(`adf-web-recovery-v1:${principal}`).digest('hex')
    sessions.set(id, { deviceId, storageScope, recoveryScope, token, expires: Date.now() + SESSION_MS, remote, tabs: new Map(), settings: {}, requests: { remaining: 120, at: Date.now() }, inFlight: 0 })
    const existing = reply.getHeader('Set-Cookie')
    const cookies = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)]
    if (kind === 'paired') cookies.push(cookie(request, token, DEVICE_COOKIE_SECONDS, DEVICE_COOKIE))
    else if (kind === 'launch') cookies.push(cookie(request, '', 0, DEVICE_COOKIE))
    return reply.header('Set-Cookie', [...cookies, cookie(request, id, SESSION_MS / 1000)]).send({ state: 'approved', authenticated: true, storageScope, recoveryScope })
  }
  server.post('/web/launch', { bodyLimit: 1024 }, async (request, reply) => {
    const verdict = guard.authenticate('POST', '/web/launch', request.headers, { remoteListener: remoteListenerOf(request.raw.socket) !== null })
    if (verdict.rejection) return reject(reply, verdict.rejection.status, verdict.rejection.body.error, verdict.rejection.body.code)
    const proof = request.headers[LOCAL_PROOF_HEADER]
    if (verdict.auth.kind !== 'master' || !directLocal(request) || request.headers.origin !== undefined || typeof proof !== 'string' || !options.localProof || !tokensEqual(proof.trim(), options.localProof)) {
      return reject(reply, 403, 'Open browser Studio from the desktop app on this computer.', 'loopback_only')
    }
    const origin = new URL(`http://${request.headers.host}`)
    if (!isLoopbackName(origin.hostname)) return reject(reply, 403, 'Browser launch requires a loopback address.', 'loopback_only')
    for (const [id, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(id)
    if (tickets.size >= MAX_SESSIONS) return reject(reply, 429, 'Too many browser launches. Try again in one minute.', 'web_rate_limited')
    const ticket = randomBytes(32).toString('base64url')
    const expires = Date.now() + TICKET_MS
    const token = request.headers.authorization!.trim().replace(/^Bearer\s+/i, '').trim()
    tickets.set(ticket, { token, authority: origin.host, expires })
    return { url: `${origin.origin}/studio/#ticket=${ticket}`, expiresAt: new Date(expires).toISOString() }
  })
  server.post('/web/session', { bodyLimit: 8192 }, async (request, reply) => {
    if (!permitLogin(request, reply)) return reply
    const ticket = (request.body as { ticket?: unknown } | null)?.ticket
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return reject(reply, 400, 'Open Studio from the desktop app or pair this browser.', 'invalid_ticket')
    const launch = tickets.get(ticket)
    if (!launch || launch.expires <= Date.now()) { tickets.delete(ticket); return reject(reply, 401, 'This browser link expired or was already used. Open it again from Studio.', 'ticket_expired') }
    if (!directLocal(request) || launch.authority !== (request.headers.host ?? '').toLowerCase()) return reject(reply, 403, 'This browser link belongs to another address.', 'ticket_origin_mismatch')
    tickets.delete(ticket)
    return createSession(request, reply, launch.token, false)
  })
  const pairingError = (reply: FastifyReply, error: unknown): FastifyReply => {
    const value = error as { status?: number; code?: string; extra?: { retryAfter?: number } }
    if (typeof value.extra?.retryAfter === 'number') reply.header('Retry-After', String(value.extra.retryAfter))
    return reject(reply, value.status && value.status >= 400 && value.status < 600 ? value.status : 400, error instanceof Error ? error.message : 'Pairing failed.', value.code ?? 'web_pairing_failed')
  }
  server.post('/web/pair', { bodyLimit: 8192 }, async (request, reply) => {
    if (!permitLogin(request, reply)) return reply
    const service = options.remoteAccess
    if (!service?.enabled) return reject(reply, 404, 'Remote access is off on this computer.', 'remote_access_off')
    const body = request.body as { code?: unknown; deviceName?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    const deviceName = cleanDisplayName(body?.deviceName, 64)
    if (!/^\d{6}$/.test(code) || !deviceName) return reject(reply, 400, 'Enter the six-digit pairing code and a browser name (1–64 characters).', 'invalid_pairing')
    for (const [id, pair] of pairs) if (pair.expires <= Date.now()) pairs.delete(id)
    if (pairs.size + pairClaimsInFlight >= MAX_SESSIONS) return reject(reply, 429, 'Too many pending browser requests. Try again later.', 'web_rate_limited')
    pairClaimsInFlight++
    try {
      const claim = await service.claim(request.raw, { code, deviceName, clientKind: 'studio' })
      const previous = cookieId(request, PAIR_COOKIE)
      if (previous) pairs.delete(previous)
      const id = randomBytes(32).toString('hex')
      const expires = Date.parse(claim.expiresAt) + APPROVED_COLLECT_MS
      pairs.set(id, { claimId: claim.claimId, collectSecret: claim.collectSecret, expires, approvalExpires: claim.expiresAt, remote: remoteListenerOf(request.raw.socket) !== null, polling: false })
      return reply.code(202).header('Set-Cookie', cookie(request, id, Math.max(1, Math.ceil((expires - Date.now()) / 1000)), PAIR_COOKIE)).send({ state: 'pending', expiresAt: claim.expiresAt })
    } catch (error) {
      if ((error as { code?: string }).code === 'wrong_code' && service.wrongCodeDelayMs > 0) await new Promise(resolve => setTimeout(resolve, service.wrongCodeDelayMs))
      return pairingError(reply, error)
    } finally { pairClaimsInFlight-- }
  })
  server.get('/web/pair', async (request, reply) => {
    const service = options.remoteAccess
    if (!service?.enabled) return reject(reply, 404, 'Remote access is off on this computer.', 'remote_access_off')
    const id = cookieId(request, PAIR_COOKIE)
    const pair = id ? pairs.get(id) : undefined
    if (!pair || pair.expires <= Date.now()) { if (id) pairs.delete(id); return reject(reply, 404, 'This pairing request expired. Enter a fresh code from Studio.', 'claim_not_found') }
    // Approved credentials are collected once. Leave them at the pairing
    // service until this process has room to create the browser session.
    if (sessions.size >= MAX_SESSIONS && !sessions.has(cookieId(request) ?? '')) return reject(reply, 429, 'Too many browser sessions. Try again later.', 'too_many_sessions')
    if (pair.polling) return { state: 'pending', expiresAt: pair.approvalExpires }
    pair.polling = true
    try {
      const result = await service.poll(pair.claimId, pair.collectSecret, 0)
      if (pairs.get(id!) !== pair) return reject(reply, 401, 'This browser pairing was cancelled. Start again from Studio.', 'web_pairing_cancelled')
      if (result.state === 'pending') return { state: 'pending', expiresAt: pair.approvalExpires }
      pairs.delete(id!)
      reply.header('Set-Cookie', cookie(request, '', 0, PAIR_COOKIE))
      if (result.state === 'denied') return { state: 'denied' }
      return createSession(request, reply, result.token, pair.remote || remoteListenerOf(request.raw.socket) !== null, 'paired')
    } catch (error) { return pairingError(reply, error) }
    finally { pair.polling = false }
  })
  server.get('/web/session', async (request, reply) => {
    const id = cookieId(request)
    const current = id ? sessions.get(id) : undefined
    if (!current || current.expires <= Date.now()) {
      if (id) endSession(id)
      const token = cookieValue(request, DEVICE_COOKIE)
      if (token) {
        const remote = remoteListenerOf(request.raw.socket) !== null
        const verdict = guard.authenticate('POST', '/web/invoke', { ...request.headers, authorization: `Bearer ${token}` }, { remoteListener: remote })
        if (!verdict.rejection && verdict.auth.kind === 'device') return createSession(request, reply, token, remote, 'remembered')
        reply.header('Set-Cookie', cookie(request, '', 0, DEVICE_COOKIE))
      }
    }
    const session = authorize(request, reply)
    if (!session) return reply
    return { authenticated: true, storageScope: session.storageScope, recoveryScope: session.recoveryScope }
  })
  server.delete('/web/session', async (request, reply) => {
    // Logout must also invalidate a renewal whose Set-Cookie response reaches
    // the browser after this reply. No daemon runtime/device mutations.
    const id = cookieId(request)
    const deviceIds = new Set<string>()
    const current = id ? sessions.get(id) : undefined
    if (current?.deviceId) deviceIds.add(current.deviceId)
    const remembered = cookieValue(request, DEVICE_COOKIE)
    if (remembered) {
      const verdict = guard.authenticate('POST', '/web/invoke', { ...request.headers, authorization: `Bearer ${remembered}` }, { remoteListener: remoteListenerOf(request.raw.socket) !== null })
      if (!verdict.rejection && verdict.auth.kind === 'device') deviceIds.add(verdict.auth.deviceId)
    }
    for (const deviceId of deviceIds) signedOutDevices.set(deviceId, Date.now() + DEVICE_COOKIE_SECONDS * 1000)
    if (id) endSession(id)
    for (const [sessionId, session] of sessions) if (session.deviceId && deviceIds.has(session.deviceId)) endSession(sessionId)
    const pairId = cookieId(request, PAIR_COOKIE)
    if (pairId) pairs.delete(pairId)
    return reply.header('Set-Cookie', [cookie(request, '', 0), cookie(request, '', 0, DEVICE_COOKIE), cookie(request, '', 0, PAIR_COOKIE)]).send({ authenticated: false })
  })
  server.post('/web/invoke', { bodyLimit: CHAT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const session = authorize(request, reply, true)
    if (!session) return reply
    if (!takeRequest(session, reply)) return reply
    const body = request.body as { clientId?: unknown; channel?: unknown; args?: unknown; generation?: unknown } | null
    if (!body || typeof body.channel !== 'string' || body.channel.length > 128 || !Array.isArray(body.args) || body.args.length > 16) return reject(reply, 400, 'Expected channel, args and clientId.', 'invalid_invoke')
    const entry = getTab(session, body.clientId, reply)
    if (!entry) return reply
    if (body.generation !== undefined && body.generation !== entry.generation) {
      return reject(reply, 409, 'This tab was inactive and its document session has closed. Reload Studio.', 'web_tab_reset')
    }
    try {
      const result = await (await readyTab(entry)).invoke(body.channel, body.args)
      return { result: result ?? null }
    } catch (error) {
      const candidate = error as { status?: number; code?: string }
      return reject(reply, candidate.status && candidate.status >= 400 && candidate.status < 600 ? candidate.status : 400,
        error instanceof Error ? error.message : 'Browser Studio request failed.', candidate.code ?? 'web_invoke_failed')
    }
  })
  server.get('/web/snapshot', async (request, reply) => {
    const session = authorize(request, reply, true)
    if (!session) return reply
    if (!takeRequest(session, reply)) return reply
    const query = request.query as { clientId?: unknown; path?: unknown; runtime?: unknown; mode?: unknown }
    if ((query.path !== undefined && (typeof query.path !== 'string' || !query.path || query.path.length > 16384)) || (query.runtime !== undefined && query.runtime !== 'local') || (query.mode !== undefined && query.mode !== 'share')) return reject(reply, 400, 'A share snapshot path is required.', 'invalid_snapshot')
    const entry = getTab(session, query.clientId, reply)
    if (!entry) return reply
    try {
      const response = await (await readyTab(entry)).snapshot(query.path as string | undefined)
      if (!response.ok) { await response.body?.cancel(); return reject(reply, response.status, 'The shared copy could not be created.', 'web_snapshot_failed') }
      reply.type('application/octet-stream').header('Content-Disposition', 'attachment; filename="agent.adf"').header('Content-Security-Policy', "sandbox; default-src 'none'")
      return reply.send(response.body ?? undefined)
    } catch (error) { return reject(reply, 400, error instanceof Error ? error.message : 'The shared copy could not be created.', 'web_snapshot_failed') }
  })
  server.get('/web/file', async (request, reply) => {
    const session = authorize(request, reply, true)
    if (!session) return reply
    if (!takeRequest(session, reply)) return reply
    const query = request.query as { clientId?: unknown; path?: unknown; runtime?: unknown; filePath?: unknown }
    if (typeof query.path !== 'string' || !query.path || query.path.length > 16384 || (query.filePath !== undefined && (typeof query.filePath !== 'string' || !query.filePath || query.filePath.length > 16384)) || (query.runtime !== undefined && query.runtime !== 'local')) return reject(reply, 400, 'A file path in this tab’s open agent is required.', 'invalid_file_path')
    const entry = getTab(session, query.clientId, reply)
    if (!entry) return reply
    try {
      const response = await (await readyTab(entry)).readFile(query.path, query.filePath as string | undefined)
      if (!response.ok) { await response.body?.cancel(); return reject(reply, response.status, 'The file could not be read.', 'web_file_failed') }
      // Internal files can contain active HTML/SVG. They never gain Studio's
      // origin privileges when navigated to directly or embedded in a frame.
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        .header('X-Content-Type-Options', 'nosniff')
        .type(response.headers.get('content-type') ?? 'application/octet-stream')
      if (!response.body) return reply.send()
      return reply.send(response.body)
    } catch (error) { return reject(reply, 400, error instanceof Error ? error.message : 'The file could not be read.', 'web_file_failed') }
  })
  server.get('/web/events', async (request, reply) => {
    const session = authorize(request, reply, true)
    if (!session) return reply
    if (!takeRequest(session, reply)) return reply
    const entry = getTab(session, (request.query as { clientId?: unknown }).clientId, reply)
    if (!entry) return reply
    try { await readyTab(entry) } catch {
      return entry.closed
        ? reject(reply, 401, 'Sign in to browser Studio again.')
        : reject(reply, 503, 'Could not open the Studio runtime session.', 'web_session_failed')
    }
    if (reply.raw.destroyed) return reply
    // A browser tab owns one stream. A reconnect supersedes the old socket.
    if (entry.responses.size > 0) entry.needsResync = true
    for (const response of entry.responses) response.end()
    entry.responses.clear()
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
    entry.responses.add(reply.raw)
    reply.raw.write(': connected\n\n')
    reply.raw.write(`data: ${JSON.stringify({ channel: 'web:tab-generation', args: [entry.generation] })}\n\n`)
    for (const pending of entry.pending) reply.raw.write(pending)
    entry.pending = []; entry.bytes = 0
    request.raw.on('close', () => {
      // A successful write only queues bytes: the last frames may never have
      // reached the browser. Reconcile on every reconnect, not just overflow.
      if (entry.responses.delete(reply.raw) && !entry.closed) entry.needsResync = true
      entry.lastUsed = Date.now()
    })
    if (entry.needsResync) { entry.needsResync = false; void entry.tab.then(tab => tab.resync()).catch(() => {}) }
  })
}
