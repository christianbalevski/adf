import { describe, expect, it, vi } from 'vitest'
import { McpAvailableTool } from '../../../src/main/tools/built-in/mcp-available.tool'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

function workspaceWith(servers: Array<{ name: string; source?: string }>) {
  return {
    getAgentConfig: vi.fn(() => ({ mcp: { servers } })),
  } as never
}

const REGS: McpServerRegistration[] = [
  { id: '1', name: 'github', type: 'npm', npmPackage: '@x/gh', runLocation: 'shared', description: 'GitHub things' },
  { id: '2', name: 'files', type: 'npm', npmPackage: '@x/fs', runLocation: 'host' }, // host default: invisible
  { id: '3', name: 'drive', type: 'npm', npmPackage: '@x/drive', runLocation: 'host', agentVisible: true, auth: true, lastVerifiedAt: 123 },
  { id: '4', name: 'remote', type: 'http', url: 'https://x.example/mcp' },
]

describe('McpAvailableTool', () => {
  it('lists only agent-visible registrations the agent has not attached', async () => {
    const tool = new McpAvailableTool(() => REGS)
    const result = await tool.execute({}, workspaceWith([]))
    const content = JSON.parse(result.content)

    const names = content.servers.map((s: { name: string }) => s.name)
    expect(names).toEqual(['github', 'drive', 'remote'])
    expect(names).not.toContain('files') // host + untouched toggle = not attachable
    const drive = content.servers.find((s: { name: string }) => s.name === 'drive')
    expect(drive).toEqual(expect.objectContaining({ auth: true, verified: true, location: 'host', package: '@x/drive' }))
    const remote = content.servers.find((s: { name: string }) => s.name === 'remote')
    expect(remote.location).toBe('remote http')
    expect(content.message).toMatch(/attach/)
  })

  it('excludes servers the agent already attached, by name and by source', async () => {
    const tool = new McpAvailableTool(() => REGS)
    const result = await tool.execute({}, workspaceWith([
      { name: 'github' },                          // attached by name
      { name: 'renamed_drive', source: 'npm:@x/drive' }, // attached by source identity
    ]))
    const content = JSON.parse(result.content)
    expect(content.servers.map((s: { name: string }) => s.name)).toEqual(['remote'])
  })

  it('reports plainly when no settings registry is reachable', async () => {
    const tool = new McpAvailableTool()
    const result = await tool.execute({}, workspaceWith([]))
    const content = JSON.parse(result.content)
    expect(content.servers).toEqual([])
    expect(content.message).toMatch(/No Settings registry/)
  })

  it('reports the empty state when everything is attached or hidden', async () => {
    const tool = new McpAvailableTool(() => [REGS[1]])
    const result = await tool.execute({}, workspaceWith([]))
    const content = JSON.parse(result.content)
    expect(content.servers).toEqual([])
    expect(content.message).toMatch(/No unattached/)
  })
})
