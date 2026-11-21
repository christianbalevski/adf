import { describe, expect, it, vi } from 'vitest'

import type { McpServerConfig, McpToolInfo } from '../../../src/shared/types/adf-v02.types'

/**
 * Controllable mock of the SDK Client: connect() and listTools() return
 * deferred promises the test settles explicitly, so a disconnect() can be
 * interleaved with an in-flight connection attempt.
 */
const h = vi.hoisted(() => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    promise.catch(() => { /* mark handled — abandoned attempts never rethrow */ })
    return { promise, resolve, reject }
  }

  class MockClient {
    static instances: MockClient[] = []
    onclose: (() => void) | undefined
    closed = false
    connectDeferred = deferred<void>()
    listToolsDeferred = deferred<{ tools: Array<Record<string, unknown>> }>()
    /** What getServerVersion() reports post-initialize (SDK: Implementation | undefined). */
    serverInfo: { name: string; version: string } | undefined
    constructor() {
      MockClient.instances.push(this)
    }
    connect(_transport: unknown): Promise<void> {
      return this.connectDeferred.promise
    }
    listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      return this.listToolsDeferred.promise
    }
    getServerVersion(): { name: string; version: string } | undefined {
      return this.serverInfo
    }
    async close(): Promise<void> {
      this.closed = true
    }
    async ping(): Promise<void> {}
  }

  return { MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client', () => ({ Client: h.MockClient }))

// Imported after the mock so the manager sees the mocked Client
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

function fakeTransport() {
  return {
    closed: false,
    async start(): Promise<void> {},
    async send(): Promise<void> {},
    async close(): Promise<void> {
      this.closed = true
    }
  }
}

function serverConfig(name = 's'): McpServerConfig {
  return { name, transport: 'stdio', command: 'noop' } as McpServerConfig
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('McpClientManager stale-connect guard', () => {
  it('closes and settles a pending initialize during disconnectAll(), even if the SDK never answers', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!

    // Agent stops while the connection attempt is still awaiting client.connect
    await manager.disconnectAll()
    expect(await connectPromise).toBeNull()
    expect(client.closed).toBe(true)
    expect(transport.closed).toBe(true)
    expect(manager.getServerState('s')).toBeNull()

    const events: string[] = []
    manager.on('status-changed', (name, status) => events.push(`status:${name}:${status}`))
    manager.on('tools-discovered', (name) => events.push(`tools:${name}`))

    // The in-flight connect now succeeds against the deleted entry
    client.connectDeferred.resolve()
    await flush()
    // The deleted entry must not be resurrected and nothing may be emitted
    expect(manager.getServerState('s')).toBeNull()
    expect(manager.getServerStates()).toEqual([])
    expect(events).toEqual([])
  })

  it('abandons a connect that becomes stale during listTools()', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!

    client.connectDeferred.resolve()
    await flush() // now awaiting listTools()

    await manager.disconnectAll()
    expect(await connectPromise).toBeNull()
    expect(client.closed).toBe(true)
    expect(transport.closed).toBe(true)
    expect(manager.getServerState('s')).toBeNull()
    client.listToolsDeferred.reject(new Error('late discovery failure'))
    await flush()
    expect(manager.getServerStates()).toEqual([])
  })

  it('a stale attempt resolving late does not clobber a re-added server of the same name', async () => {
    const manager = new McpClientManager()
    const transport1 = fakeTransport()

    const first = manager.connect(serverConfig(), { externalTransport: transport1 })
    const client1 = h.MockClient.instances.at(-1)!

    await manager.disconnect('s')

    // Same name re-added and connects successfully
    const transport2 = fakeTransport()
    const second = manager.connect(serverConfig(), { externalTransport: transport2 })
    const client2 = h.MockClient.instances.at(-1)!
    expect(client2).not.toBe(client1)
    client2.connectDeferred.resolve()
    await flush()
    client2.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })
    const tools2 = await second
    expect(tools2).toHaveLength(1)
    expect(manager.isConnected('s')).toBe(true)

    // The ORIGINAL attempt now succeeds — it must abandon, not double-register
    client1.connectDeferred.resolve()
    const tools1 = await first

    expect(tools1).toBeNull()
    expect(client1.closed).toBe(true)
    expect(transport1.closed).toBe(true)
    expect(client2.closed).toBe(false)
    expect(transport2.closed).toBe(false)
    expect(manager.isConnected('s')).toBe(true)
    expect(manager.getServerState('s')?.toolCount).toBe(1)
  })

  it('stops a replacement waiting to close the old entry when the manager unloads', async () => {
    const manager = new McpClientManager()
    const first = manager.connect(serverConfig(), { externalTransport: fakeTransport() })
    const client = h.MockClient.instances.at(-1)!
    const instances = h.MockClient.instances.length
    let release!: () => void
    client.close = async () => new Promise<void>((resolve) => { release = resolve })
    const replacement = manager.connect(serverConfig(), { externalTransport: fakeTransport() })
    await flush()
    const closing = manager.disconnectAll()
    release()
    await closing
    expect(await first).toBeNull()
    expect(await replacement).toBeNull()
    expect(h.MockClient.instances).toHaveLength(instances)
    expect(manager.getServerState('s')).toBeNull()
    client.connectDeferred.resolve()
  })

  it('can restart immediately after cancelling the pending attempt', async () => {
    const manager = new McpClientManager()
    const first = manager.connect(serverConfig(), { externalTransport: fakeTransport() })
    const original = h.MockClient.instances.at(-1)!
    try {
      const restarted = manager.restart('s')
      expect(await first).toBeNull()
      await flush()
      const next = h.MockClient.instances.at(-1)!
      expect(next).not.toBe(original)
      next.connectDeferred.resolve()
      next.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })
      expect(await restarted).toHaveLength(1)
      original.connectDeferred.resolve()
      expect(manager.isConnected('s')).toBe(true)
    } finally {
      await manager.disconnectAll()
    }
  })

  it('exposes the server-reported version from the initialize handshake after connect', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!
    client.serverInfo = { name: 'mock-server', version: '1.2.3' }
    client.connectDeferred.resolve()
    await flush()
    client.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })
    await connectPromise

    expect(manager.getServerReportedVersion('s')).toBe('1.2.3')

    await manager.disconnect('s')
    expect(manager.getServerReportedVersion('s')).toBeUndefined()
  })

  it('reports undefined when the server sends no version info', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!
    client.serverInfo = undefined
    client.connectDeferred.resolve()
    await flush()
    client.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })
    await connectPromise

    expect(manager.isConnected('s')).toBe(true)
    expect(manager.getServerReportedVersion('s')).toBeUndefined()

    await manager.disconnect('s')
  })

  it('a throwing tools-discovered listener does not break the connect path', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()
    manager.on('tools-discovered', () => { throw new Error('listener boom') })
    manager.on('status-changed', () => { throw new Error('listener boom') })

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!
    client.connectDeferred.resolve()
    await flush()
    client.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })

    const tools = (await connectPromise) as McpToolInfo[]
    expect(tools).toHaveLength(1)
    expect(manager.isConnected('s')).toBe(true)

    await manager.disconnect('s')
    expect(manager.getServerState('s')).toBeNull()
  })
})
