import { safeStorage } from 'electron'
// Studio-scope channels refuse a runtime tag (docs/design/multi-runtime.md §4.2).
import { ipcMain } from './studio-ipc'
import { IPC } from '../../shared/constants/ipc-channels'
import type { BackendDaemonStatus, BackendSettingsPatch, BackendSettingsView, StudioBackendMode } from '../../shared/types/backend.types'
import { createBackendSettingsStore, type BackendSettingsStore, type BootBackend, type SecretCodec } from './backend-config'
import { isObfuscationOnly, relaunchEmbeddedForSession, relaunchStudio } from './mode-switch'

const SAFE_PREFIX = 'safe:'

/** Electron safeStorage as the `safe:` codec, the format SettingsService uses. */
export const safeStorageCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable() && !isObfuscationOnly(),
  unavailableReason: () => isObfuscationOnly()
    ? 'No OS keyring is available (Studio would only obfuscate the token), so the token cannot be saved. Install and unlock a Secret Service keyring such as GNOME Keyring or KWallet, then restart Studio.'
    : safeStorage.isEncryptionAvailable() ? null : 'OS keychain encryption is not available, so the token cannot be saved.',
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
 * Settings → Connections channels. `local` class (design D2): registered in every
 * mode, outside `registerAllIpcHandlers`, so both backends share them.
 * The patch may carry a new token; it is never logged and never returned.
 */
export function registerBackendSettingsHandlers(boot: BootBackend, hooks: {
  daemonStatus?: () => BackendDaemonStatus | null
  confirmModeSwitch?: (target: StudioBackendMode) => Promise<boolean>
  applyModeSwitch?: (target: StudioBackendMode) => string | void
  onKeepDaemonRunningChange?: (keep: boolean) => void
  pendingSwitch?: () => BackendSettingsView['pendingSwitch']
  finishSwitchNow?: () => string | null
  cancelSwitch?: () => StudioBackendMode | null
  restarting?: () => string | null
  savedRemote?: (name: string) => { url: string } | null
} = {}): BackendSettingsStore {
  const store = createBackendSettingsStore({ boot, codec: safeStorageCodec, ...hooks })
  ipcMain.handle(IPC.BACKEND_SETTINGS_GET, () => store.get())
  ipcMain.handle(IPC.BACKEND_SETTINGS_SET, (_event, patch: BackendSettingsPatch) =>
    store.set(patch && typeof patch === 'object' ? patch : {}))
  // The saved mode differs from the running one outside a switch (a boot that fell back, a
  // hand-edited file): restart into it, dropping a session-only override (mode-switch.ts).
  // `kind` (daemon mode): the window kept its unsaved editor text as recovery copies and restarts for Reconnect or
  // Use Embedded for This Session after the daemon connection failed (daemon-mode/index.ts restartKeepingEdits).
  ipcMain.handle(IPC.BACKEND_RESTART_STUDIO, (_event, kind?: unknown) => {
    if (kind === 'reconnect') relaunchStudio('Reconnect after a failed connection to the ADF daemon (unsaved editor text kept as recovery copies)')
    else if (kind === 'embedded-session' && boot.mode === 'local') relaunchEmbeddedForSession('no usable ADF daemon (unsaved editor text kept as recovery copies)')
    else relaunchStudio('Restart Studio in Settings → Connections, so the saved backend applies')
  })
  // The daemon-side picker exists in daemon mode only (daemon-mode/remote/,
  // registered with the other daemon-mode channels). Embedded Studio never
  // asks for a pick; a stray call gets an answer, not "no handler".
  if (boot.mode === 'embedded') {
    ipcMain.handle(IPC.REMOTE_PICKER_RESPOND, () => false)
    ipcMain.handle(IPC.REMOTE_FS_BROWSE, () => ({ error: 'Browsing a daemon\'s folders needs Studio in daemon mode (Settings → Connections).', code: 'not_daemon_mode' }))
    ipcMain.handle(IPC.REMOTE_FS_MKDIR, () => ({ error: 'Creating a folder on a daemon\'s host needs Studio in daemon mode (Settings → Connections).', code: 'not_daemon_mode' }))
  }
  return store
}
