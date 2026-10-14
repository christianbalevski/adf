/**
 * W1-A: RuntimeService hooks for Studio parity (design daemon-backend.md §6,
 * §6.1 rows 3, 4, 17, 18, 19; tracker W1-A). One describe per deliverable.
 */
import { copyFileSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(process.env.ADF_USER_DATA_DIR ?? '.', 'electron')
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-runtime-parity-hooks', getVersion: () => '0.0.0-test' },
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

import {
  DUPLICATE_AGENT_ID_CODE,
  RuntimeLoopError,
  RuntimeReviewRequiredError,
  RuntimeService,
  type RuntimeAgentFileRenamedEvent,
  type RuntimeAgentPathChangedEvent,
  type RuntimeLifecycleEvent,
  type RuntimeProviderFactory,
  type RuntimeServiceOptions,
} from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder, type BuildAgentRuntimeOptions } from '../src/main/runtime/agent-runtime-builder'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { AgentLeaseRegistry, agentLeasedMessage, canonicalLeasePath, leaseKeyForCanonicalPath } from '../src/main/runtime/agent-lease'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { subscribeAgentRuntimeSignals } from '../src/main/runtime/agent-runtime-signals'
import { McpClientManager } from '../src/main/services/mcp-client-manager'
import { ChannelAdapterManager } from '../src/main/services/channel-adapter-manager'
import { applySettingLive } from '../src/main/daemon/live-setting'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'
import type { AgentConfig, McpServerConfig, McpToolInfo } from '../src/shared/types/adf-v02.types'
import type { LLMProvider } from '../src/main/providers/provider.interface'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  vi.restoreAllMocks()
  RuntimeGate._resetForTests()
})

/** Temp dirs live in the suite's user-data dir, which the test setup removes. */
function tempDir(): string {
  return realpathSync.native(mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'w1a-')))
}

function seedAgent(dir: string, name: string, patch: Partial<AgentConfig> = {}): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const config = created.workspace.getAgentConfig()
  if (Object.keys(patch).length) created.workspace.setAgentConfig({ ...config, ...patch })
  created.dispose()
  return { filePath: realpathSync.native(filePath), agentId: config.id }
}

function runtimeWith(opts: RuntimeServiceOptions = {}): RuntimeService {
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider(), ...opts })
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }) })
  return runtime
}

/** Every lifecycle event and every raw agent event, in one ordered list. */
function record(runtime: RuntimeService): Array<{ kind: 'lifecycle'; event: RuntimeLifecycleEvent } | { kind: 'agent'; type: string; payload: unknown }> {
  const seen: Array<{ kind: 'lifecycle'; event: RuntimeLifecycleEvent } | { kind: 'agent'; type: string; payload: unknown }> = []
  runtime.on('agent-lifecycle', (event) => seen.push({ kind: 'lifecycle', event }))
  runtime.on('agent-event', ({ event }) => seen.push({ kind: 'agent', type: event.type, payload: event.payload }))
  return seen
}

function lifecycleTypes(seen: ReturnType<typeof record>): string[] {
  return seen.filter((s) => s.kind === 'lifecycle').map((s) => (s as { event: RuntimeLifecycleEvent }).event.type)
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function chat(text: string) {
  return createDispatch(
    createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }),
    { scope: 'agent' },
  )
}

