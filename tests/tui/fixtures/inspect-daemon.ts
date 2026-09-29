// Inspector routes the shared mock daemon does not serve: runtime and per-agent
// diagnostics, identities, logs, tables, settings and a schema-valid config
// with PUT. Wraps fetch: these paths are answered here, the rest go to the mock.

import { DEFAULT_AGENT_CONFIG } from '../../../src/shared/constants/adf-defaults'
import { AGENT_1_ID, AGENT_2_ID } from './mock-daemon'

export interface InspectFixture {
  fetch: typeof fetch
  /** Bodies of PUT /agents/:id/config, in order. */
  configPuts: Array<{ agentId: string; body: Record<string, unknown> }>
  configs: Map<string, Record<string, unknown>>
  /** Append a log entry to agent-1 (seen by logs/after polling). */
  addLog(message: string, level?: string): void
  requests: string[]
}

export function validConfig(id: string, handle: string): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(DEFAULT_AGENT_CONFIG)) as Record<string, unknown>
  return {
    ...base,
    id,
    name: handle,
    handle,
    instructions: 'Keep the standings API notes tidy.',
    metadata: { created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    model: { ...(base.model as Record<string, unknown>), provider: 'mock', model_id: 'mock-model' },
    loops: handle === 'agent-1'
      ? [
          { name: 'consolidator', goal: 'Consolidate memories into mind.md every hour.', enabled: true, autostart: false },
          { name: 'researcher', goal: 'Research whatever main hands over and report back.', enabled: true, autostart: false },
        ]
      : [],
    // agent-1 serves a site + API (as in mock-daemon.ts) and has host access.
    ...(handle === 'agent-1'
      ? {
          serving: { public: { enabled: true, index: 'index.html' }, shared: { enabled: false, patterns: [] }, api: [{ method: 'GET', path: '/api/status', lambda: 'lib/api.ts:status' }, { method: 'WS', path: '/live', lambda: 'lib/ws.ts:onMessage' }] },
          compute: { ...(base.compute as Record<string, unknown>), host_access: true },
        }
      : {}),
  }
}

const now = () => Date.now()

