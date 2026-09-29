// Channels and API-key providers on top of the mock daemon, as a chainable
// fetch wrapper: PUT /agents/:id/adapters/credentials, POST/DELETE
// /agents/:id/adapters, GET /agents/:id/runtime/adapters (a channel comes up
// "connecting" then "connected"; a Telegram token containing "revoked" ends in
// "error"), config reads gain `adapters`, POST/DELETE /runtime/providers with
// GET /runtime/providers and /runtime/auth showing what was added.
//
// MCP: POST/DELETE /agents/:id/mcp/servers, POST .../:name/restart (connects:
// three tools `mcp_<name>_<tool>`, restricted like the real sync; a server
// named `broken` fails), PUT /agents/:id/mcp/credentials, POST
// /admin/mcp/packages/{npm,python}, GET /agents/:id/runtime/mcp; config reads
// carry mcp.servers and the mcp_ tool declarations, config writes keep them.
//
// Like the real daemon, provider keys are kept apart (`keys`) and never
// returned; `calls` records method + path only.

import { AGENT_1_ID, AGENT_2_ID } from './mock-daemon'

export interface SetupMockOptions {
  /** agent id → channel types already on. */
  channels?: Record<string, string[]>
  /** agent id → MCP servers already attached (connected, with tools). */
  mcp?: Record<string, Array<Record<string, unknown>>>
  /** Status polls before a new channel reports connected. Default 1. */
  connectAfterPolls?: number
  /** Answer POST /runtime/providers with 409 secret_store_locked. */
  secretStoreLocked?: boolean
}