describe('agent-lifecycle events', () => {
  it('load: agent_starting → agent_started before any executor event of the startup turn; unload: agent_stopping → agent_stopped', async () => {
    const { filePath, agentId } = seedAgent(tempDir(), 'agent-1')
    const runtime = runtimeWith({ agentRuntimeBuilder: new AgentRuntimeBuilder() })
    const seen = record(runtime)

    const ref = await runtime.loadAgent(filePath)
    await runtime.startAgent(ref.id)
    await waitFor(() => seen.some((s) => s.kind === 'agent' && s.type === 'turn_complete'))
    await runtime.unloadAgent(ref.id)

    const started = seen.findIndex((s) => s.kind === 'lifecycle' && s.event.type === 'agent_started')
    const firstExecutor = seen.findIndex((s) => s.kind === 'agent')
    expect(started).toBeGreaterThanOrEqual(0)
    expect(firstExecutor).toBeGreaterThan(started)
    expect(seen[0]).toMatchObject({ kind: 'lifecycle', event: { type: 'agent_starting', agentId: null, filePath, payload: { filePath } } })
    expect(seen[started]).toMatchObject({
      kind: 'lifecycle',
      event: { type: 'agent_started', agentId, filePath, payload: { filePath, state: 'active', handle: 'agent-1' } },
    })
    const startStop = new Set(['agent_starting', 'agent_started', 'agent_stopping', 'agent_stopped'])
    expect(lifecycleTypes(seen).filter((t) => startStop.has(t))).toEqual([
      'agent_starting', 'agent_started', 'agent_stopping', 'agent_stopped',
    ])
    // Display state through the background mapping. The host detaches before
    // the unload's dispose (as BAM's stop), so agent_stopped says the rest.
    const states = seen.filter((s) => s.kind === 'lifecycle' && s.event.type === 'agent_state_changed')
      .map((s) => (s as { event: RuntimeLifecycleEvent }).event.payload.state)
    expect(states).toEqual(['active', 'idle'])
  })

  it('concurrent loads of one file share one build and one starting/started pair', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const builder = new AgentRuntimeBuilder()
    const build = vi.spyOn(builder, 'build')
    const runtime = runtimeWith({ agentRuntimeBuilder: builder })
    const seen = record(runtime)
    // A listener that loads the same file from inside agent_starting joins the load.
    const nested: Array<Promise<unknown>> = []
    runtime.on('agent-lifecycle', (event) => { if (event.type === 'agent_starting') nested.push(runtime.loadAgent(filePath)) })

    const [a, b] = await Promise.all([runtime.loadAgent(filePath), runtime.loadAgent(filePath)])
    await Promise.all(nested)
    expect(a.id).toBe(b.id)
    expect(build).toHaveBeenCalledTimes(1)
    expect(lifecycleTypes(seen)).toEqual(['agent_starting', 'agent_started'])
  })

  it('a failed load ends in agent_start_failed with the error and its code', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const runtime = runtimeWith({ providerFactory: () => { throw new Error('no provider here') } })
    const seen = record(runtime)
    await expect(runtime.loadAgent(filePath)).rejects.toThrow('no provider here')
    expect(seen.map((s) => (s as { event: RuntimeLifecycleEvent }).event)).toMatchObject([
      { type: 'agent_starting', filePath },
      { type: 'agent_start_failed', filePath, payload: { filePath, error: 'no provider here' } },
    ])
  })

  it('trigger events go out as agent events; trigger errors and startup failures as lifecycle events', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const runtime = runtimeWith()
    const seen = record(runtime)
    const ref = await runtime.loadAgent(filePath)
    const agent = runtime.getLoadedAgent(ref.id)!.agent

    agent.triggerEvaluator.emit('event', { type: 'trigger_message', payload: { text: 'timer fired' }, timestamp: 1 })
    expect(seen.at(-1)).toEqual({ kind: 'agent', type: 'trigger_message', payload: { text: 'timer fired' } })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(agent.executor, 'executeTurn').mockRejectedValueOnce(new Error('turn exploded'))
    const before = seen.length
    agent.triggerEvaluator.emit('trigger', chat('wake up'))
    await waitFor(() => seen.some((s) => s.kind === 'lifecycle' && s.event.type === 'trigger_error'))
    // Studio's two hosts: an `error` AGENT_EVENT (foreground), display state `error` (background).
    expect(seen.slice(before).map((s) => (s.kind === 'agent' ? `agent:${s.type}` : `${s.event.type}:${String(s.event.payload.state ?? '')}`))).toEqual([
      'agent:error', 'agent_state_changed:error', 'trigger_error:',
    ])
    expect(seen.slice(before)[0]).toMatchObject({ kind: 'agent', type: 'error', payload: { error: 'turn exploded' } })
    expect(seen.find((s) => s.kind === 'lifecycle' && s.event.type === 'trigger_error')).toMatchObject({
      event: { agentId: ref.id, payload: { filePath, error: 'turn exploded', eventType: 'chat' } },
    })
    expect(JSON.stringify(agent.workspace.getLogs(20))).toContain('trigger_error')

    let rejectStartup!: (err: Error) => void
    vi.spyOn(agent, 'dispatchStartup').mockReturnValueOnce(new Promise((_resolve, reject) => { rejectStartup = reject }))
    expect(await runtime.startAgent(ref.id)).toBe(true)
    rejectStartup(new Error('startup exploded'))
    await waitFor(() => seen.some((s) => s.kind === 'lifecycle' && s.event.type === 'startup_failed'))
    expect(seen.find((s) => s.kind === 'lifecycle' && s.event.type === 'startup_failed')).toMatchObject({
      event: { agentId: ref.id, payload: { filePath, error: 'startup exploded' } },
    })
  })
})

