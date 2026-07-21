import { app, BrowserWindow, Menu, shell } from 'electron'
import { existsSync } from 'fs'
import { basename } from 'path'
import { IPC } from '../shared/constants/ipc-channels'
import type { SettingsService } from './services/settings.service'

export type MenuAction =
  | 'new-file'
  | 'open-file'
  | 'add-directory'
  | 'save'
  | 'close-file'
  | 'open-settings'

const MAX_RECENT_FILES = 10

let settingsRef: SettingsService | null = null

function targetWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sendMenuAction(action: MenuAction): void {
  targetWindow()?.webContents.send(IPC.MENU_ACTION, action)
}

// Recent entries reuse the same flow as double-clicking a .adf in Finder
function sendOpenFile(filePath: string): void {
  targetWindow()?.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath })
}

function getRecentFiles(): string[] {
  const raw = settingsRef?.get('recentFiles')
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
}

/** Call once at startup with the shared SettingsService, before any windows open. */
export function initApplicationMenu(settings: SettingsService): void {
  settingsRef = settings
  buildApplicationMenu()
}

/** Record a file in Open Recent (and the OS-level recent documents list). */
export function recordRecentFile(filePath: string): void {
  if (!settingsRef) return
  const list = [filePath, ...getRecentFiles().filter((p) => p !== filePath)].slice(
    0,
    MAX_RECENT_FILES
  )
  settingsRef.set('recentFiles', list)
  app.addRecentDocument(filePath)
  buildApplicationMenu()
}

function clearRecentFiles(): void {
  settingsRef?.set('recentFiles', [])
  app.clearRecentDocuments()
  buildApplicationMenu()
}

export function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const recents = getRecentFiles().filter((p) => existsSync(p))

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
          label: 'Add Directory…',
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
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
