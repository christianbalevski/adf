import { app, ipcMain, safeStorage } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import type { BackendSettingsPatch, RemoteCheckRequest, RemoteCheckResult } from '../../shared/types/backend.types'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import { createBackendSettingsStore, readRemoteToken, type BackendSettingsStore, type BootBackend, type SecretCodec, type StudioBackendConfig } from './backend-config'
import { remoteHandshake, RemoteConnectError } from './daemon-mode/remote/connector'

const SAFE_PREFIX = 'safe:'

/**
 * Linux without a Secret Service keyring: safeStorage falls back to
 * 'basic_text', a fixed key that only obfuscates. Not good enough for a
 * token that controls a remote daemon.
 */
function isObfuscationOnly(): boolean {
  if (process.platform !== 'linux') return false
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
  return backend === 'basic_text'
}

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
 * Settings → Backend channels. `local` class (design D2): registered in every
 * mode, outside `registerAllIpcHandlers`, so both backends share them.
 * The patch may carry a new token; it is never logged and never returned.
 */
export function registerBackendSettingsHandlers(boot: BootBackend): BackendSettingsStore {
  const store = createBackendSettingsStore({ boot, codec: safeStorageCodec })
  ipcMain.handle(IPC.BACKEND_SETTINGS_GET, () => store.get())
  ipcMain.handle(IPC.BACKEND_SETTINGS_SET, (_event, patch: BackendSettingsPatch) =>
    store.set(patch && typeof patch === 'object' ? patch : {}))
  ipcMain.handle(IPC.BACKEND_REMOTE_CHECK, (_event, request: RemoteCheckRequest) =>
    checkRemoteBackend(store.config(), safeStorageCodec, request && typeof request === 'object' ? request : {}))
  ipcMain.handle(IPC.BACKEND_RESTART_STUDIO, () => {
    console.log('[Backend] Restarting Studio (Settings → Backend), so the saved backend applies')
    app.relaunch()
    app.quit()
  })
  // The daemon-side picker exists in daemon mode only (daemon-mode/remote/,
  // registered with the other daemon-mode channels). Embedded Studio never
  // asks for a pick; a stray call gets an answer, not "no handler".
  if (boot.mode === 'embedded') {
    ipcMain.handle(IPC.REMOTE_PICKER_RESPOND, () => false)
    ipcMain.handle(IPC.REMOTE_FS_BROWSE, () => ({ error: 'Browsing a daemon\'s folders needs Studio in daemon mode (Settings → Backend).', code: 'not_daemon_mode' }))
  }
  return store
}

/**
 * Settings → Backend "Test connection": the remote handshake against a draft
 * URL (remote/connector.ts), so a wrong token or an unreachable host shows
 * before the switch. The token is the draft's, or the saved one only while
 * the draft has the saved URL's origin (§9.2: a token goes to its own origin
 * only). Plain http to an address that is not loopback or tailnet needs the
 * draft's confirmation. Nothing is saved; the token is never returned.
 */
export async function checkRemoteBackend(saved: StudioBackendConfig, codec: SecretCodec, request: RemoteCheckRequest, opts: { fetch?: typeof fetch } = {}): Promise<RemoteCheckResult> {
  const fail = (problem: string, error: string): RemoteCheckResult => ({ ok: false, problem, error })
  const rawUrl = typeof request.url === 'string' && request.url.trim() ? request.url : saved.remote.url
  if (!rawUrl) return fail('not_configured', 'Enter the daemon URL.')
  const check = checkRemoteDaemonUrl(rawUrl)
  if (!check.url) return fail('transport', check.reason ?? 'Invalid URL.')
  const sameAsSaved = remoteUrlOrigin(check.url) === remoteUrlOrigin(saved.remote.url)
  const confirmed = request.allowInsecureHttp === true || (sameAsSaved && saved.remote.allowInsecureHttp)
  if (check.kind === 'insecure-http' && !confirmed) {
    return fail('transport', 'This http:// address is not loopback or a tailnet address. Confirm that you trust this network before Studio sends the token there, or use https://.')
  }
  const draftToken = typeof request.token === 'string' ? request.token.trim() : ''
  const token = draftToken || (sameAsSaved ? readRemoteToken({ ...saved, remote: { ...saved.remote, allowInsecureHttp: confirmed } }, codec) : null)
  if (!token) return fail('no_token', sameAsSaved ? 'Enter the token (adf daemon token on the server prints it).' : 'Enter the token for this address: the saved one belongs to another address and is not sent here.')
  try {
    const info = await remoteHandshake(check.url, token, opts)
    console.log(`[Backend] Remote daemon check: ${check.url} answers (version ${info.version})`)
    return { ok: true, url: check.url, version: info.version, startedBy: info.startedBy }
  } catch (err) {
    const problem = err instanceof RemoteConnectError ? err.problem : 'unreachable'
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[Backend] Remote daemon check of ${check.url} failed: ${error}`)
    return fail(problem, error)
  }
}