describe('agent off', () => {
  it('an agent that switches itself off is stopped and unloaded (Studio handleAgentOff)', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const runtime = runtimeWith({ agentRuntimeBuilder: new AgentRuntimeBuilder() })
    const seen = record(runtime)
    const unloaded: string[] = []
    runtime.on('agent-unloaded', ({ agentId }) => unloaded.push(agentId))
    const ref = await runtime.loadAgent(filePath)

    // The same executor transition the agent's own state tool performs.
    runtime.getLoadedAgent(ref.id)!.agent.executor.applyDeferredStateTransition('off')
    await waitFor(() => unloaded.length === 1)

    expect(unloaded).toEqual([ref.id])
    expect(runtime.getAgent(ref.id)).toBeUndefined()
    // The off itself reaches clients before the teardown.
    const offEvent = seen.findIndex((s) => s.kind === 'agent' && s.type === 'state_changed' && (s.payload as { state: string }).state === 'off')
    const stopping = seen.findIndex((s) => s.kind === 'lifecycle' && s.event.type === 'agent_stopping')
    expect(offEvent).toBeGreaterThanOrEqual(0)
    expect(stopping).toBeGreaterThan(offEvent)
    expect(lifecycleTypes(seen).slice(-2)).toEqual(['agent_stopping', 'agent_stopped'])
    expect(lifecycleTypes(seen).filter((t) => t === 'agent_stopped')).toHaveLength(1)
    // The file is free again: it loads.
    const again = await runtime.loadAgent(filePath)
    expect(again.id).toBe(ref.id)
  })
})

describe('409 duplicate_agent_id', () => {
  it('refuses a second file with a loaded agent\'s id, naming both paths, before building it', async () => {
    const dir = tempDir()
    const one = seedAgent(dir, 'agent-1')
    const twoPath = join(dir, 'agent-2.adf')
    copyFileSync(one.filePath, twoPath)
    const builder = new AgentRuntimeBuilder()
    const build = vi.spyOn(builder, 'build')
    const leases = new AgentLeaseRegistry({ dir: tempDir(), kind: 'daemon' })
    cleanups.push(() => leases.close())
    const runtime = runtimeWith({ agentRuntimeBuilder: builder, agentLeases: leases })
    const seen = record(runtime)

    await runtime.loadAgent(one.filePath)
    const err = await runtime.loadAgent(twoPath).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(RuntimeLoopError)
    expect(err).toMatchObject({
      statusCode: 409,
      code: DUPLICATE_AGENT_ID_CODE,
      details: { agentId: one.agentId, filePath: realpathSync.native(twoPath), loadedFilePath: one.filePath },
    })
    expect((err as Error).message).toContain(one.filePath)
    expect((err as Error).message).toContain(realpathSync.native(twoPath))
    expect((err as Error).message).toContain('POST /files/clone')
    expect(build).toHaveBeenCalledTimes(1)
    expect(runtime.listAgents().map((a) => a.filePath)).toEqual([one.filePath])
    expect(await leases.isHeld(twoPath)).toBe(false)
    expect(seen.at(-1)).toMatchObject({ event: { type: 'agent_start_failed', agentId: one.agentId, payload: { code: DUPLICATE_AGENT_ID_CODE } } })
  })
})

describe('config.name follows the file name on load', () => {
  it('renames the agent to its file name, in the running config and the file', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1', { name: 'stale-name' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith()
    const seen = record(runtime)
    const ref = await runtime.loadAgent(filePath)
    expect(ref.config.name).toBe('agent-1')
    const workspace = runtime.getLoadedAgent(ref.id)!.workspace
    expect(workspace.getAgentConfig().name).toBe('agent-1')
    // Not silent: an adf_logs row and the agent_started payload say so.
    expect(workspace.getLogs(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'name_from_file', message: 'Agent name "stale-name" changed to "agent-1" to match its file name' }),
    ]))
    expect(seen.find((s) => s.kind === 'lifecycle' && s.event.type === 'agent_started')).toMatchObject({
      event: { payload: { nameChangedFrom: 'stale-name' } },
    })
  })

  it("a sys_create_adf child ('My Helper' in My_Helper.adf) takes the file name, as Studio's FILE_OPEN and background start do", async () => {
    // sys_create_adf writes `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.adf` and keeps the name inside.
    const dir = tempDir()
    const filePath = join(dir, 'My_Helper.adf')
    const created = createHeadlessAgent({ filePath, name: 'My Helper', provider: new MockLLMProvider() })
    expect(created.workspace.getAgentConfig().name).toBe('My Helper')
    created.dispose()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith()
    const ref = await runtime.loadAgent(realpathSync.native(filePath))
    expect(ref.config.name).toBe('My_Helper')
    // No rename back: the name now matches the file.
    expect(runtime.getPendingRename(filePath)).toBeUndefined()
  })
})

