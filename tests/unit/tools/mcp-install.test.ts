import { describe, expect, it, vi } from 'vitest'
import { McpInstallTool } from '../../../src/main/tools/built-in/mcp-install.tool'

describe('McpInstallTool', () => {
  it('reports a saved server as failed when immediate discovery cannot connect', async () => {
    const config: any = {
      compute: { enabled: true },
      mcp: { servers: [] },
    }
    const workspace = {
      getAgentConfig: vi.fn(() => config),
      setAgentConfig: vi.fn(),
      setIdentity: vi.fn(),
    }
    const tool = new McpInstallTool(vi.fn().mockRejectedValue(
      new Error('MCP container for "puppeteer" is not ready: container state improper'),
    ))

    const result = await tool.execute({
      package: '@modelcontextprotocol/server-puppeteer',
      type: 'npm',
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content).toEqual(expect.objectContaining({
      success: false,
      configured: true,
      name: 'puppeteer',
      location: 'isolated container',
      tools_discovered: 0,
      error: expect.stringContaining('container state improper'),
    }))
    expect(config.mcp.servers).toHaveLength(1)
  })
})
