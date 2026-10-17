import { app, BrowserWindow, nativeTheme } from 'electron'

/**
 * A small "ADF Studio is starting" window for the part of boot that runs
 * before the main window exists (the mode-switch handover). It opens only
 * when that part has to wait on the user: a boot dialog gets it as a visible
 * parent (a sheet on macOS, which cannot open behind other apps and does not
 * block the main thread), and a slow keychain read says what it waits on.
 * The main window closes it once that window is shown, or once the dialog
 * open on it is answered.
 */

let bootWindow: BrowserWindow | null = null

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(status: string): string {
  const dark = nativeTheme.shouldUseDarkColors
  const bg = dark ? '#0c0e13' : '#ffffff' // brand --paper
  const ink = dark ? '#e6e8ee' : '#1b1d22'
  const muted = dark ? '#b0b5c2' : '#474b54' // brand --ink-muted
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ADF Studio</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;height:100%;background:${bg};color:${ink};font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{box-sizing:border-box;height:100%;padding:28px 28px 24px;display:flex;flex-direction:column;justify-content:center;gap:8px;-webkit-app-region:drag}
h1{margin:0;font-size:14px;font-weight:600}p{margin:0;line-height:1.5;color:${muted}}</style></head>
<body><main><h1>ADF Studio is starting</h1><p>${escapeHtml(status)}</p></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Show the boot window with this status (creating it, or updating the open one), in front. */
export function showBootWindow(status: string): BrowserWindow {
  if (!bootWindow || bootWindow.isDestroyed()) {
    bootWindow = new BrowserWindow({
      width: 460,
      height: 170,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'ADF Studio',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e13' : '#ffffff',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const created = bootWindow
    created.on('closed', () => { if (bootWindow === created) bootWindow = null })
  }
  void bootWindow.loadURL(page(status)).catch(() => { /* the window still shows; the status line is a courtesy */ })
  bootWindow.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  bootWindow.focus()
  return bootWindow
}

/** Dialogs open on the boot window; it is not closed under them. */
let dialogsOpen = 0
let closeWhenAnswered = false
/** One per open dialog: aborting it dismisses the dialog as Cancel. */
const dialogAborts = new Set<AbortController>()

/** A boot dialog was dismissed because the user closed Studio (dismissBootDialogs): no answer, and nothing may act on one. */
export class BootDialogDismissedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BootDialogDismissedError'
  }
}

export interface BootDialogHold {
  release(): void
  /** Pass to the dialog: aborted when the user closes Studio while it is open. */
  signal: AbortSignal
}

/**
 * A dialog is open on the boot window: it stays open until `release` runs.
 * A boot dialog can run alongside main window creation (the daemon version
 * mismatch); closing its parent would end a macOS sheet with no button,
 * read as the cancel answer.
 */
export function holdBootWindow(): BootDialogHold {
  dialogsOpen++
  const abort = new AbortController()
  dialogAborts.add(abort)
  let released = false
  return {
    signal: abort.signal,
    release: () => {
      if (released) return
      released = true
      dialogAborts.delete(abort)
      dialogsOpen--
      if (dialogsOpen === 0 && closeWhenAnswered) {
        closeWhenAnswered = false
        console.log('[App] The boot dialog was answered; closing the boot window')
        closeBootWindow()
      }
    },
  }
}

/**
 * The user closed Studio's main window while a boot dialog is open: every
 * such dialog is dismissed as Cancel (its caller gets
 * BootDialogDismissedError) and the boot window closes once they settle,
 * so the last window goes and Studio quits as before.
 */
export function dismissBootDialogs(reason: string): void {
  if (dialogAborts.size === 0) return
  console.log(`[App] ${reason}: dismissing ${dialogAborts.size} open boot dialog(s) as Cancel; the boot window closes`)
  closeWhenAnswered = true
  for (const abort of [...dialogAborts]) abort.abort(new BootDialogDismissedError(reason))
}

/** Close the boot window, if one is open (the main window is shown); after its dialog is answered when one is open. */
export function closeBootWindow(): void {
  if (dialogsOpen > 0) {
    if (!closeWhenAnswered && bootWindow && !bootWindow.isDestroyed()) console.log('[App] The main window is shown; the boot window stays open until its dialog is answered')
    closeWhenAnswered = true
    return
  }
  const win = bootWindow
  bootWindow = null
  if (win && !win.isDestroyed()) win.close()
}
