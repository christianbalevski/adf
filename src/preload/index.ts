import { contextBridge, ipcRenderer as electronIpcRenderer, webFrame } from 'electron'
import { IPC } from '../shared/constants/ipc-channels'
import { RUNTIME_PUSH_CHANNELS } from '../shared/constants/runtime-push-channels'
import { STUDIO_CALL_CHANNELS } from '../shared/constants/studio-call-channels'
import { createRuntimeIpc, onAnyRuntime } from '../shared/runtime-ipc'
import { LOCAL_RUNTIME, type RuntimeId } from '../shared/runtime-tag'
import type { AdfApi } from './api'
import { createAdfApi } from '../shared/adf-api'

const runtimePushChannels = new Set(RUNTIME_PUSH_CHANNELS)
// Studio calls are never tagged: a surface bound to any runtime makes them as This computer's does (§4.2).
const studioCallChannels = new Set(STUDIO_CALL_CHANNELS)
const ipcChannels = new Set<string>(Object.values(IPC))
const surfaces = new Map<RuntimeId, AdfApi>()
// An agent window's page names its runtime (main sets `runtime=<id>` for a runtime other than This computer, §5.5).
const windowRuntime = new URLSearchParams(globalThis.location?.search ?? '').get('runtime') || LOCAL_RUNTIME
/**
 * The surface bound to `id`, one per runtime, made on first use. `local`
 * (This computer) sends no tag in This computer's pages; in a page of another
 * runtime it tags its calls `local` (an untagged call from there is that
 * runtime's, main §4.3).
 */
function apiFor(id: RuntimeId): AdfApi {
  const runtimeId = typeof id === 'string' && id ? id : LOCAL_RUNTIME
  let surface = surfaces.get(runtimeId)
  if (!surface) {
    surface = {
      ...createAdfApi(
        createRuntimeIpc(electronIpcRenderer, runtimeId, runtimePushChannels, studioCallChannels, { explicitLocal: windowRuntime !== LOCAL_RUNTIME }),
        { platform: process.platform, setZoomFactor: (factor) => webFrame.setZoomFactor(factor) },
      ),
      runtimeId,
      runtime: apiFor,
      onAnyRuntime: (channel: string, callback: (runtimeId: RuntimeId, ...args: unknown[]) => void) => {
        // IPC channels only: the bridge never subscribes the page to an arbitrary string.
        if (!ipcChannels.has(channel)) throw new Error(`Unknown IPC channel: ${channel}`)
        return onAnyRuntime(electronIpcRenderer, channel, callback)
      },
    }
    surfaces.set(runtimeId, surface)
  }
  return surface
}

contextBridge.exposeInMainWorld('adfApi', apiFor(windowRuntime))
