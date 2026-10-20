import { isRuntimeTag, LOCAL_RUNTIME, runtimeTag, type RuntimeId } from './runtime-tag'

/**
 * The preload factory's IPC (docs/design/multi-runtime.md §4.1): one
 * surface per runtime over the one `ipcRenderer`.
 *
 * - `invoke` and `send` put the runtime's tag first; the `local` surface
 *   sends no tag, so its traffic is exactly what preload sent before. A
 *   Studio call (`studioCallChannels`) is never tagged: it has no runtime,
 *   so a surface bound to any runtime makes it as the `local` one does.
 * - `on` delivers a push tagged with the surface's runtime, without the tag.
 *   An untagged push is the primary runtime's: the `local` surface gets it on
 *   every channel; another runtime's surface gets it only on a channel that
 *   is not runtime-scoped (Studio and aggregate pushes reach every surface).
 *
 * No Electron import: preload passes `ipcRenderer`; tests pass a fake.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcListener = (event: any, ...args: any[]) => void

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: IpcListener): unknown
  removeListener(channel: string, listener: IpcListener): unknown
}

export interface RuntimeIpc extends IpcRendererLike {
  readonly runtimeId: RuntimeId
}

export function createRuntimeIpc(ipc: IpcRendererLike, runtimeId: RuntimeId, runtimePushChannels: ReadonlySet<string>, studioCallChannels: ReadonlySet<string> = new Set()): RuntimeIpc {
  const tag = runtimeTag(runtimeId)
  const local = tag === null
  const tagged = (channel: string): boolean => !studioCallChannels.has(channel)
  /** channel → listener → the wrapper registered for it. */
  const wrappers = new Map<string, Map<IpcListener, IpcListener>>()
  return {
    runtimeId,
    invoke: local ? (channel, ...args) => ipc.invoke(channel, ...args) : (channel, ...args) => (tagged(channel) ? ipc.invoke(channel, tag, ...args) : ipc.invoke(channel, ...args)),
    send: local ? (channel, ...args) => ipc.send(channel, ...args) : (channel, ...args) => { if (tagged(channel)) ipc.send(channel, tag, ...args); else ipc.send(channel, ...args) },
    on(channel, listener) {
      const scoped = runtimePushChannels.has(channel)
      const wrapper: IpcListener = (event, ...args) => {
        if (args.length > 0 && isRuntimeTag(args[0])) {
          if (args[0].$runtime === runtimeId) listener(event, ...args.slice(1))
          return
        }
        if (local || !scoped) listener(event, ...args)
      }
      let byListener = wrappers.get(channel)
      if (!byListener) { byListener = new Map(); wrappers.set(channel, byListener) }
      byListener.set(listener, wrapper)
      return ipc.on(channel, wrapper)
    },
    removeListener(channel, listener) {
      const wrapper = wrappers.get(channel)?.get(listener)
      if (!wrapper) return undefined
      wrappers.get(channel)!.delete(listener)
      return ipc.removeListener(channel, wrapper)
    },
  }
}

/** Every push on `channel` with its runtime id (`local` for an untagged one, the primary's). Returns the unsubscribe. */
export function onAnyRuntime(ipc: IpcRendererLike, channel: string, callback: (runtimeId: RuntimeId, ...args: unknown[]) => void): () => void {
  const listener: IpcListener = (_event, ...args) => {
    if (args.length > 0 && isRuntimeTag(args[0])) callback(args[0].$runtime, ...args.slice(1))
    else callback(LOCAL_RUNTIME, ...args)
  }
  ipc.on(channel, listener)
  return () => { ipc.removeListener(channel, listener) }
}
