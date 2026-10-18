/**
 * Studio main's side of a switch (tracker W4-A review fixes): the
 * session-only embedded flag, the version-mismatch dialog (names a daemon
 * Studio did not start and the connected clients), the switch dialog with
 * turns in flight ("Wait for them to finish" / "Stop them now"), and the
 * agents that ran before a switch started again after it.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  responses: [] as number[],
  dialogs: [] as Array<{ message: string; detail: string; buttons: string[]; defaultId?: number }>,
  relaunches: [] as unknown[],
  quits: 0,
  notifications: [] as string[],
  /** The next dialog stays open until its signal aborts (the user closes Studio). */
  holdNextDialog: false,
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.9.0',
    // showBootWindow brings Studio to the front on macOS.
    focus: () => {},
    isPackaged: false,
    relaunch: (opts: unknown) => { h.relaunches.push(opts) },
    quit: () => { h.quits++ },
  },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string; buttons: string[]; defaultId?: number; cancelId?: number; signal?: AbortSignal }
      h.dialogs.push(opts)
      if (h.holdNextDialog && opts.signal) {
        h.holdNextDialog = false
        const signal = opts.signal
        // As Electron: an aborted signal ends the box with the cancel answer.
        return new Promise((r) => signal.addEventListener('abort', () => r({ response: opts.cancelId ?? 0 })))
      }
      return { response: h.responses.shift() ?? 0 }
    },
  },
  // The boot window the windowless dialog opens on.
  BrowserWindow: class {
    on() { return this }
    loadURL() { return Promise.resolve() }
    show() {}
    focus() {}
    isDestroyed() { return false }
    close() {}
  },
  nativeTheme: { shouldUseDarkColors: false },
  Notification: class {
    static isSupported() { return true }
    constructor(readonly options: { body: string }) { h.notifications.push(options.body) }
    show() {}
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

// Never the real keychain: the switch dialog's plan runs with it turned off.
process.env.ADF_KEYCHAIN = '0'

const {
  askVersionMismatch,
  createModeSwitcher,
  restartingMessage,
  resumeSwitchedAgents,
  SESSION_BACKEND_ARG,
  sessionBackendEnv,
  SWITCH_RESUME_FILE,
} = await import('../../src/main/backend/mode-switch')
const { resolveBootBackend } = await import('../../src/main/backend/backend-config')
const { dismissBootDialogs, noteMainWindowClosed } = await import('../../src/main/utils/boot-window')
import type { DaemonVersionInfo } from '../../src/main/daemon/routes/meta-routes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-mode-switch-'))
  writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({ theme: 'dark' }))
  h.responses.length = 0
  h.dialogs.length = 0
  h.relaunches.length = 0
  h.quits = 0
  h.notifications.length = 0
})

const running = (over: Partial<DaemonVersionInfo> = {}): DaemonVersionInfo => ({
  version: '0.8.0', clientApiVersion: 99, settingsPath: join(dir, 'adf-settings.json'), dataDir: dir, runtimeId: null, pid: 4242, startedBy: 'studio', ...over,
})
const mismatch = { kind: 'version-mismatch' as const, daemonVersion: '0.8.0', daemonClientApiVersion: 99, message: 'The running ADF daemon (version 0.8.0, client API 99) does not match this Studio (client API 1).' }

describe('the session-only embedded flag (§8.2)', () => {
  it('boots embedded for this launch, as source "session", without touching the configured mode', () => {
    const path = join(dir, 'studio-backend.json')
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'local' }))
    const { env, session } = sessionBackendEnv(['studio.exe', SESSION_BACKEND_ARG], {})
    expect(session).toBe(true)
    const boot = resolveBootBackend(path, env, { log: () => {}, warn: () => {} })
    expect(boot).toMatchObject({ mode: 'embedded', config: { mode: 'local' } })
    expect(sessionBackendEnv(['studio.exe'], {})).toEqual({ env: {}, session: false })
  })
})

