import { app, BrowserWindow, Menu, shell } from 'electron'
import { existsSync } from 'fs'
import { basename } from 'path'
import { IPC } from '../shared/constants/ipc-channels'
import { grantLocalOpen } from './backend/local-open-grants'
import { recentFilesKey as recentFilesKeyFor, RUNTIME_RECENT_FILES_KEY } from '../shared/constants/client-settings-keys'
import { ACCELERATORS } from '../shared/constants/keyboard-shortcuts'

/** What the menu reads and writes: `recentFiles` (SettingsService, or the client settings in daemon mode), `remoteRecentFiles` in remote mode. */
export interface MenuSettings {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/**
 * Daemon mode only (design §8.1): Help gains "Open daemon log", and while
 * the backend is not connected a status line and "Reconnect". Embedded mode
 * never sets it, so its menu is unchanged.
 */
export interface DaemonMenuOptions {
  /** The daemon's log file; null when the daemon runs on another machine. */
  logFile: () => string | null
  /** A one-line connection status, or null while connected. */
  problem: () => string | null
  /** Whether "Reconnect to the ADF Daemon" makes sense now (the connection dropped, or the launch failed to connect). */
  canReconnect: () => boolean
  openLog: () => void
  reconnect: () => void
  /**
   * After a failed launch (no daemon this session), while `launchFailed`
   * says so: local mode offers "Use Embedded for This Session" (Studio
   * restarts in embedded mode for one launch), remote mode "Open Settings →
   * Backend" (fix the URL or token there).
   */
  useEmbeddedForSession?: () => void
  openBackendSettings?: () => void
  launchFailed?: () => boolean
  /**
   * Remote mode: recent files are paths on the daemon's machine. They are
   * not added to the OS recent documents (the Windows shell may contact a
   * UNC host), not checked for existence here, and never granted as files
   * of this computer (local-open-grants.ts) (W4-B review). They are kept
   * under their own client key, `remoteRecentFiles`, which a switch back to
   * embedded leaves behind (W5-D3).
   */
  remoteRecents?: boolean
  /**
   * The runtime set (docs/design/multi-runtime.md §6.6), This computer
   * first. With more than one runtime, Help names each runtime that is down
   * and Reconnect acts on it, and Open Recent lists each remote's files under
   * its name. With one, both menus are the ones before.
   */
  runtimes?: () => MenuRuntime[]
  /** Open Recent of another runtime: open `filePath` on that runtime in the main window. */
  openOnRuntime?: (runtimeId: string, filePath: string) => void
}

/** A runtime of the set as the menu shows it. */
export interface MenuRuntime {
  id: string
  name: string
  /** primary: This computer (its recent files are `recentFiles`). */
  primary: boolean
  /** The connection status line (`ADF daemon: …`), or null while connected. */
  problem: string | null
  canReconnect: boolean
  reconnect(): void
}

export type MenuAction =
  | 'new-file'
  | 'open-file'
  | 'add-directory'
  | 'save'
  | 'close-file'
  | 'open-settings'
  | 'open-settings-backend'
  | 'go-home'
  | 'show-fleet-map'
  | 'toggle-sidebar'
  | 'toggle-panel'
  | 'go-to-agent'
  | 'open-in-new-window'
  | 'close-tab'
  | 'show-shortcuts'

/**
 * Agent windows (agent-windows.md): the items that act on the window in
 * front. Every other item acts on the main window, which alone has Home, the
 * fleet map, Settings and the sidebar.
 */
const FOCUSED_WINDOW_ACTIONS: ReadonlySet<string> = new Set<MenuAction>([
  'save', 'close-tab', 'toggle-sidebar', 'toggle-panel', 'go-to-agent', 'open-in-new-window', 'show-shortcuts'
])

/** Whether `action` acts on the focused window rather than the main window. */
export function actsOnFocusedWindow(action: string): boolean {
  return FOCUSED_WINDOW_ACTIONS.has(action)
}

const MAX_RECENT_FILES = 10

let settingsRef: MenuSettings | null = null
let daemonMenu: DaemonMenuOptions | null = null
let windowFor: ((action: MenuAction | 'open-recent') => BrowserWindow | null | undefined) | null = null

/**
 * Agent windows (agent-windows.md): the window a menu item acts on (main/index.ts
 * decides). With a resolver set (daemon mode), an action for a page that is
 * not listening yet (a window just created, a reload) waits until the page
 * takes it (takePendingMenuActions).
 */
export function setMenuWindowResolver(resolve: (action: MenuAction | 'open-recent') => BrowserWindow | null | undefined, openFile?: (filePath: string) => void): void {
  windowFor = resolve
  openRecent = openFile ?? null
}

/** Open Recent through main's open-file flow (it waits for a page that is still loading). */
let openRecent: ((filePath: string) => void) | null = null

/** webContents ids whose page takes menu actions now. */
const listening = new Set<number>()
/** webContents id → actions sent before its page listened. */
const queued = new Map<number, string[]>()
const watched = new WeakSet<Electron.WebContents>()

function watch(wc: Electron.WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  const id = wc.id
  // A new page (a reload) listens once it takes its pending actions. Only a
  // committed main-frame navigation is one: did-navigate. did-start-navigation
  // also fires for a navigation will-navigate then blocks (main/index.ts blocks
  // every page navigation), and a subframe, a <webview> or an in-page
  // navigation keeps its page (tests/electron/blocked-navigation-events.cjs).
  wc.on('did-navigate', () => { listening.delete(id) })
  wc.once('destroyed', () => { listening.delete(id); queued.delete(id) })
}

/** Send a menu action to a window's page, or keep it until the page listens (daemon mode). */
export function deliverMenuAction(win: BrowserWindow, action: string): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const wc = win.webContents
  if (!windowFor) { wc.send(IPC.MENU_ACTION, action); return }
  watch(wc)
  if (listening.has(wc.id)) { wc.send(IPC.MENU_ACTION, action); return }
  queued.set(wc.id, [...(queued.get(wc.id) ?? []), action])
}

