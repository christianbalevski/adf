import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BackgroundAgentManager reaches into electron (safeStorage / app paths); the
// AgentRuntimeBuilder path works fine under the same minimal mock.
vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-mcp-mgmt-test-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-mcp-mgmt-test',
      getVersion: () => '0.0.0-test',
    },
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

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { BackgroundAgentManager } from '../../../src/main/runtime/background-agent-manager'
import { RuntimeGate } from '../../../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import type { SettingsService } from '../../../src/main/services/settings.service'
import type { ToolResult } from '../../../src/shared/types/tool.types'

const MCP_MANAGEMENT_TOOLS = ['mcp_install', 'mcp_restart', 'mcp_uninstall'] as const
const HEADLESS_AUTH_MARKER = 'Interactive MCP authorization is not available for background agents'

function makeSettings(): SettingsService {
  return {
    get: (_key: string) => undefined,
    getProvider: (id: string) => ({
      id: id || 'mock',
      type: 'anthropic',
      name: 'mock-provider',
      apiKey: 'test-key',
    }),
  } as unknown as SettingsService
}

function seedAdf(dir: string, name: string, createOptions: Record<string, unknown> = {}): string {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    // hibernate: no startup LLM turn, so the stub provider is never invoked
    createOptions: { start_in_state: 'hibernate', ...createOptions },
  })
  created.dispose()
  return filePath
}

const managers: BackgroundAgentManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.stopAll() } catch { /* best effort */ }
    manager.dispose()
  }
  RuntimeGate._resetForTests()
  vi.restoreAllMocks()
})

describe('MCP management tool registration (non-foreground runtimes)', () => {
  it('daemon builder registers mcp_install/mcp_restart/mcp_uninstall even with no configured servers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-mgmt-daemon-'))
    // Declare mcp_install enabled+visible but configure NO servers — the exact
    // shape that previously produced a "Tool not available" error headless.
    const filePath = seedAdf(dir, 'daemon-mcp-agent', {
      tools: [{ name: 'mcp_install', enabled: true, visible: true }],
    })

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({ settings: { get: () => [] } })
    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      for (const toolName of MCP_MANAGEMENT_TOOLS) {
        expect(agent.registry.get(toolName), `expected ${toolName} registered`).toBeTruthy()
      }
    } finally {
      await agent.disposeAsync()
    }
  })

  it('daemon builder mcp_install with auth:true fails plainly instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-mgmt-daemon-auth-'))
    const filePath = seedAdf(dir, 'daemon-auth-agent', {
      tools: [{ name: 'mcp_install', enabled: true, visible: true }],
    })

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({ settings: { get: () => [] } })
    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      const tool = agent.registry.get('mcp_install')!
      const result = (await tool.execute(
        { package: '@example/needs-auth', type: 'npm', auth: true },
        workspace,
      )) as ToolResult
      expect(result.isError).toBe(true)
      expect(result.content).toContain(HEADLESS_AUTH_MARKER)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('background manager registers mcp_install/mcp_restart/mcp_uninstall in the agent tool registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-mgmt-bg-'))
    const filePath = seedAdf(dir, 'bg-mcp-agent', {
      tools: [{ name: 'mcp_install', enabled: true, visible: true }],
    })

    const manager = new BackgroundAgentManager(makeSettings(), '', {})
    managers.push(manager)

    const started = await manager.startAgent(filePath)
    expect(started).toBe(true)

    const refs = manager.getAgent(filePath)
    expect(refs).toBeTruthy()
    for (const toolName of MCP_MANAGEMENT_TOOLS) {
      expect(refs!.toolRegistry.get(toolName), `expected ${toolName} registered`).toBeTruthy()
    }
  })

  it('background manager mcp_install with auth:true fails plainly instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-mgmt-bg-auth-'))
    const filePath = seedAdf(dir, 'bg-auth-agent', {
      tools: [{ name: 'mcp_install', enabled: true, visible: true }],
    })

    const manager = new BackgroundAgentManager(makeSettings(), '', {})
    managers.push(manager)
    await manager.startAgent(filePath)

    const refs = manager.getAgent(filePath)!
    const tool = refs.toolRegistry.get('mcp_install')!
    const result = (await tool.execute(
      { package: '@example/needs-auth', type: 'npm', auth: true },
      refs.workspace,
    )) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content).toContain(HEADLESS_AUTH_MARKER)
    // The server is still persisted so foreground auth + mcp_restart can recover.
    expect(refs.workspace.getAgentConfig().mcp?.servers?.some(s => s.name === 'needs_auth')).toBe(true)
  })
})
