import net from 'node:net'
import { spawn } from 'node:child_process'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamBindingManager } from '../../../src/main/runtime/stream-binding-manager'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import { StreamBindingDeclarationSchema } from '../../../src/main/adf/adf-schema'
import { WsConnectionManager, type WsManagerDelegate } from '../../../src/main/services/ws-connection-manager'

async function createTcpSink(expected: string): Promise<{
  host: string
  port: number
  received: Promise<string>
  close: () => Promise<void>
}> {
  const server = net.createServer()
  let resolveReceived!: (value: string) => void
  let rejectReceived!: (err: Error) => void
  const received = new Promise<string>((resolve, reject) => {
    resolveReceived = resolve
    rejectReceived = reject
  })
  let buffer = ''

  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      if (buffer.includes(expected)) resolveReceived(buffer)
    })
    socket.on('error', rejectReceived)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server')

  return {
    host: '127.0.0.1',
    port: address.port,
    received,
    close: () => new Promise(resolve => server.close(() => resolve()))
  }
}

async function createTcpCollector(expectedBytes: number, pauseMs = 0): Promise<{
  host: string
  port: number
  received: Promise<Buffer>
  close: () => Promise<void>
}> {
  const server = net.createServer()
  const chunks: Buffer[] = []
  let receivedBytes = 0
  let resolveReceived!: (value: Buffer) => void
  let rejectReceived!: (err: Error) => void
  const received = new Promise<Buffer>((resolve, reject) => {
    resolveReceived = resolve
    rejectReceived = reject
  })

  server.on('connection', (socket) => {
    if (pauseMs > 0) {
      socket.pause()
      setTimeout(() => socket.resume(), pauseMs)
    }
    socket.on('data', (chunk) => {
      const bytes = Buffer.from(chunk)
      chunks.push(bytes)
      receivedBytes += bytes.byteLength
      if (receivedBytes >= expectedBytes) resolveReceived(Buffer.concat(chunks))
    })
    socket.on('error', rejectReceived)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server')

  return {
    host: '127.0.0.1',
    port: address.port,
    received,
    close: () => new Promise(resolve => server.close(() => resolve()))
  }
}

async function createTcpRoundTrip(payload: string): Promise<{
  host: string
  port: number
  received: Promise<string>
  close: () => Promise<void>
}> {
  const server = net.createServer()
  const sockets = new Set<net.Socket>()
  let resolveReceived!: (value: string) => void
  let rejectReceived!: (err: Error) => void
  const received = new Promise<string>((resolve, reject) => {
    resolveReceived = resolve
    rejectReceived = reject
  })
  let buffer = ''

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.write(payload)
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      if (buffer.includes(payload)) resolveReceived(buffer)
    })
    socket.on('error', rejectReceived)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server')

  return {
    host: '127.0.0.1',
    port: address.port,
    received,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
  }
}

function createManager(
  config: ConstructorParameters<typeof StreamBindingManager>[3],
  ws: WsConnectionManager | null = null,
  podman: unknown = null,
  workspace: ConstructorParameters<typeof StreamBindingManager>[6] = null,
): StreamBindingManager {
  return new StreamBindingManager('00000000-0000-0000-0000-000000000001', 'Test Agent', '/tmp/agent.adf', config, ws, podman as never, workspace)
}

function createFakePodman(): {
  service: unknown
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    service: {
      ensureRunning: async () => { calls.push('ensureRunning') },
      registerAgent: async (agentId: string) => { calls.push(`registerAgent:${agentId}`) },
      spawnExec: (_agentId: string, command: string, args: string[]) => {
        calls.push('spawnExec')
        return spawn(command, args, { stdio: 'pipe' })
      },
      spawnImageProcess: async (image: string, command: string, args: string[]) => {
        calls.push(`spawnImageProcess:${image}`)
        return spawn(command, args, { stdio: 'pipe' })
      }
    }
  }
}

