import { describe, it, expect, vi } from 'vitest'
import { resyncServerTools } from '../../../src/main/services/mcp-tool-sync'
import { pickFresherConfig } from '../../../src/main/runtime/config-freshness'
import type { AgentConfig, McpToolInfo } from '../../../src/shared/types/adf-v02.types'

/**
 * Regression tests for the live-reported trust bug: the Studio UI shows a tool
 * as ENABLED while the adf_shell gate exits 126 "disabled".
 *
 * Root causes fixed:
 *
 * 1. The foreground `tools-discovered` MCP reconnect listener (ipc/index.ts)
 *    synced into the config object captured AT AGENT START and wrote that
 *    snapshot back over the workspace + executor on every reconnect —
 *    silently reverting all config changes made since start (UI toggles,
 *    sys_update_config, "Always approve"). resyncServerTools now reads the
 *    config through a provider AT EVENT TIME.
 *
 * 2. AGENT_START assembles the executor from a config captured before seconds
 *    of awaits. A DOC_SET_AGENT_CONFIG landing in that window persisted to
 *    the workspace but had no executor to fan out to (agentExecutor === null),
 *    so the fresh executor kept the pre-start snapshot. pickFresherConfig is
 *    the adoption comparator used at install time.
 */

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'agent-test-id',
    name: 'agent-test',
    model: { provider: 'openai', model_id: 'gpt-x' },
    tools: [
      { name: 'fs_delete', enabled: false, visible: false },
    ],
    metadata: { created_at: '2026-08-09T00:00:00.000Z', updated_at: '2026-08-09T00:00:00.000Z' },
    ...overrides,
  } as unknown as AgentConfig
}

const TOOL_INFO: McpToolInfo[] = [
  { name: 'search', description: 'Search things', input_schema: { type: 'object' } },
]

function makeRegistry() {
  return { register: vi.fn() } as any
}

describe('resyncServerTools (long-lived tools-discovered listeners)', () => {
  it('reads config at EVENT time — an enabled-after-start tool survives an MCP reconnect', () => {
    // Live workspace config: the owner enabled fs_delete AFTER agent start.
    const liveConfig = makeConfig({
      tools: [{ name: 'fs_delete', enabled: true, visible: false }],
      mcp: { servers: [{ name: 'srv', transport: 'stdio' }] },
    } as any)

    const persist = vi.fn()
    const fanOut = vi.fn()
    resyncServerTools({
      getFreshConfig: () => liveConfig,
      serverName: 'srv',
      tools: TOOL_INFO,
      registry: makeRegistry(),
      manager: {} as any,
      persist,
      fanOut,
    })

    // MCP declarations were synced and persisted...
    expect(persist).toHaveBeenCalledTimes(1)
    expect(fanOut).toHaveBeenCalledTimes(1)
    const persisted = persist.mock.calls[0][0] as AgentConfig
    expect(persisted.tools.find((t) => t.name === 'mcp_srv_search')).toMatchObject({
      enabled: true,
      restricted: true,
    })
    // ...and the post-start enablement was NOT reverted (the old code synced
    // into the start-time snapshot where fs_delete was still disabled).
    expect(persisted.tools.find((t) => t.name === 'fs_delete')).toMatchObject({
      enabled: true,
      visible: false,
    })
  })

  it('each event re-reads the provider — a config change between reconnects is respected', () => {
    let current = makeConfig({
      tools: [{ name: 'fs_delete', enabled: false, visible: false }],
      mcp: { servers: [{ name: 'srv', transport: 'stdio' }] },
    } as any)
    const persist = vi.fn((c: AgentConfig) => { current = c })
    const fanOut = vi.fn()
    const registry = makeRegistry()

    resyncServerTools({
      getFreshConfig: () => current, serverName: 'srv', tools: TOOL_INFO,
      registry, manager: {} as any, persist, fanOut,
    })

    // Owner enables fs_delete between reconnect events.
    current = {
      ...current,
      tools: current.tools.map((t) => (t.name === 'fs_delete' ? { ...t, enabled: true } : t)),
      mcp: current.mcp,
    } as AgentConfig

    // Second reconnect with CHANGED tool schema forces a persist.
    const changedTools: McpToolInfo[] = [
      { name: 'search', description: 'Search things v2', input_schema: { type: 'object', v: 2 } },
    ]
    resyncServerTools({
      getFreshConfig: () => current, serverName: 'srv', tools: changedTools,
      registry, manager: {} as any, persist, fanOut,
    })

    const lastPersisted = persist.mock.calls.at(-1)![0] as AgentConfig
    expect(lastPersisted.tools.find((t) => t.name === 'fs_delete')?.enabled).toBe(true)
  })

  it('unknown server: registers tools for callability but persists nothing', () => {
    const persist = vi.fn()
    const fanOut = vi.fn()
    const registry = makeRegistry()
    resyncServerTools({
      getFreshConfig: () => makeConfig(),
      serverName: 'ghost',
      tools: TOOL_INFO,
      registry,
      manager: {} as any,
      persist,
      fanOut,
    })
    expect(registry.register).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it('no-op rediscovery (same tools, same hashes) does not persist again', () => {
    const config = makeConfig({
      tools: [],
      mcp: { servers: [{ name: 'srv', transport: 'stdio' }] },
    } as any)
    const persist = vi.fn()
    const fanOut = vi.fn()
    const registry = makeRegistry()
    const opts = {
      getFreshConfig: () => config, serverName: 'srv', tools: TOOL_INFO,
      registry, manager: {} as any, persist, fanOut,
    }
    resyncServerTools(opts)
    expect(persist).toHaveBeenCalledTimes(1)
    resyncServerTools(opts)
    expect(persist).toHaveBeenCalledTimes(1) // unchanged — no clobbering rewrite
  })
})

describe('pickFresherConfig (AGENT_START startup-window adoption)', () => {
  it('keeps the captured snapshot when the workspace was not written during startup', () => {
    const captured = makeConfig()
    const workspace = makeConfig() // same updated_at
    expect(pickFresherConfig(captured, workspace)).toBe(captured)
  })

  it('adopts the workspace config when a write landed during the startup window', () => {
    const captured = makeConfig()
    const workspace = makeConfig({
      tools: [{ name: 'fs_delete', enabled: true, visible: false }],
      metadata: { created_at: '2026-08-09T00:00:00.000Z', updated_at: '2026-08-09T00:00:05.000Z' },
    } as any)
    const picked = pickFresherConfig(captured, workspace)
    expect(picked).toBe(workspace)
    expect(picked.tools.find((t) => t.name === 'fs_delete')?.enabled).toBe(true)
  })

  it('adopts the workspace config even if its timestamp is somehow older (any drift means missed writes)', () => {
    const captured = makeConfig({
      metadata: { created_at: '2026-08-09T00:00:00.000Z', updated_at: '2026-08-09T00:00:09.000Z' },
    } as any)
    const workspace = makeConfig()
    expect(pickFresherConfig(captured, workspace)).toBe(workspace)
  })
})