export interface SetupMock {
  fetch: typeof fetch
  calls: string[]
  /** agent id → type → stored credential keys → value (what the agent keystore holds). */
  credentials: Map<string, Map<string, Map<string, string>>>
  /** agent id → type → config written by POST /adapters. */
  channels: Map<string, Map<string, { config: Record<string, unknown>; polls: number }>>
  /** Providers added (public shape). */
  providers: Array<Record<string, unknown>>
  /** provider id → key (the daemon secret store). */
  keys: Map<string, string>
  /** Raw bodies of POST /runtime/providers (tests assert the key went here, and only here). */
  providerBodies: Array<Record<string, unknown>>
  setSecretStoreLocked(on: boolean): void
  /** agent id → attached MCP server configs. */
  mcpServers: Map<string, Array<Record<string, unknown>>>
  /** agent id → server → live state. */
  mcpStates: Map<string, Map<string, { status: string; error?: string; toolCount: number; logs: Array<{ timestamp: number; stream: string; message: string }> }>>
  /** agent id → mcp_ tool declarations. */
  mcpTools: Map<string, Array<{ name: string; enabled: boolean; restricted?: boolean }>>
  /** agent id → `mcp:<ns>:<KEY>` → value. */
  mcpCredentials: Map<string, Map<string, string>>
  /** Packages installed, e.g. `npm @modelcontextprotocol/server-everything`. */
  installed: string[]
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function createSetupFetch(options: SetupMockOptions = {}, next: typeof fetch = globalThis.fetch.bind(globalThis)): SetupMock {
  const calls: string[] = []
  const credentials: SetupMock['credentials'] = new Map()
  const channels: SetupMock['channels'] = new Map()
  const providers: SetupMock['providers'] = []
  const keys = new Map<string, string>()
  const providerBodies: SetupMock['providerBodies'] = []
  let locked = !!options.secretStoreLocked
  const connectAfter = options.connectAfterPolls ?? 1
  const idOf = (idOrHandle: string) => (idOrHandle === 'agent-1' ? AGENT_1_ID : idOrHandle === 'agent-2' ? AGENT_2_ID : idOrHandle)
  for (const [agentId, types] of Object.entries(options.channels ?? {})) {
    channels.set(idOf(agentId), new Map(types.map(t => [t, { config: { enabled: true }, polls: connectAfter }])))
  }
  const mcpServers: SetupMock['mcpServers'] = new Map()
  const mcpStates: SetupMock['mcpStates'] = new Map()
  const mcpTools: SetupMock['mcpTools'] = new Map()
  const mcpCredentials: SetupMock['mcpCredentials'] = new Map()
  const installed: string[] = []
  const serversOf = (agentId: string) => mcpServers.get(agentId) ?? mcpServers.set(agentId, []).get(agentId)!
  const statesOf = (agentId: string) => mcpStates.get(agentId) ?? mcpStates.set(agentId, new Map()).get(agentId)!
  const toolsOf = (agentId: string) => mcpTools.get(agentId) ?? mcpTools.set(agentId, []).get(agentId)!
  const connectMcp = (agentId: string, name: string) => {
    const now = Date.now()
    if (name === 'broken') {
      statesOf(agentId).set(name, { status: 'error', error: 'spawn failed: command not found', toolCount: 0, logs: [{ timestamp: now, stream: 'stderr', message: 'sh: server: not found' }] })
      return { toolsDiscovered: 0, location: 'shared container', error: 'spawn failed: command not found', stderrTail: ['sh: server: not found'] }
    }
    const tools = ['search', 'read', 'write']
    const decls = toolsOf(agentId)
    for (const t of tools) if (!decls.some(d => d.name === `mcp_${name}_${t}`)) decls.push({ name: `mcp_${name}_${t}`, enabled: true, restricted: true })
    statesOf(agentId).set(name, { status: 'connected', toolCount: tools.length, logs: [{ timestamp: now, stream: 'system', message: `Connecting to "${name}"` }, { timestamp: now, stream: 'stderr', message: `${name} listening on stdio` }] })
    return { toolsDiscovered: tools.length, location: 'shared container' }
  }
  for (const [agentId, servers] of Object.entries(options.mcp ?? {})) {
    for (const server of servers) { serversOf(idOf(agentId)).push(server); connectMcp(idOf(agentId), String(server.name)) }
  }
  const channelsOf = (agentId: string) => channels.get(agentId) ?? channels.set(agentId, new Map()).get(agentId)!
  const credsOf = (agentId: string, type: string) => {
    const byType = credentials.get(agentId) ?? credentials.set(agentId, new Map()).get(agentId)!
    return byType.get(type) ?? byType.set(type, new Map()).get(type)!
  }

  const liveState = (agentId: string, type: string, entry: { polls: number }) => {
    entry.polls++
    if (entry.polls <= connectAfter) return { type, status: 'connecting', restartCount: 0, logs: [] }
    const token = credsOf(agentId, type).get('TELEGRAM_BOT_TOKEN') ?? ''
    if (/revoked/i.test(token)) return { type, status: 'error', error: 'Telegram rejected the request (401 Unauthorized): the TELEGRAM_BOT_TOKEN is invalid or was revoked.', restartCount: 0, logs: [] }
    return { type, status: 'connected', connectedAt: Date.now(), restartCount: 0, logs: [] }
  }

  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const log = () => calls.push(`${method} ${url.pathname}`)

    if (url.pathname === '/runtime/providers' && method === 'POST') {
      log()
      providerBodies.push(body)
      if (locked && body.apiKey) return json(409, { error: 'The daemon secret store is locked or not set up yet: set up or unlock the owner identity first, then add the provider.', code: 'secret_store_locked' })
      const type = String(body.type ?? '')
      if (!['anthropic', 'openai', 'openrouter', 'openai-compatible'].includes(type)) return json(400, { error: 'bad type', code: 'bad_type' })
      const id = `custom:${(providers.length + 1).toString(16).padStart(6, '0')}`
      if (typeof body.apiKey === 'string' && body.apiKey) keys.set(id, body.apiKey)
      const provider = { id, type, name: String(body.name ?? type), baseUrl: String(body.baseUrl ?? ''), defaultModel: String(body.defaultModel ?? ''), preset: body.preset, credentialStorage: 'app', ...(keys.has(id) ? { apiKeyStorage: 'secret-store' } : {}), hasApiKey: keys.has(id) }
      providers.push(provider)
      return json(201, { provider, defaultProviderId: 'mock' })
    }
    if (parts[0] === 'runtime' && parts[1] === 'providers' && parts[2] && method === 'DELETE') {
      log()
      const at = providers.findIndex(p => p.id === parts[2])
      if (at < 0) return json(404, { error: `Unknown provider "${parts[2]}"`, code: 'not_found' })
      providers.splice(at, 1)
      keys.delete(parts[2])
      return json(200, { removed: parts[2], providers })
    }
    if ((url.pathname === '/runtime/providers' || url.pathname === '/runtime/auth') && method === 'GET') {
      const upstream = await next(input, init)
      const data = await upstream.json() as { providers?: Array<Record<string, unknown>> }
      return json(upstream.status, { ...data, providers: [...(data.providers ?? []), ...providers] })
    }

    if (parts[0] === 'admin' && parts[1] === 'mcp' && parts[2] === 'packages' && parts[3] && method === 'POST') {
      log()
      installed.push(`${parts[3]} ${String(body.package ?? '')}`)
      return json(200, { success: true, installed: { package: body.package, version: '1.0.0' } })
    }
    if (parts[0] !== 'agents' || !parts[1]) return next(input, init)
    const agentId = idOf(parts[1])
    const sub = parts.slice(2).join('/')

    if (sub === 'adapters/credentials' && method === 'PUT') {
      log()
      const { adapterType, envKey, value } = body as { adapterType?: string; envKey?: string; value?: string }
      if (typeof adapterType !== 'string' || typeof envKey !== 'string' || typeof value !== 'string') return json(400, { error: 'adapterType, envKey and value are required' })
      credsOf(agentId, adapterType).set(envKey, value)
      return json(200, { agentId, adapterType, envKey, success: true })
    }
    if (sub === 'adapters' && method === 'POST') {
      log()
      const type = String(body.adapterType ?? '')
      const map = channelsOf(agentId)
      const alreadyAttached = map.has(type)
      map.set(type, { config: (body.config ?? {}) as Record<string, unknown>, polls: 0 })
      return json(200, { agentId, adapterType: type, success: true, alreadyAttached })
    }
    if (parts[2] === 'adapters' && parts[3] && method === 'DELETE') {
      log()
      channelsOf(agentId).delete(parts[3])
      const creds = credentials.get(agentId)?.get(parts[3])
      const deleted = creds?.size ?? 0
      credentials.get(agentId)?.delete(parts[3])
      return json(200, { agentId, adapterType: parts[3], success: true, deletedCredentials: deleted })
    }
    if ((sub === 'runtime/adapters' || sub === 'adapters') && method === 'GET') {
      const map = channelsOf(agentId)
      return json(200, {
        agentId,
        configured: [...map.entries()].map(([type, c]) => ({ type, enabled: true, config: c.config })),
        states: [...map.entries()].map(([type, c]) => liveState(agentId, type, c)),
      })
    }
    if (sub === 'mcp/servers' && method === 'POST') {
      log()
      const server = (body.server ?? body.serverConfig) as Record<string, unknown> | undefined
      if (!server?.name || !server.transport) return json(400, { error: 'server with name and transport is required' })
      const list = serversOf(agentId)
      const alreadyAttached = list.some(s => s.name === server.name)
      if (!alreadyAttached) list.push(server)
      return json(200, { agentId, serverName: server.name, success: true, alreadyAttached })
    }
    if (parts[2] === 'mcp' && parts[3] === 'servers' && parts[4] && parts[5] === 'restart' && method === 'POST') {
      log()
      if (!serversOf(agentId).some(s => s.name === parts[4])) return json(404, { error: `Agent has no MCP server "${parts[4]}".` })
      const outcome = connectMcp(agentId, parts[4])
      return json(200, { agentId, serverName: parts[4], success: outcome.toolsDiscovered > 0 && !outcome.error, ...outcome })
    }
    if (parts[2] === 'mcp' && parts[3] === 'servers' && parts[4] && method === 'DELETE') {
      log()
      mcpServers.set(agentId, serversOf(agentId).filter(s => s.name !== parts[4]))
      statesOf(agentId).delete(parts[4])
      mcpTools.set(agentId, toolsOf(agentId).filter(t => !t.name.startsWith(`mcp_${parts[4]}_`)))
      const ns = url.searchParams.get('credentialNamespace') ?? parts[4]
      const creds = mcpCredentials.get(agentId)
      let deleted = 0
      for (const key of [...(creds?.keys() ?? [])]) if (key.startsWith(`mcp:${ns}:`)) { creds!.delete(key); deleted++ }
      return json(200, { agentId, serverName: parts[4], success: true, deletedCredentials: deleted })
    }
    if (sub === 'mcp/credentials' && method === 'PUT') {
      log()
      const { npmPackage, envKey, value } = body as { npmPackage?: string; envKey?: string; value?: string }
      if (!npmPackage || !envKey || typeof value !== 'string') return json(400, { error: 'npmPackage, envKey and value are required' })
      const creds = mcpCredentials.get(agentId) ?? mcpCredentials.set(agentId, new Map()).get(agentId)!
      creds.set(`mcp:${npmPackage}:${envKey}`, value)
      return json(200, { agentId, npmPackage, envKey, success: true })
    }
    if ((sub === 'runtime/mcp' || sub === 'mcp') && method === 'GET') {
      const servers = serversOf(agentId)
      return json(200, {
        agentId,
        configured: servers.map(s => ({ name: s.name, transport: s.transport, command: s.command, args: s.args, toolCount: toolsOf(agentId).filter(t => t.name.startsWith(`mcp_${String(s.name)}_`)).length })),
        states: [...statesOf(agentId).entries()].map(([name, st]) => ({ name, restartCount: 0, ...st })),
      })
    }
    if (sub === 'config' && method === 'PUT') {
      // Keep this layer's MCP state in step with whole-config writes (tool toggles).
      const tools = Array.isArray(body.tools) ? body.tools as Array<{ name: string; enabled: boolean }> : null
      if (tools) mcpTools.set(agentId, tools.filter(t => t.name.startsWith('mcp_')))
      const rest = { ...body, ...(tools ? { tools: tools.filter(t => !t.name.startsWith('mcp_')) } : {}) }
      delete (rest as Record<string, unknown>).mcp
      return next(input, { ...init, body: JSON.stringify(rest) })
    }
    if (sub === 'config' && method === 'GET') {
      const upstream = await next(input, init)
      if (!upstream.ok) return upstream
      const data = await upstream.json() as { config?: Record<string, unknown> }
      const map = channelsOf(agentId)
      const adapters = Object.fromEntries([...map.entries()].map(([type, c]) => [type, c.config]))
      const servers = serversOf(agentId)
      const ownTools = ((data.config?.tools as Array<{ name: string }> | undefined) ?? []).filter(t => !t.name.startsWith('mcp_'))
      const mcp = servers.length ? { mcp: { ...(data.config?.mcp as object | undefined), servers } } : {}
      const tools = toolsOf(agentId).length ? { tools: [...ownTools, ...toolsOf(agentId)] } : {}
      return json(200, { ...data, config: { ...data.config, ...(map.size ? { adapters } : {}), ...mcp, ...tools } })
    }
    return next(input, init)
  }

  return {
    fetch: wrapped,
    calls,
    credentials,
    channels,
    providers,
    keys,
    providerBodies,
    setSecretStoreLocked(on) { locked = on },
    mcpServers,
    mcpStates,
    mcpTools,
    mcpCredentials,
    installed,
  }
}
