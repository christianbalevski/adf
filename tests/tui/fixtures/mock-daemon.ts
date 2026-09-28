// A tiny in-memory ADF daemon for TUI tests and `npm run tui:mock`.
// Implements the subset of docs/daemon/http-api.md the TUI uses, with the
// same shapes: agents, status, loops (main + inner), loop history, chat with
// scripted streaming turns, files, timers, tasks/approvals, asks, and the
// /events SSE stream (cursor resume, agent filter, heartbeat).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const AGENT_1_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
export const AGENT_2_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean }
interface Row { seq: number; role: 'user' | 'assistant'; content_json: Block[]; model?: string; created_at: number }
interface MockLoop { name: string; goal: string; enabled: boolean; autostart?: boolean; tools?: string[]; status: 'idle' | 'running'; model?: { provider: string; model_id: string } }
interface MockServing { public?: { enabled: boolean; index?: string }; shared?: { enabled: boolean; patterns?: string[] }; api?: Array<{ method: string; path: string; lambda: string }> }
interface MockAgent {
  id: string
  handle: string
  name: string
  model: string
  state: string
  loops: MockLoop[]
  history: Record<string, Row[]>
  files: Array<{ path: string; content: string; protection: string }>
  timers: Array<Record<string, unknown>>
  tasks: Array<Record<string, unknown>>
  asks: Array<{ requestId: string; question: string; loop?: string }>
  provider: string
  /** What the agent serves through the daemon's web server (config.serving). */
  serving?: MockServing
  /** adf_meta `status`: the agent's own one-line status. */
  status?: string
  hostAccess?: boolean
}

/** The daemon's mesh web server (GET /network/server). */
export interface MockWebServer { running: boolean; port: number; host: string }

export interface MockEvent {
  event_type: string
  agent_id?: string | null
  loop?: string
  payload?: Record<string, unknown>
  source?: string
}

export interface MockDaemon {
  url: string
  server: Server
  agents: Map<string, MockAgent>
  /** Publish an umbilical event (assigns cursor + per-agent seq). */
  emit(event: MockEvent): void
  /** Kill every open SSE connection (clients should reconnect with ?since=). */
  dropEventStreams(): void
  /** Requests seen, e.g. `GET /agents`, `GET /events?since=3`. */
  requests: string[]
  /** The web server state; mutate it to simulate Studio / the CLI starting or stopping it. */
  web: MockWebServer
  close(): Promise<void>
}

export interface MockDaemonOptions {
  port?: number
  /** Delay between scripted turn events. Default 40ms. */
  stepMs?: number
  /** Initial web server state. Default running on 127.0.0.1:7295. */
  web?: Partial<MockWebServer>
}

let seqCounter = 1
const now = () => Date.now()

function row(role: Row['role'], blocks: Block[], at = now()): Row {
  return { seq: seqCounter++, role, content_json: blocks, created_at: at, ...(role === 'assistant' ? { model: 'mock-model' } : {}) }
}

