/**
 * MeshServer — Fastify HTTP server for agent mesh networking.
 *
 * Routes:
 *   GET  /health              — server health check
 *   GET  /:handle/mesh/card   — single agent card
 *   GET  /:handle/mesh/health — agent health
 *   POST /:handle/mesh/inbox  — ALF message delivery
 *   ALL  /:handle/mesh/*      — agent mesh routes (API lambdas)
 *   ALL  /:handle/*           — agent web/api (public files, shared files)
 *
 * Middleware is Fastify preHandlers — the preHandler array IS the pipeline.
 * User/agent-defined middleware (from adf_files) will also be preHandlers.
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import picomatch from 'picomatch'
import type { MeshManager, ServableAgent } from '../runtime/mesh-manager'
import type { CodeSandboxService } from '../runtime/code-sandbox'
import { loadLambdaSource } from '../runtime/ts-transpiler'
import type { WsConnectionManager } from './ws-connection-manager'
import type { AgentConfig, AlfAgentCard, AlfMessage, HttpRequest, HttpResponse, SecurityConfig, ServingApiRoute } from '../../shared/types/adf-v02.types'
import { flattenMessageToInbox } from '../utils/alf-message'
import {
  signEd25519,
  verifyEd25519,
  didToPublicKey,
  rawPublicKeyToSpki
} from '../crypto/identity-crypto'
import { canonicalJsonStringify } from './alf-pipeline'
import { ApiResponseCache } from './api-response-cache'
import { executeMiddlewareChain } from './middleware-executor'
import { classifyRemote, permits, denialReason, type Scope } from '../runtime/scope-resolver'
import { withSource } from '../runtime/execution-context'
import { emitUmbilicalEvent } from '../runtime/emit-umbilical'

export interface MeshServerSettings {
  get(key: string): unknown
}

// ===========================================================================
// Fastify Request Augmentation
// ===========================================================================

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved agent (set by resolveAgent preHandler) */
    agent?: ServableAgent | null
    /** Agent config (set by resolveAgent preHandler) */
    agentConfig?: AgentConfig | null
  }
}

// ===========================================================================
// Built-in Fastify PreHandlers (ALF Ingress Middleware)
// ===========================================================================

/**
 * PreHandler: Resolve agent by handle or DID, validate state.
 * Attaches request.agent and request.agentConfig for downstream handlers.
 */
function createResolveAgentHook(getMeshManager: () => MeshManager | null) {
  return async (request: FastifyRequest<{ Params: { handle: string } }>, reply: FastifyReply) => {
    const meshManager = getMeshManager()
    if (!meshManager) {
      return reply.code(404).send({ error: 'Mesh not enabled' })
    }

    const identifier = request.params.handle
    let agent = meshManager.getServableAgent(identifier)
    if (!agent) {
      agent = meshManager.getServableAgents().find(a => a.workspace.getDid() === identifier) ?? null
    }
    if (!agent) {
      return reply.code(404).send({ error: 'No agent with matching handle or DID' })
    }

    const config = agent.workspace.getAgentConfig()
    if (config.state === 'off') {
      return reply.code(503).send({ error: 'Agent is off' })
    }

    request.agent = agent
    request.agentConfig = config
  }
}

/**
 * PreHandler: Validate that the request body is a valid ALF message structure.
 */
async function validateAlfMessage(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'Invalid JSON body' })
  }
  if (!body.from || typeof body.from !== 'string') {
    return reply.code(400).send({ error: 'Missing required field: from' })
  }
  if (!body.payload || typeof body.payload !== 'object') {
    return reply.code(400).send({ error: 'Missing required field: payload' })
  }
  const payload = body.payload as Record<string, unknown>
  if (!payload.content) {
    return reply.code(400).send({ error: 'Missing required field: payload.content' })
  }
}

/**
 * PreHandler: Verify ALF message signature (if present or required).
 * Uses the agent's security config from request.agentConfig.
 *
 * Wire format: `from` may be a DID, an adapter-prefixed label, or a bare handle.
 * Signature verification is only attempted when `from` is a DID — it's the only
 * form from which a public key can be derived. Messages from bare handles or
 * adapter prefixes are treated as unsigned regardless of whether a signature
 * field is present (the field is ignored). Receivers decide whether to accept
 * unsigned messages via security config.
 */
async function verifyAlfMessageSignature(request: FastifyRequest, reply: FastifyReply) {
  const message = request.body as AlfMessage
  const security: SecurityConfig = request.agentConfig?.security ?? { allow_unsigned: true }
  const senderIsDid = typeof message.from === 'string' && message.from.startsWith('did:')

  if (!message.signature || !senderIsDid) {
    if (security.require_signature && !security.allow_unsigned) {
      return reply.code(403).send({ error: 'Message signature required but missing' })
    }
    message.meta = { ...message.meta, message_verified: false }
    return
  }

  const parts = message.signature.split(':')
  if (parts.length < 2 || parts[0] !== 'ed25519') {
    return reply.code(400).send({ error: `Unsupported signature algorithm: ${parts[0]}` })
  }
  const sigBase64 = parts.slice(1).join(':')

  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) {
    return reply.code(400).send({ error: `Cannot extract public key from DID: ${message.from}` })
  }
  const spkiKey = rawPublicKeyToSpki(rawPubKey)

  // Sign everything except `signature` and `transit`
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature, transit, ...signable } = message
  const data = Buffer.from(canonicalJsonStringify(signable))
  const valid = verifyEd25519(data, sigBase64, spkiKey)

  if (!valid) {
    return reply.code(403).send({ error: 'Invalid message signature' })
  }

  // Stamp after verification — doesn't affect the already-verified signature
  message.meta = { ...message.meta, message_verified: true }
}