export function createInspectFixture(_mockUrl: string, next: typeof fetch = globalThis.fetch.bind(globalThis)): InspectFixture {
  const configs = new Map<string, Record<string, unknown>>([
    [AGENT_1_ID, validConfig(AGENT_1_ID, 'agent-1')],
    [AGENT_2_ID, validConfig(AGENT_2_ID, 'agent-2')],
  ])
  const configPuts: InspectFixture['configPuts'] = []
  const requests: string[] = []
  let nextLogId = 1
  const logs: Array<Record<string, unknown>> = [
    { id: nextLogId++, level: 'info', origin: 'executor', event: 'turn', target: null, message: 'Turn started in loop consolidator', data: JSON.stringify({ loop: 'consolidator' }), created_at: now() - 5000 },
    { id: nextLogId++, level: 'warn', origin: 'mcp', event: 'restart', target: 'files-server', message: 'files-server restarted', data: null, created_at: now() - 4000 },
  ]
  const idOf = (idOrHandle: string) => idOrHandle === 'agent-1' ? AGENT_1_ID : idOrHandle === 'agent-2' ? AGENT_2_ID : idOrHandle

  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

  const handle = async (method: string, url: URL, init?: RequestInit): Promise<Response | null> => {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const path = url.pathname
    if (method === 'GET' && path === '/runtime') {
      return json({ daemon: { uptime: 3725, pid: 4242 }, settings: {}, providers: { providers: [], agentUsage: [] }, auth: {}, mcp: { servers: [] }, adapters: { adapters: [] }, network: { host: [], mesh: { enabledSetting: false, lan: false, port: 7295, status: null }, websocket: { activeConnections: 0, inboundConnections: 0, outboundConnections: 0 }, agents: [] }, compute: null, agents: [] })
    }
    if (method === 'GET' && path === '/runtime/usage') {
      return json({
        source: 'token-usage-service', note: 'Aggregated provider/model totals.',
        totals: { input: 5000, output: 700, total: 5700 },
        byProvider: [{ provider: 'mock', input: 5000, output: 700, total: 5700 }],
        byModel: [{ provider: 'mock', model: 'mock-model', days: 2, input: 5000, output: 700, total: 5700 }],
        usage: {},
      })
    }
    if (method === 'GET' && path === '/runtime/providers') {
      return json({
        providers: [{ id: 'mock', type: 'openai-compatible', name: 'Mock', credentialStorage: 'app', apiKey: 'sk-provider-secret-1' }],
        agentUsage: [{ agentId: AGENT_1_ID, handle: 'agent-1', name: 'agent-1', providerId: 'mock', modelId: 'mock-model', source: 'app', credentialStorage: 'app' }],
      })
    }
    if (method === 'GET' && path === '/runtime/auth') {
      return json({ chatgpt: { authenticated: true, email: 'owner@example.test' }, grok: { authenticated: false }, providers: [{ id: 'mock', type: 'openai-compatible', name: 'Mock', credentialStorage: 'app', hasApiKey: true }] })
    }
    if (method === 'GET' && path === '/runtime/network') {
      return json({ host: ['192.168.1.20'], mesh: { enabledSetting: true, lan: false, port: 7295, status: null }, websocket: { activeConnections: 0, inboundConnections: 0, outboundConnections: 0 }, agents: [{ agentId: AGENT_1_ID, handle: 'agent-1', receive: true, sendMode: 'respond_only', wsConnectionsConfigured: 0, servingRoutes: 1, publicServingEnabled: false }] })
    }
    if (method === 'GET' && path === '/runtime/settings') {
      return json({ configured: true, filePath: '/settings.json', trackedDirectories: ['/agents'], maxDirectoryScanDepth: 3, autoCompactThreshold: null, promptOverrides: { globalSystemPrompt: false, compactionPrompt: false, toolPrompts: 0 }, packageCounts: { sandboxPackages: 0, mcpServers: 1, adapters: 0, providers: 1 } })
    }
    if (method === 'GET' && path === '/settings') {
      return json({ filePath: '/settings.json', settings: { theme: 'dark', providers: [{ id: 'mock', apiKey: 'sk-settings-secret-2' }], mcpServers: [{ name: 'files-server', env: { GITHUB_TOKEN: 'ghp-env-secret-3' } }], meshPort: 7295 } })
    }
    if (parts[0] !== 'agents' || !parts[1]) return null
    const agentId = idOf(parts[1])
    const sub = parts.slice(2).join('/')
    // Agents made later (POST /agents/create) keep the mock daemon's own config.
    if (sub === 'config' && method === 'GET') return configs.has(agentId) ? json({ agentId, config: configs.get(agentId) }) : null
    if (sub === 'config' && method === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      configPuts.push({ agentId, body })
      configs.set(agentId, body)
      return json({ agentId, config: body, success: true })
    }
    if (sub === 'runtime' && method === 'GET') {
      return json({
        agentId,
        status: { id: agentId, name: 'agent-1', handle: 'agent-1', runtimeState: 'idle', targetState: null, loopCount: 5 },
        adapters: { agentId, configured: [], states: [] },
        mcp: { agentId, configured: [], states: [] },
        triggers: { agentId, displayState: 'active', configured: [{ type: 'on_timer', enabled: true, targetCount: 1, targets: [{ scope: 'agent', loop: 'consolidator' }] }, { type: 'on_chat', enabled: true, targetCount: 1, targets: [{ scope: 'agent' }] }] },
        ws: { configured: [], active: [] },
      })
    }
    if (sub === 'usage' && method === 'GET') {
      return json({ agentId, source: 'adf_loop', note: '', loopRows: 12, usageRows: 4, totals: { input: 4200, output: 610, cacheRead: 800, cacheWrite: 90, total: 5700 }, byModel: [{ model: 'mock-model', rows: 3, input: 4000, output: 600, cacheRead: 800, cacheWrite: 90, total: 5490 }, { model: 'mock-small', rows: 1, input: 200, output: 10, cacheRead: 0, cacheWrite: 0, total: 210 }] })
    }
    if (sub === 'runtime/mcp' && method === 'GET') {
      return json({ agentId, configured: [{ name: 'files-server', transport: 'stdio', command: 'npx', args: ['files-server'], toolCount: 4 }], states: [{ name: 'files-server', status: 'connected', restartCount: 1, toolCount: 4, connectedAt: now() - 60_000, logs: [{ timestamp: now() - 30_000, stream: 'stderr', message: 'listening on stdio' }] }] })
    }
    if (sub === 'runtime/adapters' && method === 'GET') {
      return json({ agentId, configured: [{ type: 'telegram', enabled: true, config: { chat_id: '42', bot_token: 'tg-adapter-secret-4' } }], states: [{ type: 'telegram', status: 'connected', restartCount: 0, logs: [] }] })
    }
    if (sub === 'identities' && method === 'GET') {
      return json({ agentId, identities: [{ purpose: 'adapter:telegram:BOT_TOKEN', encrypted: true, code_access: false }, { purpose: 'crypto:signing:private_key', encrypted: true, code_access: false }] })
    }
    if (sub === 'logs' && method === 'GET') return json({ agentId, logs: [...logs].reverse() })
    if (sub === 'logs/after' && method === 'GET') {
      const after = Number(url.searchParams.get('afterId') ?? 0)
      return json({ agentId, logs: logs.filter(l => Number(l.id) > after) })
    }
    if (sub === 'tables' && method === 'GET') return json({ agentId, tables: [{ name: 'local_standings', row_count: 3 }, { name: 'local_notes', row_count: 0 }] })
    if (parts[2] === 'tables' && parts[3] && method === 'GET') {
      if (parts[3] !== 'local_standings') return json({ agentId, columns: [], rows: [] })
      return json({ agentId, columns: ['team', 'points', 'meta'], rows: [{ team: 'north', points: 12, meta: { streak: 3 } }, { team: 'south', points: 9, meta: null }, { team: 'east', points: 4, meta: null }] })
    }
    return null
  }

  const wrapped: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${target.pathname}${target.search}`)
    const answered = await handle(method, target, init)
    if (answered) return answered
    // Pass through to whatever daemon the client targets (usually `mockUrl`).
    return next(input, init)
  }

  return {
    fetch: wrapped,
    configPuts,
    configs,
    requests,
    addLog(message, level = 'info') {
      logs.push({ id: nextLogId++, level, origin: 'executor', event: 'note', target: null, message, data: null, created_at: now() })
    },
  }
}
