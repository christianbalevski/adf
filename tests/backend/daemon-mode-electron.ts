/**
 * A minimal `electron` stand-in for daemon-mode unit tests: records window
 * pushes, dialogs, notifications and menus. The parity harness has the
 * strict one (tests/parity/harness/electron-fake.ts); these tests need no
 * isolated environment.
 */
export interface ElectronStub {
  module: Record<string, unknown>
  pushes: Array<{ channel: string; args: unknown[] }>
  calls: Array<{ api: string; args: unknown[] }>
  handlers: Map<string, (...args: unknown[]) => unknown>
  listeners: Map<string, (...args: unknown[]) => unknown>
  dialogResponse: number
  windows: number
  /** Whether the window has focus (native toasts are only for an unfocused Studio). */
  focused: boolean
  /** Click handlers of the toasts shown, in order. */
  toastClicks: Array<() => void>
}

export function createElectronStub(): ElectronStub {
  const stub: ElectronStub = {
    module: {},
    pushes: [],
    calls: [],
    handlers: new Map(),
    listeners: new Map(),
    dialogResponse: 0,
    windows: 1,
    focused: true,
    toastClicks: [],
  }
  const call = (api: string, args: unknown[]) => { stub.calls.push({ api, args }) }
  const webContents = {
    send: (channel: string, ...args: unknown[]) => { stub.pushes.push({ channel, args }) },
    isDestroyed: () => false,
    isLoading: () => false,
    once: () => {},
  }
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: () => {},
    show: () => {},
    focus: () => {},
  }
  class Notification {
    static isSupported(): boolean { return true }
    constructor(readonly options: unknown) { call('Notification.new', [options]) }
    on(event: string, fn: () => void): this { if (event === 'click') stub.toastClicks.push(fn); return this }
    show(): void { call('Notification.show', [this.options]) }
    close(): void {}
  }
  stub.module = {
    app: {
      getVersion: () => '9.9.9',
      setBadgeCount: (n: number) => { call('app.setBadgeCount', [n]); return true },
      addRecentDocument: (p: string) => { call('app.addRecentDocument', [p]) },
      clearRecentDocuments: () => {},
      focus: () => {},
      quit: () => {},
      name: 'ADF Studio',
    },
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        if (stub.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
        stub.handlers.set(channel, fn)
      },
      on: (channel: string, fn: (...args: unknown[]) => unknown) => { stub.listeners.set(channel, fn) },
    },
    BrowserWindow: {
      getAllWindows: () => (stub.windows > 0 ? [window] : []),
      getFocusedWindow: () => (stub.focused ? window : null),
    },
    dialog: {
      showOpenDialog: async (opts: unknown) => { call('dialog.showOpenDialog', [opts]); return { canceled: true, filePaths: [] } },
      showMessageBox: async (opts: unknown) => { call('dialog.showMessageBox', [opts]); return { response: stub.dialogResponse } },
    },
    shell: {
      openPath: async (p: string) => { call('shell.openPath', [p]); return '' },
      openExternal: async () => {},
    },
    Notification,
    Menu: {
      buildFromTemplate: (template: unknown[]) => ({ items: template }),
      setApplicationMenu: (menu: { items: unknown[] }) => { call('Menu.setApplicationMenu', [menu.items]) },
    },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
  }
  return stub
}

/** Labels of the Help submenu of the last application menu set. */
export function helpLabels(stub: ElectronStub): string[] {
  const last = [...stub.calls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  const items = (last?.args[0] ?? []) as Array<{ role?: string; submenu?: Array<{ label?: string; type?: string }> }>
  const help = items.find((i) => i.role === 'help')
  return (help?.submenu ?? []).map((i) => i.label ?? `<${i.type}>`)
}

/** One stub per test file (vi.mock('electron', …) hands out its module). */
export const electronStub = createElectronStub()
