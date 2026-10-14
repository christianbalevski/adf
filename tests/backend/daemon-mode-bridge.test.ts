/**
 * The daemon-mode event bridge (design D6): frames → IPC pushes, the shared
 * background mapping, push topics, `stream.gap` resync; and the interim
 * GET /events adapter's translation.
 */
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { DaemonClient } from '../../src/shared/daemon-client'
import type { BackgroundAgentEvent } from '../../src/shared/types/ipc.types'
import { applyBackgroundEvent, type BackgroundMappingState } from '../../src/main/runtime/background-event-mapping'
import { EventBridge } from '../../src/main/backend/daemon-mode/event-bridge'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { translateUmbilicalEnvelope } from '../../src/main/backend/daemon-mode/client-stream'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'

const AGENT_1 = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
const AGENT_2 = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e02'
const FILE_1 = 'C:/agents/agent-1.adf'
const FILE_2 = 'C:/agents/agent-2.adf'
const BASE = 'http://127.0.0.1:47385'

function setup() {
  const pushes: Array<{ channel: string; args: unknown[]; all?: boolean }> = []
  const batched: BackgroundAgentEvent[] = []
  const daemon = createFakeDaemon(BASE)
  const client = new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch })
  const clientSession = createFakeClientSession()
  const session = new DaemonModeSession(clientSession, { log: () => {}, warn: () => {} })
  const approvals: unknown[] = []
  let t = 1000
  const bridge = new EventBridge({
    session,
    output: {
      send: (channel, ...args) => { pushes.push({ channel, args }) },
      sendAll: (channel, ...args) => { pushes.push({ channel, args, all: true }) },
    },
    batcher: { push: (e) => { batched.push(e) }, flush: () => {} },
    client: () => client,
    onApprovals: (s) => { approvals.push(s) },
    log: { log: () => {}, warn: () => {} },
    now: () => t++,
  })
  return { pushes, batched, daemon, session, bridge, approvals }
}

async function focus(session: DaemonModeSession, filePath: string, agentId: string | null) {
  await session.openFile(filePath, async () => agentId)
}

