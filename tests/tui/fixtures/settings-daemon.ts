// Inspect › Settings routes on top of the inspect fixture (schema-valid configs
// with PUT): GET /agents/:id/tools (the catalog, built from the stored config),
// PATCH /agents/:id/loops/:name with compact_threshold (writes the stored
// config's loop), and GET /agents/:id/loop pages whose newest entry carries
// token usage (context in use). Everything else falls through to `inspect`.

import type { InspectFixture } from './inspect-daemon'

export interface SettingsFixture {
  fetch: typeof fetch
  /** Context tokens the newest main / loop entry reports (input + cache). */
  contextTokens: Record<string, number>
  loopPatches: Array<{ agentId: string; loop: string; body: Record<string, unknown> }>
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export function createSettingsFixture(inspect: InspectFixture): SettingsFixture {
  const contextTokens: Record<string, number> = { main: 42_000, consolidator: 9_000 }
  const loopPatches: SettingsFixture['loopPatches'] = []
  const idOf = (idOrHandle: string) => [...inspect.configs.entries()].find(([id, c]) => id === idOrHandle || c.handle === idOrHandle)?.[0] ?? idOrHandle

  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] === 'agents' && parts[1]) {
      const agentId = idOf(parts[1])
      const config = inspect.configs.get(agentId) as { tools?: Array<Record<string, unknown>>; loops?: Array<Record<string, unknown>>; mcp?: { servers?: Array<{ name: string; available_tools?: Array<{ name: string; description?: string }> }> } } | undefined
      if (config && method === 'GET' && parts[2] === 'tools' && !parts[3]) {
        const tools = (config.tools ?? []).map(t => {
          const name = String(t.name)
          const server = config.mcp?.servers?.find(s => name.startsWith(`mcp_${s.name}_`))
          const own = server?.available_tools?.find(x => `mcp_${server.name}_${x.name}` === name)
          return {
            name, enabled: !!t.enabled, visible: !!t.visible, restricted: !!t.restricted, locked: !!t.locked,
            source: server ? `mcp:${server.name}` : 'builtin',
            description: own?.description ?? `Built-in tool ${name}.`, schema: {},
            restrictions: { restricted: !!t.restricted, locked: !!t.locked },
          }
        }).sort((a, b) => a.name.localeCompare(b.name))
        return json({ agentId, tools })
      }
      if (config && method === 'PATCH' && parts[2] === 'loops' && parts[3]) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (!('compact_threshold' in body)) return inspect.fetch(input, init)
        const loop = config.loops?.find(l => l.name === parts[3])
        if (!loop) return json({ error: `Unknown loop "${parts[3]}"` }, 404)
        const value = body.compact_threshold
        if (value !== null && !(Number.isInteger(value) && (value as number) > 0)) return json({ error: 'Invalid loop config — compact_threshold: must be a positive integer' }, 400)
        if (value === null) delete loop.compact_threshold
        else loop.compact_threshold = value
        loopPatches.push({ agentId, loop: parts[3], body })
        return json({ agentId, loop: { name: parts[3], config: loop }, updated: ['compact_threshold'], excludedTools: [] })
      }
      if (config && method === 'GET' && parts[2] === 'loop' && !parts[3]) {
        const loop = url.searchParams.get('loop') ?? 'main'
        const tokens = contextTokens[loop]
        const entries = tokens ? [{ seq: 1, role: 'assistant', content_json: [{ type: 'text', text: 'ok' }], created_at: Date.now(), tokens: { input: tokens - 2000, cache_read: 2000, output: 50 } }] : []
        return json({ agentId, loop, total: entries.length, limit: 20, offset: 0, entries })
      }
    }
    return inspect.fetch(input, init)
  }
  return { fetch: wrapped, contextTokens, loopPatches }
}
