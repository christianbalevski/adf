/**
 * Show-or-create for the main window, kept free of electron imports so the
 * lifecycle rules are unit-testable.
 *
 * On macOS the app outlives its last window, so a request that needs a window
 * (open a file, second launch, notification click) may find none. The rules:
 *
 *   - Nothing is created before startup has finished (IPC handlers and the
 *     adf-file protocol are registered in the whenReady continuation; startup
 *     creates the window itself) or once shutdown has begun (the window would
 *     boot a renderer only to be torn down by app.exit).
 *   - An existing window is restored and focused. One still loading is left
 *     to its own 'ready-to-show' handler — showing it early flashes an
 *     unpainted window.
 *   - Creation is synchronous so the caller gets the new window back.
 */

/** The slice of BrowserWindow this module touches. */
export interface ShowableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  isVisible(): boolean
  show(): void
  focus(): void
  webContents: { isLoading(): boolean }
}

export interface ShowMainWindowDeps<W extends ShowableWindow> {
  current: () => W | null
  create: () => W
  /** False before startup completes and once shutdown has begun. */
  canShow: () => boolean
}

export function showOrCreateMainWindow<W extends ShowableWindow>(deps: ShowMainWindowDeps<W>): W | null {
  if (!deps.canShow()) return null
  const win = deps.current()
  if (!win || win.isDestroyed()) return deps.create()
  if (win.isMinimized()) win.restore()
  if (!win.isVisible() && !win.webContents.isLoading()) win.show()
  win.focus()
  return win
}