/**
 * PreHandler: Verify ALF payload signature (if present or required).
 * Like verifyAlfMessageSignature, only attempts verification when the sender is a DID.
 */
async function verifyAlfPayloadSignature(request: FastifyRequest, reply: FastifyReply) {
  const message = request.body as AlfMessage
  const security: SecurityConfig = request.agentConfig?.security ?? { allow_unsigned: true }
  const senderIsDid = typeof message.from === 'string' && message.from.startsWith('did:')

  if (!message.payload?.signature || !senderIsDid) {
    if (security.require_payload_signature) {
      return reply.code(403).send({ error: 'Payload signature required but missing' })
    }
    message.meta = { ...message.meta, payload_verified: false }
    return
  }

  const parts = message.payload.signature.split(':')
  if (parts.length < 2 || parts[0] !== 'ed25519') {
    return reply.code(400).send({ error: `Unsupported payload signature algorithm: ${parts[0]}` })
  }
  const sigBase64 = parts.slice(1).join(':')

  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) {
    return reply.code(400).send({ error: `Cannot extract public key from DID: ${message.from}` })
  }
  const spkiKey = rawPublicKeyToSpki(rawPubKey)

  // Sign everything in payload except `signature`
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature, ...signable } = message.payload
  const data = Buffer.from(canonicalJsonStringify(signable))
  const valid = verifyEd25519(data, sigBase64, spkiKey)

  if (!valid) {
    return reply.code(403).send({ error: 'Invalid payload signature' })
  }

  message.meta = { ...message.meta, payload_verified: true }
}

/**
 * PreHandler: Enforce the recipient agent's messaging.visibility tier against
 * the requester's network scope. Runs after resolveAgent (needs request.agentConfig)
 * and before any ingress-writing step.
 *
 * - visibility === 'off'      → 403 "agent not accepting messages"
 * - scope > visibility tier   → 403 "visibility tier mismatch"
 *
 * Cross-runtime requests can never satisfy 'directory' scope, so a 'directory'-tier
 * agent always rejects HTTP traffic. Same-runtime delivery uses a separate enforcement
 * path in MeshManager that can compute the ancestor-directory scope.
 */
async function enforceVisibility(request: FastifyRequest, reply: FastifyReply) {
  const config = request.agentConfig
  if (!config) return // resolveAgent must run first; if missing, let downstream 404
  const visibility = config.messaging?.visibility ?? 'localhost'
  const scope: Scope = classifyRemote(request.socket?.remoteAddress)
  if (!permits(visibility, scope)) {
    return reply.code(403).send({ error: denialReason(visibility), visibility, scope })
  }
}

// ===========================================================================
// MeshServer
// ===========================================================================

export class MeshServer {
  private server: FastifyInstance | null = null
  private meshManager: MeshManager | null = null
  private wsConnectionManager: WsConnectionManager | null = null
  private port = 7295
  private host = '127.0.0.1'
  private running = false
  private agentCaches = new Map<string, ApiResponseCache>()

  constructor(
    private codeSandboxService: CodeSandboxService,
    private settings: MeshServerSettings
  ) {}

  setMeshManager(manager: MeshManager | null): void {
    this.meshManager = manager
  }

  setWsConnectionManager(manager: WsConnectionManager | null): void {
    this.wsConnectionManager = manager
  }

  async start(): Promise<void> {
    if (this.running) return

    // Resolve port: env > settings > default
    const envPort = process.env.MESH_PORT
    if (envPort) {
      const parsed = parseInt(envPort, 10)
      if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
        this.port = parsed
      }
    } else {
      const settingsPort = this.settings.get('meshPort')
      if (typeof settingsPort === 'number' && settingsPort > 0) {
        this.port = settingsPort
      }
    }

    // Resolve host: binding is OR of {env override, meshLan setting, any lan-tier agent}.
    // A runtime with no reachable agent (all 'off') skips the server entirely.
    if (this.meshManager && !this.meshManager.hasAnyReachableAgent()) {
      console.log('[MeshServer] No reachable agents (all visibility=off); skipping server start')
      return
    }
    const envHost = process.env.MESH_HOST
    if (envHost) {
      this.host = envHost
    } else {
      const meshLan = !!this.settings.get('meshLan')
      const hasLanAgent = this.meshManager?.hasAgentOfTier('lan') ?? false
      const hasPublicAgent = this.meshManager?.hasAgentOfTier('public') ?? false
      this.host = (meshLan || hasLanAgent || hasPublicAgent) ? '0.0.0.0' : '127.0.0.1'
    }

