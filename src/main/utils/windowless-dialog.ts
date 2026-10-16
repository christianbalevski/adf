import { app, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { flushMainLogSync } from './main-log-file'

export interface WindowlessDialogDeps {
  show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  bringToFront: () => void
  flushLog: () => void
  log: (line: string) => void
}

const defaultDeps: WindowlessDialogDeps = {
  show: (options) => dialog.showMessageBox(options),
  bringToFront: () => {
    if (process.platform !== 'darwin') return
    app.focus({ steal: true })
    app.dock?.bounce('critical')
  },
  flushLog: () => flushMainLogSync(),
  log: (line) => console.log(line),
}

/**
 * A message box with no window to attach to: at boot, before the main
 * window exists. On macOS it is app-modal and blocks the main thread until
 * answered (Electron runs NSAlert runModal), so one that opens behind other
 * apps hangs Studio with no window, no Dock activity and, the log buffer
 * never flushing, nothing in main.log. This names what is waiting in the log,
 * flushes it, and brings Studio forward before the dialog opens.
 */
export async function showWindowlessMessageBox(waitingOn: string, options: MessageBoxOptions, deps: WindowlessDialogDeps = defaultDeps): Promise<MessageBoxReturnValue> {
  deps.log(`[App] Waiting for an answer in a dialog (no window yet): ${waitingOn}`)
  deps.flushLog()
  try { deps.bringToFront() } catch { /* best-effort: the dialog still opens */ }
  return deps.show(options)
}