describe('event bridge', () => {
  it('focused agent: executor frames go to AGENT_EVENT unchanged', async () => {
    const { pushes, batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const event = { type: 'text_delta_batch' as const, payload: { delta: 'hi' }, timestamp: 5 }
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event })
    expect(pushes).toEqual([{ channel: IPC.AGENT_EVENT, args: [event] }])
    expect(batched).toEqual([])
  })

  it('other agents: executor frames go through the shared background mapping', async () => {
    const { pushes, batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const events = [
      { type: 'state_changed' as const, payload: { state: 'thinking' }, timestamp: 10 },
      { type: 'text_delta' as const, payload: { delta: 'a' }, timestamp: 11 },
      { type: 'tool_call_start' as const, payload: { name: 'fs_read', id: 't1' }, timestamp: 12 },
      { type: 'turn_complete' as const, payload: {}, timestamp: 13 },
      { type: 'state_changed' as const, payload: { state: 'idle' }, timestamp: 14 },
    ]
    for (const event of events) bridge.handleFrame({ kind: 'executor', agentId: AGENT_2, filePath: FILE_2, event })
    // Same output as the mapping the background agent manager runs.
    const expected: unknown[] = []
    const state: BackgroundMappingState = { state: 'idle', loopStates: new Map(), activeLoops: 0, accumulatedText: '' }
    let t = 1000
    for (const event of events) applyBackgroundEvent(state, FILE_2, event, (e) => { expected.push(e) }, () => t++)
    expect(batched).toEqual(expected)
    expect(pushes).toEqual([])
  })

  it('routes by path before the agent id is known (frames that race the start reply)', async () => {
    const { pushes, session, bridge } = setup()
    await focus(session, FILE_1, null)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 } })
    expect(pushes.map((p) => p.channel)).toEqual([IPC.AGENT_EVENT])
  })

  it('host: trigger errors of the focused agent become `error` on AGENT_EVENT; other agents\' lifecycle is batched', async () => {
    const { pushes, batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'trigger_error', payload: { error: 'boom' }, timestamp: 7 })
    expect(pushes).toEqual([{ channel: IPC.AGENT_EVENT, args: [{ type: 'error', payload: { error: 'boom' }, timestamp: 7 }] }])
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'agent_started', payload: { handle: 'agent-1' }, timestamp: 8 })
    expect(batched).toEqual([])
    bridge.handleFrame({ kind: 'host', agentId: AGENT_2, filePath: FILE_2, type: 'agent_started', payload: { state: 'idle', handle: 'agent-2' }, timestamp: 9 })
    expect(batched).toEqual([{ type: 'agent_started', payload: { filePath: FILE_2, state: 'idle', handle: 'agent-2' }, timestamp: 9 }])
  })

  it('push topics: open-file-only topics are filtered, approvals go to every window', async () => {
    const { pushes, approvals, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'push', topic: 'inbox', agentId: AGENT_2, filePath: FILE_2, payload: { inbox: [] } })
    bridge.handleFrame({ kind: 'push', topic: 'inbox', agentId: AGENT_1, filePath: FILE_1, payload: { inbox: { version: 1, messages: [] } } })
    const snapshot = { pending: [], history: [] }
    bridge.handleFrame({ kind: 'push', topic: 'approvals', payload: snapshot })
    bridge.handleFrame({ kind: 'push', topic: 'templates', payload: undefined })
    expect(pushes).toEqual([
      { channel: IPC.INBOX_UPDATED, args: [{ inbox: { version: 1, messages: [] } }] },
      { channel: IPC.APPROVALS_CHANGED, args: [snapshot], all: true },
      { channel: IPC.TEMPLATES_CHANGED, args: [] },
    ])
    expect(approvals).toEqual([snapshot])
  })

  it('file_renamed re-keys the open file', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'push', topic: 'file_renamed', payload: { oldPath: FILE_1, newPath: 'C:/agents/agent-x.adf' } })
    // onFileRenamed is wired by registerDaemonModeHandlers; here the bridge's own registry follows.
    expect(session.filePath).toBe(FILE_1)
  })

  it('a forced stream.gap produces the documented resync pushes (D6)', async () => {
    const { pushes, batched, daemon, session, bridge } = setup()
    daemon.routes.set('GET /agents', () => [
      { id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false },
      { id: AGENT_2, filePath: FILE_2, name: 'agent-2', handle: 'agent-2', autostart: false },
    ])
    daemon.routes.set(`GET /agents/${AGENT_1}/status`, () => ({ id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false, runtimeState: 'thinking', targetState: null, loopCount: 3 }))
    daemon.routes.set(`GET /agents/${AGENT_2}/status`, () => ({ id: AGENT_2, filePath: FILE_2, name: 'agent-2', handle: 'agent-2', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${AGENT_1}/chat`, () => ({ agentId: AGENT_1, loop: 'main', chatHistory: { version: 1, uiLog: [{ type: 'user', content: 'hi' }], llmMessages: [], total: 1, earlierCount: 0 } }))
    daemon.routes.set(`GET /agents/${AGENT_1}/config`, () => ({ agentId: AGENT_1, config: { id: AGENT_1, name: 'agent-1' } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [{ path: 'C:/agents' }] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await focus(session, FILE_1, AGENT_1)

    await bridge.handleGap({ reason: 'evicted' })

    expect(pushes).toEqual([
      { channel: IPC.AGENT_EVENT, args: [{ type: 'chat_updated', payload: { uiLog: [{ type: 'user', content: 'hi' }] }, timestamp: 1001 }] },
      { channel: IPC.DOC_AGENT_CONFIG_CHANGED, args: [{ filePath: FILE_1, config: { id: AGENT_1, name: 'agent-1' } }] },
      { channel: IPC.TRACKED_DIRS_CHANGED, args: [{ dirPath: 'C:/agents' }] },
      { channel: IPC.APPROVALS_CHANGED, args: [{ pending: [], history: [] }], all: true },
    ])
    // The running-agent batch: every running agent but the focused one.
    expect(batched).toEqual([
      { type: 'agent_started', payload: { filePath: FILE_2, state: 'idle', handle: 'agent-2' }, timestamp: 1000 },
      { type: 'agent_state_changed', payload: { filePath: FILE_2, state: 'idle' }, timestamp: 1000 },
    ])
  })

  it('a resync step that fails does not stop the others', async () => {
    const { pushes, daemon, session, bridge } = setup()
    daemon.routes.set('GET /agents', () => ({ status: 500, body: { error: 'down' } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await session.closeFile()
    await bridge.resync()
    expect(pushes.map((p) => p.channel)).toEqual([IPC.APPROVALS_CHANGED])
  })

  it('waitForTurn settles after the turn ends and the loop leaves its busy state', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    let outcome: string | null = null
    const waiting = bridge.waitForTurn(AGENT_1, 'turn_1').then((o) => { outcome = o })
    const frame = (type: string, payload: unknown, turnId?: string) =>
      bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, ...(turnId ? { turnId } : {}), event: { type: type as never, payload, timestamp: 1 } })
    frame('state_changed', { state: 'thinking' }, 'turn_1')
    frame('turn_complete', {}, 'turn_other')
    await Promise.resolve()
    expect(outcome).toBeNull()
    frame('turn_complete', {}, 'turn_1')
    await Promise.resolve()
    expect(outcome).toBeNull()
    frame('state_changed', { state: 'idle' })
    await waiting
    expect(outcome).toBe('completed')
  })
})

describe('GET /events adapter (interim until W2-B)', () => {
  const envelope = (event_type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    cursor: 1,
    event: { seq: 1, event_type, timestamp: 42, source: 'agent', agent_id: AGENT_1, payload, ...extra },
  })

  it('maps only the umbilical events with an exact executor counterpart', () => {
    expect(translateUmbilicalEnvelope(envelope('agent.state.changed', { filePath: FILE_1, state: 'idle' }))).toEqual({
      kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'idle' }, timestamp: 42 },
    })
    expect(translateUmbilicalEnvelope(envelope('turn.completed', { filePath: FILE_1, absorbed_turn_ids: ['x'] }, { turn_id: 'turn_1', loop: 'side' }))).toEqual({
      kind: 'executor', agentId: AGENT_1, filePath: FILE_1, turnId: 'turn_1', event: { type: 'turn_complete', payload: {}, timestamp: 42, loop: 'side' },
    })
    const error = { type: 'error', payload: { error: 'x' }, timestamp: 40 }
    expect(translateUmbilicalEnvelope(envelope('agent.error', { event: error }))).toMatchObject({ kind: 'executor', event: error })
    expect(translateUmbilicalEnvelope(envelope('agent.loaded', { filePath: FILE_1, handle: 'agent-1' }))).toEqual({
      kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'agent_started', payload: { handle: 'agent-1' }, timestamp: 42,
    })
    expect(translateUmbilicalEnvelope(envelope('tool.started', { name: 'fs_read' }))).toBeNull()
    expect(translateUmbilicalEnvelope(envelope('context.injected', { bytes: 3 }))).toBeNull()
  })
})
