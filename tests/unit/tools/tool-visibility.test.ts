import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { buildToolDiscovery, SysGetConfigTool } from '../../../src/main/tools/built-in/sys-get-config.tool'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function stubTool(name: string, description = `${name} description`): Tool {
  return {
    name,
    description,
    inputSchema: z.object({ value: z.string().optional() }),
    category: name.startsWith('mcp_') ? 'external' : 'self',
    async execute() {
      return { content: 'ok', isError: false }
    },
    toProviderFormat() {
      return {
        name,
        description,
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      }
    },
  }
}

function makeConfig(): AgentConfig {
  return {
    tools: [
      { name: 'visible_tool', enabled: true, visible: true },
      { name: 'hidden_tool', enabled: true, visible: false },
      { name: 'disabled_tool', enabled: false, visible: false },
      { name: 'mcp_docs_search', enabled: false, visible: false },
    ],
    mcp: {
      servers: [{
        name: 'docs',
        transport: 'stdio',
        available_tools: [{
          name: 'search',
          description: 'Search docs',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        }],
      }],
    },
  } as AgentConfig
}

describe('tool visibility', () => {
  it('passes only enabled and visible declarations to the LLM tool list', () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('visible_tool'))
    registry.register(stubTool('hidden_tool'))
    registry.register(stubTool('disabled_tool'))

    const config = makeConfig()
    const tools = registry.getToolsForAgent(config.tools).map((tool) => tool.name)

    expect(tools).toEqual(['visible_tool'])
  })

  it('discovers built-in and MCP tools regardless of enabled or visible state', () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('visible_tool'))
    registry.register(stubTool('hidden_tool'))
    registry.register(stubTool('disabled_tool'))

    const tools = buildToolDiscovery(makeConfig(), registry)

    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'visible_tool',
        enabled: true,
        visible: true,
        source: 'builtin',
        description: 'visible_tool description',
        schema: expect.objectContaining({ type: 'object' }),
      }),
      expect.objectContaining({
        name: 'hidden_tool',
        enabled: true,
        visible: false,
        source: 'builtin',
      }),
      expect.objectContaining({
        name: 'disabled_tool',
        enabled: false,
        visible: false,
        source: 'builtin',
      }),
      expect.objectContaining({
        name: 'mcp_docs_search',
        enabled: false,
        visible: false,
        source: 'mcp:docs',
        description: 'Search docs',
        schema: expect.objectContaining({ type: 'object' }),
      }),
    ]))
  })

  it('sys_get_config section tools returns discovery metadata', async () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('visible_tool'))
    const config = makeConfig()
    const workspace = { getAgentConfig: () => config } as unknown as AdfWorkspace
    const tool = new SysGetConfigTool()
    tool.setToolDiscoveryProvider((ws) => buildToolDiscovery(ws.getAgentConfig(), registry))

    const result = await tool.execute({ section: 'tools' }, workspace)
    const parsed = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(parsed.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'visible_tool', enabled: true, visible: true }),
      expect.objectContaining({ name: 'mcp_docs_search', source: 'mcp:docs' }),
    ]))
  })
})
