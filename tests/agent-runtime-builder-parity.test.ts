import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { CodeSandboxService } from '../src/main/runtime/code-sandbox'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { AGENT_PROFILES } from '../src/main/runtime/agent-capability-profiles'
import { TapManager } from '../src/main/runtime/tap-manager'
import { McpClientManager } from '../src/main/services/mcp-client-manager'
import { ChannelAdapterManager } from '../src/main/services/channel-adapter-manager'
import { AgentKeystoreOAuthStore } from '../src/main/services/mcp-oauth-store'
import { MCP_OAUTH_AUTHORIZE_APPROVAL, MCP_OAUTH_SIGNIN_APPROVAL } from '../src/main/services/mcp-oauth-connect'
import { currentAgentDerivedKey, subscribeAgentRuntimeSignals } from '../src/main/runtime/agent-runtime-signals'
import { approvalHub } from '../src/main/runtime/approval-hub'
import { mcpConnectorFor } from '../src/main/runtime/mcp-connectors'
import { hashMcpToolInfo } from '../src/main/services/mcp-tool-sync'
import { createDispatch, createEvent } from '../src/shared/types/adf-event.types'
import type { runMcpHttpOAuthFlow } from '../src/main/services/mcp-http-oauth'
import type { McpOAuthRecord } from '../src/main/services/mcp-oauth.types'
import type { AgentConfig, McpServerConfig, McpToolInfo } from '../src/shared/types/adf-v02.types'

// Design §6 rows owned by AgentRuntimeBuilder: each test is one row. No test
// spawns an MCP server, starts a real adapter or reaches the network: the MCP
// connect, the adapter start and the OAuth flow are replaced by fakes.

const PING_TOOL: McpToolInfo = { name: 'ping', description: 'ping', input_schema: { type: 'object', properties: {} } }

function makeAgentFile(name: string, patch: Partial<AgentConfig> = {}): { filePath: string; workspace: AdfWorkspace } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-builder-parity-'))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  if (Object.keys(patch).length) workspace.setAgentConfig({ ...workspace.getAgentConfig(), ...patch })
  return { filePath, workspace }
}

function chat(text: string) {
  return createDispatch(
    createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }),
    { scope: 'agent' },
  )
}

