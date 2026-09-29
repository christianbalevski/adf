import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../src/main/tui/api/client'
import { EventStream, type ConnectionInfo } from '../../src/main/tui/api/sse'
import { DaemonError, type DaemonEventFrame } from '../../src/main/tui/api/types'
import { AGENT_1_ID, MOCK_AGENTS_DIR, MOCK_SPARE_DIR, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'

let mock: MockDaemon
let client: DaemonClient

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  client = new DaemonClient({ baseUrl: `${mock.url}/` })
})

afterEach(async () => {
  await mock.close()
})

async function until<T>(check: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not met in time')
}

describe('DaemonClient', () => {
  it('reads the fleet and each agent’s loops', async () => {
    expect(client.baseUrl).toBe(mock.url)
    expect(await client.health()).toEqual({ ok: true })
    const agents = await client.agents()
    expect(agents.map(a => a.handle)).toEqual(['agent-1', 'agent-2'])
    const status = await client.status('agent-1')
    expect(status).toEqual(expect.objectContaining({ id: AGENT_1_ID, runtimeState: 'idle' }))

    const { loops } = await client.loops(AGENT_1_ID)
    expect(loops.map(l => [l.name, l.isMain, l.enabled])).toEqual([
      ['main', true, true],
      ['consolidator', false, true],
      ['researcher', false, true],
    ])
    expect(loops[1].config).toEqual(expect.objectContaining({ goal: expect.stringContaining('Consolidate') }))

    const page = await client.loopHistory(AGENT_1_ID, { loop: 'consolidator', limit: 10 })
    expect(page.loop).toBe('consolidator')
    expect(page.entries[0].content_json[0].text).toContain('[from loop:main]')
  })

  it('creates, disables, schedules and deletes an inner loop', async () => {
    const created = await client.createLoop(AGENT_1_ID, { name: 'critic', goal: 'Review drafts before main sends them.', autostart: false })
    expect(created.loop).toEqual(expect.objectContaining({ name: 'critic', enabled: true }))

    const disabled = await client.setLoopEnabled(AGENT_1_ID, 'critic', false)
    expect(disabled.updated).toEqual(['enabled'])
    await expect(client.chat(AGENT_1_ID, 'hello', 'critic')).rejects.toMatchObject({ status: 409 })

    const timer = await client.createTimer(AGENT_1_ID, { mode: 'interval', every_ms: 3_600_000, scope: ['agent'], loop: 'critic' })
    const { timers } = await client.timers(AGENT_1_ID)
    expect(timers.find(t => t.id === timer.id)?.loop).toBe('critic')

    const deleted = await client.deleteLoop(AGENT_1_ID, 'critic')
    expect(deleted).toEqual({ agentId: AGENT_1_ID, name: 'critic', archivedEntries: 0, interruptedTurn: false })
    await expect(client.loop(AGENT_1_ID, 'critic')).rejects.toBeInstanceOf(DaemonError)
  })

  it('always-approves, refuses one-time approvals, denies with feedback and approves all', async () => {
    const agent = mock.agents.get(AGENT_1_ID)!
    agent.tasks.push(
      { id: 'task_oneshot', tool: 'mcp_oauth_signin', args: '{}', status: 'pending_approval', created_at: 1, approval_meta: { reason: 'restricted', canAlwaysApprove: false } },
      { id: 'task_protect', tool: 'fs_delete', args: '{}', status: 'pending_approval', created_at: 2, approval_meta: { reason: 'protection', protection: { level: 'no_delete' } } },
      { id: 'task_gated', tool: 'fs_write', args: '{}', status: 'pending_approval', created_at: 3, approval_meta: { reason: 'restricted' } },
      { id: 'task_deny', tool: 'fs_write', args: '{}', status: 'pending_approval', created_at: 4, approval_meta: { reason: 'restricted' } },
    )
    const { tasks } = await client.tasks(AGENT_1_ID, { status: 'pending_approval' })
    const byId = new Map(tasks.map(t => [t.id, t]))
    expect(byId.get('task_approve_1')?.canAlwaysApprove).toBe(true)
    expect(byId.get('task_oneshot')).toEqual(expect.objectContaining({ canAlwaysApprove: false, alwaysApproveBlockedReason: 'One-time approval only for this request' }))
    expect(byId.get('task_protect')).toEqual(expect.objectContaining({ canAlwaysApprove: false, alwaysApproveBlockedReason: 'Target is locked (no_delete)' }))

    const always = await client.alwaysApproveTask(AGENT_1_ID, 'task_approve_1')
    expect(always).toEqual(expect.objectContaining({ taskId: 'task_approve_1', loop: 'main', tool: 'msg_send', task: expect.objectContaining({ status: 'completed' }) }))
    expect((await client.config(AGENT_1_ID)).config.tools).toEqual([expect.objectContaining({ name: 'msg_send', enabled: true, restricted: false })])
    await expect(client.alwaysApproveTask(AGENT_1_ID, 'task_oneshot')).rejects.toMatchObject({ status: 409 })
    await expect(client.alwaysApproveTask(AGENT_1_ID, 'task_protect')).rejects.toMatchObject({ status: 409 })

    const denied = await client.resolveTask(AGENT_1_ID, 'task_deny', { action: 'deny', reason: 'use notes/ instead' })
    expect(denied.task).toEqual(expect.objectContaining({ status: 'denied', error: 'use notes/ instead' }))

    expect(await client.approveAllTasks(AGENT_1_ID)).toEqual({ agentId: AGENT_1_ID, approved: 2, skippedProtection: 1 })
    expect(await client.approveAllTasks(AGENT_1_ID, 'researcher')).toEqual({ agentId: AGENT_1_ID, loop: 'researcher', approved: 0, skippedProtection: 0 })
  })

  it('lists, tracks and untracks agent folders', async () => {
    const listed = await client.trackedDirs()
    expect(listed.directories).toEqual([{ path: MOCK_AGENTS_DIR, exists: true, agentCount: 2, loadedCount: 2 }])

    const tracked = await client.trackDir(MOCK_SPARE_DIR)
    expect(tracked.entry).toEqual({ path: MOCK_SPARE_DIR, exists: true, agentCount: 0, loadedCount: 0 })
    expect(tracked.directories).toEqual([MOCK_AGENTS_DIR, MOCK_SPARE_DIR])
    expect(tracked.needsReview).toEqual([])
    await expect(client.trackDir(MOCK_SPARE_DIR)).rejects.toMatchObject({ status: 409 })
    await expect(client.trackDir('relative/dir')).rejects.toMatchObject({ status: 400 })
    await expect(client.trackDir('/nope/missing')).rejects.toMatchObject({ status: 400 })

    expect(await client.untrackDir(MOCK_SPARE_DIR)).toEqual({ removed: MOCK_SPARE_DIR, directories: [MOCK_AGENTS_DIR], unloaded: [] })
    await expect(client.untrackDir(MOCK_SPARE_DIR)).rejects.toMatchObject({ status: 404 })
    const unloaded = await client.untrackDir(MOCK_AGENTS_DIR, { unload: true })
    expect(unloaded.unloaded.map(a => a.agentId)).toEqual([AGENT_1_ID, expect.any(String)])
    expect(mock.trackedDirs).toEqual([])
  })

  it('reports an unreachable daemon distinctly from an HTTP error', async () => {
    const offline = new DaemonClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 })
    const err = await offline.health().catch(e => e)
    expect(err).toBeInstanceOf(DaemonError)
    expect(err.unreachable).toBe(true)

    const notFound = await client.status('agent-9').catch(e => e)
    expect(notFound.status).toBe(404)
    expect(notFound.unreachable).toBe(false)
  })

  it('sends the bearer token when configured', async () => {
    const seen: Array<Record<string, string>> = []
    const tokenClient = new DaemonClient({
      baseUrl: mock.url,
      token: 'secret-token',
      fetch: async (url, init) => {
        seen.push(init?.headers as Record<string, string>)
        return fetch(url, init)
      },
    })
    await tokenClient.agents()
    expect(seen[0].Authorization).toBe('Bearer secret-token')
  })
})