    this.server = Fastify({ logger: false, forceCloseConnections: true })

    // Register WebSocket plugin (non-fatal — server works without WS support)
    try {
      await this.server.register(fastifyWebsocket)
    } catch (err) {
      console.error('[MeshServer] Failed to register WebSocket plugin:', err)
    }

    // Decorate request with agent slots
    this.server.decorateRequest('agent', null)
    this.server.decorateRequest('agentConfig', null)

    this.registerRoutes()

    try {
      await this.server.listen({ port: this.port, host: this.host })
      this.running = true
      if (this.meshManager) {
        this.meshManager.setMeshServerAddress(this.host, this.port)
      }
      console.log(`[MeshServer] Listening on http://${this.host}:${this.port}`)
    } catch (err) {
      console.error(`[MeshServer] Failed to start on port ${this.port}:`, err)
      this.server = null
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      try {
        await this.server.close()
      } catch (err) {
        console.error('[MeshServer] Error closing server:', err)
      }
      this.server = null
      this.running = false
      this.agentCaches.clear()
      console.log('[MeshServer] Stopped')
    }
  }

  private getAgentCache(handle: string): ApiResponseCache {
    let cache = this.agentCaches.get(handle)
    if (!cache) {
      cache = new ApiResponseCache()
      this.agentCaches.set(handle, cache)
    }
    return cache
  }

  isRunning(): boolean { return this.running }
  getPort(): number { return this.port }
  getHost(): string { return this.host }

  // ===========================================================================
  // Route Registration
  // ===========================================================================

  private registerRoutes(): void {
    const server = this.server!
    const resolveAgent = createResolveAgentHook(() => this.meshManager)

    // --- Health check ---
    server.get('/health', async () => {
      const agents = this.meshManager ? this.meshManager.getServableAgents().length : 0
      return { status: 'ok', uptime: process.uptime(), agents, port: this.port }
    })

    // --- Directory (visibility-filtered agent list) ---
    // Cards are built with requester-aware host substitution: endpoints reflect
    // the interface the request arrived on (request.socket.localAddress), not the
    // server's bind address. A LAN peer hitting a 0.0.0.0-bound server receives
    // the specific interface IP it reached us at, not 0.0.0.0 or 127.0.0.1.
    server.get('/mesh/directory', async (request) => {
      if (!this.meshManager) return []
      const scope = classifyRemote(request.socket?.remoteAddress)
      const servingHost = request.socket?.localAddress
      return this.meshManager.getDirectoryForScope(scope, servingHost)
    })

    // --- Agent card ---
    // Same requester-aware host substitution as /mesh/directory.
    server.get<{ Params: { handle: string } }>('/:handle/mesh/card', {
      preHandler: [resolveAgent]
    }, async (request) => {
      return this.getAgentCard(request.agent!, request.socket?.localAddress)
    })

    // --- Agent health ---
    server.get<{ Params: { handle: string } }>('/:handle/mesh/health', {
      preHandler: [resolveAgent]
    }, async (request) => {
      const config = request.agentConfig!
      return { status: config.state === 'off' ? 'off' : 'ok', state: config.state }
    })

    // --- ALF message receive ---
    // PreHandler pipeline: resolve agent → validate message → verify signatures
    server.post<{ Params: { handle: string } }>('/:handle/mesh/inbox', {
      preHandler: [resolveAgent, enforceVisibility, validateAlfMessage, verifyAlfMessageSignature, verifyAlfPayloadSignature]
    }, async (request, reply) => {
      const agent = request.agent!
      const body = request.body as Record<string, unknown>
      const payload = body.payload as Record<string, unknown>
      let message = body as unknown as AlfMessage
      const timestamp = Date.now()

      // Run inbox custom middleware (after verification, before storage)
      const config = request.agentConfig!
      const inboxMw = config.security?.middleware?.inbox
      if (inboxMw?.length && agent.codeSandboxService && agent.adfCallHandler) {
        const mwResult = await executeMiddlewareChain(
          inboxMw,
          { point: 'inbox', data: message, meta: {} },
          agent.workspace,
          agent.codeSandboxService,
          agent.adfCallHandler,
          config.id
        )
        if (mwResult.rejected) {
          return reply.code(mwResult.rejected.code).send({ error: mwResult.rejected.reason })
        }
        if (mwResult.data) {
          message = mwResult.data as AlfMessage
        }
      }

      // Rewrite reply_to when the sender self-declared a loopback host but the
      // packet reached us from a non-loopback peer. Senders build reply_to
      // before they know the delivery route, so cross-host messages commonly
      // arrive carrying http://127.0.0.1:<port>/... — replies to which would
      // loop back on the receiver. We trust the transport-observed remote
      // address (same pattern as observer-aware /mesh/directory URLs). Senders
      // that declared a real public endpoint keep it unchanged.
      const observedPeer = request.socket.remoteAddress
      if (typeof message.reply_to === 'string') {
        const rewritten = rewriteLoopbackHost(message.reply_to, observedPeer)
        if (rewritten !== message.reply_to) {
          message = { ...message, reply_to: rewritten }
          if (typeof body.reply_to === 'string') body.reply_to = rewritten
        }
      }

      // Audit: capture full message (has inline data from wire) before flattening
      try { agent.workspace.auditMessage('inbox', JSON.stringify(message), timestamp) } catch { /* best-effort */ }

      const flattened = flattenMessageToInbox(message, timestamp)

      // Set return_path from transport context (HTTP request origin)
      const forwardedHost = request.headers['x-forwarded-host'] as string | undefined
      const requestHost = forwardedHost || request.headers.host
      if (requestHost && body.reply_to) {
        flattened.return_path = body.reply_to as string
      }

      const inboxId = agent.workspace.addToInbox(flattened)

      // Fire on_inbox trigger
      if (agent.triggerEvaluator) {
        const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content)
        agent.triggerEvaluator.onInbox(body.from as string, content, {
          mentioned: true,
          source: 'mesh',
          messageId: inboxId,
          parentId: flattened.parent_id,
          threadId: flattened.thread_id
        })
      }

      return reply.code(202).send({ message_id: inboxId })
    })

    // --- WebSocket upgrade ---
    server.get<{ Params: { handle: string } }>('/:handle/mesh/ws', {
      websocket: true,
      preHandler: [resolveAgent]
    }, (socket, request) => {
      const agent = request.agent!
      const config = request.agentConfig!

      // Find WS route in serving.api
      const wsRoute = config.serving?.api?.find(r => r.method === 'WS')
      if (!wsRoute) {
        socket.close(4004, 'No WebSocket route configured')
        return
      }

      if (!this.wsConnectionManager) {
        socket.close(4503, 'WebSocket manager not available')
        return
      }

      const url_params: Record<string, string> = {}
      const rawQuery = request.query as Record<string, unknown> | undefined
      if (rawQuery) {
        for (const [key, value] of Object.entries(rawQuery)) {
          if (typeof value === 'string') url_params[key] = value
          else if (Array.isArray(value) && typeof value[0] === 'string') url_params[key] = value[0] as string
        }
      }
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value)) headers[key] = value.join(', ')
      }
      this.wsConnectionManager.handleInboundUpgrade(agent.filePath, socket, wsRoute, { url_params, headers })
    })

    // --- Agent mesh routes (API lambdas under mesh namespace) ---
    const meshCatchAll = async (request: FastifyRequest<{ Params: { handle: string; '*'?: string } }>, reply: FastifyReply) => {
      const agent = request.agent!
      const config = request.agentConfig!
      const rawSubpath = request.params['*'] || ''
      const serving = config.serving

      if (serving?.api && serving.api.length > 0) {
        const match = this.matchApiRoute(serving.api, request.method, rawSubpath)
        if (match) {
          return this.handleApiRoute(agent, match.route, match.params, request, reply)
        }
      }

      return reply.code(404).send({ error: 'Not found' })
    }
    server.all<{ Params: { handle: string; '*': string } }>('/:handle/mesh/*', { preHandler: [resolveAgent] }, meshCatchAll)
    server.all<{ Params: { handle: string } }>('/:handle/mesh', { preHandler: [resolveAgent] }, meshCatchAll)
    server.all<{ Params: { handle: string } }>('/:handle/mesh/', { preHandler: [resolveAgent] }, meshCatchAll)

    // --- Agent web/api routes (API lambdas, public files, shared files) ---
    const agentCatchAll = async (request: FastifyRequest<{ Params: { handle: string; '*'?: string } }>, reply: FastifyReply) => {
      const agent = request.agent!
      const config = request.agentConfig!
      const subpath = request.params['*'] || ''
      const serving = config.serving

      // Resolution order (matches standard web framework conventions):
      // 1. Exact & parameterized API routes  (e.g. /registry, /:handle/card)
      // 2. Static files                      (public/, shared patterns)
      // 3. Catch-all API routes              (e.g. /:handle/*)

      // 1 — Exact & parameterized API routes
      if (serving?.api && serving.api.length > 0) {
        const match = this.matchApiRoute(serving.api, request.method, subpath, false)
        if (match) {
          return this.handleApiRoute(agent, match.route, match.params, request, reply)
        }
      }

      // 2 — Static files (public folder, then shared patterns)
      if (serving?.public?.enabled) {
        const publicPath = subpath === '' ? (serving.public.index || 'index.html') : subpath
        const fullPath = `public/${publicPath}`
        const fileBuffer = agent.workspace.readFileBuffer(fullPath)
        if (fileBuffer) {
          const mime = this.getMimeType(publicPath)
          return reply.header('content-type', mime).send(fileBuffer)
        }
      }

      if (serving?.shared?.enabled && serving.shared.patterns?.length && subpath) {
        const isMatch = picomatch(serving.shared.patterns)
        if (isMatch(subpath)) {
          const fileBuffer = agent.workspace.readFileBuffer(subpath)
          if (fileBuffer) {
            const mime = this.getMimeType(subpath)
            return reply.header('content-type', mime).send(fileBuffer)
          }
        }
      }

      // 3 — Catch-all API routes
      if (serving?.api && serving.api.length > 0) {
        const match = this.matchApiRoute(serving.api, request.method, subpath, true)
        if (match) {
          return this.handleApiRoute(agent, match.route, match.params, request, reply)
        }
      }

      return reply.code(404).send({ error: 'Not found' })
    }
    server.all<{ Params: { handle: string; '*': string } }>('/:handle/*', { preHandler: [resolveAgent] }, agentCatchAll)
    server.all<{ Params: { handle: string } }>('/:handle/', { preHandler: [resolveAgent] }, agentCatchAll)

    // Bare /:handle — redirect GET/HEAD to /:handle/ so relative URLs in served HTML resolve correctly.
    // Other methods (POST etc.) fall through to the same handler as /:handle/.
    server.all<{ Params: { handle: string } }>('/:handle', { preHandler: [resolveAgent] }, async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
        return reply.redirect(`/${request.params.handle}/${qs}`, 301)
      }
      return agentCatchAll(request, reply)
    })
  }

  // ===========================================================================
  // Agent Card (delegates to exported buildAgentCard)
  // ===========================================================================

  private getAgentCard(agent: ServableAgent, servingHost?: string | null): AlfAgentCard {
    // If the caller provided a socket localAddress, use it so endpoints reflect
    // the interface the request arrived on. Otherwise fall back to the bind host
    // (normalized away from 0.0.0.0 by buildAgentCard).
    const host = servingHost ?? (this.host === '0.0.0.0' ? '127.0.0.1' : this.host)
    return buildAgentCard(agent, host, this.port)
  }

  // ===========================================================================
  // API Route Matching
  // ===========================================================================

  private matchApiRoute(
    routes: ServingApiRoute[],
    method: string,
    subpath: string,
    wildcard?: boolean
  ): { route: ServingApiRoute; params: Record<string, string> } | null {
    for (const route of routes) {
      if (route.method !== method) continue
      const isWildcard = route.path.includes('*')
      if (wildcard !== undefined && isWildcard !== wildcard) continue
      const params = this.matchPath(route.path, subpath)
      if (params !== null) {
        return { route, params }
      }
    }
    return null
  }

  private matchPath(pattern: string, actual: string): Record<string, string> | null {
    const patternParts = pattern.replace(/^\/+/, '').split('/')
    const actualParts = actual.replace(/^\/+/, '').split('/')
    const params: Record<string, string> = {}
    for (let i = 0; i < patternParts.length; i++) {
      const pp = patternParts[i]
      if (pp === '*') {
        params['*'] = actualParts.slice(i).join('/')
        return params
      }
      if (i >= actualParts.length) return null
      const ap = actualParts[i]
      if (pp.startsWith(':')) {
        params[pp.slice(1)] = decodeURIComponent(ap)
      } else if (pp !== ap) {
        return null
      }
    }
    if (patternParts.length !== actualParts.length) return null
    return params
  }

  // ===========================================================================
  // API Lambda Execution
  // ===========================================================================

  private async handleApiRoute(
    agent: ServableAgent,
    route: ServingApiRoute,
    params: Record<string, string>,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const reqPath = '/' + ((request.params as Record<string, string>)['*'] || '')
    const reqLabel = `${request.method} ${reqPath}`
    const t0 = performance.now()

    if (!agent.adfCallHandler || !agent.codeSandboxService) {
      const missing = [
        !agent.adfCallHandler ? 'adfCallHandler' : null,
        !agent.codeSandboxService ? 'codeSandboxService' : null,
      ].filter(Boolean).join(', ')
      agent.workspace.insertLog('error', 'serving', 'api_request', route.lambda,
        `${reqLabel} → 503 (agent registered on mesh without ${missing}; API routes cannot execute)`)
      reply.code(503).send({ error: `Agent not serving-capable (missing: ${missing})` })
      return
    }

    const lastColon = route.lambda.lastIndexOf(':')
    if (lastColon <= 0) {
      agent.workspace.insertLog('error', 'serving', 'api_request', route.lambda, `${reqLabel} → 500 (invalid lambda format)`)
      reply.code(500).send({ error: `Invalid lambda format: ${route.lambda}` })
      return
    }
    const filePath = route.lambda.slice(0, lastColon)
    const fnName = route.lambda.slice(lastColon + 1)

    let fileContent: string | null
    try {
      fileContent = await loadLambdaSource(p => agent.workspace.readFile(p), filePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      agent.workspace.insertLog('error', 'serving', 'api_request', route.lambda, `${reqLabel} → 500 (${msg})`)
      reply.code(500).send({ error: msg })
      return
    }
    if (fileContent === null) {
      agent.workspace.insertLog('error', 'serving', 'api_request', route.lambda, `${reqLabel} → 500 (file not found: ${filePath})`)
      reply.code(500).send({ error: `Lambda file not found: ${filePath}` })
      return
    }

    agent.workspace.insertLog('info', 'serving', 'api_request', route.lambda, `${reqLabel}`, {
      params: Object.keys(params).length > 0 ? params : undefined,
      query: Object.keys(request.query as Record<string, unknown>).length > 0 ? request.query : undefined
    })

    const url = new URL(request.url, `http://127.0.0.1:${this.port}`)
    const query: Record<string, string> = {}
    for (const [k, v] of url.searchParams) {
      query[k] = v
    }

    const isCacheable = route.method === 'GET' && (route.cache_ttl_ms ?? 0) > 0
    const cache = this.getAgentCache(agent.handle)
    let cacheKey = ''

    if (isCacheable) {
      cacheKey = cache.buildKey(route.method, reqPath, query)
      const cached = cache.get(cacheKey)
      if (cached) {
        const durationMs = +(performance.now() - t0).toFixed(2)
        agent.workspace.insertLog('info', 'serving', 'api_response', route.lambda, `${reqLabel} → ${cached.status} (${durationMs}ms, cache HIT)`)
        reply.header('x-cache', 'HIT')
        if (cached.headers) {
          for (const [k, v] of Object.entries(cached.headers)) {
            reply.header(k, v)
          }
        }
        reply.code(cached.status).send(cached.body)
        return
      }
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === 'string') headers[k] = v
      else if (Array.isArray(v)) headers[k] = v.join(', ')
    }

    let httpReq: HttpRequest = {
      method: request.method,
      path: reqPath,
      params,
      query,
      headers,
      body: request.body ?? null
    }

    // Run route-level custom middleware
    if (route.middleware?.length && agent.adfCallHandler && agent.codeSandboxService) {
      const mwResult = await executeMiddlewareChain(
        route.middleware,
        { point: 'route', data: httpReq, meta: {} },
        agent.workspace,
        agent.codeSandboxService,
        agent.adfCallHandler,
        agent.config.id
      )
      if (mwResult.rejected) {
        reply.code(mwResult.rejected.code).send({ error: mwResult.rejected.reason })
        return
      }
      if (mwResult.data) {
        httpReq = mwResult.data as HttpRequest
      }
    }

    const wrappedCode = `
${fileContent}

if (typeof ${fnName} === 'function') {
  return await ${fnName}(${JSON.stringify(httpReq)});
} else {
  throw new Error('API function "${fnName}" not found in "${filePath}"');
}
`

    const onAdfCall = (method: string, args: unknown) =>
      agent.adfCallHandler!.handleCall(method, args)

    const toolConfig = {
      enabledTools: agent.adfCallHandler.getEnabledToolNames(),
      hilTools: agent.adfCallHandler.getHilToolNames()
    }

    const sandboxId = `${agent.config.id}:api`
    const warm = route.warm ?? false

    try {
      const agentConfig = agent.workspace.getAgentConfig()
      const timeout = agentConfig.limits?.execution_timeout_ms

      const t0 = performance.now()
      emitUmbilicalEvent({
        event_type: 'lambda.started',
        agentId: agent.config.id,
        source: `lambda:${filePath}:${fnName}`,
        payload: { lambda_path: filePath, function_name: fnName, kind: 'api_route' }
      })
      const result = await withSource(`lambda:${filePath}:${fnName}`, agent.config.id, () =>
        agent.codeSandboxService.execute(
          sandboxId,
          wrappedCode,
          timeout,
          onAdfCall,
          toolConfig
        )
      )
      emitUmbilicalEvent({
        event_type: result.error ? 'lambda.failed' : 'lambda.completed',
        agentId: agent.config.id,
        source: `lambda:${filePath}:${fnName}`,
        payload: {
          lambda_path: filePath, function_name: fnName, kind: 'api_route',
          duration_ms: +(performance.now() - t0).toFixed(2),
          ...(result.error ? { error: result.error } : {})
        }
      })

      if (!warm) {
        agent.codeSandboxService.destroy(sandboxId)
      }

      const durationMs = +(performance.now() - t0).toFixed(2)

      if (result.error) {
        console.error(`[MeshServer] API lambda error (${route.lambda}):`, result.error)
        agent.workspace.insertLog('error', 'serving', 'api_response', route.lambda, `${reqLabel} → 500 (${durationMs}ms)`, { error: result.error, stdout: result.stdout || undefined })
        reply.code(500).send({ error: result.error })
        return
      }

      let httpRes: HttpResponse
      try {
        const parsed = typeof result.result === 'string' ? JSON.parse(result.result) : result.result
        httpRes = {
          status: parsed?.status ?? 200,
          headers: parsed?.headers,
          body: parsed?.body ?? parsed
        }
      } catch {
        httpRes = { status: 200, body: result.result ?? result.stdout ?? null }
      }

      if (httpRes.headers?.['x-cache-invalidate']) {
        const invalidPath = httpRes.headers['x-cache-invalidate']
        const invalidated = cache.invalidate(invalidPath)
        if (invalidated > 0) {
          agent.workspace.insertLog('info', 'serving', 'cache_invalidate', route.lambda,
            `Invalidated ${invalidated} cached entries for prefix "${invalidPath}"`)
        }
        delete httpRes.headers['x-cache-invalidate']
      }

      const noCache = !!httpRes.headers?.['x-no-cache']
      if (noCache && httpRes.headers) {
        delete httpRes.headers['x-no-cache']
      }

      let cacheLabel = ''
      if (isCacheable) {
        if (httpRes.status >= 200 && httpRes.status < 300 && !noCache) {
          cache.set(cacheKey, httpRes.status, httpRes.headers, httpRes.body, route.cache_ttl_ms!)
          cacheLabel = ', cache MISS'
        } else {
          cacheLabel = ', cache SKIP'
        }
      }

      agent.workspace.insertLog(
        httpRes.status >= 400 ? 'warn' : 'info',
        'serving', 'api_response', route.lambda,
        `${reqLabel} → ${httpRes.status} (${durationMs}ms${cacheLabel})`,
        result.stdout ? { stdout: result.stdout } : undefined
      )

      if (httpRes.headers) {
        for (const [k, v] of Object.entries(httpRes.headers)) {
          reply.header(k, v)
        }
      }
      if (isCacheable) {
        reply.header('x-cache', 'MISS')
      }

      reply.code(httpRes.status).send(httpRes.body)
    } catch (err) {
      const durationMs = +(performance.now() - t0).toFixed(2)
      console.error(`[MeshServer] API lambda exception (${route.lambda}):`, err)
      agent.workspace.insertLog('error', 'serving', 'api_response', route.lambda, `${reqLabel} → 500 (${durationMs}ms)`, { error: String(err) })
      reply.code(500).send({ error: String(err) })
    }
  }

  // ===========================================================================
  // MIME Type
  // ===========================================================================

  private getMimeType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase()
    const types: Record<string, string> = {
      html: 'text/html', htm: 'text/html',
      css: 'text/css', js: 'application/javascript',
      json: 'application/json', xml: 'application/xml',
      txt: 'text/plain', md: 'text/markdown',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
      ico: 'image/x-icon',
      pdf: 'application/pdf',
      woff: 'font/woff', woff2: 'font/woff2',
      csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
      ts: 'text/typescript'
    }
    return types[ext ?? ''] ?? 'application/octet-stream'
  }
}

