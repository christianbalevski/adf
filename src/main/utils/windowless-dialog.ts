import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { flushMainLogSync } from './main-log-file'
import { showBootWindow } from './boot-window'

export interface WindowlessDialogDeps {
  /** A visible window to attach the dialog to (the boot window). */
  parent: (status: string) => BrowserWindow | null
  show: (parent: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  flushLog: () => void
  log: (line: string) => void
}

const defaultDeps: WindowlessDialogDeps = {
  parent: (status) => showBootWindow(status),
  show: (parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)),
  flushLog: () => flushMainLogSync(),
  log: (line) => console.log(line),
}

/**
 * A message box raised before the main window exists: at boot, in the
 * handover. Parentless, it was app-modal on macOS (NSAlert runModal): it
 * blocked the main thread and could open behind other apps, leaving Studio
 * with no window and, the log buffer never flushing, nothing in main.log.
 * This names what is waiting in the log, flushes it, and attaches the dialog
 * to the boot window, shown in front: a sheet, visible and non-blocking.
 */
export async function showWindowlessMessageBox(waitingOn: string, options: MessageBoxOptions, deps: WindowlessDialogDeps = defaultDeps): Promise<MessageBoxReturnValue> {
  deps.log(`[App] Waiting for an answer in a dialog (before the main window): ${waitingOn}`)
  deps.flushLog()
  let parent: BrowserWindow | null = null
  try { parent = deps.parent('Waiting for your answer in the dialog.') } catch { /* no window: the dialog still opens on its own */ }
  return deps.show(parent, options)
}
