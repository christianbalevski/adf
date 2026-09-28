// Loops-manager additions on top of the shared mock daemon, as a fetch
// wrapper (the shared fixture stays untouched): agent config with tools and
// triggers, PUT config, runtime trigger diagnostics, model listing, PUT timers
// and full PATCH loop fields. Everything else passes through to the mock.

import type { MockDaemon } from './mock-daemon'

export interface LoopsMock {
  fetch: typeof fetch
  /** Requests the wrapper answered or passed on, e.g. `PUT /agents/<id>/config`. */
  calls: string[]
  configs: Map<string, Record<string, unknown>>
}

const HOST_TOOLS = [
  { name: 'fs_read', enabled: true, visible: true },
  { name: 'fs_write', enabled: true, visible: true },
  { name: 'fs_list', enabled: true, visible: true },
  { name: 'sys_fetch', enabled: true, visible: true },
  { name: 'loop_send', enabled: true, visible: true },
  { name: 'loop_list', enabled: true, visible: true },
  { name: 'sys_set_state', enabled: true, visible: true },
  { name: 'msg_send', enabled: true, visible: true, restricted: true },
  { name: 'db_execute', enabled: false, visible: true },
  { name: 'loop_manage', enabled: true, visible: true },
]

const TRIGGERS = {
  on_timer: { enabled: true, targets: [{ scope: 'agent' }, { scope: 'agent', loop: 'consolidator' }] },
  on_chat: { enabled: true, targets: [{ scope: 'agent' }] },
  on_inbox: { enabled: false, targets: [{ scope: 'agent', loop: 'researcher', debounce_ms: 30_000 }] },
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** `next` is where unanswered requests go (default: the network, i.e. the mock daemon). */
export function createLoopsMock(mock: MockDaemon, next: typeof fetch = globalThis.fetch.bind(globalThis)): LoopsMock {
  const calls: string[] = []
  const configs = new Map<string, Record<string, unknown>>()
  const base = next

  const configOf = async (agentId: string): Promise<Record<string, unknown> | null> => {
    const upstream = await base(`${mock.url}/agents/${encodeURIComponent(agentId)}/config`)
    if (!upstream.ok) return null
    const body = await upstream.json() as { config: Record<string, unknown> }
    const extra = configs.get(body.config.id as string) ?? { tools: HOST_TOOLS, triggers: TRIGGERS, autonomous: false, autostart: true }
    return { ...body.config, ...extra, loops: body.config.loops }
  }

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push(`${method} ${url.pathname}${url.search}`)

    if (url.pathname === '/runtime/models') {
      return json(200, { provider: url.searchParams.get('provider'), models: ['mock-model', 'mock-large'] })
    }
    if (parts[0] === 'agents' && parts[1]) {
      const agent = mock.agents.get(parts[1]) ?? [...mock.agents.values()].find(a => a.handle === parts[1])
      if (agent) {
        const route = `${method} ${parts.slice(2).join('/')}`
        if (route === 'GET config') {
          const config = await configOf(agent.id)
          return json(200, { agentId: agent.id, config })
        }
        if (route === 'PUT config' && body) {
          configs.set(agent.id, { tools: body.tools, triggers: body.triggers, autonomous: body.autonomous, autostart: body.autostart })
          mock.emit({ event_type: 'config.changed', agent_id: agent.id, payload: { changed_keys: ['triggers'] } })
          return json(200, { agentId: agent.id, config: await configOf(agent.id), success: true })
        }
        if (route === 'GET runtime/triggers') {
          const config = await configOf(agent.id)
          const triggers = (config?.triggers ?? {}) as Record<string, { enabled: boolean; targets: unknown[] }>
          return json(200, {
            agentId: agent.id,
            displayState: 'active',
            configured: Object.entries(triggers).map(([type, t]) => ({ type, enabled: t.enabled, targetCount: t.targets.length, targets: t.targets })),
          })
        }
        if (method === 'PUT' && parts[2] === 'timers' && parts[3] && body) {
          const timer = agent.timers.find(t => String(t.id) === parts[3])
          if (!timer) return json(404, { error: 'Unknown timer' })
          timer.schedule = body.mode === 'cron' ? { mode: 'cron', cron: body.cron } : body.mode === 'interval' ? { mode: 'interval', every_ms: body.every_ms } : { mode: 'once', at: body.at ?? Date.now() + Number(body.delay_ms ?? 0) }
          timer.payload = body.payload
          timer.next_wake_at = Date.now() + Number(body.every_ms ?? 60_000)
          if (typeof body.loop === 'string') { if (body.loop === 'main') delete timer.loop; else timer.loop = body.loop }
          return json(200, { agentId: agent.id, success: true })
        }
        if (method === 'POST' && parts[2] === 'timers' && body) {
          const response = await base(url, init)
          const created = await response.clone().json() as { id?: number }
          const timer = agent.timers.find(t => t.id === created.id)
          if (timer && body.mode === 'cron') timer.schedule = { mode: 'cron', cron: body.cron, ...(body.max_runs ? { max_runs: body.max_runs } : {}) }
          return response
        }
        if (method === 'PATCH' && parts[2] === 'loops' && parts[3] && body) {
          const loop = agent.loops.find(l => l.name === parts[3]) as unknown as Record<string, unknown> | undefined
          if (loop) for (const key of ['autonomous', 'model', 'compact_threshold'] as const) if (body[key] !== undefined) loop[key] = body[key]
        }
      }
    }
    return base(url, init)
  }

  return { fetch: wrapped as typeof fetch, calls, configs }
}
