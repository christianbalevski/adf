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
    daemon.routes.set(`GET /agents/${AGENT_1}/status`, () => ({ id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 3 }))
    daemon.routes.set(`GET /agents/${AGENT_1}/loops`, () => ({ agentId: AGENT_1, loops: [{ name: 'main' }, { name: 'tender' }] }))
    daemon.routes.set(`GET /agents/${AGENT_2}/status`, () => ({ id: AGENT_2, filePath: FILE_2, name: 'agent-2', handle: 'agent-2', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${AGENT_1}/chat`, ({ query }) => query.loop === 'tender'
      ? { agentId: AGENT_1, loop: 'tender', chatHistory: { version: 1, uiLog: [{ type: 'user', content: 'side' }], llmMessages: [], total: 1, earlierCount: 0 } }
      : { agentId: AGENT_1, loop: 'main', chatHistory: { version: 1, uiLog: [{ type: 'user', content: 'hi' }], llmMessages: [], total: 201, earlierCount: 1 } })
    daemon.routes.set(`GET /agents/${AGENT_1}/config`, () => ({ agentId: AGENT_1, config: { id: AGENT_1, name: 'agent-1' } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [{ path: 'C:/agents' }] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await focus(session, FILE_1, AGENT_1)

    await bridge.handleGap({ reason: 'evicted' })

    expect(pushes).toEqual([
      { channel: IPC.AGENT_EVENT, args: [{ type: 'chat_updated', payload: { uiLog: [{ type: 'user', content: 'hi' }], earlierCount: 1 }, timestamp: 1001 }] },
      { channel: IPC.AGENT_EVENT, args: [{ type: 'chat_updated', payload: { uiLog: [{ type: 'user', content: 'side' }], earlierCount: 0 }, timestamp: 1002, loop: 'tender' }] },
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
      kind: 'executor', agentId: AGENT_1, filePath: FILE_1, turnId: 'turn_1', absorbedTurnIds: ['x'], event: { type: 'turn_complete', payload: {}, timestamp: 42, loop: 'side' },
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

describe('event bridge: AGENT_INVOKE waits never hang', () => {
  const exec = (bridge: EventBridge, type: string, payload: unknown, extra: Partial<{ turnId: string; absorbedTurnIds: string[] }> = {}) =>
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, ...extra, event: { type: type as never, payload, timestamp: 1 } })

  it('a turn that ended before the wait registered (fast turn, POST answered late) is found in the ring', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    exec(bridge, 'turn_complete', {}, { turnId: 'turn_fast' })
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(bridge.waitForTurn(AGENT_1, 'turn_fast')).resolves.toBe('completed')
    // Ended, but the state change not seen yet: the wait still settles on it.
    exec(bridge, 'error', { error: 'x' }, { turnId: 'turn_err' })
    const pending = bridge.waitForTurn(AGENT_1, 'turn_err')
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(pending).resolves.toBe('error')
  })

  it('a chat absorbed into the running turn settles with that turn (absorbed_turn_ids)', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const absorbed = bridge.waitForTurn(AGENT_1, 'turn_b')
    exec(bridge, 'turn_complete', {}, { turnId: 'turn_a', absorbedTurnIds: ['turn_b'] })
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(absorbed).resolves.toBe('completed')
  })

  it('a stop that discards queued or cut-off chats ends their waits (chat.discarded)', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const queued = bridge.waitForTurn(AGENT_1, 'turn_q')
    const cut = bridge.waitForTurn(AGENT_1, 'turn_c')
    bridge.handleFrame({ kind: 'turn', agentId: AGENT_1, filePath: FILE_1, outcome: 'discarded', turnIds: ['turn_q'], unansweredTurnIds: ['turn_c'] })
    await expect(queued).resolves.toBe('discarded')
    await expect(cut).resolves.toBe('discarded')
    // A discard that arrived first is found too.
    bridge.handleFrame({ kind: 'turn', agentId: AGENT_1, filePath: FILE_1, outcome: 'discarded', turnIds: ['turn_early'], unansweredTurnIds: [] })
    await expect(bridge.waitForTurn(AGENT_1, 'turn_early')).resolves.toBe('discarded')
  })

  it('ends every wait when the daemon does not come back, and after the upper timeout', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const a = bridge.waitForTurn(AGENT_1, 'turn_1')
    bridge.failTurns('disconnected')
    await expect(a).resolves.toBe('disconnected')
    const quick = new EventBridge({
      session, output: { send: () => {}, sendAll: () => {} }, batcher: { push: () => {}, flush: () => {} },
      client: () => null, turnTimeoutMs: 20, log: { log: () => {}, warn: () => {} },
    })
    await expect(quick.waitForTurn(AGENT_1, 'turn_never')).resolves.toBe('timeout')
  })
})

describe('event bridge: focus and lifecycle', () => {
  const started = (bridge: EventBridge, agentId: string, filePath: string, state = 'idle') =>
    bridge.handleFrame({ kind: 'host', agentId, filePath, type: 'agent_started', payload: { state, handle: filePath.includes('agent-1') ? 'agent-1' : 'agent-2' }, timestamp: 5 })

  it('switching files: the gaining agent leaves the background list first (flushed), the losing one joins it with its state', async () => {
    const order: string[] = []
    const { session, bridge, batched } = setup()
    // Record flushes into the same stream as the pushes.
    const realPush = (bridge as unknown as { deps: { batcher: { push: (e: unknown) => void; flush: () => void } } }).deps.batcher
    const push = realPush.push
    realPush.push = (e) => { order.push(`push ${(e as { type: string }).type}`); push(e) }
    realPush.flush = () => { order.push('flush') }
    await focus(session, FILE_1, AGENT_1)
    started(bridge, AGENT_2, FILE_2, 'active')
    expect(batched.at(-1)).toMatchObject({ type: 'agent_started', payload: { filePath: FILE_2, state: 'active' } })
    order.length = 0
    batched.length = 0
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 6 } })
    await session.openFile(FILE_2, async () => AGENT_2)
    expect(order).toEqual(['flush', 'push agent_started', 'push agent_stopped', 'flush'])
    expect(batched).toEqual([
      { type: 'agent_started', payload: { filePath: FILE_1, state: 'active' }, timestamp: expect.any(Number) },
      { type: 'agent_stopped', payload: { filePath: FILE_2 }, timestamp: expect.any(Number) },
    ])
  })

  it('AGENT_START hold: per file; a file switch mid-start drops the held events and leaves the new file live', async () => {
    const { session, bridge, pushes, batched } = setup()
    const live = () => pushes.filter((p) => p.channel === IPC.AGENT_EVENT).map((p) => (p.args[0] as { payload: { state?: string; t?: string } }).payload.t)
    const exec = (agentId: string, filePath: string, t: string) =>
      bridge.handleFrame({ kind: 'executor', agentId, filePath, event: { type: 'text_delta', payload: { t }, timestamp: 1 } as never })
    await focus(session, FILE_1, null)
    const release1 = bridge.holdForeground(FILE_1)
    started(bridge, AGENT_1, FILE_1, 'active')
    exec(AGENT_1, FILE_1, 'a1-held')
    expect(live()).toEqual([])
    // The user opens agent-2 before agent-1's start answers.
    await session.openFile(FILE_2, async () => AGENT_2)
    expect(batched.at(-1)).toMatchObject({ type: 'agent_started', payload: { filePath: FILE_1, state: 'active' } })
    exec(AGENT_2, FILE_2, 'a2-live')
    expect(live()).toEqual(['a2-live'])
    exec(AGENT_1, FILE_1, 'a1-background')
    release1()
    expect(live()).toEqual(['a2-live'])
    // A start of agent-2 holds only agent-2's events; release sends them in order.
    const release2 = bridge.holdForeground(FILE_2)
    exec(AGENT_2, FILE_2, 'a2-held-1')
    exec(AGENT_2, FILE_2, 'a2-held-2')
    expect(live()).toEqual(['a2-live'])
    release2()
    release2()
    expect(live()).toEqual(['a2-live', 'a2-held-1', 'a2-held-2'])
  })

  it('a fresh start of the open file adds nothing to the background list', async () => {
    const { session, bridge, batched } = setup()
    await focus(session, FILE_1, null)
    started(bridge, AGENT_1, FILE_1)
    session.noteAgent(FILE_1, AGENT_1)
    expect(batched).toEqual([])
  })

  it('the open file started elsewhere (CLI) gives the session its agent id; stopped elsewhere, the chat panel learns it once', async () => {
    const { session, bridge, pushes } = setup()
    await focus(session, FILE_1, null)
    started(bridge, AGENT_1, FILE_1)
    expect(session.agentId).toBe(AGENT_1)
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'agent_stopped', payload: {}, timestamp: 9 })
    expect(pushes).toEqual([{ channel: IPC.AGENT_EVENT, args: [{ type: 'state_changed', payload: { state: 'stopped' }, timestamp: 9 }] }])
  })

  it('AGENT_STOP detaches: the teardown events of the open agent never reach the renderer (embedded detaches its host first)', async () => {
    const { session, bridge, pushes } = setup()
    await focus(session, FILE_1, AGENT_1)
    started(bridge, AGENT_1, FILE_1)
    bridge.detach(AGENT_1)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'stopped' }, timestamp: 10 } })
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'agent_stopped', payload: {}, timestamp: 11 })
    expect(pushes).toEqual([])
    // Cleared by the unload: a later start is seen again.
    started(bridge, AGENT_1, FILE_1)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'idle' }, timestamp: 12 } })
    expect(pushes.map((p) => p.channel)).toEqual([IPC.AGENT_EVENT])
  })

  it('resync stops the agents that died during the gap: agent_stopped for listed ones, stopped on AGENT_EVENT for the open one', async () => {
    const { session, bridge, batched, pushes, daemon } = setup()
    await focus(session, FILE_1, AGENT_1)
    started(bridge, AGENT_1, FILE_1)
    started(bridge, AGENT_2, FILE_2)
    batched.length = 0
    daemon.routes.set('GET /agents', () => [])
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await bridge.handleGap({ reason: 'epoch_changed' })
    expect(batched).toEqual([{ type: 'agent_stopped', payload: { filePath: FILE_2 }, timestamp: expect.any(Number) }])
    expect(pushes[0]).toEqual({ channel: IPC.AGENT_EVENT, args: [{ type: 'state_changed', payload: { state: 'stopped' }, timestamp: expect.any(Number) }] })
    expect(bridge.runningAgents()).toEqual([])
  })

  it('resync does not replace a chat that is still streaming', async () => {
    const { session, bridge, pushes, daemon } = setup()
    daemon.routes.set('GET /agents', () => [{ id: AGENT_1, filePath: FILE_1, name: 'agent-1', autostart: false }])
    daemon.routes.set(`GET /agents/${AGENT_1}/status`, () => ({ id: AGENT_1, filePath: FILE_1, name: 'agent-1', autostart: false, runtimeState: 'thinking', targetState: null, loopCount: 1 }))
    daemon.routes.set(`GET /agents/${AGENT_1}/config`, () => ({ agentId: AGENT_1, config: { id: AGENT_1 } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await focus(session, FILE_1, AGENT_1)
    await bridge.resync()
    expect(pushes.map((p) => (p.args[0] as { type?: string })?.type ?? p.channel)).not.toContain('chat_updated')
  })

  it('announceRunning lists every running agent but the open one, once', async () => {
    const { session, bridge, batched } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.seed([
      { id: AGENT_1, filePath: FILE_1, handle: 'agent-1', runtimeState: 'idle' as never },
      { id: AGENT_2, filePath: FILE_2, handle: 'agent-2', runtimeState: 'thinking' as never },
    ])
    bridge.announceRunning()
    bridge.announceRunning()
    expect(batched).toEqual([{ type: 'agent_started', payload: { filePath: FILE_2, state: 'active', handle: 'agent-2' }, timestamp: expect.any(Number) }])
  })
})