describe('preflightProvider', () => {
  const anthropic: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: '' }

  function providerWith(valid: boolean): LLMProvider {
    const provider = new MockLLMProvider()
    provider.validateConfig = async () => (valid ? { valid: true } : { valid: false, error: 'HTTP 401 from the provider' })
    return provider
  }

  it('returns Studio\'s AGENT_START codes for a file that is not loaded', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1', { model: { provider: 'anthropic', model_id: 'claude-x' } as AgentConfig['model'] })
    let providers: ProviderConfig[] = []
    let valid = false
    const factory: RuntimeProviderFactory = (config) => {
      if (!providers.some((p) => p.id === config.model.provider)) throw new Error(`Provider "${config.model.provider}" is not configured`)
      return providerWith(valid)
    }
    const runtime = runtimeWith({ providerFactory: factory, settings: { get: (k) => (k === 'providers' ? providers : undefined) } })

    expect(await runtime.preflightProvider(filePath)).toEqual({ ok: false, code: 'provider_missing', error: 'Provider "anthropic" is not configured' })
    providers = [anthropic]
    expect(await runtime.preflightProvider(filePath)).toEqual({ ok: false, code: 'provider_unconfigured', error: 'HTTP 401 from the provider' })
    providers = [{ ...anthropic, apiKey: 'sk-test' }]
    expect(await runtime.preflightProvider(filePath)).toEqual({ ok: false, error: 'HTTP 401 from the provider' })
    valid = true
    expect(await runtime.preflightProvider(filePath)).toEqual({ ok: true })
    // Nothing was loaded by the check.
    expect(runtime.listAgents()).toEqual([])
  })

  it("a locked key of the agent's own provider is never reported as a missing key, and nothing is called", async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1', {
      model: { provider: 'custom:own', model_id: 'm-1' } as AgentConfig['model'],
      providers: [{ id: 'custom:own', type: 'openai', name: 'Own', baseUrl: 'https://own.example/v1' }] as AgentConfig['providers'],
    })
    const workspace = AdfWorkspace.open(filePath)
    workspace.setIdentity('provider:custom:own:apiKey', 'sk-own')
    workspace.setPassword('pw')
    workspace.close()
    const validate = vi.fn(async () => ({ valid: false, error: 'HTTP 401 from the provider' }))
    const factory = vi.fn<RuntimeProviderFactory>(() => { const p = new MockLLMProvider(); p.validateConfig = validate; return p })
    const runtime = runtimeWith({ providerFactory: factory, settings: { get: () => undefined } })

    const result = await runtime.preflightProvider(filePath)

    expect(result).toEqual({ ok: true, credentialsLocked: expect.stringContaining("is locked with the agent's file password, so no request was sent") })
    expect(factory).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('applies the review gate first: an unreviewed file is refused (403) before its provider is called', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const factory = vi.fn<RuntimeProviderFactory>(() => new MockLLMProvider())
    const runtime = runtimeWith({ enforceReviewGate: true, providerFactory: factory, settings: { get: () => undefined } })
    await expect(runtime.preflightProvider(filePath)).rejects.toBeInstanceOf(RuntimeReviewRequiredError)
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('prompt settings are read at each start', () => {
  it('a changed globalSystemPrompt / toolPrompts / compactionPrompt reaches the next start', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const values: Record<string, unknown> = { globalSystemPrompt: 'prompt v1', toolPrompts: { fs_read: 'v1' }, compactionPrompt: 'compact v1' }
    const builder = new AgentRuntimeBuilder()
    const build = vi.spyOn(builder, 'build')
    const runtime = runtimeWith({ agentRuntimeBuilder: builder, basePrompt: 'boot prompt', settings: { get: (k) => values[k] } })

    const ref = await runtime.loadAgent(filePath)
    await runtime.unloadAgent(ref.id)
    Object.assign(values, { globalSystemPrompt: 'prompt v2', toolPrompts: { fs_read: 'v2' }, compactionPrompt: 'compact v2' })
    await runtime.loadAgent(filePath)

    const prompts = build.mock.calls.map(([opts]) => (opts as BuildAgentRuntimeOptions).prompts)
    expect(prompts).toEqual([
      { basePrompt: 'prompt v1', toolPrompts: { fs_read: 'v1' }, compactionPrompt: 'compact v1' },
      { basePrompt: 'prompt v2', toolPrompts: { fs_read: 'v2' }, compactionPrompt: 'compact v2' },
    ])
  })

  it('falls back to the constructor prompts while the store has no value', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const builder = new AgentRuntimeBuilder()
    const build = vi.spyOn(builder, 'build')
    const runtime = runtimeWith({ agentRuntimeBuilder: builder, basePrompt: 'boot prompt', toolPrompts: { a: 'b' }, settings: { get: () => undefined } })
    await runtime.loadAgent(filePath)
    expect((build.mock.calls[0][0] as BuildAgentRuntimeOptions).prompts).toEqual({ basePrompt: 'boot prompt', toolPrompts: { a: 'b' }, compactionPrompt: undefined })
  })
})

