import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-api-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-daemon-api-test',
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

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { ComputeEnvInfo } from '../src/main/services/podman.service'
import { getTokenUsageService } from '../src/main/services/token-usage.service'

const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

describe('daemon HTTP API', () => {
  it('serves the static OpenAPI document', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const response = await server.inject({ method: 'GET', url: '/openapi.json' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const spec = response.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toEqual(expect.objectContaining({
      title: 'ADF Daemon API',
      version: expect.any(String),
    }))
    expect(spec.paths).toEqual(expect.objectContaining({
      '/admin/mcp/packages': expect.any(Object),
      '/admin/sandbox/packages': expect.any(Object),
      '/agents/{id}/chat': expect.any(Object),
      '/agents/{id}/identity/{purpose}': expect.any(Object),
      '/agents/{id}/mcp/credentials': expect.any(Object),
      '/compute/containers/{name}': expect.any(Object),
      '/compute/setup': expect.any(Object),
      '/events': expect.any(Object),
      '/network/mesh': expect.any(Object),
      '/network/server': expect.any(Object),
      '/runtime/token-count': expect.any(Object),
      '/runtime/usage': expect.any(Object),
    }))
  })

  it('exposes and updates daemon settings', async () => {
    const data: Record<string, unknown> = {
      trackedDirectories: ['/tmp/agents'],
      meshEnabled: true,
    }
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const server = createDaemonHttpApi(runtime, {
      settingsStore: {
        filePath: '/tmp/adf-settings.json',
        get: key => data[key],
        set: (key, value) => { data[key] = value },
        getAll: () => ({ ...data }),
        update: values => { Object.assign(data, values) },
      },
    })
    servers.push(server)

    const all = await server.inject({ method: 'GET', url: '/settings' })
    expect(all.statusCode).toBe(200)
    expect(all.json()).toEqual({
      filePath: '/tmp/adf-settings.json',
      settings: {
        trackedDirectories: ['/tmp/agents'],
        meshEnabled: true,
      },
    })

    const one = await server.inject({ method: 'GET', url: '/settings/meshEnabled' })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toEqual({ key: 'meshEnabled', value: true })

    const updated = await server.inject({
      method: 'PUT',
      url: '/settings/meshEnabled',
      payload: { value: false },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({ key: 'meshEnabled', value: false })

    const patched = await server.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { meshPort: 7296 },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toEqual(expect.objectContaining({
      settings: expect.objectContaining({ meshEnabled: false, meshPort: 7296 }),
    }))
  })

  it('exposes compute status when the daemon host provides a compute service', async () => {
    let status: ComputeEnvInfo = {
      status: 'stopped',
      containerName: 'adf-mcp',
      activeAgents: [],
    }
    let stopAllCalled = 0
    const containerActions: string[] = []
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const server = createDaemonHttpApi(runtime, {
      computeService: {
        getStatus: () => status,
        listContainers: async () => [{ name: 'adf-mcp', status: status.status, running: status.status === 'running' }],
        ensureRunning: async () => { status = { ...status, status: 'running' } },
        stop: async () => { status = { ...status, status: 'stopped' } },
        stopAll: async () => {
          stopAllCalled++
          status = { ...status, status: 'stopped' }
        },
        destroy: async () => {
          containerActions.push('destroy-shared')
          status = { ...status, status: 'stopped' }
        },
        startContainer: async (name) => {
          containerActions.push(`start:${name}`)
          return true
        },
        stopContainer: async (name) => {
          containerActions.push(`stop:${name}`)
          return true
        },
        destroyContainer: async (name) => {
          containerActions.push(`destroy:${name}`)
          return true
        },
        getContainerDetail: async (name) => ({ name, processes: 'ps', packages: 'packages', workspace: 'workspace', info: 'info' }),
        getExecLog: (name) => [{ containerName: name ?? 'all', command: 'node -v', exitCode: 0 }],
        setup: async (step) => ({ success: true, step }),
      },
    })
    servers.push(server)

    const before = await server.inject({ method: 'GET', url: '/compute/status' })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toEqual(expect.objectContaining({ status: 'stopped', containerName: 'adf-mcp' }))

    const start = await server.inject({ method: 'POST', url: '/compute/start' })
    expect(start.statusCode).toBe(200)
    expect(start.json()).toEqual(expect.objectContaining({ status: 'running' }))

    const containers = await server.inject({ method: 'GET', url: '/compute/containers' })
    expect(containers.statusCode).toBe(200)
    expect(containers.json()).toEqual({ containers: [{ name: 'adf-mcp', status: 'running', running: true }] })

    const stop = await server.inject({ method: 'POST', url: '/compute/stop' })
    expect(stop.statusCode).toBe(200)
    expect(stop.json()).toEqual(expect.objectContaining({ status: 'stopped' }))
    expect(stopAllCalled).toBe(1)

    const detail = await server.inject({ method: 'GET', url: '/compute/containers/adf-mcp' })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toEqual(expect.objectContaining({ success: true, name: 'adf-mcp', processes: 'ps' }))
    const execLog = await server.inject({ method: 'GET', url: '/compute/exec-log?name=adf-mcp' })
    expect(execLog.statusCode).toBe(200)
    expect(execLog.json()).toEqual({ entries: [expect.objectContaining({ containerName: 'adf-mcp', command: 'node -v' })] })
    await server.inject({ method: 'POST', url: '/compute/containers/adf-mcp/start' })
    await server.inject({ method: 'POST', url: '/compute/containers/adf-mcp/stop' })
    await server.inject({ method: 'POST', url: '/compute/containers/adf-mcp/destroy' })
    const destroy = await server.inject({ method: 'POST', url: '/compute/destroy' })
    expect(destroy.statusCode).toBe(200)
    const setup = await server.inject({ method: 'POST', url: '/compute/setup', payload: { step: 'check' } })
    expect(setup.statusCode).toBe(200)
    expect(setup.json()).toEqual({ success: true, step: 'check' })
    expect(containerActions).toEqual(['start:adf-mcp', 'stop:adf-mcp', 'destroy:adf-mcp', 'destroy-shared'])
  })

  it('exposes network mesh and mesh server admin surfaces', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const calls: string[] = []
    let meshEnabled = false
    let serverRunning = false
    const server = createDaemonHttpApi(runtime, {
      networkService: {
        getStatus: () => ({ meshEnabled, meshServerRunning: serverRunning, agents: [] }),
        enableMesh: () => {
          calls.push('mesh:enable')
          meshEnabled = true
          return { success: true, meshEnabled }
        },
        disableMesh: () => {
          calls.push('mesh:disable')
          meshEnabled = false
          return { success: true, meshEnabled }
        },
        getRecentTools: (limit) => ({ '/tmp/agent-1.adf': [{ name: 'fs_read', timestamp: 1, limit }] }),
        getServerStatus: () => ({ running: serverRunning, port: 7295, host: '127.0.0.1' }),
        startServer: () => {
          calls.push('server:start')
          serverRunning = true
          return { success: true, running: serverRunning, port: 7295, host: '127.0.0.1' }
        },
        stopServer: () => {
          calls.push('server:stop')
          serverRunning = false
          return { success: true, running: serverRunning, port: 7295, host: '127.0.0.1' }
        },
        restartServer: () => {
          calls.push('server:restart')
          serverRunning = true
          return { success: true, running: serverRunning, port: 7295, host: '127.0.0.1' }
        },
        getLanAddresses: () => ['192.168.1.2'],
        getDiscoveredRuntimes: () => [{ id: 'peer-1', url: 'http://192.168.1.3:7295' }],
      },
    })
    servers.push(server)

    expect((await server.inject({ method: 'GET', url: '/network/mesh' })).json()).toEqual({ meshEnabled: false, meshServerRunning: false, agents: [] })
    expect((await server.inject({ method: 'POST', url: '/network/mesh/enable' })).json()).toEqual({ success: true, meshEnabled: true })
    expect((await server.inject({ method: 'POST', url: '/network/server/start' })).json()).toEqual(expect.objectContaining({ success: true, running: true }))
    expect((await server.inject({ method: 'GET', url: '/network/server' })).json()).toEqual({ running: true, port: 7295, host: '127.0.0.1' })
    expect((await server.inject({ method: 'GET', url: '/network/mesh/recent-tools?limit=3' })).json()).toEqual({
      tools: { '/tmp/agent-1.adf': [{ name: 'fs_read', timestamp: 1, limit: 3 }] },
    })
    expect((await server.inject({ method: 'GET', url: '/network/mesh/lan-addresses' })).json()).toEqual({ addresses: ['192.168.1.2'] })
    expect((await server.inject({ method: 'GET', url: '/network/mesh/discovered-runtimes' })).json()).toEqual({
      runtimes: [{ id: 'peer-1', url: 'http://192.168.1.3:7295' }],
    })
    await server.inject({ method: 'POST', url: '/network/server/restart' })
    await server.inject({ method: 'POST', url: '/network/server/stop' })
    await server.inject({ method: 'POST', url: '/network/mesh/disable' })
    expect(calls).toEqual(['mesh:enable', 'server:start', 'server:restart', 'server:stop', 'mesh:disable'])
  })

  it('exposes package admin surfaces for mcp, adapters, and sandbox packages', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const mcpPackages: Record<string, { package: string; version: string; command: string; installPath: string; installedAt: number; runtime?: 'npm' | 'uvx' }> = {}
    const pythonPackages: typeof mcpPackages = {}
    const adapterPackages: typeof mcpPackages = {}
    const sandboxPackages: Record<string, { name: string; version: string; installedAt: number; size_mb: number }> = {}
    const makeInstalled = (packageName: string, runtimeName?: 'npm' | 'uvx') => ({
      package: packageName,
      version: '1.0.0',
      command: 'node',
      installPath: `/tmp/${packageName.replace(/[/@]/g, '_')}`,
      installedAt: 123,
      ...(runtimeName ? { runtime: runtimeName } : {}),
    })
    const server = createDaemonHttpApi(runtime, {
      mcpPackageService: {
        install: async (packageName) => (mcpPackages[packageName] = makeInstalled(packageName, 'npm')),
        uninstall: async (packageName) => { delete mcpPackages[packageName] },
        listInstalled: () => Object.values(mcpPackages),
      },
      mcpPythonPackageService: {
        install: async (packageName) => (pythonPackages[packageName] = makeInstalled(packageName, 'uvx')),
        uninstall: async (packageName) => { delete pythonPackages[packageName] },
        listInstalled: () => Object.values(pythonPackages),
      },
      adapterPackageService: {
        install: async (packageName) => (adapterPackages[packageName] = makeInstalled(packageName, 'npm')),
        uninstall: async (packageName) => { delete adapterPackages[packageName] },
        listInstalled: () => Object.values(adapterPackages),
      },
      sandboxPackageService: {
        install: async (name, version) => {
          const entry = { name, version: version ?? 'latest', installedAt: 123, size_mb: 1.2 }
          sandboxPackages[name] = entry
          return { name, version: entry.version, size_mb: entry.size_mb, already_installed: false }
        },
        uninstall: (name) => {
          const existed = !!sandboxPackages[name]
          delete sandboxPackages[name]
          return existed
        },
        checkMissing: packages => packages.filter(pkg => !sandboxPackages[pkg.name] || sandboxPackages[pkg.name].version !== pkg.version),
        getInstalledModules: () => Object.keys(sandboxPackages),
        getInstalledPackages: () => Object.values(sandboxPackages),
        getBasePath: () => '/tmp/sandbox-packages',
      },
    })
    servers.push(server)

    const mcpInstall = await server.inject({
      method: 'POST',
      url: '/admin/mcp/packages/npm',
      payload: { package: '@modelcontextprotocol/server-github' },
    })
    expect(mcpInstall.statusCode).toBe(200)
    const pyInstall = await server.inject({
      method: 'POST',
      url: '/admin/mcp/packages/python',
      payload: { package: 'mcp-server-time', version: '1.0.0' },
    })
    expect(pyInstall.statusCode).toBe(200)
    const mcpList = await server.inject({ method: 'GET', url: '/admin/mcp/packages' })
    expect(mcpList.json()).toEqual({
      packages: expect.arrayContaining([
        expect.objectContaining({ package: '@modelcontextprotocol/server-github', runtime: 'npm' }),
        expect.objectContaining({ package: 'mcp-server-time', runtime: 'uvx' }),
      ]),
    })

    const adapterInstall = await server.inject({
      method: 'POST',
      url: '/admin/adapters/packages',
      payload: { package: '@adf/adapter-test' },
    })
    expect(adapterInstall.statusCode).toBe(200)
    const adapterList = await server.inject({ method: 'GET', url: '/admin/adapters/packages' })
    expect(adapterList.json()).toEqual({
      packages: [expect.objectContaining({ package: '@adf/adapter-test' })],
    })

    const sandboxInstall = await server.inject({
      method: 'POST',
      url: '/admin/sandbox/packages',
      payload: { name: 'lodash', version: '4.17.21' },
    })
    expect(sandboxInstall.statusCode).toBe(200)
    const sandboxList = await server.inject({ method: 'GET', url: '/admin/sandbox/packages' })
    expect(sandboxList.json()).toEqual(expect.objectContaining({
      basePath: '/tmp/sandbox-packages',
      modules: ['lodash'],
      packages: [expect.objectContaining({ name: 'lodash', version: '4.17.21' })],
    }))
    const missing = await server.inject({
      method: 'POST',
      url: '/admin/sandbox/packages/check',
      payload: { packages: [{ name: 'lodash', version: '4.17.21' }, { name: 'dayjs', version: '1.0.0' }] },
    })
    expect(missing.json()).toEqual({ success: true, missing: [{ name: 'dayjs', version: '1.0.0' }] })

    const encodedMcp = encodeURIComponent('@modelcontextprotocol/server-github')
    const encodedAdapter = encodeURIComponent('@adf/adapter-test')
    await server.inject({ method: 'DELETE', url: `/admin/mcp/packages/npm?package=${encodedMcp}` })
    await server.inject({ method: 'DELETE', url: '/admin/mcp/packages/python?package=mcp-server-time' })
    await server.inject({ method: 'DELETE', url: `/admin/adapters/packages?package=${encodedAdapter}` })
    const sandboxDelete = await server.inject({ method: 'DELETE', url: '/admin/sandbox/packages?name=lodash' })
    expect(sandboxDelete.json()).toEqual({ success: true })
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/packages' })).json()).toEqual({ packages: [] })
  })

  it('exposes ChatGPT subscription auth status', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const status = await server.inject({ method: 'GET', url: '/auth/chatgpt/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual(expect.objectContaining({
      authenticated: expect.any(Boolean),
    }))
  })

  it('exposes health, agent listing, and async chat acknowledgement', async () => {
    const provider = new MockLLMProvider({ tokensPerResponse: 120 })
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'api-agent', provider })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const health = await server.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ ok: true })

    const list = await server.inject({ method: 'GET', url: '/agents' })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ref.id, name: 'api-agent' }),
    ]))

    const chat = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/chat`,
      payload: { text: 'hello daemon' },
    })
    expect(chat.statusCode).toBe(202)
    expect(chat.json()).toEqual(expect.objectContaining({
      accepted: true,
      turnId: expect.stringMatching(/^turn_/),
    }))

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(provider.getCallCount()).toBeGreaterThan(0)

    const status = await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual(expect.objectContaining({
      id: ref.id,
      name: 'api-agent',
      runtimeState: 'idle',
      loopCount: expect.any(Number),
    }))

    const loop = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?limit=10` })
    expect(loop.statusCode).toBe(200)
    expect(loop.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      total: expect.any(Number),
      limit: 10,
      offset: expect.any(Number),
      entries: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content_json: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('hello daemon') }),
          ]),
        }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
    }))

    const usage = await server.inject({ method: 'GET', url: `/agents/${ref.id}/usage` })
    expect(usage.statusCode).toBe(200)
    expect(usage.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      source: 'adf_loop',
      usageRows: expect.any(Number),
      totals: expect.objectContaining({ input: 120, output: 120, total: 240 }),
      byModel: expect.arrayContaining([
        expect.objectContaining({ model: 'mock-v1', input: 120, output: 120, total: 240 }),
      ]),
    }))
  })

  it('accepts a generic trigger dispatch into an agent loop', async () => {
    const provider = new MockLLMProvider({ tokensPerResponse: 120 })
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'trigger-agent', provider })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const trigger = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/trigger`,
      payload: {
        type: 'chat',
        source: 'daemon-test',
        data: {
          message: {
            seq: Date.now(),
            role: 'user',
            content_json: [{ type: 'text', text: 'hello from generic trigger' }],
            created_at: Date.now(),
          },
        },
        target: { scope: 'agent' },
      },
    })
    expect(trigger.statusCode).toBe(202)
    expect(trigger.json()).toEqual(expect.objectContaining({
      accepted: true,
      turnId: expect.stringMatching(/^trigger_/),
    }))

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(provider.getCallCount()).toBeGreaterThan(0)

    const loop = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?limit=10` })
    expect(loop.statusCode).toBe(200)
    expect(loop.json()).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content_json: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'hello from generic trigger' }),
          ]),
        }),
      ]),
    }))
  })

  it('exposes runtime token usage totals', async () => {
    const tokenUsage = getTokenUsageService()
    tokenUsage.clearAll()
    tokenUsage.recordUsage('mock-provider', 'mock-model', 10, 20)
    tokenUsage.recordUsage('mock-provider', 'mock-model', 5, 7)
    tokenUsage.recordUsage('other-provider', 'other-model', 3, 4)

    const runtime = new RuntimeService({ enforceReviewGate: false })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const usage = await server.inject({ method: 'GET', url: '/runtime/usage' })
    expect(usage.statusCode).toBe(200)
    expect(usage.json()).toEqual(expect.objectContaining({
      source: 'token-usage-service',
      totals: { input: 18, output: 31, total: 49 },
      byProvider: expect.arrayContaining([
        expect.objectContaining({ provider: 'mock-provider', input: 15, output: 27, total: 42 }),
        expect.objectContaining({ provider: 'other-provider', input: 3, output: 4, total: 7 }),
      ]),
      byModel: expect.arrayContaining([
        expect.objectContaining({ provider: 'mock-provider', model: 'mock-model', input: 15, output: 27, total: 42, days: 1 }),
      ]),
    }))

    tokenUsage.clearAll()
  })

  it('counts tokens and reports model list errors through runtime utility endpoints', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      name: 'utility-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        model: { provider: 'openai', model_id: 'gpt-test' },
      },
    })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const count = await server.inject({
      method: 'POST',
      url: '/runtime/token-count',
      payload: { text: 'hello daemon', agentId: ref.id },
    })
    expect(count.statusCode).toBe(200)
    expect(count.json()).toEqual(expect.objectContaining({
      count: expect.any(Number),
      provider: 'openai',
      model: 'gpt-test',
    }))
    expect(count.json().count).toBeGreaterThan(0)

    const batch = await server.inject({
      method: 'POST',
      url: '/runtime/token-count/batch',
      payload: { texts: ['one', 'two'], provider: 'anthropic', model: 'claude-test' },
    })
    expect(batch.statusCode).toBe(200)
    expect(batch.json()).toEqual(expect.objectContaining({
      counts: [expect.any(Number), expect.any(Number)],
      provider: 'anthropic',
      model: 'claude-test',
    }))

    const missingModels = await server.inject({ method: 'GET', url: '/runtime/models?provider=missing' })
    expect(missingModels.statusCode).toBe(200)
    expect(missingModels.json()).toEqual(expect.objectContaining({
      provider: 'missing',
      models: [],
      error: expect.stringContaining('not found'),
    }))
  })

  it('exposes daemon and per-agent diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-diagnostics-'))
    const filePath = join(dir, 'diagnostics-agent.adf')
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      filePath,
      name: 'diagnostics-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        mcp: {
          servers: [{
            name: 'github',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          }],
        },
        adapters: {
          telegram: {
            enabled: true,
            config: {},
          },
        },
        ws_connections: [{
          id: 'relay',
          url: 'ws://127.0.0.1:9999/ws',
          enabled: true,
        }],
        triggers: {
          on_inbox: {
            enabled: true,
            targets: [{ scope: 'agent' }],
          },
        },
      },
    })
    const server = createDaemonHttpApi(runtime, {
      wsService: {
        getConnections: () => [{
            connection_id: 'conn_1',
            remote_did: 'did:key:test',
            direction: 'outbound',
            connected_at: 123,
            last_message_at: 456,
          }],
      },
    })
    servers.push(server)

    const diagnostics = await server.inject({ method: 'GET', url: '/diagnostics' })
    expect(diagnostics.statusCode).toBe(200)
    expect(diagnostics.json()).toEqual(expect.objectContaining({
      daemon: expect.objectContaining({ pid: expect.any(Number), uptime: expect.any(Number) }),
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: ref.id,
          ws: { configured: 1, active: 1 },
        }),
      ]),
    }))

    const adapters = await server.inject({ method: 'GET', url: `/agents/${ref.id}/adapters` })
    expect(adapters.statusCode).toBe(200)
    expect(adapters.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      configured: [expect.objectContaining({ type: 'telegram', enabled: true })],
    }))

    const mcp = await server.inject({ method: 'GET', url: `/agents/${ref.id}/mcp` })
    expect(mcp.statusCode).toBe(200)
    expect(mcp.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      configured: [expect.objectContaining({ name: 'github', command: 'node' })],
    }))

    const triggers = await server.inject({ method: 'GET', url: `/agents/${ref.id}/triggers` })
    expect(triggers.statusCode).toBe(200)
    expect(triggers.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      configured: expect.arrayContaining([
        expect.objectContaining({ type: 'on_inbox', enabled: true, targetCount: 1 }),
      ]),
    }))

    const ws = await server.inject({ method: 'GET', url: `/agents/${ref.id}/ws` })
    expect(ws.statusCode).toBe(200)
    expect(ws.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      configured: [expect.objectContaining({ id: 'relay', enabled: true })],
      active: [expect.objectContaining({ connection_id: 'conn_1', direction: 'outbound' })],
    }))
  })

  it('exposes daemon-level runtime diagnostics without secrets', async () => {
    const data: Record<string, unknown> = {
      providers: [{
        id: 'openai-main',
        type: 'openai',
        name: 'OpenAI Main',
        baseUrl: '',
        apiKey: 'sk-secret',
        defaultModel: 'gpt-test',
      }],
      mcpServers: [{
        id: 'github',
        name: 'github',
        type: 'npm',
        npmPackage: '@modelcontextprotocol/server-github',
        env: [{ key: 'GITHUB_TOKEN', value: 'gh-secret' }],
      }],
      adapters: [{
        id: 'telegram',
        type: 'telegram',
        env: [{ key: 'BOT_TOKEN', value: 'bot-secret' }],
      }],
      trackedDirectories: ['/tmp/agents'],
      meshEnabled: true,
      meshLan: false,
      meshPort: 7295,
      maxDirectoryScanDepth: 4,
      autoCompactThreshold: 123456,
    }
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      name: 'runtime-diag-agent',
      provider: new MockLLMProvider(),
      createOptions: {
        handle: 'runtime-diag-agent',
        model: { provider: 'openai-main', model_id: 'gpt-test' },
        messaging: { receive: true, mode: 'proactive', network: 'devnet' },
        serving: { api: [{ method: 'GET', path: '/api/health', lambda: 'api/health.ts:onRequest' }] },
      },
    })
    const server = createDaemonHttpApi(runtime, {
      settingsStore: {
        filePath: '/tmp/adf-settings.json',
        get: key => data[key],
        getAll: () => ({ ...data }),
      },
      wsService: {
        getConnections: () => [{
          connection_id: 'ws_1',
          remote_did: 'did:key:test',
          direction: 'inbound',
          connected_at: 123,
          last_message_at: 456,
        }],
      },
      networkService: {
        getStatus: () => ({ meshEnabled: true, meshServerRunning: true }),
      },
    })
    servers.push(server)

    const providers = await server.inject({ method: 'GET', url: '/runtime/providers' })
    expect(providers.statusCode).toBe(200)
    expect(providers.json()).toEqual(expect.objectContaining({
      providers: [expect.objectContaining({ id: 'openai-main', hasApiKey: true })],
      agentUsage: [expect.objectContaining({
        agentId: ref.id,
        providerId: 'openai-main',
        source: 'app',
      })],
    }))
    expect(JSON.stringify(providers.json())).not.toContain('sk-secret')

    const mcp = await server.inject({ method: 'GET', url: '/runtime/mcp' })
    expect(mcp.statusCode).toBe(200)
    expect(mcp.json()).toEqual({
      servers: [expect.objectContaining({
        id: 'github',
        env: [{ key: 'GITHUB_TOKEN', hasValue: true }],
      })],
    })
    expect(JSON.stringify(mcp.json())).not.toContain('gh-secret')

    const adapters = await server.inject({ method: 'GET', url: '/runtime/adapters' })
    expect(adapters.statusCode).toBe(200)
    expect(adapters.json()).toEqual(expect.objectContaining({
      adapters: expect.arrayContaining([expect.objectContaining({
        id: 'telegram',
        type: 'telegram',
        env: [{ key: 'BOT_TOKEN', hasValue: true }],
      }), expect.objectContaining({
        id: 'email',
        type: 'email',
      })]),
    }))
    expect(JSON.stringify(adapters.json())).not.toContain('bot-secret')

    const network = await server.inject({ method: 'GET', url: '/runtime/network' })
    expect(network.statusCode).toBe(200)
    expect(network.json()).toEqual(expect.objectContaining({
      mesh: expect.objectContaining({
        enabledSetting: true,
        port: 7295,
        status: { meshEnabled: true, meshServerRunning: true },
      }),
      websocket: {
        activeConnections: 1,
        inboundConnections: 1,
        outboundConnections: 0,
      },
      agents: [expect.objectContaining({
        agentId: ref.id,
        handle: 'runtime-diag-agent',
        receive: true,
        servingRoutes: 1,
      })],
    }))

    const settings = await server.inject({ method: 'GET', url: '/runtime/settings' })
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toEqual(expect.objectContaining({
      filePath: '/tmp/adf-settings.json',
      trackedDirectories: ['/tmp/agents'],
      maxDirectoryScanDepth: 4,
      autoCompactThreshold: 123456,
      packageCounts: expect.objectContaining({ providers: 1, mcpServers: 1, adapters: 2 }),
    }))
  })

  it('stops by unloading and exposes abort as current-turn cancellation', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const stopRef = runtime.createAgent({
      name: 'stop-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'stop-agent' },
    })
    const abortRef = runtime.createAgent({
      name: 'abort-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'abort-agent' },
    })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const stopped = await server.inject({ method: 'POST', url: '/agents/stop-agent/stop' })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json()).toEqual({ success: true })
    expect(runtime.getAgent(stopRef.id)).toBeUndefined()

    const aborted = await server.inject({ method: 'POST', url: '/agents/abort-agent/abort' })
    expect(aborted.statusCode).toBe(200)
    expect(aborted.json()).toEqual({ success: true })
    expect(runtime.getAgent(abortRef.id)).toBeDefined()

    const unloaded = await server.inject({ method: 'POST', url: '/agents/abort-agent/unload' })
    expect(unloaded.statusCode).toBe(200)
    expect(unloaded.json()).toEqual({ success: true })
    expect(runtime.getAgent(abortRef.id)).toBeUndefined()
  })

  it('starts an unloaded tracked agent by handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-start-tracked-'))
    const filePath = join(dir, 'agent-1.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'agent-1',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'agent-1', autostart: true },
    })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const runtime = new RuntimeService({
      settings: {
        get: key => {
          if (key === 'reviewedAgents') return [agentId]
          if (key === 'trackedDirectories') return [dir]
          if (key === 'maxDirectoryScanDepth') return 0
          return undefined
        },
      },
      providerFactory: () => new MockLLMProvider({ tokensPerResponse: 120 }),
    })
    const loaded = await runtime.loadAgent(filePath)
    await runtime.unloadAgent(loaded.id)
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const restarted = await server.inject({ method: 'POST', url: '/agents/agent-1/start' })

    expect(restarted.statusCode).toBe(200)
    expect(restarted.json()).toEqual(expect.objectContaining({
      success: true,
      loaded: true,
      startupTriggered: true,
      agent: expect.objectContaining({ id: agentId, handle: 'agent-1' }),
    }))
  })

  it('exposes and resolves agent tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-tasks-'))
    const filePath = join(dir, 'task-agent.adf')
    const seeded = createHeadlessAgent({
      filePath,
      name: 'task-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'task-agent' },
    })
    seeded.workspace.insertTask('task_pending', 'fs_write', JSON.stringify({ path: 'x.md', content: 'hello' }), 'hil:test', true, true)
    seeded.workspace.updateTaskStatus('task_pending', 'pending_approval')
    seeded.dispose()

    const runtime = new RuntimeService({
      enforceReviewGate: false,
      providerFactory: () => new MockLLMProvider(),
    })
    const ref = await runtime.loadAgent(filePath)
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const tasks = await server.inject({ method: 'GET', url: '/agents/task-agent/tasks?status=pending_approval' })
    expect(tasks.statusCode).toBe(200)
    expect(tasks.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      tasks: [expect.objectContaining({
        id: 'task_pending',
        status: 'pending_approval',
        tool: 'fs_write',
        requires_authorization: true,
      })],
    }))

    const task = await server.inject({ method: 'GET', url: '/agents/task-agent/tasks/task_pending' })
    expect(task.statusCode).toBe(200)
    expect(task.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      task: expect.objectContaining({ id: 'task_pending' }),
    }))

    const denied = await server.inject({
      method: 'POST',
      url: '/agents/task-agent/tasks/task_pending/resolve',
      payload: { action: 'deny', reason: 'not now' },
    })
    expect(denied.statusCode).toBe(200)
    expect(denied.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      taskId: 'task_pending',
      resolution: expect.objectContaining({ status: 'denied' }),
      task: expect.objectContaining({ status: 'denied', error: 'not now' }),
    }))
  })

  it('exposes read-only persistent resources by id or handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-resources-'))
    const filePath = join(dir, 'resource-agent.adf')
    const seeded = createHeadlessAgent({
      filePath,
      name: 'resource-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'resource-agent' },
    })
    seeded.workspace.writeFile('notes.md', 'hello from resource endpoint')
    seeded.workspace.writeFileBuffer('image.bin', Buffer.from([0, 1, 2, 3]), 'application/octet-stream')
    seeded.workspace.addToInbox({
      from: 'telegram:user',
      content: 'hello inbox',
      received_at: Date.now(),
      status: 'unread',
      source: 'telegram',
    })
    seeded.workspace.addToOutbox({
      from: 'resource-agent',
      to: 'telegram:user',
      content: 'hello outbox',
      created_at: Date.now(),
      status: 'pending',
    })
    seeded.workspace.addTimer({ mode: 'once', at: Date.now() + 60_000 }, Date.now() + 60_000, 'wake up')
    seeded.workspace.setIdentity('telegram:bot_token', 'secret-token')
    const agentId = seeded.workspace.getAgentConfig().id
    seeded.dispose()

    const runtime = new RuntimeService({
      enforceReviewGate: false,
      providerFactory: () => new MockLLMProvider(),
    })
    const ref = await runtime.loadAgent(filePath)
    expect(ref.id).toBe(agentId)

    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const config = await server.inject({ method: 'GET', url: '/agents/resource-agent/config' })
    expect(config.statusCode).toBe(200)
    expect(config.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      config: expect.objectContaining({ name: 'resource-agent', handle: 'resource-agent' }),
    }))

    const files = await server.inject({ method: 'GET', url: '/agents/resource-agent/files' })
    expect(files.statusCode).toBe(200)
    expect(files.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'notes.md' }),
        expect.objectContaining({ path: 'image.bin' }),
      ]),
    }))

    const textFile = await server.inject({
      method: 'GET',
      url: '/agents/resource-agent/files/content?path=notes.md',
    })
    expect(textFile.statusCode).toBe(200)
    expect(textFile.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      path: 'notes.md',
      encoding: 'utf-8',
      content: 'hello from resource endpoint',
    }))

    const binaryFile = await server.inject({
      method: 'GET',
      url: '/agents/resource-agent/files/content?path=image.bin',
    })
    expect(binaryFile.statusCode).toBe(200)
    expect(binaryFile.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      path: 'image.bin',
      encoding: 'base64',
      content_base64: Buffer.from([0, 1, 2, 3]).toString('base64'),
    }))

    const inbox = await server.inject({ method: 'GET', url: '/agents/resource-agent/inbox?status=unread' })
    expect(inbox.statusCode).toBe(200)
    expect(inbox.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      messages: [expect.objectContaining({ content: 'hello inbox', source: 'telegram' })],
    }))

    const outbox = await server.inject({ method: 'GET', url: '/agents/resource-agent/outbox?status=pending' })
    expect(outbox.statusCode).toBe(200)
    expect(outbox.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      messages: [expect.objectContaining({ content: 'hello outbox' })],
    }))

    const timers = await server.inject({ method: 'GET', url: '/agents/resource-agent/timers' })
    expect(timers.statusCode).toBe(200)
    expect(timers.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      timers: [expect.objectContaining({ payload: 'wake up' })],
    }))

    const identities = await server.inject({ method: 'GET', url: '/agents/resource-agent/identities' })
    expect(identities.statusCode).toBe(200)
    expect(identities.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      identities: [expect.objectContaining({ purpose: 'telegram:bot_token', encrypted: false })],
    }))
    expect(JSON.stringify(identities.json())).not.toContain('secret-token')
  })

  it('mutates persistent ADF resources through daemon endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-crud-'))
    const filePath = join(dir, 'crud-agent.adf')
    const seeded = createHeadlessAgent({
      filePath,
      name: 'crud-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'crud-agent' },
    })
    seeded.workspace.insertLog('info', 'test', 'seed', null, 'before clear')
    seeded.workspace.executeSQL('CREATE TABLE local_items (id INTEGER PRIMARY KEY, name TEXT)')
    seeded.workspace.executeSQL('INSERT INTO local_items (name) VALUES (?)', ['one'])
    seeded.dispose()

    const runtime = new RuntimeService({
      enforceReviewGate: false,
      providerFactory: () => new MockLLMProvider(),
    })
    const ref = await runtime.loadAgent(filePath)
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const document = await server.inject({
      method: 'PUT',
      url: '/agents/crud-agent/document',
      payload: { content: '# Updated document' },
    })
    expect(document.statusCode).toBe(200)
    expect(document.json()).toEqual(expect.objectContaining({ agentId: ref.id, success: true }))
    const documentRead = await server.inject({ method: 'GET', url: '/agents/crud-agent/document' })
    expect(documentRead.json()).toEqual(expect.objectContaining({ content: '# Updated document' }))

    const mind = await server.inject({
      method: 'PUT',
      url: '/agents/crud-agent/mind',
      payload: { content: 'new memory' },
    })
    expect(mind.statusCode).toBe(200)
    const mindRead = await server.inject({ method: 'GET', url: '/agents/crud-agent/mind' })
    expect(mindRead.json()).toEqual(expect.objectContaining({ content: 'new memory' }))

    const config = await server.inject({
      method: 'PUT',
      url: '/agents/crud-agent/config',
      payload: { ...ref.config, description: 'updated by daemon crud test' },
    })
    expect(config.statusCode).toBe(200)
    expect(config.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      success: true,
      config: expect.objectContaining({ description: 'updated by daemon crud test' }),
    }))

    const fileWrite = await server.inject({
      method: 'PUT',
      url: '/agents/crud-agent/files/content?path=notes.md',
      payload: { content: 'daemon note', protection: 'none' },
    })
    expect(fileWrite.statusCode).toBe(200)
    const fileRead = await server.inject({ method: 'GET', url: '/agents/crud-agent/files/content?path=notes.md' })
    expect(fileRead.json()).toEqual(expect.objectContaining({ content: 'daemon note' }))

    const renamed = await server.inject({
      method: 'POST',
      url: '/agents/crud-agent/files/rename',
      payload: { oldPath: 'notes.md', newPath: 'renamed.md' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toEqual(expect.objectContaining({ success: true }))
    const protection = await server.inject({
      method: 'PATCH',
      url: '/agents/crud-agent/files/protection',
      payload: { path: 'renamed.md', protection: 'read_only' },
    })
    expect(protection.statusCode).toBe(200)
    const authorized = await server.inject({
      method: 'PATCH',
      url: '/agents/crud-agent/files/authorized',
      payload: { path: 'renamed.md', authorized: true },
    })
    expect(authorized.statusCode).toBe(200)
    const renamedRead = await server.inject({ method: 'GET', url: '/agents/crud-agent/files/content?path=renamed.md' })
    expect(renamedRead.json()).toEqual(expect.objectContaining({ protection: 'read_only', authorized: true }))

    const meta = await server.inject({
      method: 'PUT',
      url: '/agents/crud-agent/meta/test-key',
      payload: { value: 'test-value', protection: 'none' },
    })
    expect(meta.statusCode).toBe(200)
    const metaList = await server.inject({ method: 'GET', url: '/agents/crud-agent/meta' })
    expect(metaList.json()).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([expect.objectContaining({ key: 'test-key', value: 'test-value' })]),
    }))

    const timer = await server.inject({
      method: 'POST',
      url: '/agents/crud-agent/timers',
      payload: { mode: 'once_delay', delay_ms: 60_000, scope: ['agent'], payload: 'wake' },
    })
    expect(timer.statusCode).toBe(200)
    expect(timer.json()).toEqual(expect.objectContaining({ success: true, id: expect.any(Number) }))
    const timerId = timer.json().id as number
    const timerUpdate = await server.inject({
      method: 'PUT',
      url: `/agents/crud-agent/timers/${timerId}`,
      payload: { mode: 'once_delay', delay_ms: 120_000, scope: ['agent'], payload: 'wake later' },
    })
    expect(timerUpdate.statusCode).toBe(200)
    const timerDelete = await server.inject({ method: 'DELETE', url: `/agents/crud-agent/timers/${timerId}` })
    expect(timerDelete.statusCode).toBe(200)

    const table = await server.inject({ method: 'GET', url: '/agents/crud-agent/tables/local_items' })
    expect(table.statusCode).toBe(200)
    expect(table.json()).toEqual(expect.objectContaining({
      rows: [expect.objectContaining({ name: 'one' })],
    }))

    const logsAfter = await server.inject({ method: 'GET', url: '/agents/crud-agent/logs/after?afterId=0' })
    expect(logsAfter.statusCode).toBe(200)
    expect(logsAfter.json()).toEqual(expect.objectContaining({
      logs: expect.arrayContaining([expect.objectContaining({ message: 'before clear' })]),
    }))
    const logsClear = await server.inject({ method: 'DELETE', url: '/agents/crud-agent/logs' })
    expect(logsClear.statusCode).toBe(200)
  })

  it('manages identity and agent-scoped credentials through daemon endpoints', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({
      name: 'credential-agent',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'credential-agent' },
    })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const purpose = encodeURIComponent('test:secret')
    const identitySet = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/identity/${purpose}`,
      payload: { value: 'identity-secret' },
    })
    expect(identitySet.statusCode).toBe(200)
    const identityGet = await server.inject({ method: 'GET', url: `/agents/${ref.id}/identity/${purpose}` })
    expect(identityGet.json()).toEqual(expect.objectContaining({
      agentId: ref.id,
      purpose: 'test:secret',
      value: 'identity-secret',
    }))

    const codeAccess = await server.inject({
      method: 'PATCH',
      url: `/agents/${ref.id}/identity/${purpose}/code-access`,
      payload: { codeAccess: true },
    })
    expect(codeAccess.statusCode).toBe(200)
    const identityEntries = await server.inject({ method: 'GET', url: `/agents/${ref.id}/identity/entries` })
    expect(identityEntries.json()).toEqual(expect.objectContaining({
      identities: expect.arrayContaining([
        expect.objectContaining({ purpose: 'test:secret', encrypted: false, code_access: true }),
      ]),
    }))

    const passwordSet = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/identity/password`,
      payload: { password: 'pw-test' },
    })
    expect(passwordSet.statusCode).toBe(200)
    const passwordStatus = await server.inject({ method: 'GET', url: `/agents/${ref.id}/identity/password` })
    expect(passwordStatus.json()).toEqual(expect.objectContaining({
      needsPassword: true,
      unlocked: true,
    }))
    const encryptedEntries = await server.inject({ method: 'GET', url: `/agents/${ref.id}/identity/entries` })
    expect(encryptedEntries.json()).toEqual(expect.objectContaining({
      identities: expect.arrayContaining([
        expect.objectContaining({ purpose: 'test:secret', encrypted: true }),
      ]),
    }))
    const passwordRemove = await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/identity/password` })
    expect(passwordRemove.statusCode).toBe(200)

    const providerCredential = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/providers/openai-main/credential`,
      payload: { value: 'sk-test' },
    })
    expect(providerCredential.statusCode).toBe(200)
    const providerAttach = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/providers`,
      payload: {
        provider: {
          id: 'openai-main',
          type: 'openai',
          name: 'OpenAI Main',
          baseUrl: '',
          defaultModel: 'gpt-test',
        },
      },
    })
    expect(providerAttach.statusCode).toBe(200)
    const providerCredentials = await server.inject({ method: 'GET', url: `/agents/${ref.id}/providers/openai-main/credentials` })
    expect(providerCredentials.json()).toEqual(expect.objectContaining({
      credentials: { apiKey: 'sk-test' },
      providerConfig: expect.objectContaining({ defaultModel: 'gpt-test' }),
    }))

    const mcpPackage = '@modelcontextprotocol/server-github'
    const mcpCredential = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/mcp/credentials`,
      payload: { npmPackage: mcpPackage, envKey: 'GITHUB_TOKEN', value: 'gh-secret' },
    })
    expect(mcpCredential.statusCode).toBe(200)
    const mcpAttach = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/mcp/servers`,
      payload: {
        server: {
          name: 'github',
          transport: 'stdio',
          source: `npm:${mcpPackage}`,
          npm_package: mcpPackage,
          env_keys: ['GITHUB_TOKEN'],
        },
      },
    })
    expect(mcpAttach.statusCode).toBe(200)
    const mcpCredentials = await server.inject({
      method: 'GET',
      url: `/agents/${ref.id}/mcp/credentials?npmPackage=${encodeURIComponent(mcpPackage)}`,
    })
    expect(mcpCredentials.json()).toEqual(expect.objectContaining({
      credentials: { GITHUB_TOKEN: 'gh-secret' },
    }))

    const adapterCredential = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/adapters/credentials`,
      payload: { adapterType: 'telegram', envKey: 'BOT_TOKEN', value: 'bot-secret' },
    })
    expect(adapterCredential.statusCode).toBe(200)
    const adapterAttach = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/adapters`,
      payload: { adapterType: 'telegram', config: { enabled: true, credential_key: 'BOT_TOKEN' } },
    })
    expect(adapterAttach.statusCode).toBe(200)
    const adapterCredentials = await server.inject({
      method: 'GET',
      url: `/agents/${ref.id}/adapters/credentials?adapterType=telegram`,
    })
    expect(adapterCredentials.json()).toEqual(expect.objectContaining({
      credentials: { BOT_TOKEN: 'bot-secret' },
    }))

    const config = await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })
    expect(config.json()).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        providers: [expect.objectContaining({ id: 'openai-main' })],
        mcp: expect.objectContaining({
          servers: [expect.objectContaining({ name: 'github' })],
        }),
        adapters: expect.objectContaining({
          telegram: expect.objectContaining({ enabled: true }),
        }),
      }),
    }))

    const adapterDetach = await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/adapters/telegram` })
    expect(adapterDetach.statusCode).toBe(200)
    expect(adapterDetach.json()).toEqual(expect.objectContaining({ deletedCredentials: 1 }))
    const mcpDetach = await server.inject({
      method: 'DELETE',
      url: `/agents/${ref.id}/mcp/servers/github?credentialNamespace=${encodeURIComponent(mcpPackage)}`,
    })
    expect(mcpDetach.statusCode).toBe(200)
    expect(mcpDetach.json()).toEqual(expect.objectContaining({ deletedCredentials: 1 }))
    const providerDetach = await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/providers/openai-main` })
    expect(providerDetach.statusCode).toBe(200)
    expect(providerDetach.json()).toEqual(expect.objectContaining({ deletedCredentials: 1 }))
  })

  it('loads directly by default but can enforce review for stricter clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-load-'))
    const filePath = join(dir, 'unreviewed.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'unreviewed',
      provider: new MockLLMProvider(),
    })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const runtime = new RuntimeService({
      settings: { get: () => [] },
      providerFactory: () => new MockLLMProvider(),
    })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const directLoad = await server.inject({
      method: 'POST',
      url: '/agents/load',
      payload: { filePath },
    })
    expect(directLoad.statusCode).toBe(200)
    expect(directLoad.json()).toEqual(expect.objectContaining({ id: agentId }))

    await runtime.unloadAgent(agentId)

    const strictLoad = await server.inject({
      method: 'POST',
      url: '/agents/load',
      payload: { filePath, requireReview: true },
    })

    expect(strictLoad.statusCode).toBe(403)
    expect(strictLoad.json()).toEqual(expect.objectContaining({
      code: 'AGENT_REVIEW_REQUIRED',
      agentId,
    }))
  })

  it('returns review info and can accept review through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-api-review-'))
    const filePath = join(dir, 'review-me.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'review-me',
      provider: new MockLLMProvider(),
    })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const settings = {
      reviewedAgents: [] as string[],
      get(key: string): unknown {
        return key === 'reviewedAgents' ? this.reviewedAgents : undefined
      },
      set(key: string, value: unknown): void {
        if (key === 'reviewedAgents') this.reviewedAgents = value as string[]
      },
    }
    const runtime = new RuntimeService({
      settings,
      providerFactory: () => new MockLLMProvider(),
    })
    const server = createDaemonHttpApi(runtime)
    servers.push(server)

    const before = await server.inject({
      method: 'GET',
      url: `/agents/review?filePath=${encodeURIComponent(filePath)}`,
    })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toEqual(expect.objectContaining({
      agentId,
      reviewed: false,
      summary: expect.objectContaining({ name: 'review-me' }),
    }))

    const accepted = await server.inject({
      method: 'POST',
      url: '/agents/review/accept',
      payload: { filePath },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual(expect.objectContaining({ agentId, reviewed: true }))

    const strictLoad = await server.inject({
      method: 'POST',
      url: '/agents/load',
      payload: { filePath, requireReview: true },
    })
    expect(strictLoad.statusCode).toBe(200)
    expect(strictLoad.json()).toEqual(expect.objectContaining({ id: agentId }))
  })
})
