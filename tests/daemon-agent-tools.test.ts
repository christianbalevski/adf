import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-tools-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-tools-test', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

describe('GET /agents/:id/tools', () => {
  it('lists built-in, MCP and declared tools with their declared state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-tools-'))
    const filePath = join(dir, 'tools-agent.adf')
    const seeded = createHeadlessAgent({ filePath, name: 'tools-agent', provider: new MockLLMProvider(), createOptions: { handle: 'tools-agent' } })
    const config = seeded.workspace.getAgentConfig()
    config.tools = config.tools.map(t => (t.name === 'fs_delete' ? { ...t, enabled: true, visible: true, restricted: true, locked: true } : t))
    config.tools.push({ name: 'mcp_github_search', enabled: true, visible: false })
    config.mcp = { servers: [{ name: 'github', transport: 'stdio', command: 'npx', args: [], available_tools: [{ name: 'search', description: 'Search issues' }] }] } as unknown as typeof config.mcp
    seeded.workspace.setAgentConfig(config)
    seeded.dispose()

    const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
    const ref = await runtime.loadAgent(filePath)
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const res = await server.inject({ method: 'GET', url: '/agents/tools-agent/tools' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { agentId: string; tools: Array<Record<string, unknown>> }
    expect(body.agentId).toBe(ref.id)
    const byName = new Map(body.tools.map(t => [t.name as string, t]))
    // Built-ins come from main's registry, with descriptions.
    expect(byName.get('fs_read')).toMatchObject({ source: 'builtin', enabled: true })
    expect(String(byName.get('fs_read')?.description).length).toBeGreaterThan(0)
    expect(byName.get('fs_delete')).toMatchObject({ enabled: true, restricted: true, locked: true })
    expect(byName.get('mcp_github_search')).toMatchObject({ source: 'mcp:github', enabled: true, visible: false, description: 'Search issues' })
    // Sorted by name.
    const names = body.tools.map(t => t.name as string)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))

    expect((await server.inject({ method: 'GET', url: '/agents/nope/tools' })).statusCode).toBe(404)
    const spec = (await server.inject({ method: 'GET', url: '/openapi.json' })).json() as { paths: Record<string, unknown> }
    expect(spec.paths['/agents/{id}/tools']).toBeDefined()
    await runtime.unloadAgent(ref.id)
  })
})