// =============================================================================
// Agent Card Builder (standalone, used by MeshServer and mesh-manager)
// =============================================================================

/**
 * Serialize the signed subset of an agent card — deterministic and
 * observer-independent so signatures survive per-requester URL rewriting.
 *
 * The signature covers identity + policy + shared-content metadata only.
 * Explicitly excluded:
 *  - `signature` (a signature can't cover itself).
 *  - `endpoints` (inbox/card/health/ws URLs are rewritten per-observer by the
 *    directory endpoint).
 *  - `resolution.endpoint` (URL inside the resolution block is observer-specific).
 *  - Any decoration added downstream of signing (`visibility`, `source`,
 *    `in_subdirectory`, `runtime_did`) — these are directory-endpoint metadata,
 *    not card identity.
 *
 * We pick fields explicitly rather than blacklisting. New AlfAgentCard identity
 * fields must be added here to become part of the signed payload.
 */
export function canonicalizeCardForSignature(card: AlfAgentCard): string {
  const signable: Record<string, unknown> = {}
  if (card.did !== undefined) signable.did = card.did
  if (card.public_key !== undefined) signable.public_key = card.public_key
  if (card.signed_at !== undefined) signable.signed_at = card.signed_at
  signable.handle = card.handle
  signable.description = card.description
  if (card.icon !== undefined) signable.icon = card.icon
  if (card.resolution) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { endpoint, ...resolutionRest } = card.resolution as unknown as { endpoint?: string; [k: string]: unknown }
    signable.resolution = resolutionRest
  }
  if (card.mesh_routes !== undefined) signable.mesh_routes = card.mesh_routes
  signable.public = card.public
  signable.shared = card.shared
  if (card.attestations !== undefined) signable.attestations = card.attestations
  if (card.policies !== undefined) signable.policies = card.policies
  return canonicalJsonStringify(signable)
}