describe('derived key (password-protected agent)', () => {
  const PING_TOOL: McpToolInfo = { name: 'ping', description: 'ping', input_schema: { type: 'object', properties: {} } }
  const server: McpServerConfig = { name: 'srv', transport: 'stdio', command: 'node', args: ['srv.js'], source: 'custom', env_keys: ['API_KEY'] }

  function seedLockedAgent(): { filePath: string; key: Buffer } {
    const { filePath } = seedAgent(tempDir(), 'agent-1', {
      mcp: { servers: [server] },
      adapters: { telegram: { enabled: true, config: {} } } as AgentConfig['adapters'],
    })
    const workspace = AdfWorkspace.open(filePath)
    workspace.setIdentity('mcp:srv:API_KEY', 'mcp-secret')
    workspace.setIdentity('adapter:telegram:TELEGRAM_BOT_TOKEN', 'bot-secret')
    workspace.setIdentity('app:token', 'code-secret', true)
    const key = workspace.setPassword('pw')
    workspace.close()
    return { filePath, key }
  }

  function fakeConsumers() {
    const mcpEnvs: Array<Record<string, string> | undefined> = []
    vi.spyOn(McpClientManager.prototype, 'connect').mockImplementation(async (cfg: McpServerConfig) => {
      mcpEnvs.push(cfg.env)
      return [PING_TOOL]
    })
    const adapterKeys: Array<Buffer | null | undefined> = []
    vi.spyOn(ChannelAdapterManager.prototype, 'startAdapter').mockImplementation(async (_type, _fn, _cfg, _ws, key) => {
      adapterKeys.push(key)
      return true
    })
    vi.spyOn(ChannelAdapterManager.prototype, 'stopAdapter').mockResolvedValue()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return { mcpEnvs, adapterKeys }
  }

  it('an unlock reaches the provider, model_invoke, MCP, adapters, AdfCallHandler and the mesh', async () => {
    const { mcpEnvs, adapterKeys } = fakeConsumers()
    const { filePath, key } = seedLockedAgent()
    const contexts: Array<Buffer | null> = []
    // A code sandbox makes the builder create the AdfCallHandler.
    const sandbox = new CodeSandboxService()
    cleanups.push(() => sandbox.destroyAll())
    const builder = new AgentRuntimeBuilder({ settings: { get: () => undefined }, codeSandboxService: sandbox })
    const build = vi.spyOn(builder, 'build')
    const runtime = runtimeWith({
      agentRuntimeBuilder: builder,
      providerFactory: (_config, _path, context) => { contexts.push(context?.derivedKey ?? null); return new MockLLMProvider() },
    })
    const ref = await runtime.loadAgent(filePath)
    const loaded = runtime.getLoadedAgent(ref.id)!
    const meshKeys: Array<Buffer | null> = []
    const unsubscribe = subscribeAgentRuntimeSignals(loaded.workspace, { onDerivedKeyChanged: (k) => meshKeys.push(k) })
    cleanups.push(unsubscribe)
    const resolveIdentity = (loaded.agent.adfCallHandler as unknown as { resolveIdentity: (p: string) => string | null }).resolveIdentity
    expect(loaded.derivedKey).toBeNull()
    expect(mcpEnvs[0]?.API_KEY).toBeUndefined()
    expect(resolveIdentity('app:token')).toBeNull()
    expect(contexts).toEqual([null])

    runtime.unlockAgentIdentityPassword(ref.id, 'pw')

    await waitFor(() => mcpEnvs.length === 2 && adapterKeys.length === 2)
    expect(runtime.getLoadedAgent(ref.id)!.derivedKey?.equals(key)).toBe(true)
    expect(mcpEnvs[1]?.API_KEY).toBe('mcp-secret')
    expect(adapterKeys[1]?.equals(key)).toBe(true)
    expect(resolveIdentity('app:token')).toBe('code-secret')
    expect(meshKeys.map((k) => k?.equals(key))).toEqual([true])
    await waitFor(() => contexts.length === 2)
    expect(contexts[1]?.equals(key)).toBe(true) // provider rebuilt with the key
    // model_invoke providers are built with the key held now.
    const createProviderForModel = (build.mock.calls[0][0] as BuildAgentRuntimeOptions).createProviderForModel!
    createProviderForModel({ provider: 'mock', model_id: 'other' } as AgentConfig['model'])
    expect(contexts.at(-1)?.equals(key)).toBe(true)

    // The running telegram adapter holds the key in its context: removing
    // the password restarts it without the key.
    vi.spyOn(ChannelAdapterManager.prototype, 'getStates').mockReturnValue([{ type: 'telegram', status: 'connected' } as never])
    const stops = vi.mocked(ChannelAdapterManager.prototype.stopAdapter)
    stops.mockClear()
    runtime.removeAgentIdentityPassword(ref.id)
    await waitFor(() => meshKeys.length === 2 && adapterKeys.length === 3)
    expect(meshKeys[1]).toBeNull()
    expect(runtime.getLoadedAgent(ref.id)!.derivedKey).toBeNull()
    expect(stops).toHaveBeenCalledWith('telegram')
    expect(adapterKeys[2]).toBeNull()
    expect(JSON.stringify(loaded.workspace.getLogs(50))).toContain('keystore_key_dropped')
  })

  it('a key held before the start reaches every consumer from the first connect', async () => {
    const { mcpEnvs, adapterKeys } = fakeConsumers()
    const { filePath, key } = seedLockedAgent()
    const contexts: Array<Buffer | null> = []
    const runtime = runtimeWith({
      agentRuntimeBuilder: new AgentRuntimeBuilder({ settings: { get: () => undefined } }),
      providerFactory: (_config, _path, context) => { contexts.push(context?.derivedKey ?? null); return new MockLLMProvider() },
    })
    const ref = await runtime.loadAgent(filePath, { derivedKey: key })
    expect(contexts[0]?.equals(key)).toBe(true)
    expect(mcpEnvs[0]?.API_KEY).toBe('mcp-secret')
    expect(adapterKeys[0]?.equals(key)).toBe(true)
    expect(runtime.getLoadedAgent(ref.id)!.derivedKey?.equals(key)).toBe(true)
  })
})

