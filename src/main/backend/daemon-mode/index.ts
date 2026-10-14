import type { App, IpcMain } from 'electron'
import { IPC } from '../../../shared/constants/ipc-channels'
import type { StudioBackendMode } from '../../../shared/types/backend.types'
import { BACKEND_ENV_OVERRIDE } from '../backend-config'

/**
 * Daemon-mode IPC registration (design D1, §3): the alternative to
 * `registerAllIpcHandlers` when `studio-backend.json` selects `local` or
 * `remote`.
 *
 * STUB (tracker W0-E). It registers only the `local` channels below. Every
 * proxied channel is unregistered, so the renderer's calls reject and Studio
 * is not usable in this mode yet. W2-C replaces `STUB_LOCAL_CHANNELS` with the
 * channel map (`src/main/backend/channel-map.ts`, W0-A) and adds the proxied
 * handlers and the event bridge.
 *
 * Channels registered outside `registerAllIpcHandlers` in `src/main/index.ts`
 * (orbital cache, fullscreen, open-file pull, updater, spellcheck,
 * Settings → Backend) are registered there in both modes and are not listed.
 */
export const STUB_LOCAL_CHANNELS = [IPC.APP_GET_VERSION, IPC.APP_SET_BADGE_COUNT] as const

export interface DaemonModeDeps {
  mode: Exclude<StudioBackendMode, 'embedded'>
  ipcMain: Pick<IpcMain, 'handle'>
  app: Pick<App, 'getVersion' | 'setBadgeCount'>
  log?: Pick<Console, 'warn'>
}

export function registerDaemonModeHandlers(deps: DaemonModeDeps): { registered: string[] } {
  const log = deps.log ?? console
  deps.ipcMain.handle(IPC.APP_GET_VERSION, () => deps.app.getVersion())
  deps.ipcMain.handle(IPC.APP_SET_BADGE_COUNT, (_event, count: unknown) => {
    deps.app.setBadgeCount(Number.isInteger(count) && (count as number) > 0 ? (count as number) : 0)
  })
  log.warn(
    `[Backend] ${deps.mode} daemon mode is not implemented in this build: ` +
    `only ${STUB_LOCAL_CHANNELS.length} local channels are registered and Studio will not work. ` +
    `Start Studio with ${BACKEND_ENV_OVERRIDE}=embedded to recover.`
  )
  return { registered: [...STUB_LOCAL_CHANNELS] }
}
