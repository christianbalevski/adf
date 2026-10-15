import { resolve } from 'node:path'
import type { ParityEnv } from './env'

/**
 * A stand-in for the `electron` module, enough to run Studio main's IPC layer
 * under Electron-as-Node without a window.
 *
 * - `ipcMain.handle`/`ipcMain.on` registrations are captured so the harness
 *   can invoke a channel the way the preload does.
 * - Every `webContents.send` of the one fake window is recorded, in order,
 *   with its channel. That is the renderer's view of push events.
 * - Native UI (dialogs, shell, notifications, menus) is recorded as a `local`
 *   call and answered from a script the scenario sets (default: cancel). Both
 *   backends share these, so they are part of the comparison.
 * - `safeStorage` is a reversible fake that is "available", so `safe:` secrets
 *   round-trip like on a desktop with a keychain, without touching one.
 *
 * - Notifications (supported, as on a desktop), the application menu, the
 *   menu bar tray and the dock badge are recorded as local calls.
 *
 * Members the code under test uses but this fake lacks throw, naming the
 * member, and are recorded in `missing`; the runner fails the run on any.
 */

export interface PushRecord {
  /** Global send order across all channels, from 1. */
  seq: number
  /** Milliseconds since the run began (timing data; never in golden files). */
  t: number
  channel: string
  args: unknown[]
}

export interface LocalCallRecord {
  api: string
  args: unknown[]
}

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface DialogScript {
  showOpenDialog?: (options: unknown) => { canceled: boolean; filePaths: string[] }
  showSaveDialog?: (options: unknown) => { canceled: boolean; filePath?: string }
  showMessageBox?: (options: unknown) => { response: number; checkboxChecked?: boolean }
}

export interface FakeElectron {
  /** The module object handed to `vi.doMock('electron', …)`. */
  readonly module: Record<string, unknown>
  readonly handlers: Map<string, IpcHandler>
  readonly listeners: Map<string, IpcHandler[]>
  /** Every push to the window, in send order. */
  readonly pushes: PushRecord[]
  /** Calls into native UI and OS integration. */
  readonly localCalls: LocalCallRecord[]
  /** Members the code under test asked for that the fake does not have. */
  readonly missing: string[]
  dialogs: DialogScript
  /** Create the main window (Studio creates it after registering handlers). */
  openWindow(): void
  /** Mark the window destroyed: later sends are dropped and not recorded. */
  closeWindow(): void
  /** The `event` argument handlers receive. */
  ipcEvent(): unknown
  /** Called after every recorded push (the harness answers the remote picker this way, as the renderer would). */
  onPush(listener: (record: PushRecord) => void): void
}

const SAFE_MARK = 'parity-safe:'

/**
 * Throws on a member the fake lacks, and records it: code under test may
 * swallow the throw, and the runner fails the run on any recorded miss.
 */
function strict<T extends object>(name: string, target: T, missing: string[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop in obj) return Reflect.get(obj, prop, receiver)
      // vitest and interop helpers probe these on module objects.
      if (prop === 'then' || prop === '__esModule' || prop === 'default' || prop === 'toJSON') return undefined
      missing.push(`${name}.${prop}`)
      throw new Error(`parity harness: electron fake has no ${name}.${prop}`)
    },
  })
}

