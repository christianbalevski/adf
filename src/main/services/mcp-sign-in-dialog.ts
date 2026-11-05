import type { BrowserWindow as ElectronBrowserWindow, Dialog } from 'electron'

/**
 * Studio's dialog while an MCP server's sign-in command runs (the
 * `waitForUser` of mcp-auth-preflight.ts). It closes by itself when the
 * command finishes (`signal`); Cancel ends the sign-in. "Open sign-in page"
 * opens the link the command printed, for when no browser page appeared.
 * Electron is passed in so embedded Studio and the daemon client share it.
 */
export async function showMcpSignInDialog(
  ui: { dialog: Pick<Dialog, 'showMessageBox'>; BrowserWindow: Pick<typeof ElectronBrowserWindow, 'getFocusedWindow' | 'getAllWindows'> },
  info: { serverName: string; authUrl: () => string | null; openUrl: (url: string) => void | Promise<void>; signal: AbortSignal },
): Promise<void> {
  while (!info.signal.aborted) {
    const url = info.authUrl()
    const win = ui.BrowserWindow.getFocusedWindow() ?? ui.BrowserWindow.getAllWindows()[0] ?? undefined
    const options = {
      type: 'info' as const,
      title: `Sign in — ${info.serverName}`,
      message: `Finish signing in to ${info.serverName} in your browser.`,
      detail: url
        ? 'This closes by itself when sign-in is done. If no sign-in page opened, choose Open sign-in page.'
        : 'This closes by itself when sign-in is done.',
      buttons: url ? ['Cancel', 'Open sign-in page'] : ['Cancel'],
      defaultId: url ? 1 : 0,
      cancelId: 0,
      signal: info.signal,
    }
    const { response } = win ? await ui.dialog.showMessageBox(win, options) : await ui.dialog.showMessageBox(options)
    if (info.signal.aborted || response !== 1 || !url) return
    try { await info.openUrl(url) } catch { /* the dialog shows again; the link still works */ }
  }
}
