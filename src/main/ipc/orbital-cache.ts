import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import { isOrbitalCacheRequest, readOrbitalCache, writeOrbitalCache } from '../services/orbital-cache'

/** Get/put for the rendered-orbital disk cache. `root` is Studio's userData. */
export function registerOrbitalCacheHandlers(root: string): void {
  ipcMain.handle(IPC.ORBITAL_CACHE_GET, async (_event, req: unknown) => {
    if (!isOrbitalCacheRequest(req)) return null
    return readOrbitalCache(root, req)
  })

  ipcMain.handle(IPC.ORBITAL_CACHE_PUT, async (_event, req: unknown, bytes: unknown) => {
    if (!isOrbitalCacheRequest(req) || !(bytes instanceof Uint8Array)) return false
    return writeOrbitalCache(root, req, bytes)
  })
}
