/**
 * The daemon-mode event bridge (design D6): frames → IPC pushes, the shared
 * background mapping, push topics, `stream.gap` resync; and the interim
 * client-session frame translation (W2-B wire frames, the turn ends executor frames carry).
 */
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { DaemonClient } from '../../src/shared/daemon-client'
import type { BackgroundAgentEvent } from '../../src/shared/types/ipc.types'
import { applyBackgroundEvent, type BackgroundMappingState } from '../../src/main/runtime/background-event-mapping'
import { EventBridge } from '../../src/main/backend/daemon-mode/event-bridge'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { translateClientFrame, turnEndOf } from '../../src/main/backend/daemon-mode/client-stream'
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

/** A turn's end as the daemon sends it (D5): the executor frame carries its turnId and the ids it absorbed. */
const ended = (outcome: 'completed' | 'error', [turnId, ...absorbedTurnIds]: string[]) => ({
  kind: 'executor' as const,
  agentId: AGENT_1,
  filePath: FILE_1,
  event: { type: outcome === 'completed' ? 'turn_complete' as const : 'error' as const, payload: outcome === 'completed' ? {} : { error: 'x' }, timestamp: 1 },
  turnId,
  ...(absorbedTurnIds.length > 0 ? { absorbedTurnIds } : {}),
})

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

  it('host: trigger and startup failures add no second `error` (W1-A emitted it); other agents\' lifecycle is batched', async () => {
    const { pushes, batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'trigger_error', payload: { error: 'boom' }, timestamp: 7 })
    bridge.handleFrame({ kind: 'host', agentId: AGENT_1, filePath: FILE_1, type: 'startup_failed', payload: { error: 'boom' }, timestamp: 7 })
    bridge.handleFrame({ kind: 'host', agentId: AGENT_2, filePath: FILE_2, type: 'trigger_error', payload: { error: 'boom' }, timestamp: 7 })
    expect(pushes).toEqual([])
    expect(batched).toEqual([])
    // agent_starting before the file's id was read: batched by path.
    bridge.handleFrame({ kind: 'host', agentId: null, filePath: FILE_2, type: 'agent_starting', payload: {}, timestamp: 6 })
    expect(batched).toEqual([{ type: 'agent_starting', payload: { filePath: FILE_2 }, timestamp: 6 }])
    batched.length = 0
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
      { type: 'agent_started', payload: { filePath: FILE_2, state: 'idle', handle: 'agent-2', loopStates: {} }, timestamp: 1000 },
      { type: 'agent_state_changed', payload: { filePath: FILE_2, state: 'idle' }, timestamp: 1000 },
    ])
  })

  it("a resync announces each running agent's side loops from its status, and the busy count", async () => {
    const { batched, daemon, session, bridge } = setup()
    daemon.routes.set('GET /agents', () => [{ id: AGENT_2, filePath: FILE_2, name: 'agent-2', handle: 'agent-2', autostart: false }])
    daemon.routes.set(`GET /agents/${AGENT_2}/status`, () => ({ id: AGENT_2, filePath: FILE_2, name: 'agent-2', handle: 'agent-2', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0, loopStates: { reflector: 'thinking', critic: 'idle' } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await focus(session, FILE_1, AGENT_1)
    await bridge.handleGap({ reason: 'evicted' })
    expect(batched).toEqual([
      { type: 'agent_started', payload: { filePath: FILE_2, state: 'idle', handle: 'agent-2', loopStates: { reflector: 'active', critic: 'idle' } }, timestamp: 1000 },
      { type: 'agent_state_changed', payload: { filePath: FILE_2, state: 'idle' }, timestamp: 1000 },
      { type: 'agent_loops_changed', payload: { filePath: FILE_2, activeLoops: 1 }, timestamp: 1000 },
    ])
  })

  it("other agents' side loops: each loop's own transition is batched, also when the busy count does not move", async () => {
    const { batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const side = (loop: string, state: string, timestamp: number) =>
      bridge.handleFrame({ kind: 'executor', agentId: AGENT_2, filePath: FILE_2, event: { type: 'state_changed', payload: { state }, timestamp, loop } })
    side('reflector', 'thinking', 1)
    side('critic', 'thinking', 2)
    side('reflector', 'idle', 3)
    side('reflector', 'idle', 4)
    expect(batched.map((e) => [e.type, e.payload.loop ?? e.payload.activeLoops, e.payload.state])).toEqual([
      ['agent_loop_state_changed', 'reflector', 'active'],
      ['agent_loops_changed', 1, undefined],
      ['agent_loop_state_changed', 'critic', 'active'],
      ['agent_loops_changed', 2, undefined],
      ['agent_loop_state_changed', 'reflector', 'idle'],
      ['agent_loops_changed', 1, undefined],
    ])
    // The daemon's own count (host frame) follows the same executor frames: not batched twice.
    const count = batched.length
    bridge.handleFrame({ kind: 'host', agentId: AGENT_2, filePath: FILE_2, type: 'agent_loops_changed', payload: { activeLoops: 1 }, timestamp: 5 })
    expect(batched).toHaveLength(count)
  })

  it("a failed chat to a background agent: the error, and an idle only when its loop reads busy (no repeated idle to retry a queue on)", async () => {
    const { batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_2, filePath: FILE_2, event: { type: 'state_changed', payload: { state: 'idle' }, timestamp: 1 } })
    batched.length = 0
    bridge.reportChatFailure({ agentId: AGENT_2, filePath: FILE_2 }, undefined, 'too large')
    expect(batched.map((e) => e.type)).toEqual(['error'])

    batched.length = 0
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_2, filePath: FILE_2, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 2, loop: 'critic' } })
    batched.length = 0
    bridge.reportChatFailure({ agentId: AGENT_2, filePath: FILE_2 }, 'critic', 'gone')
    expect(batched.map((e) => [e.type, e.payload.loop ?? null, e.payload.state ?? null])).toEqual([
      ['agent_loop_state_changed', 'critic', 'idle'],
      ['agent_loops_changed', null, null],
    ])
  })

  it("the agent losing the window is announced with its side loops' states, as the background manager adopts it", async () => {
    const { batched, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    // Focused: folded without being batched.
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1, loop: 'reflector' } })
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'idle' }, timestamp: 2, loop: 'critic' } })
    expect(batched).toEqual([])
    await focus(session, FILE_2, AGENT_2)
    expect(batched).toEqual([
      { type: 'agent_started', payload: { filePath: FILE_1, state: 'idle', loopStates: { reflector: 'active', critic: 'idle' } }, timestamp: 1003 },
      { type: 'agent_loops_changed', payload: { filePath: FILE_1, activeLoops: 1 }, timestamp: 1003 },
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
    const frame = (type: string, payload: unknown) =>
      bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: type as never, payload, timestamp: 1 } })
    frame('state_changed', { state: 'thinking' })
    frame('turn_complete', {})
    bridge.handleFrame(ended('completed', ['turn_other']))
    await Promise.resolve()
    expect(outcome).toBeNull()
    bridge.handleFrame(ended('completed', ['turn_1']))
    await Promise.resolve()
    expect(outcome).toBeNull()
    frame('state_changed', { state: 'idle' })
    await waiting
    expect(outcome).toBe('completed')
  })

  it('reduced frames (sent before the daemon applied the focus) never reach AGENT_EVENT; the mapping still sees them', async () => {
    const { pushes, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, stripped: 'stub', event: { type: 'file_updated', payload: { path: 'a.md', size: 9 }, timestamp: 1 } as never })
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, stripped: 'tool_result', event: { type: 'tool_call_result', payload: { name: 'x', result: { isError: false }, resultSize: 4 }, timestamp: 1 } as never })
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 2 } })
    expect(pushes).toEqual([{ channel: IPC.AGENT_EVENT, args: [{ type: 'state_changed', payload: { state: 'thinking' }, timestamp: 2 }] }])
    expect(bridge.runningAgents().find((a) => a.agentId === AGENT_1)?.mapping.state).toBe('active')
  })

  it('inter_agent_message: an AGENT_EVENT of the open file\'s agent only, never a stub', async () => {
    const { pushes, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const payload = { fromAgent: 'agent-2', toAgent: 'agent-1', content: 'hi', direction: 'incoming' as const }
    bridge.handleFrame({ kind: 'push', topic: 'inter_agent_message', agentId: AGENT_1, filePath: FILE_1, payload })
    bridge.handleFrame({ kind: 'push', topic: 'inter_agent_message', agentId: AGENT_2, filePath: FILE_2, payload: { ...payload, content: undefined, size: 2 }, stripped: 'stub' })
    expect(pushes).toEqual([{ channel: IPC.AGENT_EVENT, args: [{ type: 'inter_agent_message', payload, timestamp: 1000 }] }])
  })

  it('adf_file_created (push or executor): the covering tracked folder is rescanned, else the folder is tracked', async () => {
    const { pushes, daemon, session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [{ path: 'C:/agents' }] }))
    daemon.routes.set('POST /tracked-dirs', () => ({ status: 201, body: { path: 'D:/new' } }))
    bridge.handleFrame({ kind: 'push', topic: 'adf_file_created', agentId: null, filePath: null, payload: { filePath: 'C:/agents/sub/made.adf' } })
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_2, filePath: FILE_2, event: { type: 'adf_file_created', payload: { filePath: 'D:/new/child.adf' }, timestamp: 3 } as never })
    await new Promise((r) => setTimeout(r, 20))
    expect(pushes.filter((p) => p.channel === IPC.TRACKED_DIRS_CHANGED).map((p) => p.args[0])).toEqual([{ dirPath: 'C:/agents' }, { dirPath: 'D:/new' }])
    expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/tracked-dirs').map((r) => r.body)).toEqual([{ path: 'D:/new' }])
  })

  it('daemon_orphan_hold is a notice; agent_path_changed re-keys; autostart pushes nothing', async () => {
    const notices: string[] = []
    const renamed: string[] = []
    const { pushes, session } = setup()
    const bridge = new EventBridge({
      session, output: { send: (c, ...a) => { pushes.push({ channel: c, args: a }) }, sendAll: () => {} }, batcher: { push: () => {}, flush: () => {} },
      client: () => null, onNotice: (t) => { notices.push(t) }, onFileRenamed: (a, b) => { renamed.push(`${a}>${b}`) }, log: { log: () => {}, warn: () => {} },
    })
    bridge.handleFrame({ kind: 'push', topic: 'daemon_orphan_hold', agentId: null, filePath: null, payload: { holding: true, reason: 'owner expired', sessions: 1 } })
    bridge.handleFrame({ kind: 'push', topic: 'daemon_orphan_hold', agentId: null, filePath: null, payload: { holding: false, reason: 'Studio is back', sessions: 1 } })
    bridge.handleFrame({ kind: 'push', topic: 'agent_path_changed', agentId: AGENT_1, filePath: 'C:/agents/b.adf', payload: { oldFilePath: FILE_1, filePath: 'C:/agents/b.adf' } })
    bridge.handleFrame({ kind: 'push', topic: 'autostart', agentId: null, filePath: null, payload: { filePath: FILE_2 } })
    bridge.handleFrame({ kind: 'push', topic: 'daemon_orphan_hold', agentId: null, filePath: null, payload: { holding: true, reason: 'owner expired', sessions: 2 } })
    bridge.handleFrame({ kind: 'push', topic: 'daemon_orphan_hold', agentId: null, filePath: null, payload: { holding: true, reason: 'owner expired' } })
    expect(notices).toHaveLength(3)
    expect(notices[0]).toMatch(/keeps running while 1 other client is connected, and/)
    expect(notices[1]).toMatch(/keeps running while 2 other clients are connected, and/)
    // An older daemon that does not count them: no "other other".
    expect(notices[2]).toMatch(/keeps running while other clients are connected, and/)
    expect(renamed).toEqual([`${FILE_1}>C:/agents/b.adf`])
    expect(pushes).toEqual([])
  })

  it('a gap mid-turn: waits settle when the loop is no longer busy, and the chat is refreshed once the turn settles', async () => {
    const { pushes, daemon, session, bridge } = setup()
    let state = 'thinking'
    daemon.routes.set('GET /agents', () => [{ id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false }])
    daemon.routes.set(`GET /agents/${AGENT_1}/status`, () => ({ id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false, runtimeState: state, targetState: null, loopCount: 3 }))
    daemon.routes.set(`GET /agents/${AGENT_1}/loops`, () => ({ agentId: AGENT_1, loops: [{ name: 'main' }] }))
    daemon.routes.set(`GET /agents/${AGENT_1}/chat`, () => ({ agentId: AGENT_1, loop: 'main', chatHistory: { version: 1, uiLog: [{ type: 'assistant', content: 'done' }], llmMessages: [], total: 2, earlierCount: 0 } }))
    daemon.routes.set(`GET /agents/${AGENT_1}/config`, () => ({ agentId: AGENT_1, config: { id: AGENT_1 } }))
    daemon.routes.set('GET /tracked-dirs', () => ({ maxDepth: 5, directories: [] }))
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 } })
    const wait = bridge.waitForTurn(AGENT_1, 'turn_lost')
    await bridge.handleGap({ reason: 'oversized' })
    // Busy at the resync: no chat_updated yet (it would replace the live entries).
    expect(pushes.filter((p) => (p.args[0] as { type?: string })?.type === 'chat_updated')).toEqual([])
    state = 'idle'
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'idle' }, timestamp: 9 } })
    await expect(wait).resolves.toBe('gap')
    await new Promise((r) => setTimeout(r, 20))
    const updates = pushes.filter((p) => (p.args[0] as { type?: string })?.type === 'chat_updated')
    expect(updates.map((p) => (p.args[0] as { payload: unknown }).payload)).toEqual([{ uiLog: [{ type: 'assistant', content: 'done' }], earlierCount: 0 }])
    // A wait whose loop is idle at the resync settles there.
    const idleWait = bridge.waitForTurn(AGENT_1, 'turn_idle')
    await bridge.handleGap({ reason: 'evicted' })
    await expect(idleWait).resolves.toBe('gap')
  })
})