function stdioServer(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, transport: 'stdio', command: 'node', args: [`${name}.js`], source: 'custom', ...extra }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentRuntimeBuilder parity: MCP', () => {
  it('connects a server added by a config write and disconnects a removed one (Studio reconcile)', async () => {
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue([PING_TOOL])
    const disconnect = vi.spyOn(McpClientManager.prototype, 'disconnect').mockResolvedValue()
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      expect(connect).not.toHaveBeenCalled()

      // A config write as RuntimeService.setAgentConfig makes it.
      const added = { ...workspace.getAgentConfig(), mcp: { servers: [stdioServer('srv')] } }
      workspace.setAgentConfig(added)
      agent.applyConfigChange(added)
      await waitFor(() => connect.mock.calls.length === 1)
      expect(connect.mock.calls[0][0]).toMatchObject({ name: 'srv' })
      await waitFor(() => !!agent.registry.get('mcp_srv_ping'))

      const removed = { ...workspace.getAgentConfig(), mcp: { servers: [] } }
      workspace.setAgentConfig(removed)
      agent.applyConfigChange(removed)
      await waitFor(() => disconnect.mock.calls.some(call => call[0] === 'srv'))
      await waitFor(() => !agent.registry.get('mcp_srv_ping'))
    } finally {
      await agent.disposeAsync()
    }
  })

  it('does not reconnect a server mcp_install already connected when a later write lists it as added', async () => {
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue([PING_TOOL])
    vi.spyOn(McpClientManager.prototype, 'getServerState').mockImplementation((name: string) =>
      name === 'srv' ? { name, status: 'connected', restartCount: 0, toolCount: 1, logs: [] } as never : null)
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      const next = { ...workspace.getAgentConfig(), mcp: { servers: [stdioServer('srv')] } }
      agent.applyConfigChange(next)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(connect).not.toHaveBeenCalled()
    } finally {
      await agent.disposeAsync()
    }
  })

  it('keeps the MCP manager when setup fails, so mcp_install can still connect', async () => {
    vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue(null)
    const { filePath, workspace } = makeAgentFile('agent-1', { mcp: { servers: [stdioServer('srv')] } })
    const settings = {
      get: (key: string) => {
        if (key === 'mcpServers') throw new Error('settings unreadable')
        return undefined
      },
    }
    const agent = await new AgentRuntimeBuilder({ settings }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      expect(agent.mcpManager).toBeInstanceOf(McpClientManager)
      expect(agent.scratchDir).toBeTruthy()
      const logs = workspace.getLogs?.() ?? []
      expect(JSON.stringify(logs)).toContain('setup_failed')
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('AgentRuntimeBuilder parity: start window (design §6.1 row 24)', () => {
  it('the MCP startup sync lands on a fresh read: a config write made while servers connect is kept', async () => {
    let release!: (tools: McpToolInfo[]) => void
    vi.spyOn(McpClientManager.prototype, 'connect').mockImplementation(() => new Promise((resolve) => { release = resolve as never }))
    const base = makeAgentFile('agent-1')
    const tools = [...(base.workspace.getAgentConfig().tools ?? []), { name: 'mcp_gone_ping', enabled: true, visible: true }]
    base.workspace.setAgentConfig({
      ...base.workspace.getAgentConfig(),
      tools,
      // `gone` is neither registered in Settings nor carries a source: skipped, so its tools are disabled.
      mcp: { servers: [stdioServer('srv'), { name: 'gone', transport: 'stdio', command: 'node' }] },
    })
    const { workspace } = base
    const building = new AgentRuntimeBuilder().build({ workspace, filePath: base.filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    await waitFor(() => typeof release === 'function')
    // A config write during the build (a client's save through the open document).
    workspace.setAgentConfig({ ...workspace.getAgentConfig(), description: 'written during the start' })
    release([PING_TOOL])
    const agent = await building
    try {
      const saved = workspace.getAgentConfig()
      expect(saved.description).toBe('written during the start')
      expect(saved.tools.find((t) => t.name === 'mcp_gone_ping')?.enabled).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('AgentRuntimeBuilder parity: a connect after the start', () => {
  it('an owner restart applies the discovered tools to the running agent (characterization)', async () => {
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue([PING_TOOL])
    const base = makeAgentFile('agent-1', { mcp: { servers: [stdioServer('srv')] } })
    const { workspace } = base
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath: base.filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      connect.mockResolvedValue([PING_TOOL, { name: 'pong', description: 'pong', input_schema: { type: 'object', properties: {} } }])
      await mcpConnectorFor(agent.mcpManager)!('srv')
      expect(agent.executor.getConfig().tools.some((t) => t.name === 'mcp_srv_pong')).toBe(true)
      expect(workspace.getAgentConfig().tools.some((t) => t.name === 'mcp_srv_pong')).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('a config saved while the restart connects stays on the running agent (review 4300792081)', async () => {
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue([PING_TOOL])
    const base = makeAgentFile('agent-1', { mcp: { servers: [stdioServer('srv')] } })
    const { workspace } = base
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath: base.filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      let release!: (tools: McpToolInfo[]) => void
      connect.mockImplementation(() => new Promise((resolve) => { release = resolve as never }))
      const restart = mcpConnectorFor(agent.mcpManager)!('srv')
      await waitFor(() => typeof release === 'function')
      // A client's save during the connect (RuntimeService.setAgentConfig: file, then the agent).
      const saved = { ...workspace.getAgentConfig(), description: 'saved during the restart' }
      workspace.setAgentConfig(saved)
      agent.applyConfigChange(saved)
      release([PING_TOOL, { name: 'pong', description: 'pong', input_schema: { type: 'object', properties: {} } }])
      await restart
      expect(agent.executor.getConfig().description).toBe('saved during the restart')
      expect(agent.executor.getConfig().tools.some((t) => t.name === 'mcp_srv_pong')).toBe(true)
      expect(workspace.getAgentConfig().description).toBe('saved during the restart')
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('AgentRuntimeBuilder parity: start window, tool toggles (review fix)', () => {
  it('a tool toggle saved while the server connects survives the startup tool sync', async () => {
    let release!: (tools: McpToolInfo[]) => void
    vi.spyOn(McpClientManager.prototype, 'connect').mockImplementation(() => new Promise((resolve) => { release = resolve as never }))
    const base = makeAgentFile('agent-1')
    const declared = { name: 'mcp_srv_ping', enabled: true, visible: true, restricted: false, mcp_tool_hash: hashMcpToolInfo(PING_TOOL) }
    base.workspace.setAgentConfig({
      ...base.workspace.getAgentConfig(),
      tools: [...(base.workspace.getAgentConfig().tools ?? []), declared],
      mcp: { servers: [stdioServer('srv', { available_tools: [PING_TOOL] })] },
    })
    const { workspace } = base
    const building = new AgentRuntimeBuilder().build({ workspace, filePath: base.filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    await waitFor(() => typeof release === 'function')
    // The owner turns the tool off while the server is still connecting.
    const now = workspace.getAgentConfig()
    workspace.setAgentConfig({ ...now, tools: now.tools.map((t) => (t.name === 'mcp_srv_ping' ? { ...t, enabled: false } : t)) })
    release([PING_TOOL, { name: 'pong', description: 'pong', input_schema: { type: 'object', properties: {} } }])
    const agent = await building
    try {
      const saved = workspace.getAgentConfig()
      expect(saved.tools.find((t) => t.name === 'mcp_srv_ping')?.enabled).toBe(false)
      expect(saved.tools.some((t) => t.name === 'mcp_srv_pong')).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('AgentRuntimeBuilder parity: derived key', () => {
  it('hands an unlock to MCP, adapters and the mesh, and restarts what needed the key', async () => {
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

    const { filePath, workspace } = makeAgentFile('agent-1', {
      mcp: { servers: [stdioServer('srv', { env_keys: ['API_KEY'] })] },
      adapters: { telegram: { enabled: true, config: {} } } as AgentConfig['adapters'],
    })
    workspace.setIdentity('mcp:srv:API_KEY', 'mcp-secret')
    workspace.setIdentity('adapter:telegram:TELEGRAM_BOT_TOKEN', 'bot-secret')
    workspace.setIdentity('app:token', 'code-secret', true)
    const key = workspace.setPassword('pw')
    expect(workspace.getIdentityDecrypted('mcp:srv:API_KEY', null)).toBeNull()

    const sandbox = new CodeSandboxService()
    const builder = new AgentRuntimeBuilder({ settings: { get: () => undefined }, codeSandboxService: sandbox })
    const agent = await builder.build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    const meshKeys: Array<Buffer | null> = []
    const unsubscribe = subscribeAgentRuntimeSignals(workspace, { onDerivedKeyChanged: k => meshKeys.push(k) })
    try {
      expect(mcpEnvs).toHaveLength(1)
      expect(mcpEnvs[0]?.API_KEY).toBeUndefined()
      expect(adapterKeys).toEqual([null])
      const resolveIdentity = (agent.adfCallHandler as unknown as { resolveIdentity: (p: string) => string | null }).resolveIdentity
      expect(resolveIdentity('app:token')).toBeNull()

      const result = await builder.applyDerivedKey(agent, key)

      expect(result).toEqual({ applied: true, adaptersRestarted: ['telegram'], mcpReconnected: ['srv'] })
      expect(mcpEnvs[1]?.API_KEY).toBe('mcp-secret')
      expect(adapterKeys[1]).toBe(key)
      expect(meshKeys).toEqual([key])
      expect(currentAgentDerivedKey(workspace)).toBe(key)
      // AdfCallHandler identity reads (code get_identity) go through the same key.
      expect(resolveIdentity('app:token')).toBe('code-secret')

      // A second unlock with the same key opens nothing new: nothing restarts.
      const again = await builder.applyDerivedKey(agent, key)
      expect(again).toEqual({ applied: true, adaptersRestarted: [], mcpReconnected: [] })

      const locked = await builder.applyDerivedKey(agent, null)
      expect(locked.applied).toBe(true)
      expect(meshKeys).toEqual([key, key, null])
      expect(currentAgentDerivedKey(workspace)).toBeNull()
    } finally {
      unsubscribe()
      await agent.disposeAsync()
      sandbox.destroyAll()
    }
  })

  it('a key drop restarts only the running adapters that have stored credentials (W1-A follow-up)', async () => {
    vi.spyOn(ChannelAdapterManager.prototype, 'startAdapter').mockResolvedValue(true)
    const stop = vi.spyOn(ChannelAdapterManager.prototype, 'stopAdapter').mockResolvedValue()
    // telegram reads its token through the key; email has no stored credential.
    vi.spyOn(ChannelAdapterManager.prototype, 'getStates').mockReturnValue([
      { type: 'telegram', status: 'connected', restartCount: 0, logs: [] },
      { type: 'email', status: 'connected', restartCount: 0, logs: [] },
    ] as never)
    const { filePath, workspace } = makeAgentFile('agent-1', {
      adapters: { telegram: { enabled: true, config: {} } } as AgentConfig['adapters'],
    })
    workspace.setIdentity('adapter:telegram:TELEGRAM_BOT_TOKEN', 'bot-secret')
    const key = workspace.setPassword('pw')
    const sandbox = new CodeSandboxService()
    const builder = new AgentRuntimeBuilder({ settings: { get: () => undefined }, codeSandboxService: sandbox })
    const agent = await builder.build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      await builder.applyDerivedKey(agent, key)
      stop.mockClear()
      const dropped = await builder.applyDerivedKey(agent, null)
      expect(dropped).toEqual({ applied: true, adaptersRestarted: ['telegram'], mcpReconnected: [] })
      expect(stop.mock.calls.map((call) => call[0])).toEqual(['telegram'])
    } finally {
      await agent.disposeAsync()
      sandbox.destroyAll()
    }
  })

  it('reports applied:false for an agent it did not build', async () => {
    const result = await new AgentRuntimeBuilder().applyDerivedKey({}, Buffer.alloc(32))
    expect(result).toEqual({ applied: false, adaptersRestarted: [], mcpReconnected: [] })
  })
})

describe('AgentRuntimeBuilder parity: umbilical taps', () => {
  it('the daemon profile enables taps and the built agent exposes its TapManager', async () => {
    expect(AGENT_PROFILES.daemon.umbilicalTaps).toBe(true)
    const { filePath, workspace } = makeAgentFile('agent-1', {
      umbilical_taps: [{
        name: 'tap-1',
        lambda: 'lib/tap.ts:onEvent',
        filter: { event_types: ['agent.loaded'], allow_wildcard: false },
        exclude_own_origin: false,
        max_rate_per_sec: 10,
      }],
    })
    workspace.writeFile('lib/tap.ts', 'export async function onEvent() { return null }')
    const sandbox = new CodeSandboxService()
    const agent = await new AgentRuntimeBuilder({ codeSandboxService: sandbox }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      expect(agent.tapManager).toBeInstanceOf(TapManager)
    } finally {
      await agent.disposeAsync()
      sandbox.destroyAll()
    }
  })
})

describe('AgentRuntimeBuilder parity: interactive MCP OAuth', () => {
  function oauthServer(): McpServerConfig {
    return { name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', oauth: true, source: 'http:https://mcp.example.test/mcp' }
  }

  function fakeAgentStore(): Map<string, McpOAuthRecord> {
    const records = new Map<string, McpOAuthRecord>()
    vi.spyOn(AgentKeystoreOAuthStore.prototype, 'get').mockImplementation(async (url: string) => records.get(url))
    vi.spyOn(AgentKeystoreOAuthStore.prototype, 'save').mockImplementation(async (url: string, record: McpOAuthRecord) => { records.set(url, record) })
    return records
  }

  async function setup(flow: typeof runMcpHttpOAuthFlow) {
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue(null)
    const { filePath, workspace } = makeAgentFile('agent-1', { mcp: { servers: [oauthServer()] } })
    const agent = await new AgentRuntimeBuilder({ mcpHttpOAuthFlow: flow }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    return { agent, workspace, connect }
  }

  it('never prompts on the initial connect', async () => {
    fakeAgentStore()
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>()
    const { agent, connect } = await setup(flow)
    try {
      expect(connect).toHaveBeenCalledTimes(1)
      expect(agent.executor.getPendingApprovals()).toEqual([])
      expect(flow).not.toHaveBeenCalled()
    } finally {
      await agent.disposeAsync()
    }
  })

  it('raises the Studio consent request, then a request carrying the authorize URL that settles on the callback', async () => {
    const records = fakeAgentStore()
    let completeCallback!: () => void
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (url, store, io) => {
      await io.openUrl('https://auth.example.test/authorize?client_id=c&state=s')
      await new Promise<void>(resolve => { completeCallback = resolve })
      await store.save(url, { tokens: { access_token: 'a', token_type: 'Bearer' }, updatedAt: Date.now() } as McpOAuthRecord)
      return { authorized: true }
    })
    const { agent, workspace, connect } = await setup(flow)
    try {
      const restart = agent.registry.get('mcp_restart')!
      const result = restart.execute({ name: 'remote' }, workspace)

      await waitFor(() => agent.executor.getPendingApprovals().length === 1)
      const consent = agent.executor.getPendingApprovals()[0]
      expect(consent).toMatchObject({ name: MCP_OAUTH_SIGNIN_APPROVAL, input: { server: 'remote', url: 'https://mcp.example.test/mcp' }, canAlwaysApprove: false })
      agent.executor.resolveHilTask(consent.requestId, true)

      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL))
      const authorize = agent.executor.getPendingApprovals().find(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL)!
      expect(authorize.input).toEqual({
        server: 'remote',
        url: 'https://mcp.example.test/mcp',
        authorize_url: 'https://auth.example.test/authorize?client_id=c&state=s',
      })
      expect(authorize.canAlwaysApprove).toBe(false)

      // Approve = "opened": the flow keeps waiting and the URL stays pending.
      agent.executor.resolveHilTask(authorize.requestId, true)
      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL && a.requestId !== authorize.requestId))
      const reopened = agent.executor.getPendingApprovals().find(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL)!
      expect(reopened.input).toEqual(authorize.input)
      expect(flow).toHaveBeenCalledTimes(1)

      completeCallback()
      await result
      expect(agent.executor.getPendingApprovals()).toEqual([])
      expect(records.get('https://mcp.example.test/mcp')?.tokens?.access_token).toBe('a')
      // Connected after the sign-in (initial connect + this one).
      expect(connect).toHaveBeenCalledTimes(2)
      // The runtime ends the request as `completed`, never as a human approval.
      expect(workspace.getTask(reopened.requestId)).toMatchObject({ status: 'completed', result: 'Authorization completed' })
      const history = approvalHub.historySnapshot().find(h => h.requestId === reopened.requestId)
      expect(history?.outcome).toBe('completed')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('a repeated redirect replaces the authorize request without cancelling the flow', async () => {
    const records = fakeAgentStore()
    let aborted = false
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (url, store, io, opts) => {
      opts?.signal?.addEventListener('abort', () => { aborted = true })
      await io.openUrl('https://auth.example.test/authorize?state=first')
      await io.openUrl('https://auth.example.test/authorize?state=second')
      await new Promise(resolve => setTimeout(resolve, 20))
      await store.save(url, { tokens: { access_token: 'b', token_type: 'Bearer' }, updatedAt: Date.now() } as McpOAuthRecord)
      return { authorized: true }
    })
    const { agent, workspace } = await setup(flow)
    try {
      const result = agent.registry.get('mcp_restart')!.execute({ name: 'remote' }, workspace)
      await waitFor(() => agent.executor.getPendingApprovals().length === 1)
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      await waitFor(() => agent.executor.getPendingApprovals().some(a => (a.input as { authorize_url?: string }).authorize_url?.endsWith('second')))
      expect(agent.executor.getPendingApprovals()).toHaveLength(1)

      await result
      expect(aborted).toBe(false)
      expect(records.get('https://mcp.example.test/mcp')?.tokens?.access_token).toBe('b')
      expect(agent.executor.getPendingApprovals()).toEqual([])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('a config write to an idle agent never prompts and leaves its state alone', async () => {
    fakeAgentStore()
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>()
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue(null)
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder({ mcpHttpOAuthFlow: flow }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      const before = agent.executor.getState()
      const next = { ...workspace.getAgentConfig(), mcp: { servers: [oauthServer()] } }
      workspace.setAgentConfig(next)
      agent.applyConfigChange(next)
      await waitFor(() => connect.mock.calls.length === 1)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(agent.executor.getPendingApprovals()).toEqual([])
      expect(agent.executor.getState()).toBe(before)
      expect(flow).not.toHaveBeenCalled()
    } finally {
      await agent.disposeAsync()
    }
  })

  it('defers the sign-in of a server added to an idle agent to its next turn, visibly', async () => {
    const records = fakeAgentStore()
    let completeCallback!: () => void
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (url, store, io) => {
      await io.openUrl('https://auth.example.test/authorize?state=s')
      await new Promise<void>(resolve => { completeCallback = resolve })
      await store.save(url, { tokens: { access_token: 'd', token_type: 'Bearer' }, updatedAt: Date.now() } as McpOAuthRecord)
      return { authorized: true }
    })
    const connect = vi.spyOn(McpClientManager.prototype, 'connect').mockResolvedValue(null)
    const provider = new MockLLMProvider()
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder({ mcpHttpOAuthFlow: flow }).build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
    try {
      const next = { ...workspace.getAgentConfig(), mcp: { servers: [oauthServer()] } }
      workspace.setAgentConfig(next)
      agent.applyConfigChange(next)
      await waitFor(() => agent.mcpManager?.getServerState('remote')?.status === 'needs_sign_in')
      expect(agent.mcpManager?.getServerState('remote')?.error).toContain('next turn')
      expect(JSON.stringify(workspace.getLogs())).toContain('oauth_signin_pending')
      expect(flow).not.toHaveBeenCalled()

      // A system-scope timer never raises it and is never held by it.
      await agent.dispatch(createDispatch(
        createEvent({ type: 'timer', source: 'test', data: {} } as never),
        { scope: 'system', lambda: 'lib/none.ts:tick' },
      )).catch(() => { /* no sandbox in this test: the lambda itself fails */ })
      expect(agent.executor.getPendingApprovals()).toEqual([])

      // The next LLM turn raises the sign-in and runs without waiting for it.
      await agent.dispatch(chat('hi'))
      await waitFor(() => provider.getCallCount() > 0 && agent.executor.getState() === 'idle')
      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_SIGNIN_APPROVAL))
      expect(agent.mcpManager?.getServerState('remote')?.status).toBe('needs_sign_in')
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL))
      completeCallback()
      // Write-time connect + the one after the sign-in.
      await waitFor(() => connect.mock.calls.length === 2)
      expect(records.get('https://mcp.example.test/mcp')?.tokens?.access_token).toBe('d')
      expect(agent.executor.getPendingApprovals()).toEqual([])
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('a second "opened" approve acknowledges without raising the request again', async () => {
    fakeAgentStore()
    let completeCallback!: () => void
    let aborted = false
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (url, store, io, opts) => {
      opts?.signal?.addEventListener('abort', () => { aborted = true })
      await io.openUrl('https://auth.example.test/authorize?state=s')
      await new Promise<void>(resolve => { completeCallback = resolve })
      await store.save(url, { tokens: { access_token: 'e', token_type: 'Bearer' }, updatedAt: Date.now() } as McpOAuthRecord)
      return { authorized: true }
    })
    const { agent, workspace } = await setup(flow)
    try {
      const result = agent.registry.get('mcp_restart')!.execute({ name: 'remote' }, workspace)
      await waitFor(() => agent.executor.getPendingApprovals().length === 1)
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      const authorizeIds = new Set<string>()
      for (let i = 0; i < 2; i++) {
        await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL && !authorizeIds.has(a.requestId)))
        const request = agent.executor.getPendingApprovals().find(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL)!
        authorizeIds.add(request.requestId)
        agent.executor.resolveHilTask(request.requestId, true)
      }
      await new Promise(resolve => setTimeout(resolve, 30))
      // One re-raise at most: two requests in all, none pending, flow still waiting.
      expect(authorizeIds.size).toBe(2)
      expect(agent.executor.getPendingApprovals()).toEqual([])
      expect(aborted).toBe(false)
      completeCallback()
      await result
      expect(aborted).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('an owner restart during an interactive sign-in does not wait for it', async () => {
    fakeAgentStore()
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>()
    const { agent, workspace, connect } = await setup(flow)
    try {
      const interactive = agent.registry.get('mcp_restart')!.execute({ name: 'remote' }, workspace)
      await waitFor(() => agent.executor.getPendingApprovals().length === 1)

      const ownerRestart = mcpConnectorFor(agent.mcpManager)!('remote')
      const outcome = await Promise.race([ownerRestart, new Promise(resolve => setTimeout(() => resolve('hung'), 1000))])
      expect(outcome).not.toBe('hung')
      expect(agent.executor.getPendingApprovals()).toHaveLength(1)

      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, false)
      await interactive
      expect(flow).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledTimes(3)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('runs one sign-in per server when two calls race', async () => {
    const records = fakeAgentStore()
    let completeCallback!: () => void
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (url, store, io) => {
      await io.openUrl('https://auth.example.test/authorize?state=s')
      await new Promise<void>(resolve => { completeCallback = resolve })
      await store.save(url, { tokens: { access_token: 'c', token_type: 'Bearer' }, updatedAt: Date.now() } as McpOAuthRecord)
      return { authorized: true }
    })
    const { agent, workspace, connect } = await setup(flow)
    try {
      const restart = agent.registry.get('mcp_restart')!
      const first = restart.execute({ name: 'remote' }, workspace)
      const second = restart.execute({ name: 'remote' }, workspace)
      await waitFor(() => agent.executor.getPendingApprovals().length === 1)
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL))
      // Only the first call prompts; the second waits on it.
      expect(agent.executor.getPendingApprovals()).toHaveLength(1)
      completeCallback()
      await Promise.all([first, second])
      expect(flow).toHaveBeenCalledTimes(1)
      expect(records.get('https://mcp.example.test/mcp')?.tokens?.access_token).toBe('c')
      // Initial connect + one connect per call.
      expect(connect).toHaveBeenCalledTimes(3)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('denying the authorize request cancels the flow', async () => {
    const records = fakeAgentStore()
    let aborted = false
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (_url, _store, io, opts) => {
      await io.openUrl('https://auth.example.test/authorize?state=s')
      await new Promise<void>(resolve => opts?.signal?.addEventListener('abort', () => { aborted = true; resolve() }))
      return { authorized: false, error: 'OAuth authorization was cancelled' }
    })
    const { agent, workspace } = await setup(flow)
    try {
      const result = agent.registry.get('mcp_restart')!.execute({ name: 'remote' }, workspace)
      await waitFor(() => agent.executor.getPendingApprovals().length === 1)
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL))
      const authorize = agent.executor.getPendingApprovals().find(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL)!
      agent.executor.resolveHilTask(authorize.requestId, false)

      await result
      expect(aborted).toBe(true)
      expect(records.size).toBe(0)
      expect(agent.executor.getPendingApprovals()).toEqual([])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('agent teardown during the sign-in drains the request and cancels the flow', async () => {
    fakeAgentStore()
    let aborted = false
    const flow = vi.fn<typeof runMcpHttpOAuthFlow>(async (_url, _store, io, opts) => {
      await io.openUrl('https://auth.example.test/authorize?state=s')
      await new Promise<void>(resolve => opts?.signal?.addEventListener('abort', () => { aborted = true; resolve() }))
      return { authorized: false, error: 'OAuth authorization was cancelled' }
    })
    const { agent, workspace } = await setup(flow)
    const result = agent.registry.get('mcp_restart')!.execute({ name: 'remote' }, workspace)
    await waitFor(() => agent.executor.getPendingApprovals().length === 1)
    agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
    await waitFor(() => agent.executor.getPendingApprovals().some(a => a.name === MCP_OAUTH_AUTHORIZE_APPROVAL))

    await agent.disposeAsync()
    await result
    expect(aborted).toBe(true)
  })
})

describe('AgentExecutor.requestApproval restoreState', () => {
  class GatedProvider extends MockLLMProvider {
    release!: () => void
    private gate = new Promise<void>(resolve => { this.release = resolve })
    override async createMessage(...args: Parameters<MockLLMProvider['createMessage']>) {
      await this.gate
      return super.createMessage(...args)
    }
  }

  it('raised and settled during an active turn, it never changes the state', async () => {
    const provider = new GatedProvider()
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
    try {
      const turn = agent.dispatch(chat('hi'))
      await waitFor(() => agent.executor.isTurnActive() && agent.executor.getState() === 'thinking')
      const decision = agent.executor.requestApproval('mcp_oauth_authorize', { server: 'remote' }, { canAlwaysApprove: false, restoreState: true })
      expect(agent.executor.getState()).toBe('thinking')
      const pending = agent.executor.getPendingApprovals()[0]
      agent.executor.settleHilTask(pending.requestId, 'Authorization completed')
      expect(await decision).toBe(false)
      expect(agent.executor.getState()).toBe('thinking')
      provider.release()
      await turn
      await waitFor(() => agent.executor.getState() === 'idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('raised with no turn running, it shows awaiting_approval and restores the prior state', async () => {
    const { filePath, workspace } = makeAgentFile('agent-1')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider: new MockLLMProvider() })
    try {
      const before = agent.executor.getState()
      const decision = agent.executor.requestApproval('mcp_oauth_signin', { server: 'remote' }, { canAlwaysApprove: false, restoreState: true })
      expect(agent.executor.getState()).toBe('awaiting_approval')
      agent.executor.resolveHilTask(agent.executor.getPendingApprovals()[0].requestId, true)
      expect(await decision).toBe(true)
      expect(agent.executor.getState()).toBe(before)
    } finally {
      await agent.disposeAsync()
    }
  })
})