/** MENU_ACTION_TAKE_PENDING: the page listens from now on; the actions it missed. */
export function takePendingMenuActions(wc: Electron.WebContents): string[] {
  watch(wc)
  listening.add(wc.id)
  const actions = queued.get(wc.id) ?? []
  queued.delete(wc.id)
  return actions
}

function targetWindow(action: MenuAction | 'open-recent'): BrowserWindow | undefined {
  return windowFor?.(action) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sendMenuAction(action: MenuAction): void {
  const win = targetWindow(action)
  if (win) deliverMenuAction(win, action)
}

// Recent entries reuse the same flow as double-clicking a .adf in Finder
function sendOpenFile(filePath: string): void {
  // The user's own recent list: remote mode may offer this computer's copy for upload (local-open-grants.ts).
  if (!daemonMenu?.remoteRecents) grantLocalOpen(filePath)
  if (openRecent) { openRecent(filePath); return }
  targetWindow('open-recent')?.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath })
}

/** The settings key of this mode's Open Recent list. */
function recentFilesKey(): string {
  return recentFilesKeyFor(!!daemonMenu?.remoteRecents)
}

function getRecentFiles(): string[] {
  const raw = settingsRef?.get(recentFilesKey())
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
}

/** Call once at startup with the shared SettingsService, before any windows open. */
export function initApplicationMenu(settings: MenuSettings, daemon: DaemonMenuOptions | null = null): void {
  settingsRef = settings
  daemonMenu = daemon
  buildApplicationMenu()
}

/** Record a file in Open Recent (and the OS-level recent documents list). */
export function recordRecentFile(filePath: string): void {
  if (!settingsRef) return
  const list = [filePath, ...getRecentFiles().filter((p) => p !== filePath)].slice(
    0,
    MAX_RECENT_FILES
  )
  settingsRef.set(recentFilesKey(), list)
  if (!daemonMenu?.remoteRecents) app.addRecentDocument(filePath)
  buildApplicationMenu()
}

/** `runtimeRecentFiles`: each remote runtime's Open Recent, by runtime id (docs/design/multi-runtime.md §7.4). */
function runtimeRecentFiles(): Record<string, string[]> {
  const raw = settingsRef?.get(RUNTIME_RECENT_FILES_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(list)) out[id] = list.filter((p): p is string => typeof p === 'string')
  }
  return out
}

