// Stored credential values for Studio on this machine (tracker W3-B):
// the Identity panel's Reveal, the provider override form's key field and
// "Copy app key" on an agent's providers.
//
//   POST /agents/:id/identity/reveal                              { purposes?, prefix? }
//   POST /files/agent/identity/reveal?path=                       { purposes?, prefix? }
//   POST /files/agent/providers/:providerId/credential/copy-app-key?path=   { replace? }
//
// The reveal routes are the one exception to "values never leave the
// daemon" (design §5.4.1). They answer local callers that ALSO present this
// run's local proof (X-ADF-Local-Proof, the daemon-local-proof file next to
// the daemon settings), in every mode: the token alone, forwarded to the
// loopback port (`ssh -L`, socat), is refused. Embedded Studio shows these
// values in its own window; in daemon mode that window's process is a
// local client that can read the proof file. Key material (`crypto:*`) is
// never returned, whoever asks. Answers carry `Cache-Control: no-store`;
// values are never logged.
//
// Both are reads: a document another runtime runs (opened read-only here)
// is revealed from its open workspace, and a file nobody has open is read
// through one readonly connection (no migration, no envelope re-wrap, no
// write). Such a file's sealed values stay out (no envelope is unlocked),
// as Studio's read of a file it does not have open leaves them out.
//
// copy-app-key stores the app provider's own key (Settings → Providers) as
// the agent's provider credential, inside the daemon: the app key reaches a
// client only as `__redacted__`, so a client cannot copy it itself. It has
// the locked-envelope rules of PUT /files/agent/providers/:providerId/credential.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { basename } from 'node:path'
import { AdfDatabase } from '../../adf/adf-database'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import { RuntimeLoopError } from '../../runtime/runtime-service'
import { isKeyMaterialPurpose } from '../../../shared/constants/identity-reveal'
import { AgentFileOps, FileOpError } from '../file-ops'
import { PathAgentOps } from '../path-agent-ops'
import { requireLocalCaller } from '../identity-routes'
import { requireLocalProof } from './identity-import-routes'
import { providerSettings } from './credentials-routes'
import { resolveAgentWorkspace, resolveAgentWorkspaceByPath } from './agent-resolver'
import type { DaemonRouteContext } from './index'
import { badRequest, notFound } from './route-helpers'

const VALUES = 'Stored credential values can be read'
const PROOF_REFUSAL = 'Stored credential values are shown only to Studio on the daemon\'s own machine: this request lacks the local proof (X-ADF-Local-Proof, the daemon-local-proof file next to the daemon settings).'

interface RevealBody { purposes?: unknown; prefix?: unknown }
interface Selection { purposes: string[]; prefix: string | null }

/** The purposes a reveal asks for: an explicit list, every purpose under an exact prefix, or both. */
function selection(body: unknown): Selection | string {
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

/** The selected purposes among `all`, exact prefix match (a LIKE would take `_`/`%` as wildcards), never key material. */
function wanted(all: Iterable<string>, sel: Selection): string[] {
  const out = new Set(sel.purposes)
  if (sel.prefix !== null) for (const purpose of all) if (purpose.startsWith(sel.prefix)) out.add(purpose)
  return [...out].filter((p) => !isKeyMaterialPurpose(p))
}

/** The readable values of the selection in an open workspace. */
function readValues(ws: AdfWorkspace, derivedKey: Buffer | null, sel: Selection): Record<string, string> {
  const values: Record<string, string> = {}
  for (const purpose of wanted(sel.prefix !== null ? ws.listIdentityPurposes(sel.prefix) : [], sel)) {
    let value: string | null = null
    try { value = ws.getIdentityDecrypted(purpose, derivedKey) } catch { value = null }
    if (value !== null) values[purpose] = value
  }
  return values
}

/** The plain values of the selection in a file nobody has open: one readonly connection, nothing written. */
function peekValues(filePath: string, sel: Selection): Record<string, string> {
  return AdfDatabase.peek(filePath, (db) => {
    let rows: Array<{ purpose: string; value: Buffer | string; encryption_algo: string | null }> = []
    try {
      rows = db.prepare('SELECT purpose, value, encryption_algo FROM adf_identity').all() as typeof rows
    } catch { /* no identity table in an old file */ }
    const byPurpose = new Map(rows.map((r) => [r.purpose, r]))
    const values: Record<string, string> = {}
    for (const purpose of wanted(byPurpose.keys(), sel)) {
      const row = byPurpose.get(purpose)
      if (!row || (row.encryption_algo ?? 'plain') !== 'plain') continue
      values[purpose] = Buffer.isBuffer(row.value) ? row.value.toString('utf-8') : String(row.value)
    }
    return values
  })
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
  const local = (request: Parameters<typeof requireLocalCaller>[0], reply: FastifyReply): boolean =>
    requireLocalCaller(request, reply, ctx.localAccess, VALUES)
    && requireLocalProof(request, reply, ctx.localAccess.localProof ?? null, PROOF_REFUSAL)

  server.post<{ Params: { id: string }; Body: unknown }>('/agents/:id/identity/reveal', async (request, reply) => {
    if (!local(request, reply)) return reply
    const sel = selection(request.body)
    if (typeof sel === 'string') return badRequest(reply, sel)
    const found = resolveAgentWorkspace(runtime, request.params.id)
    if (!found.ok) return notFound(reply, found.message)
    const values = readValues(found.agent.workspace, found.agent.derivedKey, sel)
    return reply.header('Cache-Control', 'no-store').send({ agentId: found.agent.agentId, values })
  })

  server.post<{ Querystring: { path?: string }; Body: unknown }>('/files/agent/identity/reveal', async (request, reply) => {
    if (!local(request, reply)) return reply
    const sel = selection(request.body)
    if (typeof sel === 'string') return badRequest(reply, sel)
    try {
      const filePath = await files.adfPath(request.query.path)
      const open = resolveAgentWorkspaceByPath(runtime, filePath)
      const values = open ? readValues(open.workspace, open.derivedKey, sel) : peekValues(filePath, sel)
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
