import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type { WsConnectionConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * Fake `ws` socket + a spy on the umbilical emitter.
 *
 * The fake never transitions state on its own: it stays in CONNECTING until a
 * test says otherwise, which is exactly the wedged-socket case the connect
 * timeout exists for.
 */
const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = 0
    bufferedAmount = 0
    url: string
    sent: unknown[] = []
    pings = 0
    terminated = false
    closedWith: { code?: number; reason?: string } | null = null
    private listeners = new Map<string, Listener[]>()

    constructor(url: string) {
      this.url = url
      instances.push(this)
    }

    on(event: string, fn: Listener): this {
      const arr = this.listeners.get(event) ?? []
      arr.push(fn)
      this.listeners.set(event, arr)
      return this
    }

    removeListener(event: string, fn: Listener): this {
      const arr = this.listeners.get(event)
      if (arr) this.listeners.set(event, arr.filter((l) => l !== fn))
      return this
    }

    removeAllListeners(event?: string): this {
      if (event) this.listeners.delete(event)
      else this.listeners.clear()
      return this
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0
    }

    emit(event: string, ...args: unknown[]): boolean {
      const arr = [...(this.listeners.get(event) ?? [])]
      for (const fn of arr) fn(...args)
      return arr.length > 0
    }

    send(data: unknown): void { this.sent.push(data) }
    ping(): void { this.pings++ }
    close(code?: number, reason?: string): void {
      this.closedWith = { code, reason }
      this.readyState = FakeWebSocket.CLOSED
    }
    terminate(): void {
      this.terminated = true
      this.readyState = FakeWebSocket.CLOSED
    }
  }

  const instances: FakeWebSocket[] = []
  const emitUmbilicalEvent = vi.fn()
  return { FakeWebSocket, instances, emitUmbilicalEvent }
})

vi.mock('ws', () => ({ default: h.FakeWebSocket, WebSocket: h.FakeWebSocket }))
vi.mock('../../../src/main/runtime/emit-umbilical', () => ({
  emitUmbilicalEvent: h.emitUmbilicalEvent,
  registerDaemonEventBus: vi.fn(),
}))

import { WsConnectionManager } from '../../../src/main/services/ws-connection-manager'

const AGENT_PATH = 'C:/agents/agent-1.adf'

function makeDelegate() {
  const workspace = {
    getAgentConfig: () => ({ id: 'agent-1' }),
    insertLog: () => { /* noop */ },
    readFile: () => null,
    isFileAuthorized: () => false,
  }
  return {
    getAgentDid: () => null,
    getPrivateKey: () => null,
    getPublicKey: () => null,
    processIngressMessage: async () => ({}),
    getCodeSandbox: () => null,
    getAdfCallHandler: () => null,
    getWorkspace: () => workspace,
    getToolConfig: () => null,
    getAllowUnsigned: () => true,
  } as unknown as ConstructorParameters<typeof WsConnectionManager>[0]
}

function config(overrides: Partial<WsConnectionConfig> = {}): WsConnectionConfig {
  return {
    id: 'conn-cfg-1',
    url: 'wss://example.invalid/socket',
    enabled: true,
    ...overrides,
  }
}

/** Internal shape reached into by the tests — deliberate white-box access. */
type Internals = {
  connections: Map<string, Record<string, unknown>>
  reconnectStates: Map<string, { attempt: number }>
  scheduleReconnect: (path: string, cfg: WsConnectionConfig, previousAttempts: number) => void
  startKeepalive: (conn: unknown) => void
  clearTimers: (conn: unknown) => void
  handlePong: (conn: unknown) => void
}

function internals(mgr: WsConnectionManager): Internals {
  return mgr as unknown as Internals
}

