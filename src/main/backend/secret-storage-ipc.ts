import { readFileSync } from 'node:fs'
// Studio-scope channels refuse a runtime tag (docs/design/multi-runtime.md §4.2).
import { ipcMain } from './studio-ipc'
import { IPC } from '../../shared/constants/ipc-channels'
import { chooseKeyringStorage, secretStorageView, type PolicyChangeResult, type SecretStorageView } from '../services/secret-storage-policy'
import { keyringAvailable, studioSecretCipher } from '../utils/studio-safe-storage'

/** Studio's own secrets through its settings store (Inside Studio: SettingsService keeps the file in memory). */
export interface StudioSecretAccess {
  status(): SecretStorageView
  useKeyring(): PolicyChangeResult
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Settings → Identity → Secret storage, in every mode. Inside Studio it goes
 * through SettingsService. With agents on the ADF daemon (Local or a remote),
 * the daemon keeps its own secrets, but Studio's settings file can still hold
 * its own copies (the owner phrase and runtime keys from Inside Studio, kept
 * at a switch) and the saved plain-text choice: those are shown, with their
 * warning and the switch back, and changed in the file itself by the same
 * verified swap (chooseKeyringStorage), never through the daemon.
 */
export function registerSecretStorageHandlers(deps: { settingsPath: string; embedded: () => StudioSecretAccess | null }): void {
  ipcMain.handle(IPC.STUDIO_SECRET_STORAGE_GET, (): SecretStorageView | null => {
    const embedded = deps.embedded()
    if (embedded) return embedded.status()
    const view = secretStorageView(readSettings(deps.settingsPath), keyringAvailable(), 'studio-copies')
    return view.storedSecrets > 0 || view.policy === 'plaintext' ? view : null
  })
  ipcMain.handle(IPC.STUDIO_SECRET_STORAGE_USE_KEYRING, () => {
    const embedded = deps.embedded()
    const result = embedded ? embedded.useKeyring() : chooseKeyringStorage(deps.settingsPath, studioSecretCipher, keyringAvailable())
    if (!result.ok) {
      console.warn(`[SecretStorage] Switching to the keychain failed: ${result.error}`)
      return { success: false, error: result.error }
    }
    console.log(`[SecretStorage] Encrypted ${result.encrypted} secret(s) with the keychain; keychain storage saved`)
    return { success: true, encrypted: result.encrypted }
  })
}
