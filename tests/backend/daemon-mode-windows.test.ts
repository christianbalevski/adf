/**
 * Agent windows in daemon mode (docs/design/agent-windows.md): each window
 * is its own client session; an IPC call is served by its sender's session,
 * frames reach only that window, approvals have one notice window, and a
 * closed window releases its session before the main session's quit.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon, type FakeClientSession } from './daemon-mode-fakes'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { NoticeOwners, noticeWindow, type WindowView } from '../../src/main/backend/daemon-mode/windows'
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { NotificationsSnapshot, PendingNotification } from '../../src/shared/types/ipc.types'

const BASE = 'http://127.0.0.1:47385'
const TOKEN = 'a'.repeat(43)
const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const FILE_1 = join(tmpdir(), 'agents', 'agent-1.adf')
const FILE_2 = join(tmpdir(), 'agents', 'agent-2.adf')
const WINDOW = 7

const samePath = (a: string | null, b: string | null): boolean => !!a && !!b && a === b

function pending(id: string, filePath: string, agentName: string): PendingNotification {
  return { id, kind: 'approval', requestId: id, filePath, agentName, loop: 'main', toolName: 'fs_write', preview: '', requestedAt: 1 }
}

describe('notice window rule', () => {
  const windows: WindowView[] = [
    { id: 1, main: true, focused: false, filePath: FILE_2 },
    { id: WINDOW, main: false, focused: true, filePath: FILE_1 },
  ]

  it('is the focused window that shows the agent, else the main window', () => {
    expect(noticeWindow(FILE_1, windows, samePath)).toBe(WINDOW)
    expect(noticeWindow(FILE_2, windows, samePath)).toBe(1)
    expect(noticeWindow(FILE_1, windows.map((w) => ({ ...w, focused: false })), samePath)).toBe(1)
  })

  it('without a main window: a window that shows the agent, else none', () => {
    const agentOnly = [{ id: WINDOW, main: false, focused: false, filePath: FILE_1 }]
    expect(noticeWindow(FILE_1, agentOnly, samePath)).toBe(WINDOW)
    expect(noticeWindow(FILE_2, agentOnly, samePath)).toBeNull()
  })

  it('decides once per request and forgets answered ones', () => {
    const owners = new NoticeOwners(samePath)
    owners.assign([pending('n1', FILE_1, 'agent-1')], windows)
    // The agent window loses focus: n1 stays there; a new request goes to the main window.
    const unfocused = windows.map((w) => ({ ...w, focused: false }))
    owners.assign([pending('n1', FILE_1, 'agent-1'), pending('n2', FILE_1, 'agent-1')], unfocused)
    expect(owners.owner('n1')).toBe(WINDOW)
    expect(owners.owner('n2')).toBe(1)
    expect(owners.idsFor(WINDOW)).toEqual(['n1'])
    owners.assign([pending('n2', FILE_1, 'agent-1')], unfocused)
    expect(owners.owner('n1')).toBeNull()
    // A closed window's requests are the main window's.
    owners.assign([pending('n2', FILE_1, 'agent-1'), pending('n3', FILE_1, 'agent-1')], windows)
    owners.moveTo(WINDOW, 1)
    expect(owners.idsFor(1)).toEqual(['n2', 'n3'])
  })
})

describe('daemon-mode agent windows', () => {
  let dir: string
  let handle: DaemonModeHandle
  const daemon = createFakeDaemon(BASE)
  const holds: Record<string, string> = { [FILE_1]: AGENT_1, [FILE_2]: AGENT_2 }
  const makeSession = (id: string): FakeClientSession => {
    const s = createFakeClientSession((filePath) => holds[filePath] ?? null)
    s.holdsAvailable = true
    ;(s as { sessionId: string | null }).sessionId = id
    return s
  }
  const mainSession = makeSession('s-main')
  const windowSessions: FakeClientSession[] = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const order: string[] = []
  const windowPushes: Array<{ channel: string; args: unknown[] }> = []
  let windowFocused = true
  let created = 0
  const logs: string[] = []
  const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }

  const invoke = (channel: string, sender: number | null, ...args: unknown[]) =>
    handlers.get(channel)!(sender === null ? {} : { sender: { id: sender } }, ...args)
  const pushesOf = (list: Array<{ channel: string; args: unknown[] }>, channel: string) => list.filter((p) => p.channel === channel).map((p) => p.args[0])

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-windows-'))
    daemon.routes.set('GET /agents', () => [])
    daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
    daemon.routes.set(`GET /agents/${AGENT_1}/header`, () => ({ document: 'one', agentConfig: { name: 'agent-1' }, statusText: '' }))
    mainSession.quit = async (stopDaemon: boolean) => {
      order.push('main quit')
      return { sessionId: 's-main', ended: true, stopping: stopDaemon, reason: 'test', otherSessions: 0 }
    }
    handle = registerDaemonModeHandlers({
      mode: 'local',
      userDataDir: dir,
      connect: Object.assign(async () => ({ baseUrl: BASE, logFile: join(dir, 'adf-daemon.log'), description: 'the fake daemon', source: { token: () => TOKEN } }), { logFile: join(dir, 'adf-daemon.log') }),
      leases: { registerClient: async () => {} },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
        on: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
      } as never,
      fetch: daemon.fetch,
      // The first session is the main window's; every later one an agent window's.
      createSession: () => {
        if (created++ === 0) return mainSession
        const s = makeSession(`s-window-${windowSessions.length + 1}`)
        const end = s.end.bind(s)
        s.end = async () => { order.push(`${s.sessionId} ended`); await end() }
        windowSessions.push(s)
        return s
      },
      log,
    })
    expect(await handle.ready).toBe(true)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves an agent window\'s calls by its own session', async () => {
    handle.windows.open({ id: WINDOW, send: (channel, ...args) => { windowPushes.push({ channel, args }) }, focused: () => windowFocused })
    const opened = await invoke(IPC.FILE_OPEN, WINDOW, { filePath: FILE_1 }) as { success: boolean }
    expect(opened.success).toBe(true)
    const win = windowSessions[0]
    expect(win.held).toEqual([AGENT_1])
    expect(win.focus.at(-1)).toBe(AGENT_1)
    expect(mainSession.held).toEqual([])
    expect(handle.session.filePath).toBeNull()
    expect(handle.windows.current(WINDOW)).toEqual({ filePath: FILE_1, agentId: AGENT_1 })

    // Requests carry the window's session id, so the daemon does not echo its own writes to it (D5.1).
    const header = await invoke(IPC.DOC_GET_HEADER, WINDOW) as { document: string }
    expect(header.document).toBe('one')
    const request = daemon.requests.find((r) => r.path === `/agents/${AGENT_1}/header`)!
    expect(request.headers['X-ADF-Client-Session']).toBe('s-window-1')

    // An unknown sender (and the main window) is served by the main session: no file open there.
    expect(await invoke(IPC.FILE_GET_CURRENT, null)).toEqual({ filePath: null, agentRunning: false })
    expect(await invoke(IPC.FILE_GET_CURRENT, 99)).toEqual({ filePath: null, agentRunning: false })
  })

  it('sends a window\'s frames to that window only', () => {
    const before = electronStub.pushes.length
    windowSessions[0].listener!.onFrame({ kind: 'executor', agentId: AGENT_1, filePath: FILE_1, event: { type: 'state_changed', payload: { state: 'active' }, timestamp: 1 } as never })
    expect(pushesOf(windowPushes, IPC.AGENT_EVENT)).toEqual([{ type: 'state_changed', payload: { state: 'active' }, timestamp: 1 }])
    expect(electronStub.pushes.slice(before).filter((p) => p.channel === IPC.AGENT_EVENT)).toEqual([])
  })

  it('shows each approval\'s notice in one window: the focused one that shows the agent, else the main window', () => {
    windowFocused = true
    electronStub.focused = false
    const before = electronStub.pushes.length
    windowPushes.length = 0
    const snapshot: NotificationsSnapshot = { pending: [pending('n1', FILE_1, 'agent-1'), pending('n2', FILE_2, 'agent-2')], history: [] }
    mainSession.listener!.onFrame({ kind: 'push', topic: 'approvals', payload: snapshot })
    const toMain = electronStub.pushes.slice(before).filter((p) => p.channel === IPC.APPROVALS_CHANGED).map((p) => p.args[0] as NotificationsSnapshot)
    const toWindow = pushesOf(windowPushes, IPC.APPROVALS_CHANGED) as NotificationsSnapshot[]
    expect(toMain).toHaveLength(1)
    expect(toWindow).toHaveLength(1)
    expect(toMain[0].notify).toEqual(['n2'])
    expect(toWindow[0].notify).toEqual(['n1'])
    expect(toMain[0].pending).toEqual(snapshot.pending)

    // The window's own stream carries the same snapshot: it is dropped there, never a second copy.
    windowSessions[0].listener!.onFrame({ kind: 'push', topic: 'approvals', payload: snapshot })
    expect(pushesOf(windowPushes, IPC.APPROVALS_CHANGED)).toHaveLength(1)
    expect(handle.windows.noticeOwner('n1')).toBe(WINDOW)
    expect(handle.windows.noticeOwner('n2')).toBeNull()

    // Focus moves later: a request keeps its window.
    windowFocused = false
    mainSession.listener!.onFrame({ kind: 'push', topic: 'approvals', payload: { ...snapshot, pending: [...snapshot.pending, pending('n3', FILE_1, 'agent-1')] } })
    const last = (pushesOf(windowPushes, IPC.APPROVALS_CHANGED) as NotificationsSnapshot[]).at(-1)!
    expect(last.notify).toEqual(['n1'])
    expect(handle.windows.noticeOwner('n3')).toBeNull()
  })

  it('closing the window ends its session and releases its documents; its notices go to the main window', async () => {
    await handle.windows.close(WINDOW)
    const win = windowSessions[0]
    expect(win.ended).toBe(true)
    expect(win.released).toEqual([AGENT_1])
    expect(handle.windows.current(WINDOW)).toBeNull()
    expect(handle.windows.noticeOwner('n1')).toBeNull()
    // Its calls now fall back to the main session.
    expect(await invoke(IPC.FILE_GET_CURRENT, WINDOW)).toEqual({ filePath: null, agentRunning: false })
  })

  it('a quit ends every agent window\'s session before the main session\'s quit (§8.3 counts other sessions)', async () => {
    handle.windows.open({ id: 8, send: () => {}, focused: () => false })
    await invoke(IPC.FILE_OPEN, 8, { filePath: FILE_2 })
    await handle.shutdown()
    expect(order).toEqual(['s-window-1 ended', 's-window-2 ended', 'main quit'])
  })
})
