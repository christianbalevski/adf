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
  /** Embedded for this launch only: the user chose it when the daemon's version did not match (§8.2). */
  | 'session'

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
  /** Switching between embedded and local daemon from Settings (W4-A). */
  modeSwitchAvailable: boolean
  /** Switching to remote from Settings (W4-B); false: the remote choice is disabled. */
  remoteSwitchAvailable?: boolean
  /** The daemon this Studio uses, in local or remote mode (null in embedded mode). */
  daemon?: BackendDaemonStatus | null
  /** OS keychain encryption (safeStorage) works; a token cannot be saved without it. */
  encryptionAvailable: boolean
  /** Why encryption is unavailable, when main knows (e.g. Linux without a keyring). */
  encryptionUnavailableReason: string | null
}

/** Settings → Backend's daemon line (MODE-02): what Studio is connected to. */
export interface BackendDaemonStatus {
  connection: 'connecting' | 'connected' | 'disconnected' | 'failed'
  /** While connecting: "Waiting for the ADF daemon (pid N)…" and the like. */
  progress: string | null
  /** Failed or disconnected: the reason. */
  message: string | null
  url: string | null
  pid: number | null
  version: string | null
  startedBy: 'studio' | 'cli' | 'service' | null
  /** Local mode: Studio started this daemon run, or attached to a running one. */
  how: 'attached' | 'spawned' | null
  /** The daemon's local proof (stored-value reveal, owner import); null when unknown (remote, older daemon). */
  localProof: { available: boolean; problem: string | null } | null
  logFile: string | null
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
  /** The user cancelled the switch dialog; nothing changed. */
  | 'switch_cancelled'
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
