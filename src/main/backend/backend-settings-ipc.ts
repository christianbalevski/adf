import { ipcMain, safeStorage } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import type { BackendSettingsPatch } from '../../shared/types/backend.types'
import { createBackendSettingsStore, type BackendSettingsStore, type BootBackend, type SecretCodec } from './backend-config'

const SAFE_PREFIX = 'safe:'

/** Electron safeStorage as the `safe:` codec, the format SettingsService uses. */
export const safeStorageCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => SAFE_PREFIX + safeStorage.encryptString(plain).toString('base64'),
  decrypt: (stored) => {
    if (!stored.startsWith(SAFE_PREFIX) || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(SAFE_PREFIX.length), 'base64'))
    } catch {
      console.warn('[Backend] The saved remote token could not be decrypted')
      return null
    }
  },
}

/**
 * Settings → Backend channels. `local` class (design D2): registered in every
 * mode, outside `registerAllIpcHandlers`, so both backends share them.
 * The patch may carry a new token; it is never logged and never returned.
 */
export function registerBackendSettingsHandlers(boot: BootBackend): BackendSettingsStore {
  const store = createBackendSettingsStore({ boot, codec: safeStorageCodec })
  ipcMain.handle(IPC.BACKEND_SETTINGS_GET, () => store.get())
  ipcMain.handle(IPC.BACKEND_SETTINGS_SET, (_event, patch: BackendSettingsPatch) =>
    store.set(patch && typeof patch === 'object' ? patch : {}))
  return store
}