describe('rekeyAgentPath', () => {
  it('moves the path indexes and the lease to the new path and keeps the agent running', async () => {
    const dir = tempDir()
    const { filePath } = seedAgent(dir, 'agent-1')
    const leases = new AgentLeaseRegistry({ dir: tempDir(), kind: 'daemon' })
    cleanups.push(() => leases.close())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith({ agentLeases: leases })
    const moved: RuntimeAgentPathChangedEvent[] = []
    runtime.on('agent-path-changed', (e) => moved.push(e))
    const ref = await runtime.loadAgent(filePath)
    // Stands in for the file at its new place (an open SQLite file cannot move on Windows).
    const newPath = join(dir, 'agent-1-moved.adf')
    writeFileSync(newPath, '')

    const result = await runtime.rekeyAgentPath(filePath, newPath)

    const canonicalNew = realpathSync.native(newPath)
    expect(result).toMatchObject({ id: ref.id, filePath: canonicalNew })
    expect(runtime.getAgent(ref.id)?.filePath).toBe(canonicalNew)
    expect(await leases.isHeld(canonicalNew)).toBe(true)
    expect(await leases.isHeld(filePath)).toBe(false)
    expect(moved).toEqual([{ agentId: ref.id, oldFilePath: filePath, filePath: canonicalNew }])
    expect(await runtime.rekeyAgentPath(join(dir, 'not-loaded.adf'), newPath)).toBeNull()
  })
})