describe('version mismatch dialog (§8.2 step 3)', () => {
  it('a daemon the CLI started, with the terminal app connected: named, "Restart It Anyway", embedded is the default', async () => {
    h.responses.push(1)
    const choice = await askVersionMismatch(mismatch, running({ startedBy: 'cli' }), [{ client: 'tui', version: '0.8.0' }], () => null)
    expect(choice).toBe('embedded')
    const shown = h.dialogs[0]
    expect(shown.buttons).toEqual(['Restart It Anyway', 'Run Inside Studio for This Session'])
    expect(shown.defaultId).toBe(1)
    expect(shown.detail).toMatch(/started by the ADF CLI/)
    expect(shown.detail).toMatch(/Connected to it now: tui 0\.8\.0/)
    expect(shown.detail).toMatch(/sign-ins as they are/)
    expect(h.relaunches).toEqual([{ args: expect.arrayContaining([SESSION_BACKEND_ARG]) }])
    expect(h.quits).toBe(1)
  })

  it.each(['win32', 'linux'] as const)('closing Studio while the question is open dismisses it: no answer, no restart of either kind (review follow-up to c57a8981; %s)', async (platform) => {
    h.holdNextDialog = true
    const choice = askVersionMismatch(mismatch, running(), [], () => null)
    while (h.dialogs.length === 0) await new Promise((r) => setTimeout(r, 0))
    noteMainWindowClosed(platform)
    expect(await choice).toBe('dismissed')
    expect(h.relaunches).toEqual([])
    expect(h.quits).toBe(0)
  })

  it('macOS: closing the main window leaves the question open; it answers nothing by itself', async () => {
    h.holdNextDialog = true
    let settled: string | null = null
    const choice = askVersionMismatch(mismatch, running(), [], () => null).then((c) => { settled = c; return c })
    while (h.dialogs.length === 0) await new Promise((r) => setTimeout(r, 0))
    noteMainWindowClosed('darwin')
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBeNull()
    expect(h.relaunches).toEqual([])
    // Quitting Studio (Cmd+Q) dismisses it.
    dismissBootDialogs('Studio is quitting')
    expect(await choice).toBe('dismissed')
    expect(h.relaunches).toEqual([])
  })

  it('a daemon Studio started with nobody else connected: a plain restart', async () => {
    h.responses.push(0)
    expect(await askVersionMismatch(mismatch, running(), [], () => null)).toBe('restart')
    expect(h.dialogs[0].buttons[0]).toBe('Restart the Daemon with Studio\'s Version')
    expect(h.relaunches).toEqual([])
  })
})

