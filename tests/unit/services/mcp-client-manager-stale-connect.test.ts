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
    constructor() {
      MockClient.instances.push(this)
    }
    connect(_transport: unknown): Promise<void> {
      return this.connectDeferred.promise
    }
    listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      return this.listToolsDeferred.promise
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
  it('abandons a connect that resolves after disconnect(): closes client + transport, no map mutation, no events', async () => {
    const manager = new McpClientManager()
    const transport = fakeTransport()

    const connectPromise = manager.connect(serverConfig(), { externalTransport: transport })
    const client = h.MockClient.instances.at(-1)!

    // Agent stops while the connection attempt is still awaiting client.connect
    await manager.disconnect('s')
    expect(manager.getServerState('s')).toBeNull()

    const events: string[] = []
    manager.on('status-changed', (name, status) => events.push(`status:${name}:${status}`))
    manager.on('tools-discovered', (name) => events.push(`tools:${name}`))

    // The in-flight connect now succeeds against the deleted entry
    client.connectDeferred.resolve()
    const tools = await connectPromise

    expect(tools).toBeNull()
    expect(client.closed).toBe(true)
    expect(transport.closed).toBe(true)
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

    await manager.disconnect('s')

    client.listToolsDeferred.resolve({ tools: [{ name: 'x', inputSchema: {} }] })
    const tools = await connectPromise

    expect(tools).toBeNull()
    expect(client.closed).toBe(true)
    expect(transport.closed).toBe(true)
    expect(manager.getServerState('s')).toBeNull()
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