/**
 * Record a file of a remote runtime in its Open Recent (§6.6). A path on
 * another computer: never added to the OS recent documents, never checked
 * on this computer's disk, never granted as a local file (§8.3).
 */
export function recordRuntimeRecentFile(runtimeId: string, filePath: string): void {
  if (!settingsRef) return
  const all = runtimeRecentFiles()
  const list = [filePath, ...(all[runtimeId] ?? []).filter((p) => p !== filePath)].slice(0, MAX_RECENT_FILES)
  settingsRef.set(RUNTIME_RECENT_FILES_KEY, { ...all, [runtimeId]: list })
  buildApplicationMenu()
}

/** A remote runtime's file moved (a claim, a rename): its Open Recent entry follows, then it is the most recent. */
export function renameRuntimeRecentFile(runtimeId: string, oldPath: string, newPath: string): void {
  if (!settingsRef) return
  const all = runtimeRecentFiles()
  const list = all[runtimeId]
  if (list?.includes(oldPath)) settingsRef.set(RUNTIME_RECENT_FILES_KEY, { ...all, [runtimeId]: list.map((p) => (p === oldPath ? newPath : p)) })
  recordRuntimeRecentFile(runtimeId, newPath)
}

/** The remote runtimes of the set with their Open Recent files, in the set's order; none with one runtime. */
function runtimeRecents(): Array<{ runtime: MenuRuntime; files: string[] }> {
  const runtimes = daemonMenu?.runtimes?.() ?? []
  if (runtimes.length < 2) return []
  const all = runtimeRecentFiles()
  return runtimes.filter((r) => !r.primary && (all[r.id]?.length ?? 0) > 0).map((runtime) => ({ runtime, files: all[runtime.id] }))
}

function clearRecentFiles(): void {
  settingsRef?.set(recentFilesKey(), [])
  app.clearRecentDocuments()
  // The remotes' lists shown in the menu go too; those of runtimes not in the set stay.
  const shown = runtimeRecents()
  if (shown.length > 0) {
    const all = runtimeRecentFiles()
    for (const { runtime } of shown) delete all[runtime.id]
    settingsRef?.set(RUNTIME_RECENT_FILES_KEY, all)
  }
  buildApplicationMenu()
}

function sendOpenOnRuntime(runtimeId: string, filePath: string): void {
  if (daemonMenu?.openOnRuntime) { daemonMenu.openOnRuntime(runtimeId, filePath); return }
  targetWindow('open-recent')?.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath, runtimeId })
}