describe('the file follows the agent name (syncAgentFileToName)', () => {
  it('defers the rename of a loaded agent until it unloads, then renames file and config', async () => {
    const dir = tempDir()
    const { filePath } = seedAgent(dir, 'agent-1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith()
    const renamed: RuntimeAgentFileRenamedEvent[] = []
    runtime.on('agent-file-renamed', (e) => renamed.push(e))
    const ref = await runtime.loadAgent(filePath)

    await runtime.setAgentConfig(ref.id, { ...runtime.getAgent(ref.id)!.config, name: 'agent-2' })
    expect(runtime.getPendingRename(filePath)).toBe('agent-2')
    expect(existsSync(filePath)).toBe(true)

    await runtime.unloadAgent(ref.id)
    const newPath = join(dir, 'agent-2.adf')
    expect(renamed).toEqual([{ agentId: ref.id, oldFilePath: filePath, filePath: newPath }])
    expect(existsSync(filePath)).toBe(false)
    const workspace = AdfWorkspace.open(newPath)
    expect(workspace.getAgentConfig().name).toBe('agent-2')
    workspace.close()
  })

  it('renames a file that is not loaded at once and refuses an existing target', () => {
    const dir = tempDir()
    const { filePath } = seedAgent(dir, 'agent-1')
    seedAgent(dir, 'agent-3')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith()
    expect(runtime.syncAgentFileToName(filePath, 'agent-3')).toEqual({ error: 'A file named "agent-3.adf" already exists.' })
    expect(runtime.syncAgentFileToName(filePath, 'agent-2')).toEqual({ filePath: join(dir, 'agent-2.adf') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(runtime.syncAgentFileToName(join(dir, 'agent-2.adf'), 'bad/name').error).toMatch(/not a valid file name/)
  })
})

describe('sandboxMaxWorkers applies live', () => {
  it('applySettingLive applies at once and again on each change', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const values: Record<string, unknown> = { sandboxMaxWorkers: 4 }
    const applied: Array<[unknown, boolean]> = []
    const stop = applySettingLive({ get: (k) => values[k] }, 'sandboxMaxWorkers', (v, initial) => applied.push([v, initial]), { intervalMs: 100 })
    cleanups.push(stop)
    vi.advanceTimersByTime(300)
    expect(applied).toEqual([[4, true]])
    values.sandboxMaxWorkers = 8
    vi.advanceTimersByTime(100)
    values.sandboxMaxWorkers = undefined
    vi.advanceTimersByTime(100)
    expect(applied).toEqual([[4, true], [8, false], [undefined, false]])
    stop()
    values.sandboxMaxWorkers = 2
    vi.advanceTimersByTime(500)
    expect(applied).toHaveLength(3)
  })
})

describe('agent_leased for a holder that recorded no endpoint', () => {
  it('names the lease file and the manual remedy', async () => {
    const work = tempDir()
    const leaseDirPath = tempDir()
    const { filePath } = seedAgent(work, 'agent-1')
    const canonical = await canonicalLeasePath(filePath)
    const leaseFile = join(leaseDirPath, `${leaseKeyForCanonicalPath(canonical)}.json`)
    // A live pid (this one) under another runtime id, with no endpoint: it
    // could be the holder, or a program that reused the pid.
    writeFileSync(leaseFile, JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'studio-embedded', pid: process.pid, runtimeId: '0123456789abcdef', hostname: 'h', settingsPath: 's', startedAt: 1, version: null, endpoint: null },
    }))
    const leases = new AgentLeaseRegistry({ dir: leaseDirPath, kind: 'daemon', settingsPath: 's' })
    cleanups.push(() => leases.close())

    const result = await leases.acquire(filePath)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toBe(
      `agent-1 is already running in another ADF Studio (pid ${process.pid}). Stop the agent there or quit that Studio, then start it here. ` +
      `ADF cannot confirm that pid ${process.pid} is still that process: it recorded no endpoint to check. ` +
      `If no ADF Studio or daemon runs agent-1, delete the lease file ${leaseFile} and start it again.`,
    )
  })

  it('a daemon whose control URL does not answer is not told to delete the lease (it may be busy)', async () => {
    const work = tempDir()
    const leaseDirPath = tempDir()
    const { filePath } = seedAgent(work, 'agent-1')
    const canonical = await canonicalLeasePath(filePath)
    const leaseFile = join(leaseDirPath, `${leaseKeyForCanonicalPath(canonical)}.json`)
    // No endpoint, a control URL nothing listens on: unanswered, not unconfirmed.
    writeFileSync(leaseFile, JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'daemon', pid: process.pid, runtimeId: '0123456789abcdef', hostname: 'h', settingsPath: 's', startedAt: 1, version: null, endpoint: null, controlUrl: 'http://127.0.0.1:1' },
    }))
    const leases = new AgentLeaseRegistry({ dir: leaseDirPath, kind: 'daemon', settingsPath: 's' })
    cleanups.push(() => leases.close())

    const result = await leases.acquire(filePath)

    expect(result.ok).toBe(false)
    const message = result.ok === false ? result.message : ''
    expect(message).toBe(
      `agent-1 is already running in the ADF daemon (pid ${process.pid}, http://127.0.0.1:1). ` +
      'Stop it there with "adf --url http://127.0.0.1:1 stop agent-1", or stop that daemon with "adf daemon stop", then start it here. ' +
      'ADF could not confirm it: http://127.0.0.1:1 did not answer the check, which a busy daemon also does. ' +
      'Wait a moment and try again; "adf daemon status" shows whether that daemon runs.',
    )
    expect(message).not.toContain('delete')
  })

  it('an embedded Studio holder with an endpoint ADF cannot check gets no remedy text', () => {
    const record = {
      v: 1 as const, path: 'C:\\agents\\agent-1.adf', agentId: null, acquiredAt: 1,
      holder: { kind: 'studio-embedded' as const, pid: 77, runtimeId: 'r', hostname: 'h', settingsPath: 's', startedAt: 1, version: null, endpoint: 'elsewhere' },
    }
    expect(agentLeasedMessage(record, 's', false, {})).toBe('agent-1 is already running in another ADF Studio (pid 77). Stop the agent there or quit that Studio, then start it here.')
  })

  it('leaves the sentence alone when the holder was confirmed', () => {
    const record = {
      v: 1 as const, path: 'C:\\agents\\agent-1.adf', agentId: null, acquiredAt: 1,
      holder: { kind: 'studio-embedded' as const, pid: 77, runtimeId: 'r', hostname: 'h', settingsPath: 's', startedAt: 1, version: null, endpoint: null },
    }
    expect(agentLeasedMessage(record, 's')).toBe('agent-1 is already running in another ADF Studio (pid 77). Stop the agent there or quit that Studio, then start it here.')
  })
})