/**
 * True iff the host portion of a URL (already-parsed or raw) looks like a
 * loopback: 127.0.0.0/8, localhost, ::1, or their bracketed/IPv4-mapped forms.
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false
  let h = host.trim().toLowerCase()
  // strip brackets if present
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  // strip IPv6 zone id
  const pctIdx = h.indexOf('%')
  if (pctIdx >= 0) h = h.slice(0, pctIdx)
  // unwrap IPv4-mapped IPv6
  if (h.startsWith('::ffff:')) h = h.slice(7)
  if (h === 'localhost') return true
  if (h === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

/**
 * Rewrite a reply_to URL whose host is loopback with the transport-observed
 * peer address, so replies from the receiver can route back to the sender.
 *
 * - Non-loopback hosts are left alone (sender's explicit public endpoint wins).
 * - Loopback peer (same-host delivery) is left alone (no benefit to rewriting).
 * - Malformed URLs return the original string unchanged.
 * - Port and path are preserved; only host changes.
 */
export function rewriteLoopbackHost(replyToUrl: string, observedPeer: string | undefined | null): string {
  if (!observedPeer) return replyToUrl
  let parsed: URL
  try { parsed = new URL(replyToUrl) } catch { return replyToUrl }
  if (!isLoopbackHost(parsed.hostname)) return replyToUrl
  // Canonicalize the observed peer: strip zone id, unwrap IPv4-mapped IPv6.
  // Leave IPv6 bare — URL.hostname setter re-brackets on serialization.
  let peerHost = observedPeer.trim()
  const pctIdx = peerHost.indexOf('%')
  if (pctIdx >= 0) peerHost = peerHost.slice(0, pctIdx)
  if (peerHost.toLowerCase().startsWith('::ffff:')) peerHost = peerHost.slice(7)
  if (!peerHost) return replyToUrl
  if (isLoopbackHost(peerHost)) return replyToUrl  // same-host, no rewrite
  // URL.hostname setter rejects bare IPv6 — brackets are required.
  const isIpv6 = peerHost.includes(':') && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peerHost)
  parsed.hostname = isIpv6 ? `[${peerHost}]` : peerHost
  return parsed.toString()
}