describe('client-session frames (W2-B)', () => {
  const umbilical = (event_type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ seq: 1, event_type, timestamp: 42, source: 'agent', agent_id: AGENT_1, payload, ...extra }) as never

  it('executor, host, push and turn frames pass through; umbilical envelopes are not read', () => {
    const event = { type: 'state_changed', payload: { state: 'idle' }, timestamp: 1 }
    expect(translateClientFrame({ kind: 'executor', cursor: 3, agentId: AGENT_1, filePath: FILE_1, event } as never)).toEqual({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event })
    expect(translateClientFrame({ kind: 'executor', cursor: 4, agentId: AGENT_1, filePath: FILE_1, event, stripped: 'stub' } as never)).toMatchObject({ stripped: 'stub' })
    expect(translateClientFrame({ kind: 'host', cursor: 5, agentId: null, filePath: FILE_1, type: 'agent_starting', payload: { filePath: FILE_1 }, timestamp: 2 } as never))
      .toEqual({ kind: 'host', agentId: null, filePath: FILE_1, type: 'agent_starting', payload: { filePath: FILE_1 }, timestamp: 2 })
    expect(translateClientFrame({ kind: 'push', cursor: 6, topic: 'templates', agentId: null, filePath: null, payload: {} } as never))
      .toEqual({ kind: 'push', topic: 'templates', agentId: null, filePath: null, payload: {} })
    expect(translateClientFrame({ kind: 'umbilical', cursor: 7, agentId: AGENT_1, event: umbilical('turn.completed', { filePath: FILE_1 }, { turn_id: 'turn_1' }) } as never)).toBeNull()
    expect(translateClientFrame({ kind: 'executor', cursor: 8, agentId: AGENT_1, filePath: FILE_1, event, turnId: 'turn_1', absorbedTurnIds: ['x'] } as never))
      .toEqual({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event, turnId: 'turn_1', absorbedTurnIds: ['x'] })
    expect(translateClientFrame({ kind: 'turn', cursor: 9, agentId: AGENT_1, filePath: FILE_1, outcome: 'discarded', turnIds: ['q'], unansweredTurnIds: ['c'] } as never))
      .toEqual({ kind: 'turn', agentId: AGENT_1, filePath: FILE_1, outcome: 'discarded', turnIds: ['q'], unansweredTurnIds: ['c'] })
  })

  it('turn ends: executor turn_complete / error with turnId and absorbedTurnIds', () => {
    const exec = (type: string, extra: Record<string, unknown> = {}, loop?: string) =>
      ({ kind: 'executor' as const, agentId: AGENT_1, filePath: FILE_1, event: { type, payload: {}, timestamp: 1, ...(loop ? { loop } : {}) } as never, ...extra })
    expect(turnEndOf(exec('turn_complete', { turnId: 'turn_1', absorbedTurnIds: ['x'] }, 'side'))).toEqual({
      kind: 'turn', agentId: AGENT_1, filePath: FILE_1, loop: 'side', outcome: 'completed', turnIds: ['turn_1', 'x'], unansweredTurnIds: [],
    })
    expect(turnEndOf(exec('error', { turnId: 'turn_2', absorbedTurnIds: ['y'] }))).toMatchObject({ outcome: 'error', turnIds: ['turn_2', 'y'] })
    expect(turnEndOf(exec('turn_complete'))).toBeNull()
    expect(turnEndOf(exec('state_changed', { turnId: 'turn_3' }))).toBeNull()
  })
})

