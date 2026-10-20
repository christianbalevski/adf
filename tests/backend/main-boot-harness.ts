import { join } from 'node:path'

/**
 * Electron and service stand-ins for the boot-branch tests
 * (main-boot-embedded.test.ts, main-boot-daemon.test.ts). One instance per
 * test file: each file boots src/main/index.ts once, in its own worker.
 */
function createBootHarness() {
  const calls: string[] = []
  /** `app.on`/`app.once` handlers: a test fires 'before-quit' (quitMain). */
  const state = { userData: '', windows: [] as unknown[], readyToShow: [] as Array<() => void>, appHandlers: new Map<string, Array<(...args: unknown[]) => void>>() }
  const onApp = (event: string, fn: (...args: unknown[]) => void) => {
    state.appHandlers.set(event, [...(state.appHandlers.get(event) ?? []), fn])
    return electron.app
  }
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
    /** 'ready-to-show' handlers are kept; a test fires them (fireReadyToShow). */
    once = (event?: string, fn?: () => void) => { if (event === 'ready-to-show' && fn) state.readyToShow.push(fn); return this }
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
      on: onApp,
      once: onApp,
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
    // Daemon mode subscribes to `resume` (sleep and wake, W5-D2).
    powerMonitor: { on: rec('powerMonitor.on'), removeListener: () => {} },
    protocol: {
      registerSchemesAsPrivileged: rec('protocol.registerSchemesAsPrivileged'),
      handle: (scheme: string) => { calls.push(`protocol.handle(${scheme})`) },
    },
    // Daemon mode names the window of each adf-file:// request (agent-windows.md).
    session: { defaultSession: { webRequest: { onHeadersReceived: rec('session.onHeadersReceived'), onBeforeSendHeaders: rec('session.onBeforeSendHeaders') } } },
    shell: { openExternal: async () => {}, openPath: async () => '' },
    dialog: {
      // Recorded with whether it has a parent window: a parentless dialog at boot can hang it (macOS app-modal).
      showMessageBox: async (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { message?: string }
        calls.push(`dialog.showMessageBox(${args.length > 1 && state.windows.includes(args[0]) ? 'window' : 'no parent'}: ${opts?.message ?? ''})`)
        return { response: 0 }
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showErrorBox: rec('dialog.showErrorBox'),
    },
    Notification: class { static isSupported() { return false } on() { return this } show() {} close() {} },
    Menu: { buildFromTemplate: (t: unknown) => ({ items: t }), setApplicationMenu: rec('Menu.setApplicationMenu') },
    // Daemon mode's ApprovalsUi creates the macOS menu bar icon on darwin.
    Tray: class {
      private destroyed = false
      on() { return this }
      setTitle() {}
      setToolTip() {}
      popUpContextMenu() {}
      isDestroyed() { return this.destroyed }
      destroy() { this.destroyed = true }
    },
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  }
  return { calls, state, electron }
}

export const h = createBootHarness()

const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'unhandledRejection', 'uncaughtException', 'exit']

/** Fire the main window's 'ready-to-show' handlers, then let their dialogs run. */
export async function fireReadyToShow(): Promise<void> {
  for (const fn of h.state.readyToShow.splice(0)) fn()
  await new Promise((r) => setTimeout(r, 50))
}

/**
 * Quit as Electron does: fire 'before-quit' (again at each app.quit, as a
 * held quit resumes), then wait for the app.exit that ends cleanup.
 */
export async function quitMain(): Promise<void> {
  const fire = () => { for (const fn of h.state.appHandlers.get('before-quit') ?? []) fn({ preventDefault: () => {} }) }
  let quits = h.calls.filter((c) => c === 'app.quit').length
  fire()
  const deadline = Date.now() + 10_000
  while (!h.calls.includes('app.exit')) {
    const now = h.calls.filter((c) => c === 'app.quit').length
    if (now > quits) { quits = now; fire() }
    if (Date.now() > deadline) throw new Error(`quit did not finish: ${h.calls.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

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
