/**
 * What the boot keeps of the backend switch (boot-handover.ts; tracker W4-A
 * review fixes): the session-only embedded flag and the version-mismatch
 * dialog (names a daemon Studio did not start and the connected clients).
 * The switch-and-restart flow is gone (docs/design/multi-runtime.md §7.1).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// Never the real keychain.
process.env.ADF_KEYCHAIN = '0'

const {
  askVersionMismatch,
  SESSION_BACKEND_ARG,
  sessionBackendEnv,
} = await import('../../src/main/backend/boot-handover')
const { resolveBootBackend } = await import('../../src/main/backend/backend-config')
const { dismissBootDialogs, noteMainWindowClosed } = await import('../../src/main/utils/boot-window')
import type { DaemonVersionInfo } from '../../src/main/daemon/routes/meta-routes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-boot-handover-'))
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