export function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  // No file-system call on a network path (UNC: Windows would send NTLM credentials to that host).
  const recents = daemonMenu?.remoteRecents ? getRecentFiles() : getRecentFiles().filter((p) => !/^[\\/]{2}/.test(p) && existsSync(p))
  const remoteRecents = runtimeRecents()

  const openRecentSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...recents.map((filePath) => ({
      label: basename(filePath, '.adf'),
      toolTip: filePath,
      click: () => sendOpenFile(filePath)
    })),
    // Each remote's files under its name (§6.6).
    ...remoteRecents.map(({ runtime, files }) => ({
      label: runtime.name,
      submenu: files.map((filePath) => ({
        label: basename(filePath, '.adf'),
        toolTip: filePath,
        click: () => sendOpenOnRuntime(runtime.id, filePath)
      }))
    })),
    ...(recents.length || remoteRecents.length ? [{ type: 'separator' as const }] : []),
    { label: 'Clear Menu', enabled: recents.length > 0 || remoteRecents.length > 0, click: clearRecentFiles }
  ]

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => sendMenuAction('open-settings')
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New ADF Agent',
          accelerator: ACCELERATORS.newAgent,
          click: () => sendMenuAction('new-file')
        },
        {
          label: 'Open ADF Agent…',
          accelerator: ACCELERATORS.openAgent,
          click: () => sendMenuAction('open-file')
        },
        { label: 'Open Recent', submenu: openRecentSubmenu },
        // Agent windows exist in daemon mode only (agent-windows.md §9).
        ...(daemonMenu
          ? [{
              label: 'Open in New Window',
              accelerator: ACCELERATORS.openInNewWindow,
              click: () => sendMenuAction('open-in-new-window')
            }]
          : []),
        { type: 'separator' },
        {
          label: 'Track Folder…',
          accelerator: ACCELERATORS.trackFolder,
          click: () => sendMenuAction('add-directory')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: ACCELERATORS.save,
          click: () => sendMenuAction('save')
        },
        // The page handles Cmd/Ctrl+W (the active tab, or an agent window with
        // no tab), so the menu shows it without registering it: a registered
        // accelerator would swallow the key.
        {
          label: 'Close Tab',
          accelerator: ACCELERATORS.closeTab,
          registerAccelerator: false,
          click: () => sendMenuAction('close-tab')
        },
        {
          label: 'Close Agent',
          accelerator: ACCELERATORS.closeAgent,
          click: () => sendMenuAction('close-file')
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Ctrl+,',
                click: () => sendMenuAction('open-settings')
              }
            ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Go to Agent…', accelerator: ACCELERATORS.goToAgent, click: () => sendMenuAction('go-to-agent') },
        { type: 'separator' },
        { label: 'Home', accelerator: ACCELERATORS.home, click: () => sendMenuAction('go-home') },
        { label: 'Mesh', accelerator: ACCELERATORS.fleetMap, click: () => sendMenuAction('show-fleet-map') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: ACCELERATORS.toggleSidebar, click: () => sendMenuAction('toggle-sidebar') },
        { label: 'Toggle Panel', accelerator: ACCELERATORS.togglePanel, click: () => sendMenuAction('toggle-panel') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      // role 'window': macOS lists the open windows here.
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    },
    {
      role: 'help',
      submenu: [
        // Above Documentation: daemon mode's items follow Documentation (tests/parity/harness/gaps.ts).
        { label: 'Keyboard Shortcuts', click: () => sendMenuAction('show-shortcuts') },
        {
          label: 'ADF Studio Documentation',
          click: () => shell.openExternal('https://github.com/christianbalevski/adf')
        },
        ...daemonHelpItems()
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function daemonHelpItems(): Electron.MenuItemConstructorOptions[] {
  return daemonMenu ? daemonHelpTemplate(daemonMenu) : []
}

/** The Help menu's daemon items for `options` (exported for tests). */
export function daemonHelpTemplate(options: DaemonMenuOptions): Electron.MenuItemConstructorOptions[] {
  const logFile = options.logFile()
  const problem = options.problem()
  const useEmbedded = options.useEmbeddedForSession
  const openBackend = options.openBackendSettings
  const failed = !!problem && options.launchFailed?.() === true
  const runtimes = options.runtimes?.() ?? []
  if (runtimes.length > 1) {
    // §6.6: a status line for each runtime that is down, named; Reconnect acts on it, a submenu of names for more than one.
    const down = runtimes.filter((r) => r.problem)
    const reconnectable = down.filter((r) => r.canReconnect)
    return [
      { type: 'separator' },
      { label: 'Open Daemon Log', enabled: logFile !== null, click: () => options.openLog() },
      ...down.map((r) => ({ label: `${r.name}: ${r.problem!.replace(/^ADF daemon: /, '')}`, enabled: false })),
      ...(reconnectable.length === 1 ? [{ label: 'Reconnect', toolTip: reconnectable[0].name, click: () => reconnectable[0].reconnect() }] : []),
      ...(reconnectable.length > 1 ? [{ label: 'Reconnect', submenu: reconnectable.map((r) => ({ label: r.name, click: () => r.reconnect() })) }] : []),
      ...(failed && useEmbedded ? [{ label: 'Run Inside Studio for This Session', click: () => useEmbedded() }] : []),
      ...(failed && openBackend ? [{ label: 'Open Settings → Connections', click: () => openBackend() }] : [])
    ]
  }
  return [
    { type: 'separator' },
    { label: 'Open Daemon Log', enabled: logFile !== null, click: () => options.openLog() },
    ...(problem ? [{ label: problem, enabled: false }] : []),
    ...(problem && options.canReconnect() ? [{ label: 'Reconnect to the ADF Daemon', click: () => options.reconnect() }] : []),
    ...(failed && useEmbedded ? [{ label: 'Run Inside Studio for This Session', click: () => useEmbedded() }] : []),
    ...(failed && openBackend ? [{ label: 'Open Settings → Connections', click: () => openBackend() }] : [])
  ]
}
