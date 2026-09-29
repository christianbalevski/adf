// Fleet-only additions to the shared mock daemon, layered as a fetch wrapper
// so the shared fixture stays untouched: GET /runtime, /runtime/settings,
// per-agent inbox and usage, POST /agents/load (+ review gate),
// /agents/review, /agents/review/accept and /agents/autostart.

import type { MockDaemon } from './mock-daemon'

export const AGENT_3_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'

export interface FleetMockOptions {
  /** Files that fail a review-gated load until accepted. */
  unreviewed?: string[]
  trackedDirectories?: string[]
  unread?: Record<string, number>
}

export interface FleetMock {
  fetch: typeof fetch
  calls: string[]
  reviewed: Set<string>
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function createFleetFetch(mock: MockDaemon, options: FleetMockOptions = {}, next: typeof fetch = globalThis.fetch.bind(globalThis)): FleetMock {
  const calls: string[] = []
  const reviewed = new Set<string>()
  const unreviewed = new Set(options.unreviewed ?? [])
  const base = next

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) as Record<string, unknown> : {}
    const path = url.pathname
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
    calls.push(`${method} ${path}${url.search}`)

    if (method === 'GET' && path === '/runtime') {
      const agents = [...mock.agents.values()]
      return json(200, {
        daemon: { uptime: 3 * 3600 + 12 * 60, pid: 4242 },
        settings: { configured: true, filePath: null, trackedDirectories: options.trackedDirectories ?? [], maxDirectoryScanDepth: null, autoCompactThreshold: null, promptOverrides: { globalSystemPrompt: false, compactionPrompt: false, toolPrompts: 0 }, packageCounts: { sandboxPackages: 0, mcpServers: 0, adapters: 0, providers: 1 } },
        providers: { providers: [{ id: 'mock', type: 'openai', name: 'Mock', baseUrl: '', hasApiKey: true, requestDelayMs: 0, credentialStorage: 'app', params: [] }], agentUsage: [] },
        auth: { chatgpt: { authenticated: false }, grok: { authenticated: false }, providers: [] },
        mcp: { servers: [] },
        adapters: { adapters: [] },
        network: {
          host: [],
          mesh: { enabledSetting: true, lan: false, port: 7295, status: null },
          websocket: { activeConnections: 0, inboundConnections: 0, outboundConnections: 0 },
          agents: agents.map((a, i) => ({ agentId: a.id, handle: a.handle, name: a.name, filePath: `/agents/${a.handle}.adf`, receive: i === 0, sendMode: null, network: null, wsConnectionsConfigured: 0, servingRoutes: 0, publicServingEnabled: false })),
        },
        compute: null,
        agents: [],
      })
    }
    if (method === 'GET' && path === '/runtime/settings') {
      return json(200, { configured: true, filePath: null, trackedDirectories: options.trackedDirectories ?? [], maxDirectoryScanDepth: null, autoCompactThreshold: null, promptOverrides: { globalSystemPrompt: false, compactionPrompt: false, toolPrompts: 0 }, packageCounts: { sandboxPackages: 0, mcpServers: 0, adapters: 0, providers: 1 } })
    }
    if (method === 'GET' && parts[0] === 'agents' && parts[2] === 'inbox') {
      const agent = mock.agents.get(parts[1])
      const n = agent ? options.unread?.[agent.handle] ?? 0 : 0
      return json(200, { agentId: parts[1], messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, status: 'unread', from: 'agent-2', to: agent?.handle ?? '', content: `Unread message ${i + 1}`, received_at: Date.now() - i * 60_000 })) })
    }
    if (method === 'GET' && path === '/agents/review') {
      const filePath = url.searchParams.get('filePath') ?? ''
      return json(200, { agentId: AGENT_3_ID, filePath, reviewed: reviewed.has(filePath) || !unreviewed.has(filePath), summary: { name: 'agent-3' } })
    }
    if (method === 'POST' && path === '/agents/review/accept') {
      const filePath = String(body.filePath ?? '')
      reviewed.add(filePath)
      return json(200, { agentId: AGENT_3_ID, filePath, reviewed: true, summary: { name: 'agent-3' } })
    }
    if (method === 'POST' && path === '/agents/load') {
      const filePath = String(body.filePath ?? '')
      if (!filePath) return json(400, { error: 'filePath is required' })
      if (body.requireReview === true && unreviewed.has(filePath) && !reviewed.has(filePath)) {
        return json(403, { error: 'Agent must be reviewed before loading into the runtime.', code: 'AGENT_REVIEW_REQUIRED', agentId: AGENT_3_ID, filePath })
      }
      if (!mock.agents.has(AGENT_3_ID)) {
        mock.agents.set(AGENT_3_ID, {
          id: AGENT_3_ID, handle: 'agent-3', name: 'agent-3', model: 'mock-model', state: 'idle',
          loops: [], history: { main: [] }, files: [], timers: [], tasks: [], asks: [],
        } as never)
        mock.emit({ event_type: 'agent.loaded', agent_id: AGENT_3_ID })
      }
      return json(200, { id: AGENT_3_ID, filePath, config: { id: AGENT_3_ID, name: 'agent-3', handle: 'agent-3', model: { provider: 'mock', model_id: 'mock-model' } } })
    }
    if (method === 'POST' && path === '/agents/autostart') {
      const dirs = Array.isArray(body.trackedDirs) ? body.trackedDirs : []
      return json(200, { scanned: dirs.length * 2, started: [], skipped: [{ filePath: '/agents/agent-1.adf', name: 'agent-1', reason: 'already_loaded' }], failed: [] })
    }
    return base(input, init)
  }
  return { fetch: handler as typeof fetch, calls, reviewed }
}