describe('unload robustness', () => {
  it('a failed teardown still unloads: maps cleared, lease released, agent_stopped carries the error, the file loads again', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const leases = new AgentLeaseRegistry({ dir: tempDir(), kind: 'daemon' })
    cleanups.push(() => leases.close())
    const runtime = runtimeWith({ agentLeases: leases })
    const seen = record(runtime)
    const unloaded: string[] = []
    runtime.on('agent-unloaded', ({ agentId }) => unloaded.push(agentId))
    const ref = await runtime.loadAgent(filePath)
    const agent = runtime.getLoadedAgent(ref.id)!.agent
    const realDispose = agent.disposeAsync.bind(agent)
    vi.spyOn(agent, 'disposeAsync').mockRejectedValueOnce(new Error('teardown exploded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runtime.unloadAgent(ref.id)).rejects.toThrow('teardown exploded')

    expect(runtime.getAgent(ref.id)).toBeUndefined()
    expect(unloaded).toEqual([ref.id])
    expect(await leases.isHeld(filePath)).toBe(false)
    expect(seen.at(-1)).toMatchObject({ kind: 'lifecycle', event: { type: 'agent_stopped', payload: { error: 'teardown exploded' } } })
    await realDispose({ mode: 'immediate' })
    expect((await runtime.loadAgent(filePath)).id).toBe(ref.id)
  })

  it('each lifecycle listener runs on its own: one that throws stops neither the others nor the caller', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1')
    const runtime = runtimeWith()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.on('agent-lifecycle', () => { throw new Error('listener exploded') })
    const seen = record(runtime)
    await runtime.loadAgent(filePath)
    expect(lifecycleTypes(seen)).toEqual(['agent_starting', 'agent_started'])
  })

  it('a deferred rename runs while the lease is still held, then the lease is released', async () => {
    const dir = tempDir()
    const { filePath } = seedAgent(dir, 'agent-1')
    const leases = new AgentLeaseRegistry({ dir: tempDir(), kind: 'daemon' })
    cleanups.push(() => leases.close())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = runtimeWith({ agentLeases: leases })
    const ref = await runtime.loadAgent(filePath)
    await runtime.setAgentConfig(ref.id, { ...runtime.getAgent(ref.id)!.config, name: 'agent-2' })
    const order: string[] = []
    const reconcile = leases.reconcile.bind(leases)
    vi.spyOn(leases, 'reconcile').mockImplementation(async () => {
      order.push(`reconcile (renamed: ${existsSync(join(dir, 'agent-2.adf'))}, held: ${await leases.isHeld(filePath)})`)
      return reconcile()
    })
    runtime.on('agent-file-renamed', () => order.push('agent-file-renamed'))
    runtime.on('agent-lifecycle', (e) => { if (e.type === 'agent_stopped') order.push('agent_stopped') })

    await runtime.unloadAgent(ref.id)

    expect(order).toEqual(['reconcile (renamed: true, held: true)', 'agent_stopped', 'agent-file-renamed'])
    expect(await leases.isHeld(filePath)).toBe(false)
  })
})

describe('an agent whose own provider key is locked', () => {
  it('fails its turns with credentials_locked before any request, and runs once unlocked', async () => {
    const { filePath } = seedAgent(tempDir(), 'agent-1', {
      model: { provider: 'anthropic', model_id: 'claude-x' } as AgentConfig['model'],
      providers: [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '' }] as AgentConfig['providers'],
    })
    const workspace = AdfWorkspace.open(filePath)
    workspace.setIdentity('provider:anthropic:apiKey', 'sk-own')
    workspace.setPassword('pw')
    workspace.close()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const built: Array<Buffer | null> = []
    const runtime = runtimeWith({
      settings: { get: () => undefined },
      providerFactory: (_config, _path, context) => { built.push(context?.derivedKey ?? null); return new MockLLMProvider({ tokensPerResponse: 5 }) },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen = record(runtime)
    const errors = () => seen.filter((s) => s.kind === 'agent' && s.type === 'error').map((s) => String((s as { payload: { error: string } }).payload.error))

    const ref = await runtime.loadAgent(filePath)
    await runtime.startAgent(ref.id)
    await waitFor(() => errors().length > 0)

    expect(errors()[0]).toBe(
      `agent-1's API key for its provider "Anthropic" is locked with the agent's file password, so no request was sent. ` +
      `Unlock it: POST /agents/${ref.id}/identity/password/unlock with {"password": "…"}. The next turn uses the key.`,
    )
    expect(errors()[0]).not.toContain('Settings')
    expect(built).toEqual([]) // the real provider was never built
    expect(fetchSpy).not.toHaveBeenCalled()

    runtime.unlockAgentIdentityPassword(ref.id, 'pw')
    await waitFor(() => built.length === 1)
    expect(built[0]).not.toBeNull()
    const before = seen.length
    await runtime.sendChat(ref.id, 'hello')
    const after = seen.slice(before)
    expect(after.some((s) => s.kind === 'agent' && s.type === 'turn_complete')).toBe(true)
    expect(after.some((s) => s.kind === 'agent' && s.type === 'error')).toBe(false)
  })
})
