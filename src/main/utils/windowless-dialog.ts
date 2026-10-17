import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { flushMainLogSync } from './main-log-file'
import { BootDialogDismissedError, holdBootWindow, showBootWindow, type BootDialogHold } from './boot-window'

export interface WindowlessDialogDeps {
  /** A visible window to attach the dialog to (the boot window). */
  parent: (status: string) => BrowserWindow | null
  show: (parent: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  flushLog: () => void
  log: (line: string) => void
  /** Keep the parent open while the dialog is (closeBootWindow waits); the signal dismisses the dialog. */
  hold?: () => Pick<BootDialogHold, 'release'> & Partial<Pick<BootDialogHold, 'signal'>>
}

const defaultDeps: WindowlessDialogDeps = {
  parent: (status) => showBootWindow(status),
  show: (parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)),
  flushLog: () => flushMainLogSync(),
  log: (line) => console.log(line),
  hold: () => holdBootWindow(),
}

/**
 * A message box raised before the main window exists: at boot, in the
 * handover. Parentless, it was app-modal on macOS (NSAlert runModal): it
 * blocked the main thread and could open behind other apps, leaving Studio
 * with no window and, the log buffer never flushing, nothing in main.log.
 * This names what is waiting in the log, flushes it, and attaches the dialog
 * to the boot window, shown in front: a sheet, visible and non-blocking. The
 * boot window is kept open until the dialog is answered. Closing Studio's
 * main window dismisses it (BootDialogDismissedError).
 */
export async function showWindowlessMessageBox(waitingOn: string, options: MessageBoxOptions, deps: WindowlessDialogDeps = defaultDeps): Promise<MessageBoxReturnValue> {
  deps.log(`[App] Waiting for an answer in a dialog (before the main window): ${waitingOn}`)
  deps.flushLog()
  let parent: BrowserWindow | null = null
  try { parent = deps.parent('Waiting for your answer in the dialog.') } catch { /* no window: the dialog still opens on its own */ }
  // The main window can become ready while this is open: its parent stays until it is answered.
  const held = parent ? deps.hold?.() : undefined
  try {
    const answer = await deps.show(parent, held?.signal ? { ...options, signal: held.signal } : options)
    // Dismissed because the user closed Studio: not an answer.
    if (held?.signal?.aborted) throw held.signal.reason instanceof Error ? held.signal.reason : new BootDialogDismissedError('Studio was closed')
    return answer
  } finally {
    held?.release()
  }
}
