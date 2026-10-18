// OAuth callback relay for clients on another machine (design §9.3, tracker
// W4-B):
//
//   POST /oauth/relay   { redirectUri, params } → { delivered, status }
//
// An OAuth flow the daemon runs (MCP sign-in, the registration test) waits
// for its browser callback on a loopback port of the daemon's host. A remote
// client's browser lands on the client's own loopback instead; the client
// takes that callback and hands its OAuth parameters here. The daemon
// delivers them to its own loopback callback, exactly as the browser would
// have: one GET, no redirect followed, the answer's body not returned.
//
// Bounds: the target is http on 127.0.0.1, localhost or ::1 with an explicit
// port that is not this daemon's; only the OAuth callback parameters (code,
// state, error, error_description, error_uri, iss) are passed, and state is
// required. The callback server itself still checks state against its
// flow. Values are never logged. The bearer token already allows far more
// on this host (agents with host access), so the relay adds no access; the
// bounds keep it from being a general loopback fetch.

import type { FastifyInstance } from 'fastify'
import type { DaemonRouteContext } from './index'
import { badRequest } from './route-helpers'

const RELAYED = new Set(['code', 'state', 'error', 'error_description', 'error_uri', 'iss'])
const MAX_VALUE = 8192
const RELAY_TIMEOUT_MS = 10_000

export interface OAuthRelayOptions {
  /** Tests: the fetch that reaches the loopback callback. */
  fetch?: typeof fetch
}

export function registerOAuthRelayRoutes(server: FastifyInstance, _ctx: DaemonRouteContext, opts: OAuthRelayOptions = {}): void {
  server.post<{ Body: { redirectUri?: unknown; params?: unknown } | undefined }>('/oauth/relay', async (request, reply) => {
    const body = request.body ?? {}
    if (typeof body.redirectUri !== 'string') return badRequest(reply, 'redirectUri must be a string')
    let target: URL
    try { target = new URL(body.redirectUri) } catch { return badRequest(reply, 'redirectUri is not a URL') }
    const host = target.hostname.toLowerCase()
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      return badRequest(reply, 'redirectUri must be an http loopback callback (127.0.0.1, localhost or [::1])')
    }
    if (target.username || target.password || target.hash) return badRequest(reply, 'redirectUri must not carry credentials or a fragment')
    const port = Number(target.port)
    if (!target.port || !Number.isInteger(port) || port < 1024 || port > 65535) return badRequest(reply, 'redirectUri needs an explicit port from 1024 to 65535')
    if (port === request.socket?.localPort) return badRequest(reply, 'redirectUri must not name the daemon\'s own port')

    const params = body.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return badRequest(reply, 'params must be an object')
    const entries = Object.entries(params as Record<string, unknown>)
    for (const [key, value] of entries) {
      if (!RELAYED.has(key)) return badRequest(reply, `params.${key} is not an OAuth callback parameter`)
      if (typeof value !== 'string' || value.length > MAX_VALUE) return badRequest(reply, `params.${key} must be a string of at most ${MAX_VALUE} characters`)
    }
    const values = params as Record<string, string>
    if (!values.state) return badRequest(reply, 'params.state is required')
    if (!values.code && !values.error) return badRequest(reply, 'params needs code or error')

    for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value)
    const where = `${target.host}${target.pathname}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS)
    try {
      const res = await (opts.fetch ?? fetch)(target.toString(), { redirect: 'manual', signal: controller.signal })
      void res.body?.cancel().catch(() => {})
      console.log(`[OAuth] Relayed a sign-in callback from a client to ${where} (HTTP ${res.status})`)
      return { delivered: res.status >= 200 && res.status < 300, status: res.status }
    } catch (err) {
      const why = controller.signal.aborted ? `no answer within ${RELAY_TIMEOUT_MS / 1000} s` : (err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err))
      console.warn(`[OAuth] Relaying a sign-in callback to ${where} failed: ${why}`)
      return reply.code(502).send({
        error: `No sign-in is waiting at ${where} on the daemon's host (${why}). It may have timed out: start the sign-in again.`,
        code: 'relay_unreachable',
      })
    } finally {
      clearTimeout(timer)
    }
  })
}
