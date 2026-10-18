// Remote access: other computers reach this daemon (docs/design/remote-access.md §11).
//
// Management, this machine only (the install's token, a loopback caller
// without proxy headers, and the local proof in every mode; a device token
// is refused by the request guard before it gets here):
//
//   GET    /remote-access[?refresh=1]              status
//   PUT    /remote-access                          {enabled?, name?, trustNetwork?}
//   POST   /remote-access/devices                  {label} → {device, token} (the token is shown once)
//   DELETE /remote-access/devices/:id              revoke: closes the device's sessions and connections
//   POST   /remote-access/pairing                  open the window (new 6-digit code)
//   DELETE /remote-access/pairing                  close it
//   POST   /remote-access/pairing/claims/:claimId  {allow} the owner's answer to a claim
//   POST   /remote-access/tailscale-serve          {enabled} run tailscale serve (the owner confirmed)
//
// Unauthenticated (the Host / Origin checks still apply), 404 while remote
// access is off:
//
//   GET  /remote/hello                       name, fingerprint, pairing open
//   POST /pair/claim                         {code, deviceName, clientKind} → 202 {claimId, expiresAt}
//   GET  /pair/claims/:claimId?wait=<0-25>   pending | denied | approved (token delivered once)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireLocalCaller } from '../identity-routes'
import { requireLocalProof } from './identity-import-routes'
import { cleanDisplayName } from '../remote-access/config'
import { RemoteAccessError, type RemoteAccessService } from '../remote-access/service'
import type { ClientSessionRegistry } from '../client-sessions'
import type { RemoteAccessPatch } from '../../../shared/types/remote-access.types'
import type { DaemonRouteContext } from './index'
import { badRequest } from './route-helpers'

