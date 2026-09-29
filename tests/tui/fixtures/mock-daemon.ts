// A tiny in-memory ADF daemon for TUI tests and `npm run tui:mock`.
// Implements the subset of docs/daemon/http-api.md the TUI uses, with the
// same shapes: agents, status, loops (main + inner), loop history, chat with
// scripted streaming turns, files, timers, tasks/approvals, asks, and the
// /events SSE stream (cursor resume, agent filter, heartbeat).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mockContext } from './context-mock'

export const AGENT_1_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
export const AGENT_2_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean }
interface Row { seq: number; role: 'user' | 'assistant'; content_json: Block[]; model?: string; created_at: number }
interface MockLoop { name: string; goal: string; enabled: boolean; autostart?: boolean; tools?: string[]; status: 'idle' | 'running'; model?: { provider: string; model_id: string } }
interface MockServing { public?: { enabled: boolean; index?: string }; shared?: { enabled: boolean; patterns?: string[] }; api?: Array<{ method: string; path: string; lambda: string }> }
interface MockToolDecl { name: string; enabled: boolean; visible?: boolean; restricted?: boolean; locked?: boolean }
interface MockApprovalMeta { reason?: string; protection?: { level?: string }; canAlwaysApprove?: boolean; can_always_approve?: boolean; alwaysApproveBlockedReason?: string }
interface MockAgent {
  id: string
  /** Loaded from a tracked folder file (default /agents/<handle>.adf). */
  filePath?: string
  handle: string
  name: string
  model: string
  state: string
  loops: MockLoop[]
  history: Record<string, Row[]>
  files: Array<{ path: string; content: string; protection: string }>
  timers: Array<Record<string, unknown>>
  /**
   * Tasks as adf_tasks rows. A pending_approval row's `approval_meta` drives
   * the "Always approve" affordance: `reason: 'protection'` or
   * `canAlwaysApprove: false` (+ optional `alwaysApproveBlockedReason`) makes
   * it one-time only — GET /tasks reports canAlwaysApprove:false and
   * /always-approve answers 409, like the real daemon.
   */
  tasks: Array<Record<string, unknown>>
  /** config.tools; absent until something (always-approve) writes it. */
  tools?: MockToolDecl[]
  asks: Array<{ requestId: string; question: string; loop?: string }>
  provider: string
  /** What the agent serves through the daemon's web server (config.serving). */
  serving?: MockServing
  /** adf_meta `status`: the agent's own one-line status. */
  status?: string
  hostAccess?: boolean
}

/** An .adf in a fake tracked folder. `loadError` makes every load of it fail with that message. */
export interface MockFolderFile {
  filePath: string
  name: string
  autostart: boolean
  reviewed: boolean
  loadError?: string
  unreadable?: boolean
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
  /** settings.trackedDirectories, live (GET/POST/DELETE /tracked-dirs mutate it). */
  trackedDirs: string[]
  /** Fake folders that "exist" for POST /tracked-dirs; add a path to make it trackable. */
  existingDirs: Set<string>
  /**
   * Agent files in fake folders (besides the seeded /agents/*.adf): tracking a
   * folder autostarts its reviewed autostart files; the rest are listed by
   * GET /tracked-dirs/agents and load through POST /agents/load (+ review).
   */
  folderFiles: MockFolderFile[]
  close(): Promise<void>
}

export interface MockDaemonOptions {
  port?: number
  /** Delay between scripted turn events. Default 40ms. */
  stepMs?: number
  /** Initial web server state. Default running on 127.0.0.1:7295. */
  web?: Partial<MockWebServer>
  /** Initial tracked folders. Default [MOCK_AGENTS_DIR] (where the seeded agents live). */
  trackedDirs?: string[]
  /** Extra fake folders that exist (MOCK_AGENTS_DIR and MOCK_SPARE_DIR always do). */
  existingDirs?: string[]
}

/** Seeded agents' files are /agents/<handle>.adf, so this folder "holds" them. */
export const MOCK_AGENTS_DIR = '/agents'
/** An existing, untracked, empty fake folder — ready for POST /tracked-dirs. */
export const MOCK_SPARE_DIR = '/home/owner/agent-lab'

function normDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || '/'
}

