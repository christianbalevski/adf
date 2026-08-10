import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { syncDiscoveredMcpTools, resyncServerTools } from '../../../src/main/services/mcp-tool-sync'
import type { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import type { AgentConfig, McpServerConfig, McpToolInfo } from '../../../src/shared/types/adf-v02.types'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'

/**
 * Invariant: {enabled: true, visible: false} means "hidden from the advertised
 * LLM tool schema, but fully executable" (the shell-absorption state).
 * Visibility must NEVER gate registration or execution — only schema exposure.
 *
 * This exercises the real code-call path (AdfCallHandler.handleCall) across
 * tool categories to catch any registry-population/sync site that filters on
 * `visible` instead of `enabled`.
 */

function fakeWorkspace(): AdfWorkspace {
  return {
    insertLog: () => {},
  } as unknown as AdfWorkspace
}

function fakeProvider(): LLMProvider {
  return {} as unknown as LLMProvider
}

function makeHandler(registry: ToolRegistry, config: AgentConfig): AdfCallHandler {
  const handler = new AdfCallHandler({
    toolRegistry: registry,
    workspace: fakeWorkspace(),
    config,
    provider: fakeProvider(),
  })
  // Authorized code path is the same execution route; keep unauthorized to match
  // a plain sandbox call. Non-restricted enabled+invisible tools must still run.
  handler.setAuthorizationContext(false)
  return handler
}

function fakeBuiltIn(name: string): Tool {
  return {
    name,
    description: 'd',
    inputSchema: z.object({}),
    category: 'file',
    execute: async () => ({ content: 'BUILTIN_RAN', isError: false }),
    toProviderFormat: () => ({ name, description: 'd', input_schema: { type: 'object', properties: {} } }),
  } as unknown as Tool
}

describe('enabled+invisible tools are registered and executable via handleCall', () => {
  it('built-in tool: enabled:true, visible:false executes and is hidden from schema', async () => {
    const registry = new ToolRegistry()
    registry.register(fakeBuiltIn('fs_read'))
    const config = { name: 'a', tools: [{ name: 'fs_read', enabled: true, visible: false }] } as unknown as AgentConfig
    const handler = makeHandler(registry, config)

    const result = await handler.handleCall('fs_read', {})
    expect(result.error, `built-in should execute: ${result.error}`).toBeUndefined()
    expect(result.result).toBe('BUILTIN_RAN')

    // Hidden from advertised schema
    expect(registry.getToolsForAgent(config.tools)).toHaveLength(0)
    // But present in the enabled set used for sandbox fast-fail
    expect(handler.getEnabledToolNames()).toContain('fs_read')
  })

  it('MCP tool: enabled:true, visible:false executes and is hidden from schema', async () => {
    const registry = new ToolRegistry()
    let called = false
    const fakeMgr = {
      callTool: async () => { called = true; return { content: 'MCP_RAN', isError: false } },
    } as unknown as McpClientManager

    const toolInfo: McpToolInfo = { name: 'search', description: 'search things', input_schema: { type: 'object', properties: {} } }
    const serverCfg: McpServerConfig = { name: 'web', transport: 'stdio', command: 'x' } as unknown as McpServerConfig

    // config already has the MCP tool declaration flipped to enabled+invisible
    // (shell-absorption), with the hash matching what discovery will compute.
    const config = {
      name: 'a',
      mcp: { servers: [serverCfg] },
      tools: [] as AgentConfig['tools'],
    } as unknown as AgentConfig

    // First sync: registers the tool + seeds the declaration (enabled+visible+new).
    syncDiscoveredMcpTools(config, serverCfg, [toolInfo], registry, fakeMgr)
    // Owner flips visibility off to absorb it into the shell (hidden from schema).
    const decl = config.tools.find(t => t.name === 'mcp_web_search')!
    decl.visible = false
    // Simulate an agent restart / MCP reconnect re-running discovery.
    const registry2 = new ToolRegistry()
    syncDiscoveredMcpTools(config, serverCfg, [toolInfo], registry2, fakeMgr)

    const handler = makeHandler(registry2, config)
    // MCP tools are restricted:true by default (authorized-code only) — orthogonal
    // to visibility. Authorize so this test isolates the visibility semantics.
    handler.setAuthorizationContext(true)
    const result = await handler.handleCall('mcp_web_search', {})
    expect(result.error, `MCP tool should execute: ${result.error}`).toBeUndefined()
    expect(called).toBe(true)
    expect(result.result).toBe('MCP_RAN')

    // Hidden from advertised schema, present in enabled set
    expect(registry2.getToolsForAgent(config.tools)).toHaveLength(0)
    expect(handler.getEnabledToolNames()).toContain('mcp_web_search')
    expect(registry2.get('mcp_web_search'), 'MCP tool must be registered').toBeDefined()
  })
})

/**
 * Reconnect-clobber regression.
 *
 * MCP servers drop and auto-restart routinely; each reconnect re-emits
 * `tools-discovered`. A late-discovery listener that syncs into a config object
 * captured at agent START, then persists it, writes that stale snapshot back
 * over the workspace — silently reverting every config change made since start
 * (a tool flipped to enabled+invisible for shell absorption, an enable toggle,
 * "Always approve", ...). The UI keeps showing the tool enabled while the
 * executor/shell gate reads the clobbered declaration → "not enabled/disabled"
 * at call time. The reconnect-safe path (resyncServerTools) reads FRESH config
 * at event time, so post-start changes survive.
 */
describe('MCP reconnect must not clobber post-start enabled/visible changes', () => {
  const toolInfo: McpToolInfo = { name: 'search', description: 'd', input_schema: { type: 'object', properties: {} } }
  const serverName = 'web'
  const fakeMgr = {} as unknown as McpClientManager

  it('ANTI-PATTERN: syncing a stale start-time config reverts the shell-absorption toggle', () => {
    // Start snapshot: tool freshly discovered → enabled + VISIBLE.
    const staleStartConfig = {
      name: 'a',
      mcp: { servers: [{ name: serverName, transport: 'stdio', command: 'x', available_tools: [] }] },
      tools: [{ name: 'mcp_web_search', enabled: true, visible: true, restricted: true }],
    } as unknown as AgentConfig

    // Reconnect fires against the STALE object (available_tools empty → change) and
    // the caller would persist it — overwriting the user's later visible:false.
    const changed = syncDiscoveredMcpTools(
      staleStartConfig,
      staleStartConfig.mcp!.servers![0],
      [toolInfo],
      new ToolRegistry(),
      fakeMgr,
    )
    expect(changed).toBe(true) // caller persists → clobber
    expect(staleStartConfig.tools.find(t => t.name === 'mcp_web_search')!.visible).toBe(true)
  })

  it('FIX: resyncServerTools reads fresh config, so enabled+invisible survives reconnect', () => {
    // Live/persisted config AT EVENT TIME: user has absorbed the tool (visible:false).
    const freshConfig = {
      name: 'a',
      mcp: { servers: [{ name: serverName, transport: 'stdio', command: 'x', available_tools: [] }] },
      tools: [{ name: 'mcp_web_search', enabled: true, visible: false, restricted: true }],
    } as unknown as AgentConfig

    const registry = new ToolRegistry()
    let persisted: AgentConfig | null = null
    let fannedOut: AgentConfig | null = null

    resyncServerTools({
      getFreshConfig: () => freshConfig,
      serverName,
      tools: [toolInfo],
      registry,
      manager: fakeMgr,
      persist: (c) => { persisted = c },
      fanOut: (c) => { fannedOut = c },
    })

    // Tool re-registered so it stays callable...
    expect(registry.get('mcp_web_search')).toBeDefined()
    // ...and the shell-absorption state is preserved, not clobbered.
    const decl = (persisted ?? freshConfig).tools.find(t => t.name === 'mcp_web_search')!
    expect(decl.enabled).toBe(true)
    expect(decl.visible).toBe(false)
    expect(fannedOut ?? persisted).not.toBeNull()
  })
})
