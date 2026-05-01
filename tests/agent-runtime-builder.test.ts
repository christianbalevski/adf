import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { PodmanService } from '../src/main/services/podman.service'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../src/main/providers/provider.interface'
import type { LLMResponse } from '../src/shared/types/provider.types'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../src/main/runtime/umbilical-bus'

class ConfigHotReloadProvider implements LLMProvider {
  readonly name = 'config-hot-reload'
  readonly modelId = 'config-hot-reload-v1'
  readonly toolNamesByCall: string[][] = []

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.toolNamesByCall.push((opts.tools ?? []).map(t => t.name).sort())

    if (this.toolNamesByCall.length === 1) {
      return {
        id: 'enable-tool',
        content: [{
          type: 'tool_use',
          id: 'enable-fs-write',
          name: 'sys_update_config',
          input: { path: 'tools.fs_write', value: { name: 'fs_write', enabled: true, visible: true } },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }

    return {
      id: 'done',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

describe('AgentRuntimeBuilder', () => {
  it('reloads enabled tools on the next LLM step after sys_update_config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-hot-reload-'))
    const filePath = join(dir, 'hot-reload-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'hot-reload-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        tools: [
          { name: 'sys_update_config', enabled: true, visible: true },
          { name: 'fs_write', enabled: false, visible: false },
        ],
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const provider = new ConfigHotReloadProvider()
    const llmEvents: Array<Record<string, unknown>> = []
    ensureUmbilicalBus(workspace.getAgentConfig().id).subscribe(event => {
      if (event.event_type === 'llm.completed') llmEvents.push(event.payload)
    })
    const builder = new AgentRuntimeBuilder()
    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    try {
      await agent.executor.executeTurn(createDispatch(
        createEvent({
          type: 'chat',
          source: 'test',
          data: {
            message: {
              seq: 0,
              role: 'user',
              content_json: [{ type: 'text', text: 'enable fs_write' }],
              created_at: Date.now(),
            },
          },
        }),
        { scope: 'agent' },
      ))

      expect(provider.toolNamesByCall).toHaveLength(2)
      expect(provider.toolNamesByCall[0]).not.toContain('fs_write')
      expect(provider.toolNamesByCall[1]).toContain('fs_write')
      expect(workspace.getAgentConfig().tools.find(t => t.name === 'fs_write')?.enabled).toBe(true)
      expect(llmEvents.map(event => event.call_source)).toEqual(['turn', 'turn'])
      expect(llmEvents[0]).toMatchObject({
        provider: 'config-hot-reload',
        model: 'config-hot-reload-v1',
        input_tokens: 10,
        output_tokens: 10,
      })
    } finally {
      agent.dispose()
      clearAllUmbilicalBuses()
    }
  })

  it('builds daemon agents with code and compute tools under plain Node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-'))
    const filePath = join(dir, 'builder-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'builder-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        tools: [
          { name: 'sys_code', enabled: true, visible: true },
          { name: 'compute_exec', enabled: true, visible: true },
        ],
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    const builder = new AgentRuntimeBuilder({
      codeSandboxService: new CodeSandboxService(),
      podmanService: null,
    })

    const agent = await builder.build({
      workspace,
      filePath,
      config,
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
      restoreLoop: true,
    })

    try {
      expect(agent.registry.get('sys_code')).toBeTruthy()
      expect(agent.registry.get('compute_exec')).toBeTruthy()
      expect(agent.registry.get('fs_transfer')).toBeTruthy()

      const updatedTools = workspace.getAgentConfig().tools.map(t => t.name)
      expect(updatedTools).toEqual(expect.arrayContaining(['msg_list', 'msg_read', 'msg_update']))
    } finally {
      agent.dispose()
    }
  })

  it('skips unregistered MCP servers and disables their enabled tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-mcp-'))
    const filePath = join(dir, 'mcp-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'mcp-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        tools: [{ name: 'mcp_ghost_ping', enabled: true, visible: true }],
        mcp: {
          servers: [{
            name: 'ghost',
            transport: 'stdio',
            command: 'node',
            args: ['ghost.js'],
          }],
        },
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({
      settings: { get: () => [] },
    })

    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      expect(workspace.getAgentConfig().tools.find(t => t.name === 'mcp_ghost_ping')?.enabled).toBe(false)
      expect(agent.registry.get('mcp_ghost_ping')).toBeUndefined()
    } finally {
      agent.dispose()
    }
  })

  it('awaits in-flight isolated compute startup before stopping on async dispose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-compute-dispose-'))
    const filePath = join(dir, 'compute-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'compute-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        compute: { enabled: true },
      },
    })
    created.dispose()

    const calls: string[] = []
    let releaseStartup!: () => void
    const startupGate = new Promise<void>(resolve => { releaseStartup = resolve })
    const podmanService = {
      ensureIsolatedRunning: async () => {
        calls.push('start')
        await startupGate
        calls.push('started')
      },
      ensureWorkspace: async () => {
        calls.push('workspace')
      },
      stopIsolated: async () => {
        calls.push('stop')
      },
    } as unknown as PodmanService

    const workspace = AdfWorkspace.open(filePath)
    workspace.setAgentConfig({ ...workspace.getAgentConfig(), compute: { enabled: true } })
    const builder = new AgentRuntimeBuilder({ podmanService })
    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    const dispose = agent.disposeAsync?.()
    expect(dispose).toBeTruthy()
    await Promise.resolve()
    expect(calls).toEqual(['start'])

    releaseStartup()
    await dispose

    expect(calls).toEqual(['start', 'started', 'workspace', 'stop'])
  })

  it('skips unknown channel adapters without failing agent build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-adapter-'))
    const filePath = join(dir, 'adapter-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'adapter-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        adapters: {
          unknown_adapter: {
            enabled: true,
            config: {},
          },
        },
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({
      settings: { get: () => [] },
    })

    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      agent.dispose()
    }
  })

  it('treats built-in channel adapters as registered by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-builtin-adapter-'))
    const filePath = join(dir, 'builtin-adapter-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'builtin-adapter-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        adapters: {
          telegram: {
            enabled: true,
            config: {},
          },
        },
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({
      settings: { get: () => [] },
    })

    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      expect(agent.adapterManager?.getStatus('telegram')).toBe('error')
      expect(agent.adapterManager?.getState('telegram')?.error).toContain('Missing TELEGRAM_BOT_TOKEN')
    } finally {
      agent.dispose()
    }
  })

  it('does not start globally registered adapters unless the agent enables them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-adapter-opt-in-'))
    const filePath = join(dir, 'adapter-opt-in-agent.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'adapter-opt-in-agent',
      provider: new MockLLMProvider(),
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder({
      settings: {
        get: (key: string) => key === 'adapters'
          ? [{ id: 'telegram', type: 'telegram', env: [{ key: 'TELEGRAM_BOT_TOKEN', value: 'fake-token' }] }]
          : undefined,
      },
    })

    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ tokensPerResponse: 120 }),
    })

    try {
      expect(workspace.getAgentConfig().adapters).toEqual({})
      expect(agent.adapterManager).toBeNull()
    } finally {
      agent.dispose()
    }
  })

  it('wires daemon trigger evaluator so inbox messages wake the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-builder-trigger-'))
    const filePath = join(dir, 'trigger-agent.adf')
    const provider = new MockLLMProvider({ tokensPerResponse: 120 })
    const created = createHeadlessAgent({
      filePath,
      name: 'trigger-agent',
      provider,
      createOptions: {
        triggers: {
          on_inbox: {
            enabled: true,
            targets: [{ scope: 'agent' }],
          },
        },
      },
    })
    created.dispose()

    const workspace = AdfWorkspace.open(filePath)
    const builder = new AgentRuntimeBuilder()
    const agent = await builder.build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
      restoreLoop: true,
    })

    try {
      const inboxId = workspace.addToInbox({
        from: 'telegram:123',
        content: 'hello from telegram',
        source: 'telegram',
        received_at: Date.now(),
        status: 'unread',
      })
      agent.triggerEvaluator?.onInbox('telegram:123', 'hello from telegram', {
        source: 'telegram',
        messageId: inboxId,
      })

      await waitFor(() => provider.getCallCount() > 0)
      expect(provider.getCallCount()).toBeGreaterThan(0)
    } finally {
      agent.dispose()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