/** `child` is `dir` itself or beneath it (case/separator-insensitive, like the daemon on Windows). */
function isUnder(dir: string, child: string): boolean {
  const d = normDir(dir)
  const c = normDir(child)
  return c === d || c.startsWith(d === '/' ? '/' : `${d}/`)
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
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
  const trackedDirs: string[] = [...(options.trackedDirs ?? [MOCK_AGENTS_DIR])]
  const existingDirs = new Set<string>([MOCK_AGENTS_DIR, MOCK_SPARE_DIR, ...(options.existingDirs ?? [])])
  const folderFiles: MockFolderFile[] = []
  /** filePath -> agent id, for folder files loaded from a tracked folder. */
  const loadedFiles = new Map<string, string>()

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
  const summary = (a: MockAgent) => ({ id: a.id, filePath: a.filePath ?? `/agents/${a.handle}.adf`, name: a.name, handle: a.handle, autostart: true })
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
    // Tracked agent folders (settings.trackedDirectories). Paths are fake:
    // "exists" means listed in `existingDirs`; agents count by their
    // /agents/<handle>.adf filePath.
    const fromFolders = () => new Set(loadedFiles.values())
    const agentsUnder = (dir: string) => [...agents.values()].filter(a => !fromFolders().has(a.id) && isUnder(dir, `/agents/${a.handle}.adf`))
    const filesUnder = (dir: string) => folderFiles.filter(f => isUnder(dir, f.filePath))
    const loadedFile = (f: MockFolderFile) => { const id = loadedFiles.get(f.filePath); return id && agents.has(id) ? id : undefined }
    const loadFile = (f: MockFolderFile): string => {
      const id = `mock-${f.name}`
      agents.set(id, { id, filePath: f.filePath, handle: f.name, name: f.name, model: 'mock-model', state: 'idle', loops: [], history: { main: [] }, files: [], timers: [], tasks: [], asks: [], provider: 'mock' })
      loadedFiles.set(f.filePath, id)
      emit({ event_type: 'agent.loaded', agent_id: id })
      return id
    }
    const folderAgentList = (dir: string, failures: Map<string, string> = new Map()) => [
      ...agentsUnder(dir).map(a => ({ filePath: `/agents/${a.handle}.adf`, name: a.name, agentId: a.id, status: 'loaded', autostart: true, reviewed: true })),
      ...filesUnder(dir).map(f => {
        const id = loadedFile(f)
        if (f.unreadable) return { filePath: f.filePath, name: f.name, status: 'unreadable', autostart: false, reviewed: false, error: 'Not a readable .adf: file is not a database' }
        const base = { filePath: f.filePath, name: f.name, agentId: id ?? `mock-${f.name}`, autostart: f.autostart, reviewed: f.reviewed }
        if (id) return { ...base, status: 'loaded' }
        const status = !f.reviewed ? 'needs_review' : f.autostart ? 'stopped' : 'not_autostart'
        const error = failures.get(f.filePath)
        return error ? { ...base, status, error } : { ...base, status }
      }),
    ]
    if (url.pathname === '/tracked-dirs/agents/all' && method === 'GET') {
      return send(200, {
        maxDepth: 5,
        folders: trackedDirs.map(dir => {
          const exists = existingDirs.has(dir)
          const list = exists ? folderAgentList(dir) : []
          return { path: dir, exists, agentCount: list.length, loadedCount: list.filter(a => a.status === 'loaded').length, agents: list }
        }),
      })
    }
    if (url.pathname === '/tracked-dirs/agents' && method === 'GET') {
      const raw = url.searchParams.get('path') ?? ''
      if (!raw) return send(400, { error: 'path is required' })
      const match = trackedDirs.find(d => normDir(d) === normDir(raw))
      if (match === undefined) return send(404, { error: `Not a tracked folder: ${raw}` })
      return send(200, { path: match, agents: folderAgentList(match) })
    }
    if (url.pathname === '/agents/review' && method === 'GET') {
      const f = folderFiles.find(x => x.filePath === url.searchParams.get('filePath'))
      if (!f) return notFound('file')
      return send(200, {
        agentId: `mock-${f.name}`,
        filePath: f.filePath,
        reviewed: f.reviewed,
        summary: {
          name: f.name, description: 'A mock folder agent', identity: { scenario: 'foreign', needsClaim: true }, computeTier: 'host', autostart: f.autostart,
          tools: [{ name: 'compute_exec', enabled: true, notable: true }, { name: 'fs_read', enabled: true, notable: false }],
          mcpServers: [], triggers: [], codeExecution: false, messaging: { mode: 'proactive' },
          network: { wsConnections: [], serving: null, adapters: ['telegram'] }, security: { tableProtections: [] },
        },
      })
    }
    if (url.pathname === '/agents/review/accept' && method === 'POST') {
      const f = folderFiles.find(x => x.filePath === body?.filePath)
      if (!f) return notFound('file')
      f.reviewed = true
      return send(200, { agentId: `mock-${f.name}`, filePath: f.filePath, reviewed: true, summary: {} })
    }
    if (url.pathname === '/agents/load' && method === 'POST') {
      const f = folderFiles.find(x => x.filePath === body?.filePath)
      if (!f) return send(500, { error: `ENOENT: ${String(body?.filePath)}` })
      if (body?.requireReview === true && !f.reviewed) return send(403, { error: 'Agent review required', code: 'AGENT_REVIEW_REQUIRED' })
      if (f.loadError || f.unreadable) return send(500, { error: f.loadError ?? 'file is not a database' })
      const id = loadedFile(f) ?? loadFile(f)
      return send(200, { id, filePath: f.filePath, config: { id, name: f.name, handle: f.name } })
    }
    if (url.pathname === '/tracked-dirs') {
      const entry = (dir: string) => {
        const exists = existingDirs.has(dir)
        const files = exists ? filesUnder(dir) : []
        const n = exists ? agentsUnder(dir).length : 0
        return { path: dir, exists, agentCount: n + files.length, loadedCount: n + files.filter(f => loadedFile(f)).length }
      }
      if (method === 'GET') return send(200, { maxDepth: 5, directories: trackedDirs.map(entry) })
      if (method === 'POST') {
        const raw = typeof body?.path === 'string' ? body.path.trim() : ''
        if (!raw) return send(400, { error: 'path is required' })
        if (!isAbsolutePath(raw)) return send(400, { error: 'path must be an absolute path.' })
        if (!existingDirs.has(raw)) return send(400, { error: `path does not exist: ${raw}` })
        const coveredBy = trackedDirs.find(d => isUnder(d, raw))
        if (coveredBy !== undefined) {
          return send(409, { error: normDir(coveredBy) === normDir(raw) ? `Already tracked: ${coveredBy}` : `Already tracked through its parent folder ${coveredBy}`, coveredBy })
        }
        const absorbed = trackedDirs.filter(d => isUnder(raw, d))
        trackedDirs.splice(0, trackedDirs.length, ...trackedDirs.filter(d => !absorbed.includes(d)), raw)
        const found = agentsUnder(raw)
        // The autostart pass: reviewed autostart files load; the rest are reported.
        const started: Array<Record<string, unknown>> = []
        const skipped: Array<Record<string, unknown>> = found.map(a => ({ filePath: `/agents/${a.handle}.adf`, name: a.name, reason: 'already_loaded', agentId: a.id }))
        const failed: Array<{ filePath: string; name: string; error: string }> = []
        for (const f of filesUnder(raw)) {
          if (loadedFile(f)) skipped.push({ filePath: f.filePath, name: f.name, reason: 'already_loaded' })
          else if (f.unreadable) failed.push({ filePath: f.filePath, name: f.name, error: 'Unable to read ADF boot status.' })
          else if (!f.autostart) skipped.push({ filePath: f.filePath, name: f.name, reason: 'not_autostart' })
          else if (!f.reviewed) skipped.push({ filePath: f.filePath, name: f.name, reason: 'unreviewed' })
          else if (f.loadError) failed.push({ filePath: f.filePath, name: f.name, error: f.loadError })
          else started.push({ agentId: loadFile(f), filePath: f.filePath, name: f.name, startupTriggered: true })
        }
        return send(201, {
          entry: entry(raw),
          directories: [...trackedDirs],
          absorbed,
          autostart: { scanned: found.length + filesUnder(raw).length, started, skipped, failed },
          needsReview: skipped.filter(x => x.reason === 'unreviewed'),
          agents: folderAgentList(raw, new Map(failed.map(f => [f.filePath, f.error]))),
        })
      }
      if (method === 'DELETE') {
        const raw = url.searchParams.get('path') ?? ''
        const unload = url.searchParams.get('unload')
        if (!raw) return send(400, { error: 'path is required' })
        if (unload !== null && unload !== 'true' && unload !== 'false') return send(400, { error: 'unload must be true or false' })
        const match = trackedDirs.find(d => normDir(d) === normDir(raw))
        if (match === undefined) return send(404, { error: `Not a tracked folder: ${raw}` })
        trackedDirs.splice(trackedDirs.indexOf(match), 1)
        const unloaded: Array<{ agentId: string; filePath: string; name: string }> = []
        if (unload === 'true') {
          for (const a of agentsUnder(match)) {
            agents.delete(a.id)
            unloaded.push({ agentId: a.id, filePath: `/agents/${a.handle}.adf`, name: a.name })
            emit({ event_type: 'agent.unloaded', agent_id: a.id })
          }
        }
        return send(200, { removed: match, directories: [...trackedDirs], unloaded })
      }
    }
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
      case 'GET context': {
        if (!hasLoop(agent, loopParam)) return notFound(`loop "${loopParam}"`)
        const enabled = loopParam === 'main' || !!agent.loops.find(l => l.name === loopParam)?.enabled
        return send(200, mockContext(agent.id, loopParam, enabled ? (agent.history[loopParam] ?? []).length : null, agent.model, Number(url.searchParams.get('items') ?? 12)))
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
          return task ? send(200, { agentId: agent.id, task: taskEntry(agent, task) }) : notFound('task')
        }
        const wanted = url.searchParams.get('status')
        return send(200, { agentId: agent.id, tasks: agent.tasks.filter(t => !wanted || t.status === wanted).map(t => taskEntry(agent, t)) })
      }
      case 'POST tasks': {
        // Studio's "Approve all": gated approvals only; protection overrides are skipped.
        if (parts[3] === 'approve-all') {
          const loop = typeof body?.loop === 'string' ? body.loop : url.searchParams.get('loop') ?? undefined
          if (loop !== undefined && !hasLoop(agent, loop)) return notFound(`loop "${loop}"`)
          let approved = 0
          let skippedProtection = 0
          for (const task of agent.tasks) {
            if (task.status !== 'pending_approval') continue
            if (loop !== undefined && ((task.loop as string | undefined) ?? 'main') !== loop) continue
            if (approvalMetaOf(task).reason === 'protection') { skippedProtection++; continue }
            task.status = 'completed'
            approved++
            emit({ event_type: 'hil.resolved', agent_id: agent.id, loop: task.loop as string | undefined, payload: { request_id: task.id, task_id: task.id, approved: true } })
          }
          return send(200, { agentId: agent.id, ...(loop !== undefined ? { loop } : {}), approved, skippedProtection })
        }
        const task = agent.tasks.find(t => t.id === parts[3])
        if (!task) return notFound('task')
        const taskLoop = task.loop as string | undefined
        // Approve ▸ Always approve: tool comes from the task, never the body.
        if (parts[4] === 'always-approve') {
          if (task.status !== 'pending_approval') return send(409, { error: `Task "${task.id}" is in status "${String(task.status)}" - only pending_approval tasks can be always-approved` })
          const entry = taskEntry(agent, task)
          if (entry.canAlwaysApprove === false) return send(409, { error: entry.alwaysApproveBlockedReason })
          const tool = String(task.tool)
          const tools = agent.tools ??= []
          const decl = tools.find(t => t.name === tool)
          if (decl) { decl.enabled = true; decl.restricted = false } else tools.push({ name: tool, enabled: true, visible: true, restricted: false })
          emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['tools'] } })
          task.status = 'completed'
          emit({ event_type: 'hil.resolved', agent_id: agent.id, loop: taskLoop, payload: { request_id: task.id, task_id: task.id, approved: true } })
          return send(200, { agentId: agent.id, taskId: task.id, loop: taskLoop ?? 'main', tool, resolution: { task_id: task.id, status: 'approved' }, task: taskEntry(agent, task) })
        }
        const approve = body?.action === 'approve'
        const reason = typeof body?.reason === 'string' && body.reason ? body.reason : undefined
        task.status = approve ? 'completed' : 'denied'
        if (!approve) task.error = reason ?? 'Denied'
        emit({ event_type: 'hil.resolved', agent_id: agent.id, loop: taskLoop, payload: { request_id: task.id, task_id: task.id, approved: approve, ...(!approve && reason ? { feedback: reason } : {}) } })
        return send(200, { agentId: agent.id, taskId: task.id, resolution: { action: body?.action }, task: taskEntry(agent, task) })
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
    trackedDirs,
    folderFiles,
    existingDirs,
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
    ...(agent.tools ? { tools: agent.tools } : {}),
  }
}

function approvalMetaOf(task: Record<string, unknown>): MockApprovalMeta {
  const meta = task.approval_meta
  return meta && typeof meta === 'object' ? meta as MockApprovalMeta : {}
}

/** A task row as GET /tasks returns it: pending_approval rows gain the live
 *  "Always approve" affordance (same rules as runtime-service). */
function taskEntry(agent: MockAgent, task: Record<string, unknown>): Record<string, unknown> & { canAlwaysApprove?: boolean; alwaysApproveBlockedReason?: string } {
  if (task.status !== 'pending_approval') return task
  const meta = approvalMetaOf(task)
  if (meta.reason === 'protection') {
    return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: meta.alwaysApproveBlockedReason ?? `Target is locked (${meta.protection?.level ?? 'locked'})` }
  }
  if (meta.canAlwaysApprove === false || meta.can_always_approve === false) {
    return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: meta.alwaysApproveBlockedReason ?? 'One-time approval only for this request' }
  }
  if (agent.tools?.find(t => t.name === task.tool)?.locked === true) {
    return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: 'Tool declaration is locked' }
  }
  return { ...task, canAlwaysApprove: true }
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
