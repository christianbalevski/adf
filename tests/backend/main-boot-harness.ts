import { join } from 'node:path'

/**
 * Electron and service stand-ins for the boot-branch tests
 * (main-boot-embedded.test.ts, main-boot-daemon.test.ts). One instance per
 * test file: each file boots src/main/index.ts once, in its own worker.
 */
function createBootHarness() {
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
    isMinimized = () => false
    isVisible = () => true
    focus = () => {}
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
    dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: rec('dialog.showErrorBox') },
    Notification: class { static isSupported() { return false } on() { return this } show() {} close() {} },
    Menu: { buildFromTemplate: (t: unknown) => ({ items: t }), setApplicationMenu: rec('Menu.setApplicationMenu') },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  }
  return { calls, state, electron }
}

export const h = createBootHarness()

const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'unhandledRejection', 'uncaughtException', 'exit']

/** Import src/main/index.ts and wait until boot finished (the updater is its last step). Returns a listener cleanup. */
export async function bootMain(): Promise<() => void> {
  const before = new Map(EVENTS.map((e) => [e, new Set(process.listeners(e as NodeJS.Signals))]))
  await import('../../src/main/index')
  const deadline = Date.now() + 5000
  while (!h.calls.includes('initAppUpdater')) {
    if (Date.now() > deadline) throw new Error(`boot did not finish: ${h.calls.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
  return () => {
    for (const e of EVENTS) {
      for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.has(l)) process.removeListener(e, l as never)
    }
  }
}
