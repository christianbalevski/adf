/**
 * Settings → Backend: which backend Studio's IPC handlers use (design D9,
 * docs/design/daemon-backend.md). The choice lives in `studio-backend.json`
 * in Studio's userData and takes effect at the next launch.
 *
 * The remote token never crosses IPC towards the renderer: the view carries
 * only whether one is saved.
 */

export type StudioBackendMode = 'embedded' | 'local' | 'remote'

/** Where the running Studio's mode came from. */
export type StudioBackendSource =
  /** No `studio-backend.json`: embedded, as before backend selection existed. */
  | 'default'
  | 'file'
  /** `ADF_STUDIO_BACKEND` set in the environment (recovery override). */
  | 'env'

export interface BackendSettingsView {
  /** The backend this Studio process booted with. Fixed until restart. */
  active: { mode: StudioBackendMode; source: StudioBackendSource }
  /** What `studio-backend.json` holds now (what the next launch uses, unless overridden). */
  configured: {
    mode: StudioBackendMode
    keepDaemonRunning: boolean
    remoteUrl: string | null
    /** True when an encrypted remote token is saved. The token itself is never returned. */
    remoteTokenSaved: boolean
    /** The user confirmed sending the token over plain HTTP to `remoteUrl`. */
    allowInsecureHttp: boolean
  }
  /** False until mode switching ships; the renderer disables mode choices. */
  modeSwitchAvailable: boolean
  /** OS keychain encryption (safeStorage) works; a token cannot be saved without it. */
  encryptionAvailable: boolean
  /** Why encryption is unavailable, when main knows (e.g. Linux without a keyring). */
  encryptionUnavailableReason: string | null
}

export interface BackendSettingsPatch {
  mode?: StudioBackendMode
  keepDaemonRunning?: boolean
  /** `null` or `''` clears the remote URL and the token saved for it. */
  remoteUrl?: string | null
  /** A new token. Encrypted in main before it is written; never echoed back. */
  remoteToken?: string
  clearRemoteToken?: boolean
  allowInsecureHttp?: boolean
  /**
   * The origin the user confirmed plain HTTP for. `allowInsecureHttp: true`
   * counts for a new address only when this names that address's origin.
   */
  insecureHttpOrigin?: string
}

export type BackendSettingsErrorCode =
  | 'mode_switch_unavailable'
  | 'invalid_mode'
  | 'invalid_url'
  | 'insecure_url_unconfirmed'
  | 'token_without_url'
  | 'invalid_token'
  | 'encryption_unavailable'
  | 'invalid_patch'
  | 'file_unreadable'
  | 'write_failed'

export type BackendSettingsSaveResult =
  | { ok: true; view: BackendSettingsView; notices: string[] }
  | { ok: false; code: BackendSettingsErrorCode; error: string }