const MANAGEMENT_PROOF_REFUSAL = 'Remote access is managed only from this computer: it needs this machine\'s local proof (X-ADF-Local-Proof, the daemon-local-proof file next to the daemon settings). Use ADF Studio or adf on this computer.'

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RemoteAccessError) {
    const { retryAfter, ...extra } = err.extra
    if (typeof retryAfter === 'number') void reply.header('Retry-After', String(retryAfter))
    return reply.code(err.status).send({ error: err.message, code: err.code, ...extra })
  }
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function registerRemoteAccessRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const service = (): RemoteAccessService | undefined => ctx.options.routes?.remoteAccess
  const registry = (): ClientSessionRegistry | undefined =>
    (server as unknown as { adfClientSessions?: ClientSessionRegistry }).adfClientSessions

  /** Who acts: Studio when the request names a Studio client session (X-ADF-Client-Session), else the CLI. */
  const actor = (request: FastifyRequest): 'studio' | 'cli' => {
    const raw = request.headers['x-adf-client-session']
    const id = Array.isArray(raw) ? raw[0] : raw
    return id && registry()?.clientOf(id) === 'studio' ? 'studio' : 'cli'
  }

  /** Local caller + local proof, and a configured service; false when a refusal was sent. */
  const manage = (request: FastifyRequest, reply: FastifyReply): RemoteAccessService | null => {
    if (!requireLocalCaller(request, reply, ctx.localAccess, 'Remote access can be managed')) return null
    if (!requireLocalProof(request, reply, ctx.localAccess.localProof ?? null, MANAGEMENT_PROOF_REFUSAL)) return null
    const s = service()
    if (!s) {
      void reply.code(503).send({ error: 'Remote access is not available on this daemon.', code: 'unavailable' })
      return null
    }
    return s
  }

  server.get<{ Querystring: { refresh?: string } }>('/remote-access', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    void reply.header('Cache-Control', 'no-store')
    try { return await s.status({ refresh: request.query.refresh === '1' || request.query.refresh === 'true' }) } catch (err) { return sendError(reply, err) }
  })

  server.put<{ Body: unknown }>('/remote-access', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    const body = request.body
    if (!isRecord(body)) return badRequest(reply, 'Body must be an object: {enabled?, name?, trustNetwork?}')
    const patch: RemoteAccessPatch = {}
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return badRequest(reply, 'enabled must be a boolean')
      patch.enabled = body.enabled
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return badRequest(reply, 'name must be a string')
      patch.name = body.name
    }
    if (body.trustNetwork !== undefined) {
      if (typeof body.trustNetwork !== 'boolean') return badRequest(reply, 'trustNetwork must be a boolean')
      patch.trustNetwork = body.trustNetwork
    }
    if (Object.keys(patch).length === 0) return badRequest(reply, 'Give at least one of enabled, name, trustNetwork')
    void reply.header('Cache-Control', 'no-store')
    try { return await s.update(patch) } catch (err) { return sendError(reply, err) }
  })

  server.post<{ Body: unknown }>('/remote-access/devices', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    const label = cleanDisplayName(isRecord(request.body) ? request.body.label : undefined, 64)
    if (!label) return badRequest(reply, 'label must be 1-64 characters without control or bidi characters')
    void reply.header('Cache-Control', 'no-store')
    try { return reply.code(201).send(s.createDevice(label, actor(request), 'token')) } catch (err) { return sendError(reply, err) }
  })

  server.delete<{ Params: { id: string } }>('/remote-access/devices/:id', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    try { return await s.revokeDevice(request.params.id) } catch (err) { return sendError(reply, err) }
  })

  server.post('/remote-access/pairing', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    void reply.header('Cache-Control', 'no-store')
    try { return reply.code(201).send(s.openPairing()) } catch (err) { return sendError(reply, err) }
  })

  server.delete('/remote-access/pairing', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    s.closePairing()
    return reply.code(204).send()
  })

  server.post<{ Params: { claimId: string }; Body: unknown }>('/remote-access/pairing/claims/:claimId', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    const allow = isRecord(request.body) ? request.body.allow : undefined
    if (typeof allow !== 'boolean') return badRequest(reply, 'allow must be a boolean')
    try { return s.decideClaim(request.params.claimId, allow, actor(request)) } catch (err) { return sendError(reply, err) }
  })

  server.post<{ Body: unknown }>('/remote-access/tailscale-serve', async (request, reply) => {
    const s = manage(request, reply)
    if (!s) return reply
    const enabled = isRecord(request.body) ? request.body.enabled : undefined
    if (typeof enabled !== 'boolean') return badRequest(reply, 'enabled must be a boolean')
    try { return await s.setTailscaleServe(enabled) } catch (err) { return sendError(reply, err) }
  })

  // --- unauthenticated -----------------------------------------------------------

  const off = (reply: FastifyReply) => reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Remote access is off on this computer.', code: 'remote_access_off' })

  server.get('/remote/hello', async (request, reply) => {
    const s = service()
    if (!s) return off(reply)
    void reply.header('Cache-Control', 'no-store')
    try { return s.hello(request.raw) } catch (err) { return sendError(reply, err) }
  })

  server.post<{ Body: unknown }>('/pair/claim', async (request, reply) => {
    const s = service()
    if (!s) return off(reply)
    void reply.header('Cache-Control', 'no-store')
    if (!s.enabled) return off(reply)
    const body = isRecord(request.body) ? request.body : {}
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!/^\d{6}$/.test(code)) return badRequest(reply, 'code must be the 6 digits the host shows')
    const deviceName = cleanDisplayName(body.deviceName, 64)
    if (!deviceName) return badRequest(reply, 'deviceName must be 1-64 characters without control or bidi characters')
    if (body.clientKind !== 'studio' && body.clientKind !== 'cli') return badRequest(reply, 'clientKind must be studio or cli')
    try {
      return reply.code(202).send(await s.claim(request.raw, { code, deviceName, clientKind: body.clientKind }))
    } catch (err) {
      // A wrong code is answered after a fixed delay (§5.5).
      if (err instanceof RemoteAccessError && err.code === 'wrong_code' && s.wrongCodeDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, s.wrongCodeDelayMs))
      }
      return sendError(reply, err)
    }
  })

  server.get<{ Params: { claimId: string }; Querystring: { wait?: string } }>('/pair/claims/:claimId', async (request, reply) => {
    const s = service()
    if (!s) return off(reply)
    void reply.header('Cache-Control', 'no-store')
    if (!s.enabled) return off(reply)
    const waitText = request.query.wait
    const wait = waitText === undefined ? 0 : Number(waitText)
    if (!Number.isInteger(wait) || wait < 0 || wait > 25) return badRequest(reply, 'wait must be an integer from 0 to 25 (seconds)')
    try { return await s.poll(request.params.claimId, wait * 1000) } catch (err) { return sendError(reply, err) }
  })
}