describe('EventStream', () => {
  it('streams loop-stamped events for a chat turn on an inner loop', async () => {
    const frames: DaemonEventFrame[] = []
    const stream = client.events({ onEvent: frame => frames.push(frame) }).start()
    try {
      await until(() => stream.connection.state === 'open')
      await client.chat(AGENT_1_ID, 'dig into the standings API', 'researcher')
      await until(() => frames.some(f => f.event.event_type === 'turn.completed'))
      const turn = frames.filter(f => f.event.agent_id === AGENT_1_ID)
      expect(turn.every(f => f.event.loop === 'researcher')).toBe(true)
      expect(turn.map(f => f.event.event_type)).toEqual(expect.arrayContaining(['agent.state.changed', 'turn.delta', 'tool.started', 'tool.completed', 'turn.completed']))
    } finally {
      stream.close()
    }
  })

  it('reconnects with ?since=cursor, replays the gap once and reports each transition', async () => {
    const frames: DaemonEventFrame[] = []
    const states: ConnectionInfo[] = []
    const stream = new EventStream({
      baseUrl: mock.url,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      onEvent: frame => frames.push(frame),
      onState: info => states.push(info),
    }).start()
    try {
      await until(() => stream.connection.state === 'open')
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
      await until(() => frames.length === 1)

      mock.dropEventStreams()
      await until(() => states.some(s => s.state === 'reconnecting'))
      // Emitted while disconnected: must arrive via the ?since= replay.
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'idle' } })
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { state: 'thinking' } })

      await until(() => frames.length >= 3)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(frames.map(f => f.event.seq)).toEqual([1, 2, 3])
      expect(frames[2].event.loop).toBe('consolidator')
      expect(states.map(s => s.state)).toEqual(expect.arrayContaining(['connecting', 'open', 'reconnecting']))
      expect(states.filter(s => s.state === 'open').at(-1)?.resumed).toBe(true)
      expect(mock.requests.filter(r => r.startsWith('GET /events')).at(-1)).toMatch(/since=1\b/)
    } finally {
      stream.close()
    }
    expect(stream.connection.state).toBe('closed')
  })

  it('dedupes a frame replayed twice by agent + seq', async () => {
    const frames: DaemonEventFrame[] = []
    mock.emit({ event_type: 'agent.loaded', agent_id: AGENT_1_ID })
    const stream = new EventStream({ baseUrl: mock.url, replay: true, onEvent: frame => frames.push(frame), minBackoffMs: 10, maxBackoffMs: 20 }).start()
    try {
      await until(() => frames.length === 1)
      // Force a full replay (cursor rewind) — the known frame must not repeat.
      ;(stream as unknown as { lastCursor: number }).lastCursor = 0
      mock.dropEventStreams()
      mock.emit({ event_type: 'agent.unloaded', agent_id: AGENT_1_ID })
      await until(() => frames.length >= 2)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(frames.map(f => f.event.event_type)).toEqual(['agent.loaded', 'agent.unloaded'])
    } finally {
      stream.close()
    }
  })
})

describe('DaemonClient token scope', () => {
  it('carries its bearer token only to the same origin', () => {
    const base = new DaemonClient({ baseUrl: 'http://127.0.0.1:7385', token: 'daemon-a-token' })
    expect(base.withBaseUrl('http://127.0.0.1:7385/').headers().Authorization).toBe('Bearer daemon-a-token')
    const other = base.withBaseUrl('http://example.invalid:7385')
    const env = process.env.ADF_DAEMON_TOKEN
    expect(other.headers().Authorization).toBe(env ? `Bearer ${env}` : undefined)
    expect(base.withBaseUrl('http://example.invalid:7385', 'daemon-b-token').headers().Authorization).toBe('Bearer daemon-b-token')
  })
})

