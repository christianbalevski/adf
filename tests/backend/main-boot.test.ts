/**
 * Studio's boot branch (src/main/index.ts, design D9) with Electron and the
 * services stubbed.
 *
 * - Embedded (no studio-backend.json): characterization of what boot does
 *   and in which order. Written before the embedded IPC layer became a lazy
 *   import, and unchanged by it.
 * - Daemon mode (`local`): the embedded IPC layer (ipc/index.ts) is never
 *   loaded, so no PodmanService is constructed and none of its module-load
 *   side effects run (the uvx manifest repair writes a file the daemon
 *   owns); no daemon-owned settings file is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const state = { userData: '', windows: [] as unknown[] }
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push(args.length && typeof args[0] === 'string' ? `${name}(${args[0]})` : name)
  }
  class FakeWebContents {
    on = () => this
    once = () => this
    send = rec('webContents.send')
    setWindowOpenHandler = () => {}
    isDestroyed = () => false
    isLoading = () => false
  }
  class FakeBrowserWindow {
    static getAllWindows = () => state.windows
    static getFocusedWindow = () => null
    webContents = new FakeWebContents()
    constructor() { calls.push('new BrowserWindow'); state.windows.push(this) }
    once = () => this
    on = () => this
    loadURL = rec('window.loadURL')
    loadFile = () => { calls.push('window.loadFile') }
    show = () => {}
    isDestroyed = () => false
    isFullScreen = () => false
    setFullScreen = () => {}
    setTitleBarOverlay = () => {}
    setProgressBar = rec('window.setProgressBar')
  }
  const electron = {
    app: {
      isPackaged: false,
      getPath: (name: string) => (name === 'userData' ? state.userData : join(state.userData, name)),
      setPath: () => {},
      getVersion: () => '9.9.9',
      getName: () => 'ADF Studio',
      name: 'ADF Studio',
      on: () => electron.app,
      once: () => electron.app,
      whenReady: () => Promise.resolve(),
      requestSingleInstanceLock: () => true,
      exit: rec('app.exit'),
      quit: rec('app.quit'),
      focus: () => {},
      setAppUserModelId: rec('app.setAppUserModelId'),
      setBadgeCount: () => true,
      addRecentDocument: () => {},
      clearRecentDocuments: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    crashReporter: { start: rec('crashReporter.start') },
    ipcMain: {
      handle: (channel: string) => { calls.push(`ipcMain.handle(${channel})`) },
      on: (channel: string) => { calls.push(`ipcMain.on(${channel})`) },
    },
    nativeTheme: { shouldUseDarkColors: false, on: () => {}, off: () => {} },
    protocol: {
      registerSchemesAsPrivileged: rec('protocol.registerSchemesAsPrivileged'),
      handle: (scheme: string) => { calls.push(`protocol.handle(${scheme})`) },
    },
    session: { defaultSession: { webRequest: { onHeadersReceived: rec('session.onHeadersReceived') } } },
    shell: { openExternal: async () => {}, openPath: async () => '' },
    dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    Notification: class { static isSupported() { return false } on() { return this } show() {} close() {} },
    Menu: { buildFromTemplate: (t: unknown) => ({ items: t }), setApplicationMenu: rec('Menu.setApplicationMenu') },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  }
  return { calls, state, electron }
})

vi.mock('electron', () => h.electron)
vi.mock('../../src/main/ipc/index', () => {
  h.calls.push('load ipc/index')
  return {
    registerAllIpcHandlers: (hooks: object) => { h.calls.push(`registerAllIpcHandlers(${Object.keys(hooks).sort().join(',')})`) },
    cleanupAllProcesses: async () => {},
    fastSessionEndCleanup: async () => {},
    getCurrentWorkspace: () => null,
    readAppSetting: () => undefined,
    writeAppSetting: () => {},
  }
})
vi.mock('../../src/main/services/podman.service', () => {
  h.calls.push('load podman.service')
  return { PodmanService: class { constructor() { h.calls.push('new PodmanService') } } }
})
vi.mock('../../src/main/ipc/orbital-cache', () => ({ registerOrbitalCacheHandlers: () => { h.calls.push('registerOrbitalCacheHandlers') } }))
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null }))
vi.mock('../../src/main/utils/stall-monitor', () => ({ startStallMonitor: () => null, stopStallMonitor: () => {} }))
vi.mock('../../src/main/utils/scratch-dir', () => ({ purgeStaleProcessDirs: () => { h.calls.push('purgeStaleProcessDirs') } }))
vi.mock('../../src/main/services/app-updater.service', () => ({ initAppUpdater: () => { h.calls.push('initAppUpdater') } }))
vi.mock('../../src/main/services/spellcheck-dictionaries.service', () => ({ initSpellcheckDictionaries: () => { h.calls.push('initSpellcheckDictionaries') } }))
vi.mock('../../src/main/runtime/sandbox-host', () => ({ shutdownSandboxHosts: () => {} }))
vi.mock('../../src/main/backend/daemon-mode/connectors', () => ({
  // A daemon that never answers: boot must not wait for it.
  localDaemonConnector: () => Object.assign(() => new Promise(() => {}), { logFile: null }),
  remoteDaemonConnector: () => Object.assign(() => new Promise(() => {}), { logFile: null }),
}))

let listenersBefore: Map<string, Set<(...args: unknown[]) => void>>
const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'unhandledRejection', 'uncaughtException', 'exit']

beforeEach(() => {
  h.calls.length = 0
  h.state.windows.length = 0
  h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
  process.env.ADF_USER_DATA_DIR = h.state.userData
  delete process.env.ADF_STUDIO_BACKEND
  delete process.env.ADF_INSTANCE
  listenersBefore = new Map(EVENTS.map((e) => [e, new Set(process.listeners(e as NodeJS.Signals) as Array<(...args: unknown[]) => void>)]))
  vi.resetModules()
})

afterEach(() => {
  for (const e of EVENTS) {
    for (const l of process.listeners(e as NodeJS.Signals) as Array<(...args: unknown[]) => void>) {
      if (!listenersBefore.get(e)!.has(l)) process.removeListener(e, l)
    }
  }
  rmSync(h.state.userData, { recursive: true, force: true })
})

async function boot(): Promise<void> {
  await import('../../src/main/index')
  const deadline = Date.now() + 5000
  while (!h.calls.includes('initAppUpdater')) {
    if (Date.now() > deadline) throw new Error(`boot did not finish: ${h.calls.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('Studio boot branch', () => {
  it('embedded: the same boot, in the same order (characterization)', async () => {
    await boot()
    // The top of the module, before app 'ready'; podman.service only through ipc/index (mocked here).
    expect(h.calls).toEqual([
      'load ipc/index',
      'protocol.registerSchemesAsPrivileged',
      'app.setAppUserModelId(com.adf.app)',
      'crashReporter.start',
      'ipcMain.handle(adf:open-file:get-pending)',
      'registerAllIpcHandlers(openFile,showMainWindow)',
      'ipcMain.handle(adf:backend:settings:get)',
      'ipcMain.handle(adf:backend:settings:set)',
      'registerOrbitalCacheHandlers',
      'ipcMain.handle(adf:app:get-fullscreen)',
      'ipcMain.handle(adf:app:set-fullscreen)',
      'protocol.handle(adf-file)',
      'initSpellcheckDictionaries',
      'new BrowserWindow',
      'session.onHeadersReceived',
      'window.loadFile',
      'initAppUpdater',
    ])
  })

  it('daemon mode: never loads the embedded IPC layer, constructs no PodmanService, writes no daemon-owned file', async () => {
    writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local' }))
    await boot()
    expect(h.calls).not.toContain('load ipc/index')
    expect(h.calls).not.toContain('load podman.service')
    expect(h.calls).not.toContain('new PodmanService')
    expect(h.calls).toContain('protocol.handle(adf-file)')
    expect(h.calls).toContain('new BrowserWindow')
    // The daemon writes adf-settings.json and its stores; Studio main writes only its client files.
    const written = readdirSync(h.state.userData).filter((f) => !f.startsWith('studio-') && f !== 'agent-leases' && f !== 'logs' && f !== 'crashDumps')
    expect(written).toEqual([])
    expect(existsSync(join(h.state.userData, 'adf-settings.json'))).toBe(false)
  })
})

// Keep the unused helpers referenced for type-checking tools.
void mkdirSync