describe('the switch dialog and the agents that ran before it (§11.1)', () => {
  const agent1 = 'C:/agents/agent-1.adf'
  const agent2 = 'C:/agents/agent-2.adf'

  function switcher(activity: () => Array<{ filePath: string; busy: boolean; waiting?: boolean }>, activeMode: 'embedded' | 'local' | 'remote' = 'embedded', daemon: { keep?: boolean; startedBy?: 'studio' | 'cli' | null } = {}) {
    const relaunched: string[] = []
    const s = createModeSwitcher({
      activeMode,
      remoteUrl: () => 'https://adf.example.test',
      userDataDir: dir,
      agentActivity: activity,
      keepDaemonRunning: () => daemon.keep ?? false,
      daemonStartedBy: () => daemon.startedBy ?? null,
      window: () => null,
      relaunch: (target) => { relaunched.push(target) },
    })
    return { s, relaunched }
  }

  it('turns in flight: the dialog names them and "Wait for Them to Finish" restarts once they are done', async () => {
    let busy = true
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy }, { filePath: agent2, busy: false }])
    h.responses.push(0)
    expect(await s.confirm('local')).toBe(true)
    expect(h.dialogs[0].buttons).toEqual(['Wait for Them to Finish', 'Stop Them Now', 'Cancel'])
    expect(h.dialogs[0].detail).toMatch(/A turn is in flight in: agent-1/)
    expect(h.dialogs[0].detail).toMatch(/Running agents keep running: agent-1, agent-2/)
    expect(s.apply('local')).toBe('Studio restarts once the turns in flight finish (agent-1).')
    await new Promise((r) => setTimeout(r, 1300))
    expect(relaunched).toEqual([])
    busy = false
    await vi.waitFor(() => expect(relaunched).toEqual(['local']), { timeout: 3000 })
    const record = JSON.parse(readFileSync(join(dir, SWITCH_RESUME_FILE), 'utf-8'))
    expect(record).toMatchObject({ v: 1, from: 'embedded', to: 'local', agents: [agent1, agent2] })
  })

  it('to Remote (W4-B): says what stays on this computer; running agents are not started on the remote daemon', async () => {
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy: false }])
    h.responses.push(0)
    expect(await s.confirm('remote')).toBe(true)
    const detail = h.dialogs[0].detail
    expect(detail).toMatch(/uses the ADF daemon at https:\/\/adf\.example\.test\./)
    expect(detail).toMatch(/Stays on this computer: ChatGPT, Grok and MCP sign-ins, provider keys, the owner phrase and the runtime identity\./)
    expect(detail).toMatch(/agent-1 stop here and are not started on the remote daemon/)
    expect(detail).not.toMatch(/Studio starts them/)
    s.apply('remote')
    await vi.waitFor(() => expect(relaunched).toEqual(['remote']))
    expect(JSON.parse(readFileSync(join(dir, SWITCH_RESUME_FILE), 'utf-8'))).toMatchObject({ from: 'embedded', to: 'remote', agents: [] })
  })

  it('from Remote (W4-B): the remote daemon keeps its agents; no wait for its turns, nothing resumed here', async () => {
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy: true }], 'remote')
    h.responses.push(0)
    expect(await s.confirm('embedded')).toBe(true)
    expect(h.dialogs[0].buttons).toEqual(['Switch and Restart', 'Cancel'])
    expect(h.dialogs[0].detail).toMatch(/Nothing comes from the remote daemon: its agents, sign-ins and keys stay on it\./)
    expect(h.dialogs[0].detail).toMatch(/The remote daemon keeps running its agents \(agent-1\)\. Studio does not start them itself\./)
    expect(s.apply('embedded')).toBe('Studio restarts now.')
    await vi.waitFor(() => expect(relaunched).toEqual(['embedded']))
    expect(JSON.parse(readFileSync(join(dir, SWITCH_RESUME_FILE), 'utf-8'))).toMatchObject({ from: 'remote', to: 'embedded', agents: [] })
  })

  it('from Local (DMN-02): turns in a daemon Studio stops at quit are asked about; in one that keeps running they are not', async () => {
    const busy = () => [{ filePath: agent1, busy: true }]
    // Studio started the daemon and "keep running" is off: the quit stops it, so its turns would be interrupted.
    h.responses.push(2)
    await switcher(busy, 'local', { startedBy: 'studio' }).s.confirm('embedded')
    expect(h.dialogs.at(-1)!.buttons).toEqual(['Wait for Them to Finish', 'Stop Them Now', 'Cancel'])
    // Who started it is unknown (no /version answer): counted as stopping, so the turns are asked about.
    h.responses.push(2)
    await switcher(busy, 'local', { startedBy: null }).s.confirm('embedded')
    expect(h.dialogs.at(-1)!.buttons).toEqual(['Wait for Them to Finish', 'Stop Them Now', 'Cancel'])
    expect(h.dialogs.at(-1)!.detail).not.toMatch(/Keep the daemon running/)
    // Started by the CLI, or "keep running" on: the daemon and its turns go on; nothing to wait for or stop.
    for (const [daemon, why] of [[{ startedBy: 'cli' as const }, 'started by the ADF CLI'], [{ startedBy: 'studio' as const, keep: true }, '"Keep the daemon running" is on']] as const) {
      h.responses.push(1)
      await switcher(busy, 'local', daemon).s.confirm('embedded')
      expect(h.dialogs.at(-1)!.buttons, JSON.stringify(daemon)).toEqual(['Switch and Restart', 'Cancel'])
      expect(h.dialogs.at(-1)!.detail).toContain(`keeps running (${why}), and so do its agents (agent-1) there`)
    }
  })

  it('from Local with a daemon that stays (DMN-02): agents waiting on an approval are named, with where to answer them', async () => {
    h.responses.push(1)
    await switcher(() => [{ filePath: agent1, busy: true, waiting: true }, { filePath: agent2, busy: false }], 'local', { startedBy: 'cli' }).s.confirm('embedded')
    expect(h.dialogs.at(-1)!.detail).toContain('Waiting for an answer there: agent-1. Answer in the terminal app (adf).')
    h.responses.push(1)
    await switcher(() => [{ filePath: agent1, busy: false }], 'local', { startedBy: 'cli' }).s.confirm('embedded')
    expect(h.dialogs.at(-1)!.detail).not.toMatch(/Waiting for an answer/)
  })

  it('"Stop Them Now" restarts at once; Cancel does nothing', async () => {
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy: true }])
    h.responses.push(2)
    expect(await s.confirm('local')).toBe(false)
    h.responses.push(1)
    expect(await s.confirm('local')).toBe(true)
    expect(s.apply('local')).toBe('Studio restarts now.')
    await vi.waitFor(() => expect(relaunched).toEqual(['local']))
  })

  it('after the restart the recorded agents are started on the new side, and the user is told', async () => {
    writeFileSync(join(dir, SWITCH_RESUME_FILE), JSON.stringify({ v: 1, from: 'embedded', to: 'local', agents: [agent1, agent2], at: new Date().toISOString() }))
    const started: string[] = []
    await resumeSwitchedAgents('local', dir, async (p) => {
      started.push(p)
      return p === agent1 ? { success: true } : { success: false, error: 'agent-2 is running in the ADF daemon, pid 4242' }
    })
    expect(started).toEqual([agent1, agent2])
    expect(existsSync(join(dir, SWITCH_RESUME_FILE))).toBe(false)
    expect(h.notifications[0]).toMatch(/Running again after the switch: agent-1\. Not started: agent-2/)
  })

  // W5-D3: the switch to embedded waits 22 s for the daemon to exit; one that
  // takes longer still holds the leases, and the resume never tried again.
  it('a start refused with agent_leased (the old runtime still holds it) is tried again until the wait runs out; then the notification says what is still not started', async () => {
    writeFileSync(join(dir, SWITCH_RESUME_FILE), JSON.stringify({ v: 1, from: 'local', to: 'embedded', agents: [agent1, agent2], at: new Date().toISOString() }))
    const calls: string[] = []
    const leased = { success: false, code: 'agent_leased', error: 'agent-x is already running in the ADF daemon (pid 4242).' }
    await resumeSwitchedAgents('embedded', dir, async (p) => {
      calls.push(p)
      // agent-1 is let go of on the third try; agent-2 never is.
      if (p === agent1) return calls.filter((c) => c === agent1).length >= 3 ? { success: true } : leased
      return leased
    }, { leaseWaitMs: 200, retryMs: 20 })
    expect(calls.filter((c) => c === agent1)).toHaveLength(3)
    expect(calls.filter((c) => c === agent2).length).toBeGreaterThan(3)
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]).toMatch(/Running again after the switch: agent-1\. Not started: agent-2 \(still held after 0 s: agent-x is already running in the ADF daemon/)
  })

  it('any other refusal is reported at once, not retried', async () => {
    writeFileSync(join(dir, SWITCH_RESUME_FILE), JSON.stringify({ v: 1, from: 'local', to: 'embedded', agents: [agent1], at: new Date().toISOString() }))
    const start = vi.fn(async () => ({ success: false, error: 'Agent is password-protected. Open it in the foreground and unlock first.' }))
    await resumeSwitchedAgents('embedded', dir, start, { leaseWaitMs: 200, retryMs: 20 })
    expect(start).toHaveBeenCalledTimes(1)
    expect(h.notifications[0]).toMatch(/Not started: agent-1 \(Agent is password-protected/)
  })

  it('embedded resume waits for the backend to be ready (the mesh boot), as autostart does', async () => {
    writeFileSync(join(dir, SWITCH_RESUME_FILE), JSON.stringify({ v: 1, from: 'local', to: 'embedded', agents: [agent1], at: new Date().toISOString() }))
    let meshUp!: () => void
    const ready = new Promise<void>((r) => { meshUp = r })
    const start = vi.fn(async () => ({ success: true }))
    const resuming = resumeSwitchedAgents('embedded', dir, start, { ready })
    await new Promise((r) => setTimeout(r, 50))
    expect(start).not.toHaveBeenCalled()
    meshUp()
    await resuming
    expect(start).toHaveBeenCalledWith(agent1)
  })

  it('a waiting switch can be finished now or cancelled from Settings → Backend', async () => {
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy: true }])
    h.responses.push(0)
    await s.confirm('local')
    s.apply('local')
    expect(s.pendingSwitch()).toEqual({ target: 'local', waitingFor: ['agent-1'], gaveUp: false })
    expect(s.cancel()).toBe('local')
    expect(s.pendingSwitch()).toBeNull()
    await new Promise((r) => setTimeout(r, 1200))
    expect(relaunched).toEqual([])
    h.responses.push(0)
    await s.confirm('local')
    s.apply('local')
    expect(s.finishNow()).toBe('Studio restarts now.')
    await vi.waitFor(() => expect(relaunched).toEqual(['local']))
    expect(s.pendingSwitch()).toBeNull()
    expect(s.finishNow()).toBeNull()
  })

  it('a second switch while one waits replaces it: one restart, into the latest choice (W5-F)', async () => {
    let busy = true
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy }])
    h.responses.push(0)
    await s.confirm('local')
    s.apply('local')
    h.responses.push(0)
    await s.confirm('remote')
    expect(h.dialogs[1].detail).toMatch(/This replaces the waiting switch to "This computer"\./)
    expect(s.apply('remote')).toBe('Replaces the waiting switch to "This computer". Studio restarts once the turns in flight finish (agent-1).')
    expect(s.pendingSwitch()).toEqual({ target: 'remote', waitingFor: ['agent-1'], gaveUp: false })
    busy = false
    await vi.waitFor(() => expect(relaunched).toEqual(['remote']), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 1300))
    expect(relaunched).toEqual(['remote'])
    expect(JSON.parse(readFileSync(join(dir, SWITCH_RESUME_FILE), 'utf-8'))).toMatchObject({ from: 'embedded', to: 'remote', agents: [] })
  })

  it('a launch in another mode (a session-only override) leaves the record for the switch\'s own launch, and says which agents did not start', async () => {
    writeFileSync(join(dir, SWITCH_RESUME_FILE), JSON.stringify({ v: 1, from: 'embedded', to: 'local', agents: [agent1, agent2], at: new Date().toISOString() }))
    const start = vi.fn()
    await resumeSwitchedAgents('embedded', dir, start)
    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(dir, SWITCH_RESUME_FILE))).toBe(true)
    expect(h.notifications).toEqual(['Not started after the switch: agent-1, agent-2. The switch was to "This computer", but this launch runs agents inside Studio.'])
  })

  it('once the restart has started, a later switch or Cancel Switch is refused and changes nothing (W5-F)', async () => {
    const { s, relaunched } = switcher(() => [{ filePath: agent1, busy: true }])
    h.responses.push(0)
    await s.confirm('local')
    s.apply('local')
    expect(s.restartingInto()).toBeNull()
    expect(s.finishNow()).toBe('Studio restarts now.')
    expect(s.restartingInto()).toBe('local')
    expect(s.cancel()).toBeNull()
    expect(s.apply('remote')).toBe(restartingMessage('local'))
    expect(restartingMessage('local')).toBe('Studio is already restarting for the switch to "This computer". Nothing changed.')
    await vi.waitFor(() => expect(relaunched).toEqual(['local']))
    await new Promise((r) => setTimeout(r, 1200))
    expect(relaunched).toEqual(['local'])
    expect(JSON.parse(readFileSync(join(dir, SWITCH_RESUME_FILE), 'utf-8'))).toMatchObject({ to: 'local' })
  })
})
