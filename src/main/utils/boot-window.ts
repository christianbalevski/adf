import { app, BrowserWindow, nativeTheme } from 'electron'

/**
 * A small "ADF Studio is starting" window for the part of boot that runs
 * before the main window exists (the mode-switch handover). It opens only
 * when that part has to wait on the user: a boot dialog gets it as a visible
 * parent (a sheet on macOS, which cannot open behind other apps and does not
 * block the main thread), and a slow keychain read says what it waits on.
 * The main window closes it once that window is shown.
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

/** Close the boot window, if one is open (the main window is shown). */
export function closeBootWindow(): void {
  const win = bootWindow
  bootWindow = null
  if (win && !win.isDestroyed()) win.close()
}
