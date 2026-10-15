// File-level operations, raw file transfers and the tracked-folder watcher
// (design daemon-backend.md §6, §9.3; tracker W1-E):
//
//   GET    /files/agent                path → id rule: { agentId, loaded, tracked, … }
//   GET    /files/agents-folder        where new and accepted agents go
//   DELETE /files                      delete an agent file (stops it first)
//   POST   /files/rename               rename (deferred while the agent runs)
//   POST   /files/clone                clone with selected tables + clone-fixup
//   POST   /files/relocate             accept-relocate into the agents folder
//   POST   /files/save-as              shareable copy to another path on this host
//   GET    /files/snapshot             snapshot bytes: share (identity-free) or export
//   POST   /files/import               octet-stream upload of an .adf into a tracked folder
//   GET    /agents/:id/export          consistent snapshot of an agent's file (SQLite backup API)
//   GET    /agents/:id/files/meta      internal file metadata, no content
//   GET    /agents/:id/files/raw       internal file bytes (octet-stream, optional size cap)
//   PUT    /agents/:id/files/raw       internal file upload (octet-stream, own body limit)
//   GET    /fs/browse                  daemon-side folder picker (folders and .adf files only)
//   GET    /tracked-dirs/tree          a tracked folder's tree (Studio's TRACKED_DIRS_SCAN)
//   …      /files/agent/*              path-addressed agent ops for files that are not loaded
//
// The tracked-folder watcher (dir-watcher.ts) is the push source for
// `tracked_dirs` and `file_renamed`. The composition root passes one in
// DaemonRouteDeps.trackedDirWatcher to watch and autostart; without it these
// routes still raise their pushes on a watcher that does not watch.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { AdfWorkspace } from '../../adf/adf-workspace'
import { withSource } from '../../runtime/execution-context'
import { fileRevisionKey, observeRevision, runAsWriter } from '../../runtime/resource-revisions'
import { requestWriter } from './client-routes'
import { RuntimeLoopError, RuntimeReviewRequiredError, type RuntimeAgentFileRenamedEvent, type RuntimeAgentPathChangedEvent } from '../../runtime/runtime-service'
import { TrackedDirWatcher } from '../dir-watcher'
import { AgentFileOps, FileOpError, browse, readCapped, resolveAgentsFolder, snapshotToTemp, streamSnapshot, type SnapshotMode } from '../file-ops'
import { PathAgentOps } from '../path-agent-ops'
import { forgetTrackedFile, scanTrackedTree, TrackedDirError, type TrackedDirsSettings } from '../tracked-dirs'
import type { DaemonRouteContext } from './index'
import { resolveAgentWorkspace } from './agent-resolver'

const MIB = 1024 * 1024
/** PUT /agents/:id/files/raw default cap (ADF_DAEMON_RAW_BODY_LIMIT_MB overrides). */
export const RAW_FILE_BODY_LIMIT = 64 * MIB
/** POST /files/import default cap (ADF_DAEMON_IMPORT_BODY_LIMIT_MB overrides). */
export const IMPORT_BODY_LIMIT = 1024 * MIB

/** Routes that take an application/octet-stream body as a stream. */
const STREAM_ROUTES = new Set(['/agents/:id/files/raw', '/files/import', '/templates/:id/files/raw'])

/** Extensions Studio's file viewer reads as text (DOC_READ_INTERNAL_FILE). */
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])

function limitFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw * MIB) : fallback
}

const NO_SETTINGS: TrackedDirsSettings = { get: () => undefined }

