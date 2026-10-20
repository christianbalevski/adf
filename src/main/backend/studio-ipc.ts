import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isRuntimeTag, NO_RUNTIME_SENTENCE } from '../../shared/runtime-tag'

/**
 * `ipcMain` for the `studio`-scope channels registered outside the backend
 * registration (docs/design/multi-runtime.md §4.2): main/index.ts, Settings
 * → Connections, remote access, edit recovery, the updater, spellcheck and
 * the orbital cache. Studio has one of each, so a call tagged with a runtime
 * is refused: an invoke rejects with "This call has no runtime.", a send is
 * dropped and logged. An untagged call reaches the listener unchanged.
 */

/** True (and logged) when a `studio` call carries a runtime tag. */
export function taggedStudioCall(channel: string, args: readonly unknown[], log: Pick<Console, 'warn'> = console): boolean {
  if (args.length === 0 || !isRuntimeTag(args[0])) return false
  log.warn(`[IPC] ${channel} was called with a runtime tag (${args[0].$runtime}); it is a Studio call and has no runtime`)
  return true
}

export const ipcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (taggedStudioCall(channel, args)) throw new Error(NO_RUNTIME_SENTENCE)
      return listener(event, ...args)
    })
  },
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
    electronIpcMain.on(channel, (event, ...args) => {
      if (taggedStudioCall(channel, args)) return
      listener(event, ...args)
    })
  },
}