async function createWsPeer(): Promise<{
  url: string
  socket: Promise<WebSocket>
  messages: string[]
  close: () => Promise<void>
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const socket = new Promise<WebSocket>((resolve) => {
    server.once('connection', (ws) => {
      ws.on('message', (data) => messages.push(Buffer.from(data as Buffer).toString('utf-8')))
      resolve(ws)
    })
  })
  const messages: string[] = []
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind WS server')
  return {
    url: `ws://127.0.0.1:${address.port}`,
    socket,
    messages,
    close: () => new Promise(resolve => server.close(() => resolve()))
  }
}

/**
 * A source endpoint that honours pause/resume and lets the test decide exactly
 * when bytes arrive. Injected by stubbing the manager's private createEndpoint,
 * which is the only seam between the pump and its real transports.
 */
function createFakeSource() {
  let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
  const state = { pauseCalls: 0, resumeCalls: 0 }
  const runtime = {
    summary: { kind: 'tcp', host: 'fake-source', port: 1 },
    readable: true,
    writable: false,
    onData: (listener: (data: Buffer) => void | Promise<void>) => { dataListener = listener },
    onClose: () => {},
    onError: () => {},
    write: async () => { throw new Error('fake source is read-only') },
    close: () => {},
    dispose: () => {},
    pause: () => { state.pauseCalls += 1 },
    resume: () => { state.resumeCalls += 1 },
  }
  return { runtime, state, emit: (data: Buffer) => { void dataListener?.(data) } }
}

/** A sink whose writes only settle when the test releases them. */
function createGatedSink() {
  const pending: Array<() => void> = []
  const writes: Buffer[] = []
  const runtime = {
    summary: { kind: 'tcp', host: 'fake-sink', port: 2 },
    readable: false,
    writable: true,
    onData: () => {},
    onClose: () => {},
    onError: () => {},
    write: (data: Buffer) => new Promise<void>((resolve) => {
      pending.push(() => { writes.push(data); resolve() })
    }),
    close: () => {},
    dispose: () => {},
  }
  return {
    runtime,
    writes,
    release: () => { pending.shift()?.() },
    releaseAll: () => { while (pending.length > 0) pending.shift()?.() },
  }
}

/** A sink that accepts everything immediately. */
function createCollectingSink() {
  const frames: string[] = []
  const runtime = {
    summary: { kind: 'tcp', host: 'fake-sink', port: 3 },
    readable: false,
    writable: true,
    onData: () => {},
    onClose: () => {},
    onError: () => {},
    write: async (data: Buffer) => { frames.push(data.toString('utf-8')) },
    close: () => {},
    dispose: () => {},
  }
  return { runtime, frames }
}

/** Replace one or both endpoint factories with fakes, keeping the real one otherwise. */
function stubEndpoints(
  manager: StreamBindingManager,
  fakes: { a?: unknown; b?: unknown },
): void {
  const target = manager as unknown as {
    createEndpoint: (endpoint: unknown, label: 'a' | 'b', context: unknown) => Promise<unknown>
  }
  const original = target.createEndpoint.bind(manager)
  target.createEndpoint = async (endpoint, label, context) => {
    const fake = label === 'a' ? fakes.a : fakes.b
    return fake ?? original(endpoint, label, context)
  }
}