export function createFakeElectron(env: ParityEnv): FakeElectron {
  const handlers = new Map<string, IpcHandler>()
  const listeners = new Map<string, IpcHandler[]>()
  const pushes: PushRecord[] = []
  const localCalls: LocalCallRecord[] = []
  const local = (api: string, args: unknown[]) => { localCalls.push({ api, args }) }
  const missing: string[] = []
  let window: FakeWindow | null = null
  const state: { dialogs: DialogScript } = { dialogs: {} }
  const pushListeners: Array<(record: PushRecord) => void> = []

  class FakeWebContents {
    readonly id = 1
    destroyed = false
    send(channel: string, ...args: unknown[]): void {
      if (this.destroyed) return
      // Structured clone, as Electron's IPC does: a payload object mutated
      // after the send must not change what the renderer received.
      const record: PushRecord = {
        seq: pushes.length + 1,
        t: Date.now() - env.startedAt,
        channel,
        args: args.map((a) => (a === undefined ? a : structuredClone(a))),
      }
      pushes.push(record)
      for (const listener of pushListeners) listener(record)
    }
    isDestroyed(): boolean { return this.destroyed }
    isLoading(): boolean { return false }
    startDrag(item: unknown): void { local('webContents.startDrag', [item]) }
    getURL(): string { return 'app://parity' }
  }

  class FakeWindow {
    readonly id = 1
    readonly webContents = strict('webContents', new FakeWebContents(), missing)
    destroyed = false
    isDestroyed(): boolean { return this.destroyed }
    isMinimized(): boolean { return false }
    isVisible(): boolean { return true }
    isFocused(): boolean { return true }
    isFullScreen(): boolean { return false }
    restore(): void { local('window.restore', []) }
    show(): void { local('window.show', []) }
    focus(): void { local('window.focus', []) }
    flashFrame(flag: boolean): void { local('window.flashFrame', [flag]) }
  }

  const BrowserWindow = Object.assign(function BrowserWindow() {
    throw new Error('parity harness: Studio main must not construct a BrowserWindow here')
  }, {
    getAllWindows: () => (window && !window.destroyed ? [window] : []),
    getFocusedWindow: () => (window && !window.destroyed ? window : null),
    fromWebContents: () => (window && !window.destroyed ? window : null),
  })

  const app = {
    name: 'ADF Studio',
    isPackaged: false,
    getPath: (name: string) => env.appPath(name),
    getAppPath: () => resolve(__dirname, '../../..'),
    getVersion: () => '0.0.0-parity',
    getName: () => 'ADF Studio',
    getLocale: () => 'en-US',
    setBadgeCount: (count: number) => { local('app.setBadgeCount', [count]); return true },
    addRecentDocument: (path: string) => { local('app.addRecentDocument', [path]) },
    clearRecentDocuments: () => { local('app.clearRecentDocuments', []) },
    focus: (opts?: unknown) => { local('app.focus', [opts]) },
    getFileIcon: async () => ({ toDataURL: () => 'data:image/png;base64,' }),
    on: () => app,
    once: () => app,
    off: () => app,
    removeListener: () => app,
    quit: () => { local('app.quit', []) },
    whenReady: () => Promise.resolve(),
    isReady: () => true,
  }

  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      if (handlers.has(channel)) throw new Error(`parity harness: second handler for ${channel}`)
      handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => { handlers.delete(channel) },
    on: (channel: string, fn: IpcHandler) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), fn])
      return ipcMain
    },
    removeAllListeners: (channel?: string) => {
      if (channel) listeners.delete(channel)
      else listeners.clear()
      return ipcMain
    },
  }

  const dialog = {
    showOpenDialog: async (...args: unknown[]) => {
      const options = args.length > 1 ? args[1] : args[0]
      local('dialog.showOpenDialog', [options])
      return state.dialogs.showOpenDialog?.(options) ?? { canceled: true, filePaths: [] }
    },
    showSaveDialog: async (...args: unknown[]) => {
      const options = args.length > 1 ? args[1] : args[0]
      local('dialog.showSaveDialog', [options])
      return state.dialogs.showSaveDialog?.(options) ?? { canceled: true }
    },
    showMessageBox: async (...args: unknown[]) => {
      const options = args.length > 1 ? args[1] : args[0]
      local('dialog.showMessageBox', [options])
      return state.dialogs.showMessageBox?.(options) ?? { response: 0, checkboxChecked: false }
    },
    showErrorBox: (title: string, content: string) => { local('dialog.showErrorBox', [title, content]) },
  }

  const shell = {
    openExternal: async (url: string) => { local('shell.openExternal', [url]) },
    showItemInFolder: (path: string) => { local('shell.showItemInFolder', [path]) },
    openPath: async (path: string) => { local('shell.openPath', [path]); return '' },
    trashItem: async (path: string) => { local('shell.trashItem', [path]) },
  }

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(SAFE_MARK + value, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf-8')
      if (!text.startsWith(SAFE_MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text.slice(SAFE_MARK.length)
    },
  }

  class Notification {
    static isSupported(): boolean { return true }
    constructor(readonly options: unknown) { local('Notification.new', [options]) }
    on(): this { return this }
    show(): void { local('Notification.show', [this.options]) }
    close(): void { local('Notification.close', [this.options]) }
  }

  /** Menu template without click handlers: what the user sees. */
  const menuShape = (items: unknown): unknown =>
    Array.isArray(items)
      ? items.map((item) => {
          const i = item as Record<string, unknown>
          const out: Record<string, unknown> = {}
          for (const key of ['label', 'role', 'type', 'accelerator', 'enabled', 'checked', 'visible']) {
            if (i[key] !== undefined) out[key] = i[key]
          }
          if (i.submenu !== undefined) out.submenu = menuShape(i.submenu)
          return out
        })
      : items

  class Tray {
    private destroyed = false
    constructor(icon: unknown) { local('Tray.new', [String((icon as { path?: string })?.path ?? '')]) }
    on(): this { return this }
    setTitle(title: string): void { local('Tray.setTitle', [title]) }
    setToolTip(tooltip: string): void { local('Tray.setToolTip', [tooltip]) }
    setImage(): void { local('Tray.setImage', []) }
    setContextMenu(menu: { items?: unknown } | null): void { local('Tray.setContextMenu', [menuShape(menu?.items ?? null)]) }
    popUpContextMenu(menu?: { items?: unknown }): void { local('Tray.popUpContextMenu', [menuShape(menu?.items ?? null)]) }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true; local('Tray.destroy', []) }
  }

  const nativeImage = {
    createFromPath: (path: string) => ({ isEmpty: () => true, setTemplateImage: () => {}, path }),
    createEmpty: () => ({ isEmpty: () => true }),
  }

  const Menu = {
    buildFromTemplate: (template: unknown[]) => ({ items: template, popup: () => {} }),
    setApplicationMenu: (menu: { items?: unknown } | null) => { local('Menu.setApplicationMenu', [menuShape(menu?.items ?? null)]) },
  }

  const module = strict('electron', {
    app: strict('app', app, missing),
    ipcMain: strict('ipcMain', ipcMain, missing),
    BrowserWindow,
    dialog: strict('dialog', dialog, missing),
    shell: strict('shell', shell, missing),
    safeStorage: strict('safeStorage', safeStorage, missing),
    Notification,
    Tray,
    nativeImage: strict('nativeImage', nativeImage, missing),
    Menu: strict('Menu', Menu, missing),
  } as Record<string, unknown>, missing)

  return {
    module,
    handlers,
    listeners,
    pushes,
    localCalls,
    missing,
    get dialogs() { return state.dialogs },
    set dialogs(script: DialogScript) { state.dialogs = script },
    openWindow(): void {
      if (window && !window.destroyed) return
      window = strict('window', new FakeWindow(), missing)
    },
    closeWindow(): void {
      if (!window) return
      window.destroyed = true
      ;(window.webContents as unknown as FakeWebContents).destroyed = true
    },
    ipcEvent(): unknown {
      return { sender: window?.webContents ?? null, senderFrame: null, processId: 1, frameId: 1 }
    },
    onPush(listener: (record: PushRecord) => void): void {
      pushListeners.push(listener)
    },
  }
}
