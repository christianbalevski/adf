import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { createDispatch, createEvent, type AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
import type { ToolDeclaration } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { SandboxPackagesService } from '../../../src/main/services/sandbox-packages.service'

/**
 * Host tools registered while declared (sys_code, sys_lambda, npm_*) must
 * follow declarations added to or removed from a RUNNING agent. Before, they
 * were registered once at start, so a tool the owner enabled mid-run failed
 * as "not available" until the agent restarted.
 */

class ScriptedProvider implements LLMProvider {
  readonly name = 'hot-reload-provider'
  readonly modelId = 'hot-reload-model'
  readonly calls: CreateMessageOptions[] = []
  constructor(private readonly respond: (call: number) => LLMResponse) {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(options)
    return this.respond(this.calls.length)
  }
  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

const text = (t: string): LLMResponse => ({
  id: `r-${Math.random()}`,
  content: [{ type: 'text', text: t }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
})

const toolUse = (name: string, input: Record<string, unknown>): LLMResponse => ({
  id: `t-${Math.random()}`,
  content: [{ type: 'tool_use', id: `tu-${Math.random()}`, name, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
})

function chat(message: string): AdfEventDispatch {
  return createDispatch(createEvent({
    type: 'chat',
    source: 'hot-reload-test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: message }], created_at: Date.now() } },
  }), { scope: 'agent' })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function startAgent(
  tools: ToolDeclaration[],
  provider: LLMProvider,
  extra: { packages?: string[]; sandbox?: CodeSandboxService } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-hot-reload-'))
  const filePath = join(dir, 'hot.adf')
  createHeadlessAgent({ filePath, name: 'hot', provider, createOptions: { tools } }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  config.tools = tools
  config.recovery = { ...(config.recovery ?? {}), auto_retry: false }
  if (extra.packages) {
    config.code_execution = { ...config.code_execution, packages: extra.packages.map((name) => ({ name, version: '1.0.0' })) }
  }
  workspace.setAgentConfig(config)
  const sandbox = extra.sandbox ?? new CodeSandboxService()
  // Construction only stores the service; nothing here installs anything.
  const sandboxPackagesService = {} as SandboxPackagesService
  const agent = await new AgentRuntimeBuilder({ codeSandboxService: sandbox, sandboxPackagesService }).build({
    workspace, filePath, config, provider,
  })
  cleanups.push(async () => {
    try { await agent.disposeAsync() } catch { /* cleanup */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { agent, workspace, filePath, config }
}

describe('declared host tools on a running agent', () => {
  it('registers a tool declared mid-run, so the next call runs it', async () => {
    const provider = new ScriptedProvider((call) =>
      call === 1 ? toolUse('sys_code', { code: 'return 6 * 7' }) : text('done'))
    const { agent, workspace } = await startAgent([], provider)
    expect(agent.registry.get('sys_code')).toBeUndefined()

    const updated = workspace.getAgentConfig()
    updated.tools = [{ name: 'sys_code', enabled: true, visible: true }]
    workspace.setAgentConfig(updated)
    agent.applyConfigChange(updated)
    expect(agent.registry.get('sys_code')).toBeDefined()

    await agent.dispatch(chat('compute'))
    await waitFor(() => provider.calls.length === 2)
    const loop = JSON.stringify(workspace.getLoop())
    expect(loop).not.toContain('not available')
    expect(loop).not.toContain('not enabled')
    expect(loop).toContain('42')
  })

  it('drops the tool when its declaration is removed mid-run', async () => {
    const { agent, workspace } = await startAgent(
      [{ name: 'sys_code', enabled: true, visible: true }],
      new ScriptedProvider(() => text('ok')),
    )
    expect(agent.registry.get('sys_code')).toBeDefined()

    const updated = workspace.getAgentConfig()
    updated.tools = []
    workspace.setAgentConfig(updated)
    agent.applyConfigChange(updated)
    expect(agent.registry.get('sys_code')).toBeUndefined()
  })
})

describe('npm tools and packages on daemon agents', () => {
  it('registers npm_install when it is declared mid-run', async () => {
    const { agent, workspace } = await startAgent([], new ScriptedProvider(() => text('ok')))
    expect(agent.registry.get('npm_install')).toBeUndefined()

    const updated = workspace.getAgentConfig()
    updated.tools = [{ name: 'npm_install', enabled: true, visible: true }]
    workspace.setAgentConfig(updated)
    agent.applyConfigChange(updated)
    expect(agent.registry.get('npm_install')).toBeDefined()
  })

  it("exposes an agent's packages to its own sandboxes only, until it is disposed", async () => {
    const sandbox = new CodeSandboxService()
    const { agent, filePath, config } = await startAgent([], new ScriptedProvider(() => text('ok')), {
      packages: ['vega-lite'],
      sandbox,
    })
    expect(sandbox.getUserPackageModules(filePath)).toContain('vega-lite')
    expect(sandbox.getUserPackageModules(config.id)).toContain('vega-lite')
    expect(sandbox.getUserPackageModules('/some/other.adf')).not.toContain('vega-lite')

    await agent.disposeAsync()
    expect(sandbox.getUserPackageModules(filePath)).not.toContain('vega-lite')
  })
})

describe('ToolRegistry.provideDeclared', () => {
  const fake = (name: string): Tool => ({ name, description: name } as unknown as Tool)

  it('registers only while declared, enabled or not, and keeps one instance', () => {
    const registry = new ToolRegistry()
    let built = 0
    registry.provideDeclared('npm_install', () => { built++; return fake('npm_install') }, [])
    expect(registry.get('npm_install')).toBeUndefined()

    registry.syncDeclared([{ name: 'npm_install', enabled: false, visible: true }])
    const first = registry.get('npm_install')
    expect(first).toBeDefined()
    registry.syncDeclared([{ name: 'npm_install', enabled: true, visible: true }])
    expect(registry.get('npm_install')).toBe(first)
    expect(built).toBe(1)

    registry.syncDeclared([])
    expect(registry.get('npm_install')).toBeUndefined()
  })

  it('leaves tools it was not given a factory for alone', () => {
    const registry = new ToolRegistry()
    registry.register(fake('fs_read'))
    registry.syncDeclared([])
    expect(registry.get('fs_read')).toBeDefined()
  })
})