/**
 * Normalize a host value for URL construction. Unwraps IPv4-mapped IPv6,
 * falls back to 127.0.0.1 for unknown/missing addresses (Unix sockets, etc.),
 * and wraps bare IPv6 addresses in brackets for URL safety.
 */
function normalizeServingHost(addr: string | undefined | null): string {
  if (!addr) return '127.0.0.1'
  let h = addr.trim()
  if (!h) return '127.0.0.1'
  // Strip IPv6 zone id
  const pctIdx = h.indexOf('%')
  if (pctIdx >= 0) h = h.slice(0, pctIdx)
  // Unwrap IPv4-mapped IPv6
  if (h.startsWith('::ffff:')) h = h.slice(7)
  if (h.startsWith('::FFFF:')) h = h.slice(7)
  // 0.0.0.0 should never be handed out as a reachable address; treat as loopback.
  if (h === '0.0.0.0' || h === '::') return '127.0.0.1'
  // IPv6 addresses need brackets in URLs. Heuristic: contains a colon but isn't an IPv4 dotted-quad.
  if (h.includes(':') && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return `[${h}]`
  }
  return h
}

export function buildAgentCard(agent: ServableAgent, servingHost: string, port: number): AlfAgentCard {
  const config = agent.config
  const serving = config.serving
  const cardOverrides = config.card
  const did = agent.workspace.getDid()
  const host = normalizeServingHost(servingHost)
  const base = `http://${host}:${port}/${agent.handle}/mesh`

  let sharedFiles: string[] = ['document.md']
  const patterns = serving?.shared?.patterns
  if (serving?.shared?.enabled && patterns?.length) {
    const allFiles = agent.workspace.listFiles().map(f => f.path)
    const isMatch = picomatch(patterns)
    sharedFiles = [...new Set([...sharedFiles, ...allFiles.filter(f => isMatch(f))])]
  }

  // Build endpoints: auto-derived, then merge card overrides
  const endpoints: AlfAgentCard['endpoints'] = {
    inbox: cardOverrides?.endpoints?.inbox ?? `${base}/inbox`,
    card: cardOverrides?.endpoints?.card ?? `${base}/card`,
    health: cardOverrides?.endpoints?.health ?? `${base}/health`
  }

  // WS endpoint: override or auto-derive if agent has a WS route
  if (cardOverrides?.endpoints?.ws) {
    endpoints.ws = cardOverrides.endpoints.ws
  } else {
    const wsRoute = serving?.api?.find(r => r.method === 'WS')
    if (wsRoute) {
      endpoints.ws = `ws://${host}:${port}/${agent.handle}/mesh/ws`
    }
  }

  // Resolution: override wins, otherwise self-resolution (always — cards resolve via card endpoint).
  const resolution = cardOverrides?.resolution
    ?? { method: 'self', endpoint: endpoints.card }

  // Build policies from security config
  const securityLevel = config.security?.level ?? 0
  const policies: AlfAgentCard['policies'] = []
  if (securityLevel >= 1) {
    policies.push({
      type: 'signing',
      standard: 'ed25519',
      send: 'required',
      receive: 'required'
    })
  }

  // Identity is opt-in. Only populate did/public_key/signature fields when the agent has a DID.
  const card: AlfAgentCard = {
    handle: agent.handle,
    description: config.description,
    icon: config.icon,
    resolution,
    endpoints,
    mesh_routes: serving?.api?.map(r => ({ method: r.method, path: r.path })),
    public: serving?.public?.enabled ?? false,
    shared: sharedFiles,
    attestations: [],  // future: populated from identity store
    policies
  }

  if (did) {
    card.did = did
    if (did.startsWith('did:key:')) {
      card.public_key = did.slice(8)
    }

    // Sign the card if we have a signing key. Only meaningful when the agent has an identity.
    const signingKey = agent.getSigningKey?.()
    if (signingKey) {
      card.signed_at = new Date().toISOString()
      // Signature scope excludes `endpoints` and `resolution.endpoint` — those are observer-
      // dependent and rewritten per-requester by the directory endpoint. See canonicalizeCardForSignature.
      const data = Buffer.from(canonicalizeCardForSignature(card))
      const sig = signEd25519(data, signingKey)
      card.signature = `ed25519:${sig}`
    }
  }

  return card
}
