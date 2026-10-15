import { app, BrowserWindow, Menu, shell } from 'electron'
import { existsSync } from 'fs'
import { basename } from 'path'
import { IPC } from '../shared/constants/ipc-channels'
import { grantLocalOpen } from './backend/local-open-grants'
import { recentFilesKey as recentFilesKeyFor } from '../shared/constants/client-settings-keys'

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
}

export type MenuAction =
  | 'new-file'
  | 'open-file'
  | 'add-directory'
  | 'save'
  | 'close-file'
  | 'open-settings'
  | 'open-settings-backend'

const MAX_RECENT_FILES = 10

let settingsRef: MenuSettings | null = null
let daemonMenu: DaemonMenuOptions | null = null

function targetWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sendMenuAction(action: MenuAction): void {
  targetWindow()?.webContents.send(IPC.MENU_ACTION, action)
}

// Recent entries reuse the same flow as double-clicking a .adf in Finder
function sendOpenFile(filePath: string): void {
  // The user's own recent list: remote mode may offer this computer's copy for upload (local-open-grants.ts).
  if (!daemonMenu?.remoteRecents) grantLocalOpen(filePath)
  targetWindow()?.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath })
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

function clearRecentFiles(): void {
  settingsRef?.set(recentFilesKey(), [])
  app.clearRecentDocuments()
  buildApplicationMenu()
}

export function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  // No file-system call on a network path (UNC: Windows would send NTLM credentials to that host).
  const recents = daemonMenu?.remoteRecents ? getRecentFiles() : getRecentFiles().filter((p) => !/^[\\/]{2}/.test(p) && existsSync(p))

  const openRecentSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...recents.map((filePath) => ({
      label: basename(filePath, '.adf'),
      toolTip: filePath,
      click: () => sendOpenFile(filePath)
    })),
    ...(recents.length ? [{ type: 'separator' as const }] : []),
    { label: 'Clear Menu', enabled: recents.length > 0, click: clearRecentFiles }
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
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-file')
        },
        {
          label: 'Open ADF Agent…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-file')
        },
        { label: 'Open Recent', submenu: openRecentSubmenu },
        { type: 'separator' },
        {
          label: 'Track Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendMenuAction('add-directory')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save')
        },
        // Cmd/Ctrl+W is left unbound here on purpose — the renderer uses it to
        // close the active editor tab; binding it to a menu role would swallow it.
        {
          label: 'Close Agent',
          accelerator: 'CmdOrCtrl+Shift+W',
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
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    },
    {
      role: 'help',
      submenu: [
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
  return [
    { type: 'separator' },
    { label: 'Open Daemon Log', enabled: logFile !== null, click: () => options.openLog() },
    ...(problem ? [{ label: problem, enabled: false }] : []),
    ...(problem && options.canReconnect() ? [{ label: 'Reconnect to the ADF Daemon', click: () => options.reconnect() }] : []),
    ...(failed && useEmbedded ? [{ label: 'Use Embedded for This Session', click: () => useEmbedded() }] : []),
    ...(failed && openBackend ? [{ label: 'Open Settings → Backend', click: () => openBackend() }] : [])
  ]
}