describe('event bridge: AGENT_INVOKE waits never hang', () => {
  const exec = (bridge: EventBridge, type: string, payload: unknown) =>
    bridge.handleFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: type as never, payload, timestamp: 1 } })

  it('a turn that ended before the wait registered (fast turn, POST answered late) is found in the ring', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.handleFrame(ended('completed', ['turn_fast']))
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(bridge.waitForTurn(AGENT_1, 'turn_fast')).resolves.toBe('completed')
    // Ended, but the state change not seen yet: the wait still settles on it.
    bridge.handleFrame(ended('error', ['turn_err']))
    const pending = bridge.waitForTurn(AGENT_1, 'turn_err')
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(pending).resolves.toBe('error')
  })

  it('a chat absorbed into the running turn settles with that turn (absorbed_turn_ids)', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    const absorbed = bridge.waitForTurn(AGENT_1, 'turn_b')
    bridge.handleFrame(ended('completed', ['turn_a', 'turn_b']))
    exec(bridge, 'state_changed', { state: 'idle' })
    await expect(absorbed).resolves.toBe('completed')
  })

  it('a turn that ends with its loop already idle (give-up recovery sets idle before the error) settles at once', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    exec(bridge, 'state_changed', { state: 'thinking' })
    const waiting = bridge.waitForTurn(AGENT_1, 'turn_giveup')
    exec(bridge, 'state_changed', { state: 'idle' })
    bridge.handleFrame(ended('error', ['turn_giveup']))
    // No state change follows; the wait does not sit until the 30-minute timeout.
    await expect(waiting).resolves.toBe('error')
    // Registered after such an end: found in the ring and settled too.
    bridge.handleFrame(ended('error', ['turn_late']))
    await expect(bridge.waitForTurn(AGENT_1, 'turn_late')).resolves.toBe('error')
  })

  it('ended turns are kept per agent: another agent\'s turn with the same id settles nothing', async () => {
    const { session, bridge } = setup()
    await focus(session, FILE_1, AGENT_1)
    exec(bridge, 'state_changed', { state: 'thinking' })
    let outcome: string | null = null
    const waiting = bridge.waitForTurn(AGENT_1, 'turn_same').then((o) => { outcome = o })
    bridge.handleFrame({ kind: 'turn', agentId: AGENT_2, filePath: FILE_2, outcome: 'completed', turnIds: ['turn_same'], unansweredTurnIds: [] })
    bridge.handleFrame({ kind: 'turn', agentId: AGENT_2, filePath: FILE_2, outcome: 'discarded', turnIds: ['turn_same'], unansweredTurnIds: [] })
    await new Promise((r) => setTimeout(r, 10))
    expect(outcome).toBeNull()
    bridge.handleFrame(ended('completed', ['turn_same']))
    exec(bridge, 'state_changed', { state: 'idle' })
    await waiting
    expect(outcome).toBe('completed')
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
      { type: 'agent_started', payload: { filePath: FILE_1, state: 'active', loopStates: {} }, timestamp: expect.any(Number) },
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

  it('an agent marked listed in the background (BACKGROUND_AGENT_STATUS) gets its stop as a background event', async () => {
    const { session, bridge, batched } = setup()
    await focus(session, FILE_1, AGENT_1)
    bridge.seed([{ id: AGENT_2, filePath: FILE_2, handle: 'agent-2', runtimeState: 'idle' as never }])
    bridge.markListedInBackground(AGENT_2)
    bridge.handleFrame({ kind: 'host', agentId: AGENT_2, filePath: FILE_2, type: 'agent_stopped', payload: {}, timestamp: 1 })
    expect(batched).toEqual([{ type: 'agent_stopped', payload: { filePath: FILE_2 }, timestamp: 1 }])
  })
})