function queuedBytes(manager: StreamBindingManager, bindingId: string): number {
  const bindings = (manager as unknown as {
    bindings: Map<string, { aToB: { queuedBytes: number } }>
  }).bindings
  return bindings.get(bindingId)!.aToB.queuedBytes
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function createWsManager(): WsConnectionManager {
  const delegate: WsManagerDelegate = {
    getAgentDid: () => null,
    getPrivateKey: () => null,
    getPublicKey: () => null,
    processIngressMessage: async () => ({}),
    getCodeSandbox: () => null,
    getAdfCallHandler: () => null,
    getWorkspace: () => ({
      getAgentConfig: () => ({ id: '00000000-0000-0000-0000-000000000001' }),
      insertLog: () => {}
    } as never),
    getToolConfig: () => null,
    getAllowUnsigned: () => true
  }
  return new WsConnectionManager(delegate)
}

describe('StreamBindingManager', () => {
  afterEach(() => {
    clearAllUmbilicalBuses()
  })

  it('binds a host process source to a TCP target and drains output before termination', async () => {
    const sink = await createTcpSink('hello')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })

      const { binding_id } = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("hello")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(sink.received).resolves.toContain('hello')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(manager.bindingsSummary().some(binding => binding.binding_id === binding_id)).toBe(false)
    } finally {
      await sink.close()
    }
  })

  it('emits lifecycle events and adf log rows for short-lived bindings', async () => {
    const sink = await createTcpSink('hello')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const eventTypes: string[] = []
      const logs: Array<[string, string | null, string | null, string | null, string, unknown?]> = []
      const unsubscribe = bus.subscribe(event => {
        if (event.event_type.startsWith('binding.')) eventTypes.push(event.event_type)
      })
      const workspace = {
        insertLog: (...args: [string, string | null, string | null, string | null, string, unknown?]) => {
          logs.push(args)
        }
      } as ConstructorParameters<typeof StreamBindingManager>[6]
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      }, null, null, workspace)

      const { binding_id } = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("hello")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(sink.received).resolves.toContain('hello')
      await waitFor(() => eventTypes.includes('binding.terminated'))
      expect(eventTypes).toEqual(expect.arrayContaining([
        'binding.created',
        'binding.flow_summary',
        'binding.terminated',
      ]))
      expect(logs.map(log => log[1])).toEqual(expect.arrayContaining(['stream_bind']))
      expect(logs.map(log => log[2])).toEqual(expect.arrayContaining([
        'binding.created',
        'binding.flow_summary',
        'binding.terminated',
      ]))
      expect(logs.find(log => log[2] === 'binding.terminated')?.[3]).toBe(binding_id)
      unsubscribe()
    } finally {
      await sink.close()
    }
  })

  it('streams filtered umbilical events as JSON lines to a TCP target', async () => {
    const sink = await createTcpSink('"event_type":"tool.failed"')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })

      await manager.bind({
        a: { kind: 'umbilical', filter: { event_types: ['tool.failed'] } },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      bus.publish({
        event_type: 'tool.completed',
        timestamp: Date.now(),
        source: 'test',
        payload: { ignored: true }
      })
      bus.publish({
        event_type: 'tool.failed',
        timestamp: Date.now(),
        source: 'test',
        payload: { tool: 'demo' }
      })

      const received = await sink.received
      expect(received).toContain('"tool":"demo"')
      expect(received).not.toContain('ignored')
      manager.stopAll('agent_stopped')
    } finally {
      await sink.close()
    }
  })

  it('handles backpressure without dropping bytes', async () => {
    const size = 512 * 1024
    const sink = await createTcpCollector(size, 75)
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })

      await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', `process.stdout.write(Buffer.alloc(${size}, 65))`] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      const received = await sink.received
      expect(received.byteLength).toBe(size)
      expect(received.equals(Buffer.alloc(size, 65))).toBe(true)
    } finally {
      await sink.close()
    }
  })

  it('accounts reverse traffic for bidirectional process to TCP bindings', async () => {
    const tcp = await createTcpRoundTrip('from-tcp')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: tcp.port }]
      })

      const { binding_id } = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'] },
        b: { kind: 'tcp', host: tcp.host, port: tcp.port },
        bidirectional: true,
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(tcp.received).resolves.toContain('from-tcp')
      await waitFor(() => {
        const summary = manager.bindingsSummary().find(binding => binding.binding_id === binding_id)
        return !!summary && summary.bytes_a_to_b >= 8 && summary.bytes_b_to_a >= 8
      })
      const summary = manager.bindingsSummary().find(binding => binding.binding_id === binding_id)
      expect(summary?.bytes_a_to_b).toBeGreaterThanOrEqual(8)
      expect(summary?.bytes_b_to_a).toBeGreaterThanOrEqual(8)
      await manager.unbind(binding_id)
    } finally {
      await tcp.close()
    }
  })

  it('tracks multiple simultaneous bindings independently', async () => {
    const one = await createTcpSink('one')
    const two = await createTcpSink('two')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [
          { host: '127.0.0.1', port: one.port },
          { host: '127.0.0.1', port: two.port },
        ]
      })

      const first = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("one"); setTimeout(()=>{}, 1000)'] },
        b: { kind: 'tcp', host: one.host, port: one.port },
        options: { flow_summary_interval_ms: 100 }
      })
      const second = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("two"); setTimeout(()=>{}, 1000)'] },
        b: { kind: 'tcp', host: two.host, port: two.port },
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(one.received).resolves.toContain('one')
      await expect(two.received).resolves.toContain('two')
      const summaries = manager.bindingsSummary()
      expect(summaries.map(binding => binding.binding_id)).toEqual(expect.arrayContaining([first.binding_id, second.binding_id]))
      expect(summaries.find(binding => binding.binding_id === first.binding_id)?.bytes_a_to_b).toBe(3)
      expect(summaries.find(binding => binding.binding_id === second.binding_id)?.bytes_a_to_b).toBe(3)
      manager.stopAll('agent_stopped')
    } finally {
      await one.close()
      await two.close()
    }
  })

  it('unbinds active bindings explicitly and emits manual termination', async () => {
    const sink = await createTcpSink('never-matched')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const reasons: string[] = []
      const unsubscribe = bus.subscribe(event => {
        if (event.event_type === 'binding.terminated') reasons.push(String(event.payload.reason))
      })
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })

      const { binding_id } = await manager.bind({
        a: { kind: 'process', isolation: 'host', command: ['/bin/sh', '-c', 'sleep 30'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      expect(manager.bindingsSummary().some(binding => binding.binding_id === binding_id)).toBe(true)
      await expect(manager.unbind(binding_id)).resolves.toEqual({ ok: true })
      expect(manager.bindingsSummary().some(binding => binding.binding_id === binding_id)).toBe(false)
      expect(reasons).toContain('manual')
      unsubscribe()
    } finally {
      await sink.close()
    }
  })

  it('emits threshold_exceeded and terminates when max_bytes is exceeded', async () => {
    const sink = await createTcpSink('"payload"')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const events: string[] = []
      const unsubscribe = bus.subscribe(event => {
        if (event.event_type.startsWith('binding.')) events.push(event.event_type)
      })
      const manager = createManager({
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })

      await manager.bind({
        a: { kind: 'umbilical', filter: { event_types: ['custom.big'] } },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { max_bytes: 10, flow_summary_interval_ms: 100 }
      })
      bus.publish({
        event_type: 'custom.big',
        timestamp: Date.now(),
        source: 'test',
        payload: { payload: 'x'.repeat(128) }
      })

      await waitFor(() => events.includes('binding.threshold_exceeded') && events.includes('binding.terminated'))
      expect(manager.bindingsSummary()).toEqual([])
      unsubscribe()
    } finally {
      await sink.close()
    }
  })

  it('terminates active bindings when max_duration_ms is exceeded', async () => {
    const sink = await createTcpSink('never-matched')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const terminated: string[] = []
      const unsubscribe = bus.subscribe(event => {
        if (event.event_type === 'binding.terminated') {
          terminated.push(String(event.payload.reason))
        }
      })
      const manager = createManager({
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: sink.host, port: sink.port }]
      })

      await manager.bind({
        a: { kind: 'umbilical', filter: { event_types: ['custom.never'] } },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { max_duration_ms: 100, flow_summary_interval_ms: 100 }
      })

      await waitFor(() => terminated.includes('threshold_exceeded:max_duration_ms'))
      expect(manager.bindingsSummary()).toEqual([])
      unsubscribe()
    } finally {
      await sink.close()
    }
  })

  it('rejects TCP targets not granted by config', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    await expect(manager.bind({
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 }
    })).rejects.toThrow('TCP stream binding is not enabled')
  })

  it('reports declarative bindings as pending while dependencies are unavailable', () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    manager.loadDeclarations([{
      id: 'pending-demo',
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
      reconnect: true
    }])

    const [summary] = manager.bindingsSummary()
    expect(summary.binding_id).toBe('pending-demo')
    expect(summary.status).toBe('pending')
    manager.stopAll('agent_stopped')
  })

  it('materializes declarative bindings when dependencies are available', async () => {
    const sink = await createTcpSink('declared')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      })
      manager.loadDeclarations([{
        id: 'declared-demo',
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("declared")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        reconnect: true,
        options: { flow_summary_interval_ms: 100 }
      }])

      await expect(sink.received).resolves.toContain('declared')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(manager.bindingsSummary().some(binding => binding.binding_id === 'declared-demo')).toBe(true)
      manager.stopAll('agent_stopped')
    } finally {
      await sink.close()
    }
  })

  it('rejects declarative configs with umbilical as b', () => {
    const result = StreamBindingDeclarationSchema.safeParse({
      id: 'bad',
      a: { kind: 'ws', connection_id: 'a' },
      b: { kind: 'umbilical' }
    })
    expect(result.success).toBe(false)
  })

  it('binds a shared-container process source through the Podman pipe surface', async () => {
    const sink = await createTcpSink('shared')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const fakePodman = createFakePodman()
      const manager = createManager({
        container_shared_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      }, null, fakePodman.service)

      await manager.bind({
        a: { kind: 'process', isolation: 'container_shared', command: [process.execPath, '-e', 'process.stdout.write("shared")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(sink.received).resolves.toContain('shared')
      expect(fakePodman.calls).toEqual(expect.arrayContaining(['ensureRunning', 'registerAgent:00000000-0000-0000-0000-000000000001', 'spawnExec']))
    } finally {
      await sink.close()
    }
  })

  it('binds an isolated image process source through the Podman pipe surface', async () => {
    const sink = await createTcpSink('isolated')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const fakePodman = createFakePodman()
      const manager = createManager({
        container_isolated_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      }, null, fakePodman.service)

      await manager.bind({
        a: { kind: 'process', isolation: 'container_isolated', image: 'node:20-slim', command: [process.execPath, '-e', 'process.stdout.write("isolated")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 }
      })

      await expect(sink.received).resolves.toContain('isolated')
      expect(fakePodman.calls).toContain('spawnImageProcess:node:20-slim')
    } finally {
      await sink.close()
    }
  })

  it('pumps bytes between two WebSocket connections bidirectionally', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const left = await createWsPeer()
    const right = await createWsPeer()
    const wsManager = createWsManager()
    try {
      const leftConn = await wsManager.connectOutbound('/tmp/agent.adf', {
        id: 'left',
        url: left.url,
        enabled: true,
        auth: 'none'
      })
      const rightConn = await wsManager.connectOutbound('/tmp/agent.adf', {
        id: 'right',
        url: right.url,
        enabled: true,
        auth: 'none'
      })
      expect(leftConn.connection_id).toBeDefined()
      expect(rightConn.connection_id).toBeDefined()
      const leftSocket = await left.socket
      const rightSocket = await right.socket

      const manager = createManager({}, wsManager)
      await manager.bind({
        a: { kind: 'ws', connection_id: leftConn.connection_id! },
        b: { kind: 'ws', connection_id: rightConn.connection_id! },
        bidirectional: true,
        options: { flow_summary_interval_ms: 100 }
      })

      leftSocket.send('left-to-right')
      await waitFor(() => right.messages.includes('left-to-right'))
      rightSocket.send('right-to-left')
      await waitFor(() => left.messages.includes('right-to-left'))
      manager.stopAll('agent_stopped')
    } finally {
      wsManager.stopAll()
      await left.close()
      await right.close()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })

  it('pauses a fast source at the high-water mark and resumes it at the low-water mark', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const source = createFakeSource()
    const sink = createGatedSink()
    stubEndpoints(manager, { a: source.runtime, b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'tcp', host: 'fake-source', port: 1 },
      b: { kind: 'tcp', host: 'fake-sink', port: 2 },
      options: { queue_high_water_bytes: 1000, flow_summary_interval_ms: 10_000 },
    })

    const chunk = Buffer.alloc(200, 65)
    // Five chunks reach the 1000-byte budget exactly; nothing has been written
    // yet because the sink is gated, so the queue is at its ceiling.
    for (let i = 0; i < 5; i += 1) source.emit(chunk)
    expect(queuedBytes(manager, binding_id)).toBe(1000)
    expect(source.state.pauseCalls).toBe(1)
    expect(source.state.resumeCalls).toBe(0)

    // Drain back under the 500-byte low-water mark: 1000 -> 800 -> 600 -> 400.
    sink.release()
    await settle()
    expect(queuedBytes(manager, binding_id)).toBe(800)
    expect(source.state.resumeCalls).toBe(0)

    sink.release()
    await settle()
    sink.release()
    await settle()
    expect(queuedBytes(manager, binding_id)).toBe(400)
    expect(source.state.resumeCalls).toBe(1)

    // Each release lets the loop issue the next write, so drain iteratively.
    for (let i = 0; i < 5; i += 1) {
      sink.releaseAll()
      await settle()
    }
    expect(queuedBytes(manager, binding_id)).toBe(0)
    // Nothing was lost while the source was paused.
    expect(Buffer.concat(sink.writes).byteLength).toBe(1000)
    expect(manager.bindingsSummary().find(b => b.binding_id === binding_id)?.bytes_a_to_b).toBe(1000)

    manager.stopAll('agent_stopped')
  })

  it('resumes a backpressure-paused source on manual unbind so its socket is not left dead', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const source = createFakeSource()
    const sink = createGatedSink()
    stubEndpoints(manager, { a: source.runtime, b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'tcp', host: 'fake-source', port: 1 },
      b: { kind: 'tcp', host: 'fake-sink', port: 2 },
      options: { queue_high_water_bytes: 1000, flow_summary_interval_ms: 10_000 },
    })

    // Fill to the high-water mark with the sink gated: the source is paused and
    // nothing drains, so it is still paused at teardown.
    const chunk = Buffer.alloc(200, 65)
    for (let i = 0; i < 5; i += 1) source.emit(chunk)
    expect(source.state.pauseCalls).toBe(1)
    expect(source.state.resumeCalls).toBe(0)

    // 'manual' (unbind) does NOT close the source; a real ws socket would stay
    // open. Teardown must resume it so it is reusable rather than silently dead.
    await manager.unbind(binding_id)
    expect(source.state.resumeCalls).toBe(1)
    expect(manager.bindingsSummary().some(b => b.binding_id === binding_id)).toBe(false)
  })

  it('resumes a backpressure-paused source on stopAll(agent_stopped)', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const source = createFakeSource()
    const sink = createGatedSink()
    stubEndpoints(manager, { a: source.runtime, b: sink.runtime })

    await manager.bind({
      a: { kind: 'tcp', host: 'fake-source', port: 1 },
      b: { kind: 'tcp', host: 'fake-sink', port: 2 },
      options: { queue_high_water_bytes: 1000, flow_summary_interval_ms: 10_000 },
    })

    const chunk = Buffer.alloc(200, 65)
    for (let i = 0; i < 5; i += 1) source.emit(chunk)
    expect(source.state.pauseCalls).toBe(1)
    expect(source.state.resumeCalls).toBe(0)

    manager.stopAll('agent_stopped')
    expect(source.state.resumeCalls).toBe(1)
  })

  it('does not spuriously resume a source that was never paused on teardown', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const source = createFakeSource()
    const sink = createCollectingSink()
    stubEndpoints(manager, { a: source.runtime, b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'tcp', host: 'fake-source', port: 1 },
      b: { kind: 'tcp', host: 'fake-sink', port: 3 },
      options: { queue_high_water_bytes: 1000, flow_summary_interval_ms: 10_000 },
    })

    // Small traffic that never crosses the high-water mark: source is never
    // paused, so teardown must not call resume (paused-tracking is exact).
    source.emit(Buffer.alloc(100, 65))
    await settle()
    expect(source.state.pauseCalls).toBe(0)

    await manager.unbind(binding_id)
    expect(source.state.resumeCalls).toBe(0)
  })

  it('drops umbilical frames instead of buffering when the sink falls behind', async () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const sink = createGatedSink()
    stubEndpoints(manager, { b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'umbilical', filter: { event_types: ['custom.flood'] } },
      b: { kind: 'tcp', host: 'fake-sink', port: 2 },
      options: { queue_high_water_bytes: 512, flow_summary_interval_ms: 10_000 },
    })

    // The bus cannot be paused, so once the queue is over budget the pump must
    // shed frames rather than let the closure grow without bound.
    for (let i = 0; i < 200; i += 1) {
      bus.publish({
        event_type: 'custom.flood',
        timestamp: Date.now(),
        source: 'test',
        payload: { index: i, filler: 'x'.repeat(200) },
      })
    }

    expect(queuedBytes(manager, binding_id)).toBeLessThanOrEqual(512)
    const summary = manager.bindingsSummary().find(b => b.binding_id === binding_id)
    expect(summary?.frames_dropped).toBeGreaterThan(0)

    sink.releaseAll()
    manager.stopAll('agent_stopped')
  })

  it('counts rate-limited umbilical frames as drops', async () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const sink = createCollectingSink()
    stubEndpoints(manager, { b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'umbilical', filter: { event_types: ['custom.chatty'], max_rate_per_sec: 1 } },
      b: { kind: 'tcp', host: 'fake-sink', port: 3 },
      options: { flow_summary_interval_ms: 10_000 },
    })

    for (let i = 0; i < 5; i += 1) {
      bus.publish({ event_type: 'custom.chatty', timestamp: Date.now(), source: 'test', payload: { i } })
    }
    await settle()

    expect(sink.frames).toHaveLength(1)
    expect(manager.bindingsSummary().find(b => b.binding_id === binding_id)?.frames_dropped).toBe(4)
    manager.stopAll('agent_stopped')
  })

  it('never feeds a binding its own binding.* events back into itself', async () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    const sink = createCollectingSink()
    stubEndpoints(manager, { b: sink.runtime })

    const { binding_id } = await manager.bind({
      a: { kind: 'umbilical', filter: { event_types: ['binding.*'], allow_wildcard: true } },
      b: { kind: 'tcp', host: 'fake-sink', port: 3 },
      options: { flow_summary_interval_ms: 100 },
    })

    // Let several flow summaries fire. Without the guard each one would be
    // pumped into the binding, moving its byte counters and emitting another.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(sink.frames.some(frame => frame.includes(binding_id))).toBe(false)

    // Another binding's events still flow — the guard is scoped, not blanket.
    bus.publish({
      event_type: 'binding.flow_summary',
      timestamp: Date.now(),
      source: 'system:stream_bind',
      payload: { binding_id: 'some-other-binding', bytes_a_to_b: 1 },
    })
    await settle()
    expect(sink.frames.some(frame => frame.includes('some-other-binding'))).toBe(true)

    manager.stopAll('agent_stopped')
  })

  it('fails closed when allow_tcp_bind is set without a tcp_allowlist', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({ allow_tcp_bind: true })
    await expect(manager.bind({
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })).rejects.toThrow(/requires an explicit stream_bind\.tcp_allowlist/)

    const empty = createManager({ allow_tcp_bind: true, tcp_allowlist: [] })
    await expect(empty.bind({
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })).rejects.toThrow(/requires an explicit stream_bind\.tcp_allowlist/)
  })

  it('still allows an explicit wildcard allowlist entry', async () => {
    const sink = await createTcpSink('wildcarded')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '*' }],
      })
      await manager.bind({
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'process.stdout.write("wildcarded")'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 },
      })
      await expect(sink.received).resolves.toContain('wildcarded')
      manager.stopAll('agent_stopped')
    } finally {
      await sink.close()
    }
  })

  it('terminates active declarative bindings whose declaration was removed', async () => {
    const sink = await createTcpSink('never-matched')
    try {
      const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const reasons: string[] = []
      const unsubscribe = bus.subscribe(event => {
        if (event.event_type === 'binding.terminated') reasons.push(String(event.payload.reason))
      })
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }],
      })

      manager.loadDeclarations([{
        id: 'removable',
        a: { kind: 'process', isolation: 'host', command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        reconnect: true,
        options: { flow_summary_interval_ms: 100 },
      }])

      await waitFor(() => manager.bindingsSummary().some(b => b.binding_id === 'removable' && b.status === 'active'))

      // Config no longer declares it — the live binding must not survive.
      manager.loadDeclarations([])

      expect(reasons).toContain('declaration_removed')
      expect(manager.bindingsSummary()).toEqual([])
      // reconnect: true must not resurrect a declaration that is gone.
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(manager.bindingsSummary()).toEqual([])
      unsubscribe()
      manager.stopAll('agent_stopped')
    } finally {
      await sink.close()
    }
  })

  it('backs off and surfaces attempts and last_error for failing declarations', async () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    manager.loadDeclarations([{
      id: 'unreachable',
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
      reconnect: true,
    }])

    await waitFor(() => (manager.bindingsSummary()[0]?.attempts ?? 0) >= 1)
    const [summary] = manager.bindingsSummary()
    expect(summary.status).toBe('pending')
    expect(summary.attempts).toBeGreaterThanOrEqual(1)
    expect(summary.last_error).toContain('TCP stream binding is not enabled')
    manager.stopAll('agent_stopped')
  })

  it('summarizes ws endpoints with the same shape whether pending or live', () => {
    ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const manager = createManager({})
    manager.loadDeclarations([{
      id: 'ws-pending',
      a: { kind: 'ws', connection_id: 'conn-1' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    }])

    const [summary] = manager.bindingsSummary()
    expect(summary.a).toEqual({ kind: 'ws', connection_id: 'conn-1', direction: undefined, remote_did: undefined })
    expect(Object.keys(summary.a).sort()).toEqual(['connection_id', 'direction', 'kind', 'remote_did'])
    manager.stopAll('agent_stopped')
  })

  it('rejects declarative umbilical endpoints that subscribe to wildcards without opting in', () => {
    const denied = StreamBindingDeclarationSchema.safeParse({
      id: 'wildcard-denied',
      a: { kind: 'umbilical', filter: { event_types: ['tool.*'] } },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })
    expect(denied.success).toBe(false)

    // An absent filter means "everything", which is the widest wildcard there is.
    const bare = StreamBindingDeclarationSchema.safeParse({
      id: 'wildcard-bare',
      a: { kind: 'umbilical' },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })
    expect(bare.success).toBe(false)

    const allowed = StreamBindingDeclarationSchema.safeParse({
      id: 'wildcard-allowed',
      a: { kind: 'umbilical', filter: { event_types: ['tool.*'], allow_wildcard: true } },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })
    expect(allowed.success).toBe(true)

    const exact = StreamBindingDeclarationSchema.safeParse({
      id: 'exact',
      a: { kind: 'umbilical', filter: { event_types: ['tool.failed'] } },
      b: { kind: 'tcp', host: '127.0.0.1', port: 9 },
    })
    expect(exact.success).toBe(true)
  })

  it('reports process stderr into the agent log instead of blocking the child', async () => {
    const sink = await createTcpSink('done')
    try {
      ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
      const logs: Array<[string, string | null, string | null, string | null, string, unknown?]> = []
      const workspace = {
        insertLog: (...args: [string, string | null, string | null, string | null, string, unknown?]) => {
          logs.push(args)
        }
      } as ConstructorParameters<typeof StreamBindingManager>[6]
      const manager = createManager({
        host_process_bind: true,
        allow_tcp_bind: true,
        tcp_allowlist: [{ host: '127.0.0.1', port: sink.port }]
      }, null, null, workspace)

      await manager.bind({
        a: {
          kind: 'process',
          isolation: 'host',
          command: [process.execPath, '-e', 'process.stderr.write("boom\\n"); process.stdout.write("done")'],
        },
        b: { kind: 'tcp', host: sink.host, port: sink.port },
        options: { flow_summary_interval_ms: 100 },
      })

      await expect(sink.received).resolves.toContain('done')
      await waitFor(() => logs.some(log => log[2] === 'process_stderr'))
      expect(logs.find(log => log[2] === 'process_stderr')?.[4]).toContain('boom')
    } finally {
      await sink.close()
    }
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 1000) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