describe('WsConnectionManager hardening', () => {
  let mgr: WsConnectionManager

  beforeEach(() => {
    vi.useFakeTimers()
    h.instances.length = 0
    h.emitUmbilicalEvent.mockClear()
    mgr = new WsConnectionManager(makeDelegate())
  })

  afterEach(() => {
    mgr.stopAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------------
  // 1. Connect timeout
  // ---------------------------------------------------------------------------

  describe('connect timeout', () => {
    it('settles the promise, drops the connection, and terminates a socket stuck in CONNECTING', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config({ auto_reconnect: false })

      const pending = mgr.connectOutbound(AGENT_PATH, cfg)
      const socket = h.instances[0]

      expect(socket.readyState).toBe(h.FakeWebSocket.CONNECTING)
      expect(internals(mgr).connections.size).toBe(1)

      // Just short of the default deadline: nothing has happened yet.
      await vi.advanceTimersByTimeAsync(14_999)
      expect(socket.terminated).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const result = await pending

      expect(result.error).toMatch(/Connect timeout after 15000ms/)
      expect(result.connection_id).toBeUndefined()
      expect(socket.terminated).toBe(true)
      // Registry no longer holds the dead entry, and no listeners survive it.
      expect(internals(mgr).connections.size).toBe(0)
      expect(socket.listenerCount('close')).toBe(0)
    })

    it('honours the per-config connect_timeout_ms override', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const pending = mgr.connectOutbound(AGENT_PATH, config({ connect_timeout_ms: 250, auto_reconnect: false }))

      await vi.advanceTimersByTimeAsync(250)
      expect((await pending).error).toMatch(/Connect timeout after 250ms/)
    })

    it('does not fire once the socket has opened', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const pending = mgr.connectOutbound(AGENT_PATH, config({ auto_reconnect: false }))
      const socket = h.instances[0]

      socket.readyState = h.FakeWebSocket.OPEN
      socket.emit('open')
      const result = await pending
      expect(result.connection_id).toBeTruthy()

      // Past the connect deadline but short of the first keepalive tick.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(socket.terminated).toBe(false)
      expect(internals(mgr).connections.size).toBe(1)
    })

    it('schedules a reconnect on expiry when auto_reconnect is on', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config({ connect_timeout_ms: 100 })

      const pending = mgr.connectOutbound(AGENT_PATH, cfg)
      await vi.advanceTimersByTimeAsync(100)
      await pending

      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // 3 + 8. Reconnect scheduling
  // ---------------------------------------------------------------------------

  describe('reconnect scheduling', () => {
    it('keeps exactly one pending timer no matter how many schedulers fire', () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config({ reconnect_delay_ms: 1_000 })

      expect(vi.getTimerCount()).toBe(0)

      // The close handler and the reconnect-failure recursion both schedule off
      // the same failed attempt.
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 0)
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 0)
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 0)

      expect(internals(mgr).reconnectStates.size).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(1)

      // A later attempt replaces the pending timer rather than adding one.
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 1)
      expect(internals(mgr).reconnectStates.size).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(2)
    })

    it('tracks separate configs independently', () => {
      mgr.registerAgent(AGENT_PATH, [])
      internals(mgr).scheduleReconnect(AGENT_PATH, config({ id: 'a' }), 0)
      internals(mgr).scheduleReconnect(AGENT_PATH, config({ id: 'b' }), 0)

      expect(internals(mgr).reconnectStates.size).toBe(2)
      expect(vi.getTimerCount()).toBe(2)
    })

    it('cancels pending timers on unregisterAgent', () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config()
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 0)
      expect(vi.getTimerCount()).toBe(1)

      mgr.unregisterAgent(AGENT_PATH)

      expect(internals(mgr).reconnectStates.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(0)
    })

    it('gives up at the attempt ceiling instead of arming another timer', () => {
      mgr.registerAgent(AGENT_PATH, [])
      internals(mgr).scheduleReconnect(AGENT_PATH, config(), 5)
      expect(vi.getTimerCount()).toBe(0)
      expect(internals(mgr).reconnectStates.size).toBe(0)
    })

    it('does not schedule when auto_reconnect is disabled', () => {
      mgr.registerAgent(AGENT_PATH, [])
      internals(mgr).scheduleReconnect(AGENT_PATH, config({ auto_reconnect: false }), 0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('emits ws.reconnecting with the attempt ladder', () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config({ reconnect_delay_ms: 2_000 })
      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 1)

      const call = h.emitUmbilicalEvent.mock.calls
        .map((c) => c[0] as { event_type: string; agentId?: string; payload: Record<string, unknown> })
        .find((e) => e.event_type === 'ws.reconnecting')

      expect(call).toBeDefined()
      expect(call!.agentId).toBe('agent-1')
      expect(call!.payload).toMatchObject({
        config_id: cfg.id,
        attempt: 2,
        max_attempts: 5,
        delay_ms: 4_000,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Pong timeout timer tracking
  // ---------------------------------------------------------------------------

  describe('pong timeout timer', () => {
    function keepaliveConn() {
      const socket = new h.FakeWebSocket('wss://example.invalid/ka')
      socket.readyState = h.FakeWebSocket.OPEN
      return {
        id: 'ka-1',
        agentFilePath: AGENT_PATH,
        socket,
        direction: 'outbound' as const,
        authenticated: true,
        keepaliveIntervalMs: 1_000,
        pongReceived: true,
        reconnectAttempts: 0,
        connectedAt: Date.now(),
        lastMessageAt: 0,
        closed: false,
        identityVerified: false,
        highWaterMarkBytes: 1024,
        pongTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        keepaliveTimer: undefined as ReturnType<typeof setInterval> | undefined,
      }
    }

    it('tracks the pong timer on the connection and clearTimers cancels it', () => {
      const conn = keepaliveConn()
      internals(mgr).startKeepalive(conn)

      vi.advanceTimersByTime(1_000)
      expect(conn.socket.pings).toBe(1)
      expect(conn.pongTimer).toBeDefined()
      // keepalive interval + pong timeout
      expect(vi.getTimerCount()).toBe(2)

      internals(mgr).clearTimers(conn)

      expect(conn.pongTimer).toBeUndefined()
      expect(conn.keepaliveTimer).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('disarms the pong timer when the pong arrives', () => {
      const conn = keepaliveConn()
      internals(mgr).startKeepalive(conn)

      vi.advanceTimersByTime(1_000)
      expect(conn.pongTimer).toBeDefined()

      internals(mgr).handlePong(conn)

      expect(conn.pongReceived).toBe(true)
      expect(conn.pongTimer).toBeUndefined()
      expect(vi.getTimerCount()).toBe(1) // only the keepalive interval remains
      internals(mgr).clearTimers(conn)
    })

    it('does not accumulate one pong timer per tick', () => {
      const conn = keepaliveConn()
      internals(mgr).startKeepalive(conn)

      // Every tick re-arms; the previous timer must be replaced, not stacked.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(1_000)
        conn.pongReceived = true
      }

      expect(vi.getTimerCount()).toBe(2)
      internals(mgr).clearTimers(conn)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Drain honesty
  // ---------------------------------------------------------------------------

  describe('send / waitForDrain', () => {
    function registerOpenConn(bufferedAmount: number) {
      const socket = new h.FakeWebSocket('wss://example.invalid/send')
      socket.readyState = h.FakeWebSocket.OPEN
      socket.bufferedAmount = bufferedAmount
      const conn = {
        id: 'send-1',
        agentFilePath: AGENT_PATH,
        socket,
        direction: 'outbound' as const,
        authenticated: true,
        configId: 'conn-cfg-1',
        keepaliveIntervalMs: 30_000,
        pongReceived: true,
        reconnectAttempts: 0,
        connectedAt: Date.now(),
        lastMessageAt: 0,
        closed: false,
        identityVerified: false,
        highWaterMarkBytes: 16,
      }
      internals(mgr).connections.set(conn.id, conn as unknown as Record<string, unknown>)
      return conn
    }

    it('reports failure when the buffer never drains', async () => {
      const conn = registerOpenConn(4_096)

      const pending = mgr.send(conn.id, 'x'.repeat(64))
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await pending

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/did not drain within 30000ms/)
      // The frame really was handed to the socket — the honesty is about
      // whether it left, not whether it was written.
      expect(conn.socket.sent).toHaveLength(1)
    })

    it('reports failure when the socket dies mid-drain', async () => {
      const conn = registerOpenConn(4_096)

      const pending = mgr.send(conn.id, 'x'.repeat(64))
      await vi.advanceTimersByTimeAsync(50)
      conn.socket.readyState = h.FakeWebSocket.CLOSED
      await vi.advanceTimersByTimeAsync(50)

      const result = await pending
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/closed before send buffer drained/)
    })

    it('reports success once the buffer drops below the high-water mark', async () => {
      const conn = registerOpenConn(4_096)

      const pending = mgr.send(conn.id, 'x'.repeat(64))
      await vi.advanceTimersByTimeAsync(50)
      conn.socket.bufferedAmount = 0
      await vi.advanceTimersByTimeAsync(50)

      expect(await pending).toEqual({ success: true })
    })

    it('reports success without waiting when the buffer stays under the mark', async () => {
      const conn = registerOpenConn(0)
      expect(await mgr.send(conn.id, 'hi')).toEqual({ success: true })
    })
  })

  // ---------------------------------------------------------------------------
  // 9. Disconnect by config id
  // ---------------------------------------------------------------------------

  describe('disconnectByConfigId', () => {
    it('closes every live connection for a config and cancels its reconnect', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const cfg = config()

      const pending = mgr.connectOutbound(AGENT_PATH, cfg)
      const socket = h.instances[0]
      socket.readyState = h.FakeWebSocket.OPEN
      socket.emit('open')
      await pending

      internals(mgr).scheduleReconnect(AGENT_PATH, cfg, 0)
      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(1)

      expect(mgr.disconnectByConfigId(AGENT_PATH, cfg.id)).toBe(1)
      expect(socket.closedWith?.code).toBe(1000)
      expect(mgr.getPendingReconnect(AGENT_PATH, cfg.id)).toBe(0)
      expect(internals(mgr).connections.size).toBe(0)
    })

    it('returns 0 for an unknown config id', () => {
      mgr.registerAgent(AGENT_PATH, [])
      expect(mgr.disconnectByConfigId(AGENT_PATH, 'nope')).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // 5. stopAll listener cleanup
  // ---------------------------------------------------------------------------

  describe('stopAll', () => {
    it('detaches every socket listener before clearing the registries', async () => {
      mgr.registerAgent(AGENT_PATH, [])
      const pending = mgr.connectOutbound(AGENT_PATH, config())
      const socket = h.instances[0]
      socket.readyState = h.FakeWebSocket.OPEN
      socket.emit('open')
      await pending

      expect(socket.listenerCount('close')).toBeGreaterThan(0)

      mgr.stopAll()

      expect(socket.listenerCount('close')).toBe(0)
      expect(socket.listenerCount('message')).toBe(0)
      expect(internals(mgr).connections.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
