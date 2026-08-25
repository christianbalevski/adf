import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { hashMcpToolInfo, syncDiscoveredMcpTools, diffMcpServerNames } from '../../../src/main/services/mcp-tool-sync'
import type { AgentConfig, McpServerConfig } from '../../../src/shared/types/adf-v02.types'
import type { McpClientManager } from '../../../src/main/services/mcp-client-manager'

function configWithTools(tools: AgentConfig['tools']): AgentConfig {
  return {
    id: 'agent',
    name: 'Agent',
    handle: 'agent',
    state: 'idle',
    start_in: 'idle',
    model: { provider: 'test', model_id: 'test' },
    tools,
    security: { allow_unsigned: true },
    code: {
      model_invoke: false,
      sys_lambda: false,
      task_resolve: false,
      loop_inject: false,
      get_identity: false,
      set_identity: true,
      emit_event: true
    },
    mcp: { servers: [] },
    metadata: { created_at: 'now', updated_at: 'now' }
  } as AgentConfig
}

function configWithServers(names: string[]): AgentConfig {
  const cfg = configWithTools([])
  cfg.mcp = { servers: names.map((name) => ({ name, transport: 'stdio' } as McpServerConfig)) }
  return cfg
}

describe('diffMcpServerNames', () => {
  it('reports only added servers when servers are appended', () => {
    const prev = configWithServers(['a'])
    const next = configWithServers(['a', 'b'])
    expect(diffMcpServerNames(prev, next)).toEqual({ added: ['b'], removed: [] })
  })

  it('reports only removed servers when servers are dropped', () => {
    const prev = configWithServers(['a', 'b'])
    const next = configWithServers(['a'])
    expect(diffMcpServerNames(prev, next)).toEqual({ added: [], removed: ['b'] })
  })

  it('reports nothing when the server set is unchanged (order-independent)', () => {
    const prev = configWithServers(['a', 'b'])
    const next = configWithServers(['b', 'a'])
    expect(diffMcpServerNames(prev, next)).toEqual({ added: [], removed: [] })
  })

  it('reports both added and removed in a single diff', () => {
    const prev = configWithServers(['a', 'b'])
    const next = configWithServers(['b', 'c'])
    expect(diffMcpServerNames(prev, next)).toEqual({ added: ['c'], removed: ['a'] })
  })

  it('treats a missing mcp block as no servers', () => {
    const prev = configWithTools([]) // mcp.servers = []
    const next = configWithServers(['a'])
    delete (prev as { mcp?: unknown }).mcp
    expect(diffMcpServerNames(prev, next)).toEqual({ added: ['a'], removed: [] })
  })
})

describe('syncDiscoveredMcpTools', () => {
  it('adds new MCP tools enabled, visible, and HIL-gated', () => {
    const config = configWithTools([])
    const server: McpServerConfig = { name: 'docs', transport: 'stdio' }
    const changed = syncDiscoveredMcpTools(
      config,
      server,
      [{ name: 'search', input_schema: { type: 'object' } }],
      new ToolRegistry(),
      {} as McpClientManager
    )

    expect(changed).toBe(true)
    expect(config.tools[0]).toMatchObject({
      name: 'mcp_docs_search',
      enabled: true,
      visible: true,
      restricted: true,
      mcp_tool_status: 'new'
    })
  })

  it('disables and HIL-gates changed MCP tool declarations', () => {
    const config = configWithTools([{
      name: 'mcp_docs_search',
      enabled: true,
      visible: true,
      restricted: false,
      mcp_tool_hash: 'old'
    }])
    const server: McpServerConfig = { name: 'docs', transport: 'stdio' }

    syncDiscoveredMcpTools(
      config,
      server,
      [{ name: 'search', description: 'new', input_schema: { type: 'object' } }],
      new ToolRegistry(),
      {} as McpClientManager
    )

    expect(config.tools[0]).toMatchObject({
      enabled: false,
      visible: false,
      restricted: true,
      mcp_tool_status: 'changed'
    })
  })

  it('preserves user choices when an MCP tool reconnects unchanged', () => {
    const tool = { name: 'search', input_schema: { type: 'object' } }
    const config = configWithTools([{
      name: 'mcp_docs_search',
      enabled: false,
      visible: true,
      restricted: false,
      mcp_tool_hash: hashMcpToolInfo(tool)
    }])
    const server: McpServerConfig = { name: 'docs', transport: 'stdio' }

    const changed = syncDiscoveredMcpTools(config, server, [tool], new ToolRegistry(), {} as McpClientManager)

    expect(changed).toBe(true) // available_tools cache was populated
    expect(config.tools[0]).toMatchObject({
      enabled: false,
      visible: true,
      restricted: false,
    })
  })

  it('marks missing MCP tools as removed', () => {
    const config = configWithTools([{
      name: 'mcp_docs_search',
      enabled: true,
      visible: true,
      mcp_tool_hash: 'hash'
    }])
    const server: McpServerConfig = { name: 'docs', transport: 'stdio' }

    syncDiscoveredMcpTools(config, server, [], new ToolRegistry(), {} as McpClientManager)

    expect(config.tools[0]).toMatchObject({
      enabled: false,
      visible: false,
      mcp_tool_status: 'removed'
    })
  })

  it('restores a reappearing tool as enabled, visible, and HIL-gated', () => {
    const tool = { name: 'search', input_schema: { type: 'object' } }
    const config = configWithTools([{
      name: 'mcp_docs_search',
      enabled: false,
      visible: false,
      restricted: false,
      mcp_tool_hash: hashMcpToolInfo(tool),
      mcp_tool_status: 'removed'
    }])
    const server: McpServerConfig = { name: 'docs', transport: 'stdio' }

    syncDiscoveredMcpTools(
      config,
      server,
      [tool],
      new ToolRegistry(),
      {} as McpClientManager
    )

    expect(config.tools[0]).toMatchObject({
      enabled: true,
      visible: true,
      restricted: true,
      mcp_tool_status: 'new'
    })
  })
})
