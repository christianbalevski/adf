// Stored credential values for Studio on this machine (tracker W3-B):
// the Identity panel's Reveal, the provider override form's key field and
// "Copy app key" on an agent's providers.
//
//   POST /agents/:id/identity/reveal                              { purposes?, prefix? }
//   POST /files/agent/identity/reveal?path=                       { purposes?, prefix? }
//   POST /files/agent/providers/:providerId/credential/copy-app-key?path=   { replace? }
//
// The reveal routes are the one exception to "values never leave the
// daemon", and they answer local callers only (local-access.ts), as the
// owner phrase does: embedded Studio shows these values in its own window,
// and in daemon mode the window's process is a loopback client of this
// daemon. Key material (`crypto:*`: signing keys, envelope descriptors, KDF
// rows) is never returned, whoever asks. A value that is absent, sealed in a
// locked envelope or encrypted with a password key the daemon does not hold
// is left out of `values`. Answers carry `Cache-Control: no-store`; values
// are never logged.
//
// copy-app-key stores the app provider's own key (Settings → Providers) as
// the agent's provider credential, inside the daemon: the app key reaches a
// client only as `__redacted__`, so a client cannot copy it itself. It has
// the locked-envelope rules of PUT /files/agent/providers/:providerId/credential.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { basename } from 'node:path'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import { RuntimeLoopError } from '../../runtime/runtime-service'
import { AgentFileOps, FileOpError } from '../file-ops'
import { PathAgentOps, withClosedAgentFile } from '../path-agent-ops'
import { requireLocalCaller } from '../identity-routes'
import { providerSettings } from './credentials-routes'
import { resolveAgentWorkspace, resolveAgentWorkspaceByPath } from './agent-resolver'
import type { DaemonRouteContext } from './index'
import { badRequest, notFound } from './route-helpers'

const VALUES = 'Stored credential values can be read'

/** Key material: never returned by any route. */
const KEY_MATERIAL = /^crypto:/

interface RevealBody { purposes?: unknown; prefix?: unknown }

/** The purposes a reveal asks for: an explicit list, every purpose under an exact prefix, or both. */
function selection(body: unknown): { purposes: string[]; prefix: string | null } | string {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as RevealBody
  if (b.purposes !== undefined && (!Array.isArray(b.purposes) || !b.purposes.every((p) => typeof p === 'string' && p.length > 0))) {
    return 'purposes must be an array of non-empty strings'
  }
  if (b.prefix !== undefined && (typeof b.prefix !== 'string' || b.prefix.length === 0)) return 'prefix must be a non-empty string'
  const purposes = (b.purposes as string[] | undefined) ?? []
  const prefix = (b.prefix as string | undefined) ?? null
  if (purposes.length === 0 && prefix === null) return 'purposes or prefix is required'
  return { purposes, prefix }
}

/** The readable values of the selection; key material and unreadable rows are left out. */
function readValues(ws: AdfWorkspace, derivedKey: Buffer | null, sel: { purposes: string[]; prefix: string | null }): Record<string, string> {
  // listIdentityPurposes matches with LIKE (case-insensitive, `_`/`%` wildcards): keep exact prefix matches only.
  const wanted = new Set(sel.purposes)
  if (sel.prefix !== null) for (const purpose of ws.listIdentityPurposes(sel.prefix)) if (purpose.startsWith(sel.prefix)) wanted.add(purpose)
  const values: Record<string, string> = {}
  for (const purpose of wanted) {
    if (KEY_MATERIAL.test(purpose)) continue
    let value: string | null = null
    try { value = ws.getIdentityDecrypted(purpose, derivedKey) } catch { value = null }
    if (value !== null) values[purpose] = value
  }
  return values
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FileOpError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, code: err.code })
  if (err instanceof RuntimeLoopError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, ...(err.code ? { code: err.code } : {}) })
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' })
}

/** Path-addressed credential writes never move or announce a file: no tracked-folder push. */
const NO_EVENTS = { sync: () => {}, notifyPathChanged: () => {}, notifyRenamed: () => {}, expectFile: () => {} } as unknown as ConstructorParameters<typeof AgentFileOps>[0]['events']

export function registerCredentialValueRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime } = ctx
  const settings = ctx.options.settingsStore
  const files = new AgentFileOps({ runtime, settings, identity: ctx.options.identity, events: NO_EVENTS })
  const pathOps = new PathAgentOps(runtime, files, settings)

  server.post<{ Params: { id: string }; Body: unknown }>('/agents/:id/identity/reveal', async (request, reply) => {
    if (!requireLocalCaller(request, reply, ctx.localAccess, VALUES)) return reply
    const sel = selection(request.body)
    if (typeof sel === 'string') return badRequest(reply, sel)
    const found = resolveAgentWorkspace(runtime, request.params.id)
    if (!found.ok) return notFound(reply, found.message)
    const values = readValues(found.agent.workspace, found.agent.derivedKey, sel)
    return reply.header('Cache-Control', 'no-store').send({ agentId: found.agent.agentId, values })
  })

  server.post<{ Querystring: { path?: string }; Body: unknown }>('/files/agent/identity/reveal', async (request, reply) => {
    if (!requireLocalCaller(request, reply, ctx.localAccess, VALUES)) return reply
    const sel = selection(request.body)
    if (typeof sel === 'string') return badRequest(reply, sel)
    try {
      const filePath = await files.adfPath(request.query.path)
      const open = resolveAgentWorkspaceByPath(runtime, filePath)
      // A file nobody has open is opened for the read with this runtime's
      // envelope keys and closed again (Studio reads it the same way).
      const values = open
        ? readValues(open.workspace, open.derivedKey, sel)
        : withClosedAgentFile(filePath, (ws) => readValues(ws, null, sel))
      return reply.header('Cache-Control', 'no-store').send({ filePath, loaded: !!open, values })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post<{ Querystring: { path?: string }; Params: { providerId: string }; Body: { replace?: unknown } | null }>(
    '/files/agent/providers/:providerId/credential/copy-app-key',
    async (request, reply) => {
      const { providerId } = request.params
      if (request.body?.replace !== undefined && typeof request.body.replace !== 'boolean') return badRequest(reply, 'replace must be a boolean')
      const appKey = providerSettings(settings).getProvider(providerId)?.apiKey
      if (!appKey) {
        return reply.code(409).send({ error: `The app provider "${providerId}" has no API key to copy.`, code: 'no_app_key' })
      }
      try {
        const result = await pathOps.setProviderCredential(request.query.path, providerId, { value: appKey, replace: request.body?.replace === true })
        console.log(`[ADF Daemon] Copied the app key of provider "${providerId}" into ${basename(result.filePath)}`)
        return result
      } catch (err) {
        return sendError(reply, err)
      }
    },
  )
}