function seedAgents(): Map<string, MockAgent> {
  const t = now() - 60 * 60_000
  const agent1: MockAgent = {
    id: AGENT_1_ID,
    handle: 'agent-1',
    name: 'agent-1',
    model: 'mock-model',
    state: 'idle',
    loops: [
      { name: 'consolidator', goal: 'Consolidate memories into mind.md every hour.', enabled: true, autostart: false, tools: ['loop_send', 'loop_list', 'sys_set_state'], status: 'idle' },
      { name: 'researcher', goal: 'Research whatever main hands over and report back.', enabled: true, autostart: false, tools: ['loop_send', 'loop_list', 'sys_set_state'], status: 'idle' },
    ],
    history: {
      main: [
        row('user', [{ type: 'text', text: 'What did we decide about the standings API?' }], t),
        row('assistant', [{ type: 'text', text: 'We keep **v2** and add a `since` cursor.\n\n- pagination stays offset-based\n- the cursor is opaque' }], t + 1000),
        row('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'fs_read', input: { path: 'notes/api.md' } }], t + 2000),
        row('user', [{ type: 'tool_result', tool_use_id: 'tu_1', content: '# API notes\nv2 is frozen.' }], t + 3000),
        row('user', [{ type: 'text', text: '[from loop:consolidator] mind.md updated with 3 new facts.' }], t + 4000),
      ],
      consolidator: [
        row('user', [{ type: 'text', text: '[from loop:main] Autostart: your agent has started. Begin working on your goal now.' }], t),
        row('assistant', [{ type: 'text', text: 'Merged 3 notes into mind.md.' }], t + 1500),
      ],
      researcher: [],
    },
    files: [
      { path: 'document.md', content: '# agent-1\nDocument body.', protection: 'none' },
      { path: 'mind.md', content: '- prefers v2\n- cursor is opaque', protection: 'none' },
      { path: 'notes/api.md', content: '# API notes\nv2 is frozen.', protection: 'read_only' },
    ],
    timers: [
      { id: 1, schedule: { mode: 'interval', every_ms: 3_600_000 }, next_wake_at: now() + 3_600_000, scope: ['agent'], payload: 'consolidate', run_count: 3, created_at: t, loop: 'consolidator' },
    ],
    tasks: [
      { id: 'task_approve_1', tool: 'msg_send', args: JSON.stringify({ to: 'agent-2', content: 'hello' }), status: 'pending_approval', created_at: t + 5000, approval_meta: { reason: 'restricted' } },
    ],
    asks: [],
    provider: 'mock',
    serving: {
      public: { enabled: true, index: 'index.html' },
      api: [
        { method: 'GET', path: '/api/status', lambda: 'lib/api.ts:status' },
        { method: 'WS', path: '/live', lambda: 'lib/ws.ts:onMessage' },
      ],
    },
    status: 'Merging API notes into mind.md',
    hostAccess: true,
  }
  const agent2: MockAgent = {
    id: AGENT_2_ID,
    handle: 'agent-2',
    name: 'agent-2',
    model: 'mock-model',
    state: 'idle',
    loops: [],
    history: { main: [] },
    files: [{ path: 'document.md', content: '# agent-2', protection: 'none' }],
    timers: [],
    tasks: [],
    asks: [],
    provider: 'mock',
  }
  return new Map([[agent1.id, agent1], [agent2.id, agent2]])
}

export async function startMockDaemon(options: MockDaemonOptions = {}): Promise<MockDaemon> {
  const agents = seedAgents()
  const stepMs = options.stepMs ?? 40
  const buffer: Array<{ cursor: number; event: Record<string, unknown> }> = []
  const agentSeq = new Map<string, number>()
  const streams = new Set<{ res: ServerResponse; agentId?: string }>()
  const requests: string[] = []
  let cursor = 0
  const web: MockWebServer = { running: true, port: 7295, host: '127.0.0.1', ...options.web }

  const emit = (input: MockEvent) => {
    const agentId = input.agent_id ?? null
    const seq = agentId ? (agentSeq.get(agentId) ?? 0) + 1 : 0
    if (agentId) agentSeq.set(agentId, seq)
    const event: Record<string, unknown> = {
      seq,
      event_type: input.event_type,
      timestamp: now(),
      source: input.source ?? 'system:mock',
      agent_id: agentId,
      ...(input.loop && input.loop !== 'main' ? { loop: input.loop } : {}),
      payload: input.payload ?? {},
    }
    const frame = { cursor: ++cursor, event }
    buffer.push(frame)
    if (buffer.length > 1000) buffer.shift()
    for (const stream of streams) {
      if (stream.agentId && stream.agentId !== agentId) continue
      writeFrame(stream.res, frame)
    }
  }

  const find = (idOrHandle: string) => agents.get(idOrHandle) ?? [...agents.values()].find(a => a.handle === idOrHandle || a.name === idOrHandle)
  const loopInfos = (agent: MockAgent) => [
    { name: 'main', goal: 'The agent itself: talks to its owner.', status: agent.state === 'idle' ? 'idle' : 'running', enabled: true, isMain: true, config: null, entryCount: agent.history.main.length, effectiveTools: null },
    ...agent.loops.map(l => ({
      name: l.name,
      goal: l.goal,
      status: l.status,
      enabled: l.enabled,
      isMain: false,
      config: { name: l.name, goal: l.goal, enabled: l.enabled, ...(l.autostart !== undefined ? { autostart: l.autostart } : {}), ...(l.tools ? { tools: l.tools } : {}), ...(l.model ? { model: l.model } : {}) },
      entryCount: agent.history[l.name]?.length ?? 0,
      effectiveTools: l.enabled ? [...(l.tools ?? []), 'loop_compact', 'loop_clear'] : null,
    })),
  ]
  const hasLoop = (agent: MockAgent, loop: string) => loop === 'main' || agent.loops.some(l => l.name === loop)
  const summary = (a: MockAgent) => ({ id: a.id, filePath: `/agents/${a.handle}.adf`, name: a.name, handle: a.handle, autostart: true })
  const status = (a: MockAgent) => ({ ...summary(a), runtimeState: a.state, targetState: null, loopCount: a.history.main.length })

  /** A scripted turn: state → deltas → tool → llm → completed, stamped with the loop. */
  const runTurn = (agent: MockAgent, loop: string, text: string) => {
    const steps: Array<() => void> = []
    const reply = `Noted: "${text.slice(0, 60)}". Working on it in **${loop}**.`
    const toolId = `tu_${Math.random().toString(36).slice(2, 8)}`
    const setState = (state: string) => {
      if (loop === 'main') agent.state = state
      else { const l = agent.loops.find(x => x.name === loop); if (l) l.status = state === 'idle' ? 'idle' : 'running' }
      emit({ event_type: 'agent.state.changed', agent_id: agent.id, loop, payload: { state } })
    }
    steps.push(() => setState('thinking'))
    for (const chunk of reply.match(/.{1,12}/g) ?? []) steps.push(() => emit({ event_type: 'turn.delta', agent_id: agent.id, loop, payload: { kind: 'text', text: chunk } }))
    steps.push(() => setState('tool_use'))
    steps.push(() => emit({ event_type: 'tool.started', agent_id: agent.id, loop, payload: { name: 'fs_read', id: toolId, input: { path: 'mind.md' } } }))
    steps.push(() => emit({ event_type: 'tool.completed', agent_id: agent.id, loop, payload: { name: 'fs_read', id: toolId, result: { content: '- prefers v2', isError: false }, isError: false } }))
    steps.push(() => emit({ event_type: 'llm.completed', agent_id: agent.id, loop, payload: { provider: 'mock', model: 'mock-model', input_tokens: 1200, output_tokens: 80 } }))
    steps.push(() => {
      ;(agent.history[loop] ??= []).push(row('assistant', [{ type: 'text', text: reply }]))
      emit({ event_type: 'turn.completed', agent_id: agent.id, loop, payload: { content: reply } })
    })
    steps.push(() => setState('idle'))
    steps.forEach((step, i) => setTimeout(step, stepMs * (i + 1)))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const method = req.method ?? 'GET'
    requests.push(`${method} ${url.pathname}${url.search}`)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req)
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const notFound = (what: string) => send(404, { error: `Unknown ${what}` })

    if (url.pathname === '/health') return send(200, { ok: true })
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      const agentId = url.searchParams.get('agentId') ?? undefined
      const since = Number(url.searchParams.get('since') ?? 0)
      for (const frame of buffer) {
        if (frame.cursor > since && (!agentId || frame.event.agent_id === agentId)) writeFrame(res, frame)
      }
      const stream = { res, agentId }
      streams.add(stream)
      const beat = setInterval(() => res.write(`: heartbeat ${now()}\n\n`), 15_000)
      req.on('close', () => { clearInterval(beat); streams.delete(stream) })
      return
    }
    if (url.pathname === '/runtime/usage') return send(200, { totals: { input: 0, output: 0, total: 0 }, byProvider: [], byModel: [] })
    if (url.pathname === '/runtime/providers') {
      return send(200, {
        providers: [
          { id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://mock', defaultModel: 'mock-model', requestDelayMs: 0, credentialStorage: 'app', hasApiKey: true, params: [] },
          { id: 'mock-sub', type: 'chatgpt-subscription', name: 'Mock Subscription', baseUrl: '', defaultModel: '', requestDelayMs: 0, credentialStorage: 'app', hasApiKey: false, params: [] },
        ],
        agentUsage: [...agents.values()].map(a => ({ agentId: a.id, handle: a.handle, name: a.name, providerId: a.provider, modelId: a.model, source: 'app', credentialStorage: null })),
      })
    }
    if (url.pathname === '/runtime/models') {
      const provider = url.searchParams.get('provider')
      return send(200, { provider, models: provider === 'mock' ? ['mock-model', 'mock-large', 'mock-mini'] : ['sub-model-a', 'sub-model-b'] })
    }
    if (url.pathname === '/runtime/network') {
      return send(200, {
        host: [],
        mesh: { enabledSetting: true, lan: false, port: web.port, status: null },
        websocket: { activeConnections: 0, inboundConnections: 0, outboundConnections: 0 },
        agents: [...agents.values()].map(a => ({ agentId: a.id, handle: a.handle, name: a.name, receive: true, sendMode: null, network: null, wsConnectionsConfigured: 0, servingRoutes: a.serving?.api?.length ?? 0, publicServingEnabled: a.serving?.public?.enabled ?? false })),
      })
    }
    // The daemon's mesh web server: /agents/<handle>/ serves each agent's site.
    if (url.pathname === '/network/server') return send(200, { ...web })
    if (url.pathname === '/network/server/start' && method === 'POST') { web.running = true; return send(200, { success: true, ...web }) }
    if (url.pathname === '/network/server/stop' && method === 'POST') { web.running = false; return send(200, { success: true, ...web }) }
    if (url.pathname === '/network/server/restart' && method === 'POST') { web.running = true; return send(200, { success: true, ...web }) }
    if (url.pathname === '/network/mesh/lan-addresses') {
      return send(200, { addresses: { hostname: 'mock-host', addresses: [{ iface: 'eth0', address: '192.168.1.20', family: 'IPv4', mac: '00:00:00:00:00:01' }, { iface: 'eth0', address: 'fd00::20', family: 'IPv6', mac: '00:00:00:00:00:01' }] } })
    }
    if (url.pathname === '/network/mesh') {
      return send(200, {
        meshEnabled: true,
        meshServerRunning: web.running,
        meshServer: { ...web },
        agents: [...agents.values()].map(a => ({
          filePath: `/agents/${a.handle}.adf`,
          handle: a.handle,
          agentId: a.id,
          state: 'idle',
          ...(a.status ? { status: a.status } : {}),
          participating: true,
          canReceive: true,
          visibility: 'localhost',
          apiRouteCount: a.serving?.api?.length ?? 0,
          publicEnabled: a.serving?.public?.enabled ?? false,
          sharedCount: a.serving?.shared?.patterns?.length ?? 0,
        })),
      })
    }
    if (url.pathname === '/runtime/auth') return send(200, { chatgpt: { authenticated: false }, grok: { authenticated: false }, providers: [] })
    if (parts[0] !== 'agents') return notFound('route')
    if (parts.length === 1 && method === 'GET') return send(200, [...agents.values()].map(summary))

    const agent = find(parts[1] ?? '')
    if (!agent) return notFound(`agent "${parts[1]}"`)
    const sub = parts.slice(2).join('/')
    const loopParam = url.searchParams.get('loop') ?? 'main'

    switch (`${method} ${parts[2] ?? ''}`) {
      case 'GET ': return send(200, { id: agent.id, filePath: `/agents/${agent.handle}.adf`, config: configOf(agent) })
      case 'GET status': return send(200, status(agent))
      case 'GET config': return send(200, { agentId: agent.id, config: configOf(agent) })
      case 'PUT config': {
        const model = (body?.model ?? {}) as { provider?: string; model_id?: string }
        if (typeof model.model_id === 'string') agent.model = model.model_id
        if (typeof model.provider === 'string') agent.provider = model.provider
        if (body && 'serving' in body) agent.serving = body.serving as MockServing
        emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['model'] } })
        return send(200, { agentId: agent.id, config: configOf(agent), success: true })
      }
      case 'POST start': agent.state = 'idle'; return send(200, { success: true, loaded: false, startupTriggered: false, agent: status(agent) })
      case 'POST stop':
      case 'POST unload': return send(200, { success: true })
      case 'POST interrupt': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        emit({ event_type: 'agent.state.changed', agent_id: agent.id, loop: loopParam, payload: { state: 'idle' } })
        return send(200, { success: true, interrupted: true, loop: loopParam })
      }
      case 'POST abort': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        emit({ event_type: 'agent.state.changed', agent_id: agent.id, loop: loopParam, payload: { state: 'idle' } })
        return send(200, { success: true })
      }
      case 'POST compact': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        const rows = agent.history[loopParam] ?? []
        if (rows.length === 0) return send(409, { error: 'There is nothing to compact.' })
        agent.history[loopParam] = [row('user', [{ type: 'text', text: `[Compacted] ${rows.length} earlier rows summarized.` }])]
        emit({ event_type: 'loop.compacted', agent_id: agent.id, loop: loopParam, payload: { rows: rows.length } })
        return send(200, { agentId: agent.id, loop: loopParam, success: true })
      }
      case 'GET loop': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        const rows = agent.history[loopParam] ?? []
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))
        const offsetParam = url.searchParams.get('offset')
        const offset = offsetParam === null ? Math.max(0, rows.length - limit) : Math.max(0, Number(offsetParam))
        return send(200, { agentId: agent.id, loop: loopParam, total: rows.length, limit, offset, entries: rows.slice(offset, offset + limit) })
      }
      case 'GET chat': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        return send(200, { agentId: agent.id, loop: loopParam, chatHistory: null })
      }
      case 'DELETE chat': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        agent.history[loopParam] = []
        emit({ event_type: 'loop.cleared', agent_id: agent.id, loop: loopParam, payload: { method: 'clear' } })
        return send(200, { agentId: agent.id, loop: loopParam, success: true })
      }
      case 'POST chat': {
        const text = typeof body?.text === 'string' ? body.text : ''
        const loop = typeof body?.loop === 'string' ? body.loop : 'main'
        if (!text) return send(400, { error: 'text is required' })
        if (!hasLoop(agent, loop)) return notFound(`loop "${loop}"`)
        if (loop !== 'main' && !agent.loops.find(l => l.name === loop)?.enabled) return send(409, { error: `Loop "${loop}" is disabled` })
        ;(agent.history[loop] ??= []).push(row('user', [{ type: 'text', text }]))
        runTurn(agent, loop, text)
        return send(202, { accepted: true, turnId: `turn_${cursor}` })
      }
      case 'GET loops':
        if (parts[3]) {
          const info = loopInfos(agent).find(l => l.name === parts[3])
          return info ? send(200, { agentId: agent.id, loop: info }) : notFound(`loop "${parts[3]}"`)
        }
        return send(200, { agentId: agent.id, loops: loopInfos(agent) })
      case 'POST loops': {
        const name = typeof body?.name === 'string' ? body.name : ''
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || name === 'main') return send(400, { error: 'Invalid loop config — name' })
        if (hasLoop(agent, name)) return send(409, { error: `A loop named "${name}" already exists.` })
        const loop: MockLoop = { name, goal: String(body?.goal ?? ''), enabled: body?.enabled !== false, autostart: body?.autostart !== false, tools: Array.isArray(body?.tools) ? body.tools as string[] : ['loop_send', 'loop_list', 'sys_set_state'], status: 'idle' }
        agent.loops.push(loop)
        agent.history[name] = []
        emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['loops'] } })
        return send(201, { agentId: agent.id, loop: loopInfos(agent).find(l => l.name === name), effectiveTools: loop.tools, excludedTools: [], kickoff: null })
      }
      case 'PATCH loops': {
        const loop = agent.loops.find(l => l.name === parts[3])
        if (!loop) return notFound(`loop "${parts[3]}"`)
        const updated: string[] = []
        for (const key of ['goal', 'enabled', 'autostart', 'tools'] as const) {
          if (body && body[key] !== undefined) { (loop as unknown as Record<string, unknown>)[key] = body[key]; updated.push(key) }
        }
        if (body && 'model' in body) { loop.model = (body.model ?? undefined) as MockLoop['model']; updated.push('model') }
        if (updated.length === 0) return send(400, { error: 'Nothing to update' })
        emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['loops'] } })
        return send(200, { agentId: agent.id, loop: loopInfos(agent).find(l => l.name === loop.name), updated, excludedTools: [] })
      }
      case 'DELETE loops': {
        const index = agent.loops.findIndex(l => l.name === parts[3])
        if (parts[3] === 'main') return send(409, { error: 'main is the agent itself and cannot be deleted.' })
        if (index < 0) return notFound(`loop "${parts[3]}"`)
        const archived = agent.history[parts[3]]?.length ?? 0
        agent.loops.splice(index, 1)
        delete agent.history[parts[3]]
        emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['loops'] } })
        return send(200, { agentId: agent.id, name: parts[3], archivedEntries: archived, interruptedTurn: false })
      }
      case 'GET files':
        if (sub === 'files/content') {
          const file = agent.files.find(f => f.path === url.searchParams.get('path'))
          if (!file) return notFound('file')
          return send(200, { agentId: agent.id, path: file.path, mime_type: 'text/markdown', size: file.content.length, protection: file.protection, authorized: false, created_at: '', updated_at: '', encoding: 'utf-8', content: file.content })
        }
        return send(200, { agentId: agent.id, files: agent.files.map(f => ({ path: f.path, size: f.content.length, mime_type: 'text/markdown', protection: f.protection, authorized: false, created_at: '', updated_at: '' })) })
      case 'GET timers': return send(200, { agentId: agent.id, timers: agent.timers })
      case 'POST timers': {
        const loop = typeof body?.loop === 'string' ? body.loop : undefined
        if (loop && !hasLoop(agent, loop)) return notFound(`loop "${loop}"`)
        const id = agent.timers.length + 1
        agent.timers.push({ id, schedule: { mode: body?.mode === 'cron' ? 'cron' : 'interval', every_ms: body?.every_ms, cron: body?.cron }, next_wake_at: now() + Number(body?.every_ms ?? 60_000), scope: body?.scope ?? ['agent'], payload: body?.payload, run_count: 0, created_at: now(), ...(loop ? { loop } : {}) })
        return send(200, { agentId: agent.id, success: true, id })
      }
      case 'PUT timers': {
        const timer = agent.timers.find(t => String(t.id) === parts[3])
        if (!timer) return notFound('timer')
        const loop = typeof body?.loop === 'string' ? body.loop : undefined
        if (loop && !hasLoop(agent, loop)) return notFound(`loop "${loop}"`)
        if (body?.mode) timer.schedule = { mode: body.mode === 'cron' ? 'cron' : 'interval', every_ms: body.every_ms, cron: body.cron }
        if (body?.payload !== undefined) timer.payload = body.payload
        if (loop) { if (loop === 'main') delete timer.loop; else timer.loop = loop }
        return send(200, { agentId: agent.id, success: true })
      }
      case 'DELETE timers': {
        const before = agent.timers.length
        agent.timers = agent.timers.filter(t => String(t.id) !== parts[3])
        return send(200, { agentId: agent.id, success: agent.timers.length < before })
      }
      case 'GET tasks': {
        if (parts[3]) {
          const task = agent.tasks.find(t => t.id === parts[3])
          return task ? send(200, { agentId: agent.id, task }) : notFound('task')
        }
        const wanted = url.searchParams.get('status')
        return send(200, { agentId: agent.id, tasks: agent.tasks.filter(t => !wanted || t.status === wanted) })
      }
      case 'POST tasks': {
        const task = agent.tasks.find(t => t.id === parts[3])
        if (!task) return notFound('task')
        task.status = body?.action === 'approve' ? 'completed' : 'denied'
        emit({ event_type: 'hil.resolved', agent_id: agent.id, payload: { request_id: task.id, task_id: task.id, approved: body?.action === 'approve' } })
        return send(200, { agentId: agent.id, taskId: task.id, resolution: { action: body?.action }, task })
      }
      case 'GET asks': return send(200, { agentId: agent.id, asks: agent.asks })
      case 'POST asks': {
        const index = agent.asks.findIndex(a => a.requestId === parts[3] && (typeof body?.loop !== 'string' || (a.loop ?? 'main') === body.loop))
        if (index >= 0) agent.asks.splice(index, 1)
        emit({ event_type: 'ask.resolved', agent_id: agent.id, payload: { request_id: parts[3], has_response: true, response_length: String(body?.answer ?? '').length, preview: String(body?.answer ?? '').slice(0, 200) } })
        return send(200, { agentId: agent.id, requestId: parts[3], answered: index >= 0 })
      }
      case 'GET usage': return send(200, { agentId: agent.id, source: 'adf_loop', note: '', loopRows: 0, usageRows: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byModel: [] })
      case 'GET document': return send(200, { agentId: agent.id, content: agent.files.find(f => f.path === 'document.md')?.content ?? '' })
      case 'GET mind': return send(200, { agentId: agent.id, content: agent.files.find(f => f.path === 'mind.md')?.content ?? '' })
      default:
        return notFound(`route ${method} ${url.pathname}`)
    }
  })

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    agents,
    emit,
    requests,
    web,
    dropEventStreams() {
      for (const stream of streams) stream.res.destroy()
      streams.clear()
    },
    close() {
      for (const stream of streams) stream.res.destroy()
      streams.clear()
      return new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function configOf(agent: MockAgent) {
  return {
    id: agent.id,
    name: agent.name,
    handle: agent.handle,
    model: { provider: agent.provider, model_id: agent.model },
    loops: agent.loops.map(l => ({ name: l.name, goal: l.goal, enabled: l.enabled, autostart: l.autostart, tools: l.tools, ...(l.model ? { model: l.model } : {}) })),
    ...(agent.serving ? { serving: agent.serving } : {}),
    ...(agent.hostAccess ? { compute: { enabled: true, host_access: true } } : {}),
  }
}

function writeFrame(res: ServerResponse, frame: { cursor: number; event: Record<string, unknown> }) {
  res.write(`id: ${frame.cursor}\nevent: ${String(frame.event.event_type)}\ndata: ${JSON.stringify(frame)}\n\n`)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text.trim()) return undefined
  try { return JSON.parse(text) as Record<string, unknown> } catch { return undefined }
}
