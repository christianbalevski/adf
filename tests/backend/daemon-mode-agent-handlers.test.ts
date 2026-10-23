/**
 * W3-A agent runtime handlers in daemon mode (documents/agent-handlers.ts)
 * and the core AGENT_START / FILE_OPEN gates (handlers/core.ts): each answers
 * what the embedded handler answers, against a scripted daemon.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { createFakeClientSession, createFakeDaemon, type FakeClientSession } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { createStudioDaemonClient } from '../../src/main/backend/daemon-mode/credentials'
import { findRunningAgent, type DaemonModeContext } from '../../src/main/backend/daemon-mode/context'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { AGENT_HANDLERS } from '../../src/main/backend/daemon-mode/documents/agent-handlers'
import { CORE_HANDLERS } from '../../src/main/backend/daemon-mode/handlers/core'

const BASE = 'http://127.0.0.1:47393'
const AGENT = '3b9d6c1e-7a2f-4c8b-9d0e-1f2a3b4c5d01'
const OTHER = '3b9d6c1e-7a2f-4c8b-9d0e-1f2a3b4c5d02'

let dir: string
let file1: string
let file2: string
const daemon = createFakeDaemon(BASE)
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const client = createStudioDaemonClient({ baseUrl: BASE, source: { token: () => 'tok' }, fetch: daemon.fetch })
let fake: FakeClientSession
let holdLocked = false
let session: DaemonModeSession
let bridgeAgents: Array<{ agentId: string; filePath: string; handle?: string; mapping: { state: string; activeLoops: number }; shownInBackground: boolean }>
let ctx: DaemonModeContext

const handlers = { ...CORE_HANDLERS, ...AGENT_HANDLERS }
function call(channel: string, ...args: unknown[]): Promise<any> {
  return Promise.resolve(handlers[channel as keyof typeof handlers]!(ctx, {} as never, ...args))
}
const last = (method: string, path: string) => daemon.requests.filter((r) => r.method === method && r.path === path).at(-1)
const status = (id: string, filePath: string, extra: Record<string, unknown> = {}) =>
  ({ id, filePath, name: 'agent', handle: 'agent', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0, running: true, ...extra })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-agent-handlers-'))
  file1 = join(dir, 'agent-1.adf')
  file2 = join(dir, 'agent-2.adf')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  daemon.requests.length = 0
  daemon.routes.clear()
  fake = createFakeClientSession((p) => (p === file1 ? AGENT : OTHER))
  fake.holdsAvailable = true
  // The hold answers the open-document info (W2-A): needsPassword as the daemon reports it.
  const hold = fake.holdDocument.bind(fake)
  fake.holdDocument = async (filePath: string) => ({ ...(await hold(filePath)), running: false, needsPassword: holdLocked })
  holdLocked = false
  session = new DaemonModeSession(fake, quiet)
  bridgeAgents = []
  ctx = {
    mode: 'local',
    session,
    ready: async () => client,
    runningAgentAt: (filePath: string) => findRunningAgent(client, filePath),
    recordRecentFile: () => {},
    bridge: {
      holdForeground: () => () => {},
      seed: (statuses: Array<{ id: string; filePath: string; handle?: string; runtimeState: string }>) => {
        for (const s of statuses) if (!bridgeAgents.some((a) => a.agentId === s.id)) bridgeAgents.push({ agentId: s.id, filePath: s.filePath, handle: s.handle, mapping: { state: s.runtimeState, activeLoops: 0 }, shownInBackground: false })
      },
      runningAgents: () => bridgeAgents,
      markListedInBackground: (id: string) => { const a = bridgeAgents.find((b) => b.agentId === id); if (a) a.shownInBackground = true },
    },
    log: quiet,
  } as unknown as DaemonModeContext
  daemon.routes.set('GET /files/agent', ({ query }) => (query.path === file2
    ? { filePath: file2, agentId: OTHER, loaded: true, tracked: true }
    : { filePath: file1, agentId: AGENT, loaded: false, tracked: true }))
  daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
  daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'stopped', running: false }))
  daemon.routes.set(`GET /agents/${OTHER}/status`, () => status(OTHER, file2))
})

describe('open file: prompt before start (design §6.1 row 27)', () => {
  it('FILE_OPEN of a held document whose key the daemon lacks answers needsPassword', async () => {
    holdLocked = true
    expect(await call(IPC.FILE_OPEN, { filePath: file1 })).toEqual({ success: true, filePath: file1, needsPassword: true })
  })

  // As embedded stops a running agent it cannot open without the password
  // (ipc/index.ts FILE_OPEN). It used to keep running on the stub provider.
  // W5-A1 (lead decision): the agent is not stopped. Embedded stops a
  // background agent it cannot open without the password; the daemon keeps
  // it running for every client, and Studio re-attaches it after the unlock.
  it('FILE_OPEN of a running agent whose key the daemon lacks answers needsPassword and agentWasRunning; a second client watching it sees it keep running; AGENT_START after the unlock re-attaches it', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'idle', sessionId: 'session-9' }))
    daemon.routes.set(`GET /agents/${AGENT}/triggers`, () => ({ agentId: AGENT, displayState: 'idle', configured: [] }))
    daemon.routes.set('GET /approvals/interactions', () => [])
    // A second client (another Studio window or the TUI) has the agent open.
    const watcherFake = createFakeClientSession((p) => (p === file1 ? AGENT : OTHER))
    watcherFake.holdsAvailable = true
    const watcher = { ...ctx, session: new DaemonModeSession(watcherFake, quiet) } as DaemonModeContext
    const watch = (channel: string, ...args: unknown[]) => Promise.resolve(handlers[channel as keyof typeof handlers]!(watcher, {} as never, ...args))
    expect(await watch(IPC.FILE_OPEN, { filePath: file1 })).toMatchObject({ success: true, agentWasRunning: true })

    holdLocked = true
    expect(await call(IPC.FILE_OPEN, { filePath: file1 })).toEqual({ success: true, filePath: file1, needsPassword: true, agentWasRunning: true })
    expect(daemon.requests.some((r) => r.method === 'POST' && (r.path.endsWith('/stop') || r.path.endsWith('/start')))).toBe(false)
    expect(await watch(IPC.FILE_GET_CURRENT)).toEqual({ filePath: file1, agentRunning: true })

    // The password dialog unlocked it (the daemon rebuilt the real provider in place): completeFileOpen re-attaches.
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: true, unlocked: true }))
    expect(await call(IPC.AGENT_START, {})).toMatchObject({ success: true, sessionId: 'session-9', agentState: 'idle' })
    expect(daemon.requests.some((r) => r.method === 'POST' && (r.path.endsWith('/stop') || r.path.endsWith('/start')))).toBe(false)
    expect(await watch(IPC.FILE_GET_CURRENT)).toEqual({ filePath: file1, agentRunning: true })
  })

  it('FILE_OPEN of a locked agent that is not running stops nothing', async () => {
    holdLocked = true
    expect(await call(IPC.FILE_OPEN, { filePath: file1 })).toEqual({ success: true, filePath: file1, needsPassword: true })
    expect(last('POST', `/agents/${AGENT}/stop`)).toBeUndefined()
  })

  it('FILE_OPEN of a held document that is not running answers agentWasRunning false', async () => {
    expect(await call(IPC.FILE_OPEN, { filePath: file1 })).toEqual({ success: true, filePath: file1, agentWasRunning: false })
  })

  it('AGENT_START refuses a held document that is still locked with credentials_locked, and starts nothing', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: true, unlocked: false }))
    expect(await call(IPC.AGENT_START, {})).toEqual({ success: false, error: 'agent-1 is password-protected. Enter its password to start it.', code: 'credentials_locked' })
    expect(last('POST', `/agents/${AGENT}/start`)).toBeUndefined()
  })

  it('AGENT_START fresh: starts the held document by id with hasUserMessage, answers sessionId and the start-in state', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/start`, () => ({ success: true, loaded: true, startupTriggered: false, agent: status(AGENT, file1), sessionId: 'session-1' }))
    daemon.routes.set(`GET /agents/${AGENT}/config`, () => ({ agentId: AGENT, config: { id: AGENT, name: 'agent-1', start_in_state: 'idle' } }))
    expect(await call(IPC.AGENT_START, { filePath: file1, hasUserMessage: true })).toEqual({ success: true, sessionId: 'session-1', agentState: 'idle' })
    expect(last('POST', `/agents/${AGENT}/start`)?.query).toEqual({ preflight: '1', hasUserMessage: '1' })
  })

  it('AGENT_START reuse: display state, session id, main\'s pending approvals and asks', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'awaiting_approval', sessionId: 'session-7', loopStates: { reflector: 'active', critic: 'idle' } }))
    daemon.routes.set(`GET /agents/${AGENT}/triggers`, () => ({ agentId: AGENT, displayState: 'active', configured: [] }))
    daemon.routes.set('GET /approvals/interactions', () => ([
      { filePath: file1, handle: 'agent-1', type: 'ask', requestId: 'ask_1', question: 'Why?' },
      { filePath: file1, handle: 'agent-1', type: 'approval', requestId: 'task_1', toolName: 'fs_write', input: { path: 'a' }, reason: 'restricted', canAlwaysApprove: true },
      { filePath: file2, handle: 'agent-2', type: 'ask', requestId: 'ask_9', question: 'other' },
    ]))
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.AGENT_START, {})).toEqual({
      success: true,
      sessionId: 'session-7',
      agentState: 'active',
      // Side loops keep running across a switch: the re-attach answers their states (embedded: sideLoopStates()).
      loopStates: { reflector: 'active', critic: 'idle' },
      pendingApprovals: [{ requestId: 'task_1', name: 'fs_write', input: { path: 'a' }, reason: 'restricted', canAlwaysApprove: true }],
      pendingAsks: [{ requestId: 'ask_1', question: 'Why?' }],
    })
  })
  // The Kill race: FILE_OPEN saw the agent running, a Kill stopped it before
  // the re-attach. The re-attach answers not_running and never restarts it.
  it('AGENT_START reattachOnly of an agent a Kill stopped (stopped, then gone) stops and starts nothing', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'idle' }))
    expect(await call(IPC.FILE_OPEN, { filePath: file1 })).toMatchObject({ success: true, agentWasRunning: true })
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'stopped' }))
    expect(await call(IPC.AGENT_START, { reattachOnly: true })).toEqual({ success: false, code: 'not_running', error: 'agent-1 is not running.' })
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ status: 404, body: { error: `Unknown agent "${AGENT}"` } }))
    expect(await call(IPC.AGENT_START, { reattachOnly: true })).toEqual({ success: false, code: 'not_running', error: 'agent-1 is not running.' })
    expect(daemon.requests.some((r) => r.method === 'POST')).toBe(false)
  })

  // An agent in error is alive (it may recover on its next trigger): the re-attach shows it; only Start rebuilds it.
  it('AGENT_START reattachOnly of an agent in error re-attaches it, without a stop or a start', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'error', sessionId: 'session-4' }))
    daemon.routes.set(`GET /agents/${AGENT}/triggers`, () => ({ agentId: AGENT, displayState: 'error', configured: [] }))
    daemon.routes.set('GET /approvals/interactions', () => [])
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.AGENT_START, { reattachOnly: true })).toMatchObject({ success: true, sessionId: 'session-4', agentState: 'error' })
    expect(daemon.requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('AGENT_START reattachOnly of a running agent re-attaches it', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'idle', sessionId: 'session-3' }))
    daemon.routes.set(`GET /agents/${AGENT}/triggers`, () => ({ agentId: AGENT, displayState: 'idle', configured: [] }))
    daemon.routes.set('GET /approvals/interactions', () => [])
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.AGENT_START, { reattachOnly: true })).toMatchObject({ success: true, sessionId: 'session-3', agentState: 'idle' })
  })

  it('AGENT_START reuse: a failed side read never fails the re-attach', async () => {
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => status(AGENT, file1, { runtimeState: 'idle', sessionId: 'session-8' }))
    daemon.routes.set(`GET /agents/${AGENT}/triggers`, () => ({ status: 500, body: { error: 'boom' } }))
    daemon.routes.set('GET /approvals/interactions', () => ({ status: 500, body: { error: 'boom' } }))
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.AGENT_START, {})).toEqual({ success: true, sessionId: 'session-8', agentState: 'idle', loopStates: {}, pendingApprovals: [], pendingAsks: [] })
  })
})

describe('the open file\'s agent', () => {
  it('answers "Agent not running" without a file, and for a held document that is not running', async () => {
    expect(await call(IPC.AGENT_COMPACT)).toEqual({ success: false, error: 'Agent not running' })
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/compact`, () => ({ status: 409, body: { error: `Agent "${AGENT}" is not running`, code: 'agent_not_running' } }))
    expect(await call(IPC.AGENT_COMPACT)).toEqual({ success: false, error: 'Agent not running' })
  })

  it('AGENT_COMPACT passes compactNow\'s refusal sentence through', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/compact`, () => ({ status: 409, body: { error: 'There is nothing to compact.', code: 'conflict' } }))
    expect(await call(IPC.AGENT_COMPACT)).toEqual({ success: false, error: 'There is nothing to compact.' })
    daemon.routes.set(`POST /agents/${AGENT}/compact`, () => ({ agentId: AGENT, loop: 'main', success: true }))
    expect(await call(IPC.AGENT_COMPACT)).toEqual({ success: true })
  })

  it('AGENT_INTERRUPT is the daemon\'s interrupt for the open file (or a background agent by path), per loop', async () => {
    expect(await call(IPC.AGENT_INTERRUPT, {})).toEqual({ success: false, error: 'Agent not running' })
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/interrupt`, ({ query }) => ({ success: true, interrupted: true, loop: query.loop ?? 'main' }))
    expect(await call(IPC.AGENT_INTERRUPT, { filePath: file1 })).toEqual({ success: true, interrupted: true })
    expect(last('POST', `/agents/${AGENT}/interrupt`)?.query).toEqual({})
    expect(await call(IPC.AGENT_INTERRUPT, { filePath: file1, loop: 'reflection' })).toEqual({ success: true, interrupted: true })
    expect(last('POST', `/agents/${AGENT}/interrupt`)?.query).toEqual({ loop: 'reflection' })
    // Nothing running in that loop: answered, not an error.
    daemon.routes.set(`POST /agents/${AGENT}/interrupt`, () => ({ success: true, interrupted: false, loop: 'main' }))
    expect(await call(IPC.AGENT_INTERRUPT)).toEqual({ success: true, interrupted: false })
    // A refusal (a loop in error) carries the daemon's sentence.
    daemon.routes.set(`POST /agents/${AGENT}/interrupt`, () => ({ status: 409, body: { error: 'Cannot interrupt: loop "main" is error.', code: 'conflict' } }))
    expect(await call(IPC.AGENT_INTERRUPT)).toEqual({ success: false, error: 'Cannot interrupt: loop "main" is error.' })
    // Another agent by path (one Studio navigated away from).
    daemon.routes.set(`POST /agents/${OTHER}/interrupt`, () => ({ success: true, interrupted: true, loop: 'main' }))
    expect(await call(IPC.AGENT_INTERRUPT, { filePath: file2 })).toEqual({ success: true, interrupted: true })
  })

  it('approval, ask and suspend answers resolve through the task routes; a stale ask or suspend is a logged success, as embedded ignores it', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/tasks/task_1/resolve`, () => ({ agentId: AGENT, taskId: 'task_1' }))
    expect(await call(IPC.AGENT_TOOL_APPROVAL_RESPOND, { requestId: 'task_1', approved: false, feedback: 'no' })).toEqual({ success: true })
    expect(last('POST', `/agents/${AGENT}/tasks/task_1/resolve`)?.body).toEqual({ action: 'deny', reason: 'no' })
    // A stale approval is refused, so the card can say the decision did not land.
    daemon.routes.set(`POST /agents/${AGENT}/tasks/task_3/resolve`, () => ({ status: 404, body: { error: 'Task "task_3" not found', code: 'task_not_found' } }))
    expect(await call(IPC.AGENT_TOOL_APPROVAL_RESPOND, { requestId: 'task_3', approved: true })).toEqual({ success: false, error: 'This approval is no longer pending' })
    daemon.routes.set(`POST /agents/${AGENT}/asks/ask_1/respond`, () => ({ status: 404, body: { error: 'Ask request "ask_1" not found', code: 'ask_not_found' } }))
    expect(await call(IPC.AGENT_ASK_RESPOND, { requestId: 'ask_1', answer: 'x' })).toEqual({ success: true })
    expect(last('POST', `/agents/${AGENT}/asks/ask_1/respond`)?.body).toEqual({ answer: 'x', loop: 'main' })
    daemon.routes.set(`POST /agents/${AGENT}/suspend/respond`, () => ({ status: 500, body: { error: 'No pending suspend request' } }))
    expect(await call(IPC.AGENT_SUSPEND_RESPOND, { resume: true })).toEqual({ success: true })
  })

  it('always-approve refusals carry the blocked reason; approve-all is main\'s gated approvals', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set(`POST /agents/${AGENT}/tasks/task_2/always-approve`, () => ({ status: 409, body: { error: 'Tool declaration is locked', code: 'conflict' } }))
    expect(await call(IPC.AGENT_TOOL_ALWAYS_APPROVE, { requestId: 'task_2', toolName: 'fs_write' })).toEqual({ success: false, error: 'Tool declaration is locked' })
    daemon.routes.set(`POST /agents/${AGENT}/tasks/approve-all`, () => ({ agentId: AGENT, loop: 'main', approved: 2, skippedProtection: 1 }))
    expect(await call(IPC.AGENT_TOOL_APPROVE_ALL_GATED)).toEqual({ success: true, approved: 2, skippedProtection: 1 })
    expect(last('POST', `/agents/${AGENT}/tasks/approve-all`)?.body).toEqual({ loop: 'main' })
  })
})

describe('background agents and folders', () => {
  it('BACKGROUND_AGENT_START: foreground, review and password gates in embedded order, then load + start', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.BACKGROUND_AGENT_START, { filePath: file1 })).toEqual({ success: false, error: 'Cannot start background agent for the foreground file' })
    const file3 = join(dir, 'agent-3.adf')
    let peek: Record<string, unknown> = { filePath: file3, agentId: 'id-3', loaded: false, tracked: true, reviewed: false, passwordProtected: true }
    daemon.routes.set('GET /files/agent', () => peek)
    expect(await call(IPC.BACKGROUND_AGENT_START, { filePath: file3 })).toEqual({ success: false, error: 'Agent must be reviewed before starting. Open it in the foreground first.' })
    peek = { ...peek, reviewed: true }
    expect(await call(IPC.BACKGROUND_AGENT_START, { filePath: file3 })).toEqual({ success: false, error: 'Agent is password-protected. Open it in the foreground and unlock first.' })
    peek = { ...peek, passwordProtected: false }
    daemon.routes.set('POST /agents/load', () => ({ id: 'id-3', filePath: file3 }))
    daemon.routes.set('POST /agents/id-3/start', () => ({ success: true }))
    expect(await call(IPC.BACKGROUND_AGENT_START, { filePath: file3 })).toEqual({ success: true })
    expect(last('POST', '/agents/load')?.body).toEqual({ filePath: file3, requireReview: true })
    expect(last('POST', '/agents/id-3/start')).toBeTruthy()
  })

  it('BACKGROUND_AGENT_STATUS lists running agents except the open one, with in-flight starts', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    daemon.routes.set('GET /agents', () => [{ id: OTHER, filePath: file2, name: 'agent-2', handle: 'agent-2', autostart: false }])
    daemon.routes.set(`GET /agents/${OTHER}/status`, () => status(OTHER, file2, { handle: 'agent-2' }))
    bridgeAgents.push({ agentId: 'id-4', filePath: join(dir, 'agent-4.adf'), mapping: { state: 'idle', activeLoops: 0 }, shownInBackground: false })
    expect(await call(IPC.BACKGROUND_AGENT_STATUS)).toEqual({
      agents: [{ filePath: file2, handle: 'agent-2', state: 'idle', activeLoops: 0 }],
      starting: [join(dir, 'agent-4.adf')],
    })
    expect(bridgeAgents.find((a) => a.agentId === OTHER)?.shownInBackground).toBe(true)
  })

  it('BACKGROUND_* by path: the open file is not a background agent; a running one resolves through the routes', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    expect(await call(IPC.BACKGROUND_AGENT_ASK_RESPOND, { filePath: file1, requestId: 'ask_1', answer: 'x' })).toEqual({ success: false, error: 'Background agent not found' })
    expect(await call(IPC.BACKGROUND_AGENT_STOP, { filePath: file1 })).toEqual({ success: false })
    daemon.routes.set(`POST /agents/${OTHER}/tasks/t9/resolve`, () => ({ agentId: OTHER }))
    expect(await call(IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND, { filePath: file2, requestId: 't9', approved: true })).toEqual({ success: true })
    daemon.routes.set(`POST /agents/${OTHER}/tasks/t10/resolve`, () => ({ status: 409, body: { error: 'Task is not pending', code: 'conflict' } }))
    expect(await call(IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND, { filePath: file2, requestId: 't10', approved: true })).toEqual({ success: false, error: 'This approval is no longer pending' })
    daemon.routes.set(`POST /agents/${OTHER}/stop`, () => ({ success: true }))
    expect(await call(IPC.BACKGROUND_AGENT_STOP, { filePath: file2 })).toEqual({ success: true })
  })

  it('DIRECTORY_START_ALL starts each .adf directly in the folder but the open one and running ones; failures name embedded\'s sentence', async () => {
    await call(IPC.FILE_OPEN, { filePath: file1 })
    const file5 = join(dir, 'agent-5.adf')
    const file6 = join(dir, 'agent-6.adf')
    daemon.routes.set('GET /fs/browse', () => ({ path: dir, parent: null, roots: [], truncated: false, entries: [
      { name: 'sub', path: join(dir, 'sub'), kind: 'directory' },
      { name: 'agent-1.adf', path: file1, kind: 'adf' },
      { name: 'agent-2.adf', path: file2, kind: 'adf' },
      { name: 'agent-5.adf', path: file5, kind: 'adf' },
      { name: 'agent-6.adf', path: file6, kind: 'adf' },
    ] }))
    daemon.routes.set('GET /files/agent', ({ query }) => ({ filePath: query.path, agentId: query.path === file2 ? OTHER : null, loaded: query.path === file2, tracked: true }))
    daemon.routes.set('POST /agents/load', ({ body }) => ((body as { filePath: string }).filePath === file6
      ? { status: 409, body: { error: 'agent-6 is running in the ADF daemon, pid 1', code: 'agent_leased' } }
      : { id: 'id-5', filePath: file5 }))
    daemon.routes.set('POST /agents/id-5/start', () => ({ success: true }))
    expect(await call(IPC.DIRECTORY_START_ALL, { dirPath: dir })).toEqual({ success: true, failures: [{ file: file6, error: 'Failed to start agent' }] })
    expect(daemon.requests.filter((r) => r.path === '/agents/load').map((r) => (r.body as { filePath: string; requireReview: boolean }))).toEqual(expect.arrayContaining([
      { filePath: file5, requireReview: false }, { filePath: file6, requireReview: false },
    ]))
    expect(daemon.requests.some((r) => r.path === '/agents/load' && (r.body as { filePath: string }).filePath === file1)).toBe(false)
  })
})


describe('remote paths belong to the daemon filesystem', () => {
  // A daemon on the other OS family: Studio's own `join` would respell its paths.
  const remoteDir = process.platform === 'win32' ? '/srv/agents' : 'C:\\agents'
  const remoteFile = process.platform === 'win32' ? '/srv/agents/agent-5.adf' : 'C:\\agents\\agent-5.adf'

  it("DIRECTORY_START_ALL / STOP_ALL use the daemon's own paths from the listing (review 4300792035)", async () => {
    ctx.mode = 'remote'
    ctx.session = new DaemonModeSession(fake, quiet, undefined, true)
    daemon.routes.set('GET /fs/browse', () => ({ path: remoteDir, parent: null, roots: [], truncated: false, entries: [
      { name: 'agent-5.adf', path: remoteFile, kind: 'adf' },
    ] }))
    let loaded = false
    daemon.routes.set('GET /files/agent', ({ query }) => ({ filePath: query.path, agentId: loaded && query.path === remoteFile ? 'id-5' : null, loaded: loaded && query.path === remoteFile, tracked: true }))
    daemon.routes.set('POST /agents/load', () => { loaded = true; return { id: 'id-5', filePath: remoteFile } })
    daemon.routes.set('POST /agents/id-5/start', () => ({ success: true }))
    daemon.routes.set('POST /agents/id-5/stop', () => ({ success: true }))
    expect(await call(IPC.DIRECTORY_START_ALL, { dirPath: remoteDir })).toEqual({ success: true })
    expect(daemon.requests.filter((r) => r.path === '/agents/load').map((r) => (r.body as { filePath: string }).filePath)).toEqual([remoteFile])
    expect(await call(IPC.DIRECTORY_STOP_ALL, { dirPath: remoteDir })).toEqual({ success: true })
    expect(daemon.requests.filter((r) => r.path === '/agents/id-5/stop')).toHaveLength(1)
  })

  it('Start all / Stop all on a folder named through a link leave the open file\'s agent alone (review follow-up to 1993f4ca)', async () => {
    ctx.mode = 'remote'
    ctx.session = new DaemonModeSession(fake, quiet, undefined, true)
    // Opened through the link; the listing names the folder's real path.
    const linkDir = process.platform === 'win32' ? '/home/user/agents-link' : 'C:\\agents-link'
    const openPath = process.platform === 'win32' ? `${linkDir}/agent-2.adf` : `${linkDir}\\agent-2.adf`
    const canonical = process.platform === 'win32' ? '/srv/agents/agent-2.adf' : 'C:\\agents\\agent-2.adf'
    await ctx.session.openFile(openPath, async () => null)
    expect(ctx.session.agentId).toBe(OTHER)
    daemon.routes.set('GET /fs/browse', () => ({ path: remoteDir, parent: null, roots: [], truncated: false, entries: [
      { name: 'agent-2.adf', path: canonical, kind: 'adf' },
    ] }))
    daemon.routes.set('GET /files/agent', ({ query }) => ({ filePath: query.path, agentId: query.path === canonical ? OTHER : null, loaded: query.path === canonical, tracked: true }))
    expect(await call(IPC.DIRECTORY_START_ALL, { dirPath: linkDir })).toEqual({ success: true })
    expect(await call(IPC.DIRECTORY_STOP_ALL, { dirPath: linkDir })).toEqual({ success: true })
    expect(daemon.requests.filter((r) => r.path === '/agents/load' || r.path === `/agents/${OTHER}/stop`)).toEqual([])
  })

  it('allows a lowercase Linux agent to start beside a distinct uppercase foreground agent', async () => {
    ctx.mode = 'remote'
    ctx.session = new DaemonModeSession(fake, quiet, undefined, true)
    await ctx.session.openFile('/agents/Foo.adf', async () => null)
    daemon.routes.set('GET /files/agent', () => ({ loaded: true, agentId: OTHER, filePath: '/agents/foo.adf' }))
    expect(await call(IPC.BACKGROUND_AGENT_START, { filePath: '/agents/foo.adf' })).toEqual({ success: true })
    expect(last('GET', '/files/agent')?.query).toEqual({ path: '/agents/foo.adf' })
  })
})