export function registerFileRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const runtime = ctx.runtime
  const settings = ctx.options.settingsStore
  const watcher = ctx.options.routes?.trackedDirWatcher ?? new TrackedDirWatcher({
    runtime,
    settings: settings ?? NO_SETTINGS,
    onTrackedDirectoriesChanged: ctx.options.onTrackedDirectoriesChanged,
    watch: false,
  })
  const files = new AgentFileOps({ runtime, settings, identity: ctx.options.identity, events: watcher })
  const pathOps = new PathAgentOps(runtime, files, settings)
  const rawLimit = ctx.options.routes?.rawFileBodyLimit ?? limitFromEnv('ADF_DAEMON_RAW_BODY_LIMIT_MB', RAW_FILE_BODY_LIMIT)
  const importLimit = ctx.options.routes?.importBodyLimit ?? limitFromEnv('ADF_DAEMON_IMPORT_BODY_LIMIT_MB', IMPORT_BODY_LIMIT)

  // A running agent's deferred rename is applied once it stops.
  // RuntimeService renames files (a running agent's deferred rename when it
  // stops; the file following the agent's name) and re-keys moved ones
  // (W1-A): both feed the file_renamed push, and the watcher must not
  // autostart the moved file.
  const onFileMoved = (event: RuntimeAgentFileRenamedEvent | RuntimeAgentPathChangedEvent) => {
    forgetTrackedFile(event.oldFilePath)
    watcher.notifyRenamed(event.oldFilePath, event.filePath)
    watcher.notifyPathChanged(event.filePath)
  }
  runtime.on('agent-file-renamed', onFileMoved)
  runtime.on('agent-path-changed', onFileMoved)
  server.addHook('onReady', async () => {
    if (settings) watcher.start()
  })
  server.addHook('onClose', async () => {
    runtime.off('agent-file-renamed', onFileMoved)
    runtime.off('agent-path-changed', onFileMoved)
    await watcher.close()
  })
  // Other routes change the tracked list too (POST /agents/create tracks the
  // new agent's folder, POST/DELETE /tracked-dirs): re-sync after every write
  // so the watcher follows and a newly tracked folder is pushed. A no-op
  // when the list did not change.
  server.addHook('onResponse', (request, _reply, done) => {
    if (settings && request.method !== 'GET' && request.method !== 'HEAD') {
      // POST/DELETE /tracked-dirs tell the daemon themselves (onTrackedDirectoriesChanged).
      // A settings write that adds a tracked folder only re-syncs the watcher, as
      // Studio's SETTINGS_SET restarts its watcher without a TRACKED_DIRS_CHANGED.
      const url = request.routeOptions.url ?? ''
      const announce = !url.startsWith('/tracked-dirs') && !url.startsWith('/settings')
      try { watcher.sync({ announce }) } catch (err) { console.warn('[FileRoutes] Tracked-folder re-sync failed:', err) }
    }
    done()
  })

  // Octet-stream bodies reach the streaming routes as the raw request stream
  // (each enforces its own byte limit); every other route refuses them.
  if (!server.hasContentTypeParser('application/octet-stream')) {
    server.addContentTypeParser('application/octet-stream', (request, payload, done) => {
      if (!STREAM_ROUTES.has(request.routeOptions.url ?? '')) {
        const err = Object.assign(new Error('Unsupported Media Type: application/octet-stream'), { statusCode: 415 })
        done(err, undefined)
        return
      }
      done(null, payload)
    })
  }

  const fail = (reply: FastifyReply, err: unknown, request?: FastifyRequest) => {
    // An upload refused past its limit was left unread: close the connection once the answer is out.
    if (request && err instanceof FileOpError && err.statusCode === 413) closeAfterResponse(request, reply)
    return sendError(reply, err)
  }

  // --- Path → id, agents folder ------------------------------------------------

  server.get<{ Querystring: { path?: string } }>('/files/agent', async (request, reply) => {
    try { return await files.describe(request.query.path) } catch (err) { return fail(reply, err) }
  })

  server.get('/files/agents-folder', async (_request, reply) => {
    try {
      const folder = await resolveAgentsFolder(settings)
      let exists = false
      try { exists = (await stat(folder.path)).isDirectory() } catch { exists = false }
      return { ...folder, exists }
    } catch (err) {
      return fail(reply, err)
    }
  })

  // --- File-level operations -----------------------------------------------------

  server.delete<{ Querystring: { path?: string } }>('/files', async (request, reply) => {
    try { return await files.delete(request.query.path) } catch (err) { return fail(reply, err) }
  })

  server.post<{ Body: { path?: unknown; newName?: unknown } | undefined }>('/files/rename', async (request, reply) => {
    const header = request.headers['x-adf-client-session']
    const origin = Array.isArray(header) ? header[0] : header
    try { return await files.rename(request.body?.path, request.body?.newName, origin ? { origin } : {}) } catch (err) { return fail(reply, err) }
  })

  server.post<{ Body: { path?: unknown; selectedTables?: unknown } | undefined }>('/files/clone', async (request, reply) => {
    try {
      return reply.code(201).send(await files.clone(request.body?.path, request.body?.selectedTables))
    } catch (err) {
      return fail(reply, err)
    }
  })

  server.post<{ Body: { path?: unknown } | undefined }>('/files/relocate', async (request, reply) => {
    try { return await files.relocate(request.body?.path) } catch (err) { return fail(reply, err) }
  })

  // Studio's "Save a copy…": the identity-free share snapshot only. A full
  // copy on this host would be a twin of the agent (same config.id and DID).
  server.post<{ Body: { path?: unknown; destPath?: unknown; mode?: unknown; overwrite?: unknown } | undefined }>('/files/save-as', async (request, reply) => {
    const body = request.body ?? {}
    if (body.mode !== undefined && body.mode !== 'share') {
      return reply.code(400).send({ error: 'save-as writes the shareable copy only (mode share); download a full copy with GET /agents/{id}/export', code: 'export_not_supported' })
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') return badRequest(reply, 'overwrite must be a boolean')
    try {
      return await files.saveAs(body.path, body.destPath, body.overwrite === true)
    } catch (err) {
      return fail(reply, err)
    }
  })

  server.get<{ Querystring: { path?: string; mode?: string } }>('/files/snapshot', async (request, reply) => {
    const mode = parseMode(request.query.mode, 'share')
    if (!mode) return badRequest(reply, 'mode must be share or export')
    try {
      const filePath = await files.adfPath(request.query.path)
      return await sendSnapshot(reply, filePath, mode)
    } catch (err) {
      return fail(reply, err)
    }
  })

  server.get<{ Params: { id: string } }>('/agents/:id/export', async (request, reply) => {
    try {
      return await sendSnapshot(reply, await files.resolveAgentFile(request.params.id), 'export')
    } catch (err) {
      return fail(reply, err)
    }
  })

  server.post<{ Querystring: { directory?: string; name?: string; unique?: string } }>('/files/import', async (request, reply) => {
    const unique = parseBool(request.query.unique)
    if (unique === null) return badRequest(reply, 'unique must be true or false')
    if (!isOctetStream(request)) return unsupported(reply)
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > importLimit) return tooLarge(request, reply, importLimit)
    try {
      return reply.code(201).send(await files.import(request.body, {
        directory: request.query.directory,
        name: request.query.name,
        unique,
        maxBytes: importLimit,
      }))
    } catch (err) {
      return fail(reply, err, request)
    }
  })

  // --- Internal files of an agent: metadata and raw bytes ---------------------------

  // A running agent or an open document (D4, agent-resolver.ts); an in-memory agent has no workspace here.
  const agentFiles = (id: string) => {
    const ref = runtime.getAgentOrDocument(id)
    if (!ref) return null
    const resolved = resolveAgentWorkspace(runtime, id)
    return { ref, workspace: resolved.ok ? resolved.agent.workspace : null }
  }

  const fileMeta = (id: string, path: string) => {
    const agent = agentFiles(id)
    if (!agent) return null
    if (agent.workspace) {
      const meta = agent.workspace.getFileMeta(path)
      return meta ? { agent, meta } : { agent, meta: null }
    }
    // In-memory agent (no file): through the runtime's own read.
    const file = runtime.getAgentFile(agent.ref.id, path)
    if (!file) return { agent, meta: null }
    const { content: _c, content_base64: _b, encoding: _e, agentId: _a, ...meta } = file
    return { agent, meta }
  }

  // Metadata only: Studio decides text / image / too large before fetching
  // any bytes (DOC_READ_INTERNAL_FILE never ships a binary it would discard).
  server.get<{ Params: { id: string }; Querystring: { path?: string } }>('/agents/:id/files/meta', async (request, reply) => {
    const path = request.query.path
    if (!validInternalPath(path)) return badRequest(reply, 'path is required')
    const found = fileMeta(request.params.id, path)
    if (!found) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!found.meta) return notFound(reply, `Unknown file "${path}"`)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return { agentId: found.agent.ref.id, ...found.meta, text: TEXT_EXTENSIONS.has(ext) }
  })

  server.get<{ Params: { id: string }; Querystring: { path?: string; maxBytes?: string } }>('/agents/:id/files/raw', async (request, reply) => {
    const path = request.query.path
    if (!validInternalPath(path)) return badRequest(reply, 'path is required')
    let maxBytes: number | undefined
    if (request.query.maxBytes !== undefined) {
      maxBytes = Number(request.query.maxBytes)
      if (!Number.isInteger(maxBytes) || maxBytes < 0) return badRequest(reply, 'maxBytes must be a non-negative integer')
    }
    const found = fileMeta(request.params.id, path)
    if (!found) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!found.meta) return notFound(reply, `Unknown file "${path}"`)
    if (maxBytes !== undefined && found.meta.size > maxBytes) {
      return reply.code(413).send({ error: `${path} is ${found.meta.size} bytes, more than maxBytes (${maxBytes})`, code: 'too_large', size: found.meta.size, maxBytes })
    }
    let bytes: Buffer | null
    let revision: number | undefined
    if (found.agent.workspace) {
      bytes = found.agent.workspace.readFileBuffer(path)
      if (bytes) revision = observeRevision(found.agent.workspace, fileRevisionKey(path), bytes).revision
    } else {
      const file = runtime.getAgentFile(found.agent.ref.id, path)
      bytes = file ? (file.content_base64 !== undefined ? Buffer.from(file.content_base64, 'base64') : Buffer.from(file.content ?? '', 'utf-8')) : null
      revision = file?.revision
    }
    if (!bytes) return notFound(reply, `Unknown file "${path}"`)
    // W3-F: the revision a write of these bytes saves over (PUT …/files/content baseRevision).
    if (revision !== undefined) reply.header('X-ADF-Revision', String(revision))
    return reply
      .header('Content-Type', found.meta.mime_type || 'application/octet-stream')
      .header('Content-Disposition', attachment(basename(path)))
      .header('X-Content-Type-Options', 'nosniff')
      .send(bytes)
  })

  server.put<{ Params: { id: string }; Querystring: { path?: string; mimeType?: string; unique?: string } }>('/agents/:id/files/raw', async (request, reply) => {
    const path = request.query.path
    if (!validInternalPath(path)) return badRequest(reply, 'path is required')
    const unique = parseBool(request.query.unique)
    if (unique === null) return badRequest(reply, 'unique must be true or false')
    const agent = agentFiles(request.params.id)
    if (!agent) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!isOctetStream(request)) return unsupported(reply)
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > rawLimit) return tooLarge(request, reply, rawLimit)
    try {
      const bytes = await readCapped(request.body, rawLimit)
      const mimeType = request.query.mimeType || AdfWorkspace.mimeTypeForPath(path)
      // W3-F: the write runs after the body was read (an await), past the
      // preHandler's writer: it names its writer itself.
      const writer = requestWriter(request)
      let saved = path
      let revision: number | undefined
      if (agent.workspace) {
        const ws = agent.workspace
        saved = runAsWriter(writer, () => withSource('system:runtime-api', agent.ref.id, () => {
          if (unique) return ws.writeFileBufferUnique(path, bytes, mimeType)
          ws.writeFileBuffer(path, bytes, mimeType)
          return path
        }))
        revision = observeRevision(ws, fileRevisionKey(saved), ws.readFileBuffer(saved), writer).revision
      } else {
        if (unique) return reply.code(409).send({ error: 'unique naming needs a file-backed agent', code: 'not_file_backed' })
        revision = runAsWriter(writer, () => runtime.writeAgentFile(agent.ref.id, path, { contentBase64: bytes.toString('base64'), mimeType })).revision
      }
      return { agentId: agent.ref.id, success: true, path: saved, size: bytes.length, ...(revision !== undefined ? { revision } : {}) }
    } catch (err) {
      return fail(reply, err, request)
    }
  })

  // --- Daemon-side picker and tracked tree ----------------------------------------

  server.get<{ Querystring: { path?: string; showHidden?: string } }>('/fs/browse', async (request, reply) => {
    const showHidden = parseBool(request.query.showHidden)
    if (showHidden === null) return badRequest(reply, 'showHidden must be true or false')
    try { return await browse(settings, request.query.path, { showHidden }) } catch (err) { return fail(reply, err) }
  })

  server.get<{ Querystring: { path?: string } }>('/tracked-dirs/tree', async (request, reply) => {
    if (!settings) return reply.code(503).send({ error: 'Settings store is not configured.', code: 'unavailable' })
    try { return await scanTrackedTree(settings, request.query.path, fp => files.pendingName(fp)) } catch (err) { return fail(reply, err) }
  })

  // --- Path-addressed agent operations (files that are not loaded) -------------------

  type PathQ = { Querystring: { path?: string } }
  server.get<PathQ>('/files/agent/tables', async (request, reply) => {
    try { return await pathOps.tables(request.query.path) } catch (err) { return fail(reply, err) }
  })
  server.put<PathQ & { Body: unknown }>('/files/agent/model', async (request, reply) => {
    try { return await pathOps.setModel(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.put<PathQ & { Params: { providerId: string }; Body: unknown }>('/files/agent/providers/:providerId/credential', async (request, reply) => {
    try { return await pathOps.setProviderCredential(request.query.path, request.params.providerId, request.body) } catch (err) { return fail(reply, err) }
  })
  server.get<PathQ & { Params: { providerId: string } }>('/files/agent/providers/:providerId/credentials', async (request, reply) => {
    try { return await pathOps.getProviderCredentials(request.query.path, request.params.providerId) } catch (err) { return fail(reply, err) }
  })
  server.post<PathQ & { Body: unknown }>('/files/agent/providers', async (request, reply) => {
    try { return await pathOps.attachProvider(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.delete<PathQ & { Params: { providerId: string } }>('/files/agent/providers/:providerId', async (request, reply) => {
    try { return await pathOps.detachProvider(request.query.path, request.params.providerId) } catch (err) { return fail(reply, err) }
  })
  server.put<PathQ & { Body: unknown }>('/files/agent/mcp/credentials', async (request, reply) => {
    try { return await pathOps.setMcpCredential(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.get<{ Querystring: { path?: string; npmPackage?: string } }>('/files/agent/mcp/credentials', async (request, reply) => {
    try { return await pathOps.getMcpCredentials(request.query.path, request.query.npmPackage) } catch (err) { return fail(reply, err) }
  })
  server.post<PathQ & { Body: unknown }>('/files/agent/mcp/servers', async (request, reply) => {
    try { return await pathOps.attachMcpServer(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.delete<{ Querystring: { path?: string; credentialNamespace?: string }; Params: { serverName: string } }>('/files/agent/mcp/servers/:serverName', async (request, reply) => {
    try { return await pathOps.detachMcpServer(request.query.path, request.params.serverName, request.query.credentialNamespace) } catch (err) { return fail(reply, err) }
  })
  server.put<PathQ & { Body: unknown }>('/files/agent/adapters/credentials', async (request, reply) => {
    try { return await pathOps.setAdapterCredential(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.get<{ Querystring: { path?: string; adapterType?: string } }>('/files/agent/adapters/credentials', async (request, reply) => {
    try { return await pathOps.getAdapterCredentials(request.query.path, request.query.adapterType) } catch (err) { return fail(reply, err) }
  })
  server.post<PathQ & { Body: unknown }>('/files/agent/adapters', async (request, reply) => {
    try { return await pathOps.attachAdapter(request.query.path, request.body) } catch (err) { return fail(reply, err) }
  })
  server.delete<PathQ & { Params: { adapterType: string } }>('/files/agent/adapters/:adapterType', async (request, reply) => {
    try { return await pathOps.detachAdapter(request.query.path, request.params.adapterType) } catch (err) { return fail(reply, err) }
  })
}

async function sendSnapshot(reply: FastifyReply, filePath: string, mode: SnapshotMode): Promise<FastifyReply> {
  const snapshot = await snapshotToTemp(filePath, mode)
  return reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', String(snapshot.size))
    .header('Content-Disposition', attachment(basename(filePath)))
    .send(streamSnapshot(snapshot))
}

function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function parseMode(raw: unknown, fallback: SnapshotMode): SnapshotMode | null {
  if (raw === undefined || raw === null || raw === '') return fallback
  return raw === 'share' || raw === 'export' ? raw : null
}

/** 'true' / 'false' / absent (false); null for anything else. */
function parseBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '' || raw === 'false') return false
  if (raw === 'true') return true
  return null
}

function validInternalPath(path: unknown): path is string {
  return typeof path === 'string' && path.trim() !== '' && path.length <= 1024 && !path.includes('\0')
}

function isOctetStream(request: FastifyRequest): boolean {
  return String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/octet-stream'
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error, code: 'bad_request' })
}

function notFound(reply: FastifyReply, error: string) {
  return reply.code(404).send({ error, code: 'not_found' })
}

function unsupported(reply: FastifyReply) {
  return reply.code(415).send({ error: 'Send the file as the request body with Content-Type: application/octet-stream', code: 'unsupported_media_type' })
}

/** Answer, then drop the connection: the rest of the request body is never read. */
export function closeAfterResponse(request: FastifyRequest, reply: FastifyReply): void {
  // No `Connection: close` header: with it Node destroys the socket as soon as
  // the answer is written, and a client still sending gets a reset (ECONNRESET)
  // instead of the 413 body. Instead: half-close once the answer is out (the
  // client reads it, then EOF), discard what it still sends within a budget,
  // then cut the connection.
  reply.raw.once('finish', () => {
    const socket = request.raw.socket as (typeof request.raw.socket & { end?: () => void }) | undefined
    if (!socket || socket.destroyed || typeof socket.end !== 'function') return
    let drained = 0
    const cut = () => {
      clearTimeout(timer)
      if (!socket.destroyed) socket.destroy()
    }
    const timer = setTimeout(cut, DRAIN_TIMEOUT_MS)
    timer.unref?.()
    socket.once('close', () => clearTimeout(timer))
    socket.end()
    request.raw.on('data', (chunk: Buffer) => {
      drained += chunk.length
      if (drained > DRAIN_BUDGET_BYTES) cut()
    })
    request.raw.once('end', cut)
    request.raw.resume()
  })
}

/** What a refused upload may still send after its 413 before the connection is cut. */
const DRAIN_BUDGET_BYTES = 8 * MIB
const DRAIN_TIMEOUT_MS = 5_000

function tooLarge(request: FastifyRequest, reply: FastifyReply, maxBytes: number) {
  closeAfterResponse(request, reply)
  return reply.code(413).send({ error: `The body is larger than the ${Math.round(maxBytes / MIB)} MiB this route accepts`, code: 'too_large', maxBytes })
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FileOpError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, code: err.code })
  if (err instanceof TrackedDirError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message })
  if (err instanceof RuntimeLoopError) {
    return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, ...(err.code ? { code: err.code } : {}) })
  }
  if (err instanceof RuntimeReviewRequiredError) {
    return reply.code(403).send({ error: err.message, code: err.code, agentId: err.agentId, filePath: err.filePath })
  }
  console.error('[FileRoutes] Request failed:', err)
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
