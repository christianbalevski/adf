import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../../src/main/tui/api/client'
import type { ConnectionInfo } from '../../src/main/tui/api/sse'
import type { ClientFrame, TrackedAgentsList } from '../../src/main/tui/api/types'
import { createTuiStore } from '../../src/main/tui/state/store'

const empty: TrackedAgentsList = { maxDepth: 5, folders: [] }

function setup(modern = true) {
  let onEvent: (frame: ClientFrame) => void = () => {}
  let onState: (info: ConnectionInfo) => void = () => {}
  const trackedAgents = vi.fn(async (): Promise<TrackedAgentsList> => empty)
  const stream = {
    start() { onState({ state: 'open', attempt: 0 }); return this },
    close() {},
  }
  const client = {
    baseUrl: 'http://127.0.0.1:47390',
    async health() {},
    async version() { return { clientApiVersion: 2 } },
    async createClientSession() { return { sessionId: 'session' } },
    withClientSession() { return this },
    async setClientSessionFocus() {},
    async endClientSession() {},
    clientSessionEvents(_id: string, callbacks: { onEvent: typeof onEvent; onState: typeof onState }) {
      onEvent = callbacks.onEvent
      onState = callbacks.onState
      return stream
    },
    events(callbacks: { onState: typeof onState }) {
      onState = callbacks.onState
      return stream
    },
    trackedAgents,
  } as unknown as DaemonClient
  const store = createTuiStore({ client, clientSessions: modern })
  const noop = async () => {}
  store.actions.refreshAgents = noop
  store.actions.refreshIdentity = async () => null
  store.actions.refreshAuth = noop
  store.actions.refreshWeb = async () => null
  let cursor = 0
  return {
    store,
    trackedAgents,
    invalidate: () => onEvent({ kind: 'push', topic: 'tracked_dirs', payload: { dirPath: '/agents' }, agentId: null, filePath: null, cursor: ++cursor }),
    setConnection: (info: ConnectionInfo) => onState(info),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('tracked-directory refresh', () => {
  it('uses a session push immediately and reconciles after an idle minute', async () => {
    vi.useFakeTimers()
    const { store, trackedAgents, invalidate } = setup()
    try {
      await store.start()
      expect(trackedAgents).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(trackedAgents).toHaveBeenCalledTimes(1)
      invalidate()
      invalidate()
      await vi.advanceTimersByTimeAsync(300)
      expect(trackedAgents).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(59_900)
      expect(trackedAgents).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(100)
      expect(trackedAgents).toHaveBeenCalledTimes(3)
    } finally { store.stop() }
  })

  it('queues one follow-up when a burst arrives during a scan', async () => {
    vi.useFakeTimers()
    const { store, trackedAgents, invalidate } = setup()
    try {
      await store.start()
      const pending = Promise.withResolvers<TrackedAgentsList>()
      trackedAgents.mockImplementationOnce(() => pending.promise)
      const scan = store.actions.refreshTracked()
      invalidate()
      invalidate()
      await vi.advanceTimersByTimeAsync(300)
      expect(trackedAgents).toHaveBeenCalledTimes(2)
      pending.resolve(empty)
      await scan
      expect(trackedAgents).toHaveBeenCalledTimes(3)
    } finally { store.stop() }
  })

  it.each(['legacy', 'disconnected'] as const)('retains the 15-second REST fallback while %s', async (mode) => {
    vi.useFakeTimers()
    const { store, trackedAgents, setConnection } = setup(mode === 'disconnected')
    try {
      await store.start()
      if (mode === 'disconnected') setConnection({ state: 'reconnecting', attempt: 1, error: 'SSE down' })
      await vi.advanceTimersByTimeAsync(5_000)
      if (mode === 'disconnected') setConnection({ state: 'reconnecting', attempt: 2, error: 'SSE down' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(trackedAgents).toHaveBeenCalledTimes(2)
    } finally { store.stop() }
  })
})
