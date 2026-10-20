/**
 * Settings → Connections: which backend Studio's IPC handlers use (design D9,
 * docs/design/daemon-backend.md). The choice lives in `studio-backend.json`
 * in Studio's userData and takes effect at the next launch.
 *
 * The remote token never crosses IPC towards the renderer: the view carries
 * only whether one is saved.
 */

export type StudioBackendMode = 'embedded' | 'local' | 'remote'

/**
 * The modes a launch runs (docs/design/multi-runtime.md §7.3). `remote` is
 * only a value an older `studio-backend.json` may hold: the first launch of
 * this version migrates it to `local`, with that connection in the runtime set.
 */
export type StudioRunMode = Exclude<StudioBackendMode, 'remote'>

/** Where the running Studio's mode came from. */
export type StudioBackendSource =
  /** No `studio-backend.json`: the default, Local daemon (owner decision 2026-10-16); the first boot saves it to the file. */
  | 'default'
  | 'file'
  /** `ADF_STUDIO_BACKEND` set in the environment (recovery override). */
  | 'env'
  /**
   * This launch only: embedded after a daemon version mismatch (§8.2), or the
   * mode boot chose for one launch (W5-I: an unusable studio-backend.json
   * that cannot be rewritten, an older daemon on the port); `sessionReason` says why.
   */
  | 'session'

export interface BackendSettingsView {
  /** The backend this Studio process booted with. Fixed until the next launch. */
  active: {
    mode: StudioRunMode
    source: StudioBackendSource
    /**
     * What this launch could not do as configured, token-free: fields of
     * studio-backend.json were ignored, or the migration of a `mode: remote`
     * file could not be saved.
     */
    notices: string[]
    /** Source `session` set by boot (W5-I): why this launch runs its mode for one session. */
    sessionReason?: string | null
  }
  /** Why the saved remote URL is not used (an unconfirmed plain-http address), or null. */
  remoteUrlProblem: string | null
  /** What `studio-backend.json` holds now (what the next launch uses, unless overridden). */
  configured: {
    mode: StudioRunMode
    keepDaemonRunning: boolean
    remoteUrl: string | null
    /** True when an encrypted remote token is saved. The token itself is never returned. */
    remoteTokenSaved: boolean
    /** The user confirmed sending the token over plain HTTP to `remoteUrl`. */
    allowInsecureHttp: boolean
    /** The saved token came from pairing with this computer (remote-access.md §9.3); null for a pasted one. */
    remotePaired?: { fingerprint: string; name: string; label: string } | null
  }
  /** This computer's daemon (null in embedded mode). */
  daemon?: BackendDaemonStatus | null
  /** The launch that switched this install from Embedded to the new default, Local daemon; null when none did. */
  defaultSwitch?: BackendDefaultSwitch | null
  /** OS keychain encryption (safeStorage) works; a token cannot be saved without it. */
  encryptionAvailable: boolean
  /** Why encryption is unavailable, when main knows (e.g. Linux without a keyring). */
  encryptionUnavailableReason: string | null
}

/**
 * The first launch of the release that made Local daemon the default, on an
 * install that had run Embedded (owner decision 2026-10-16): what its
 * handover did. Recorded once, in `studio-default-switch.json`.
 */
export interface BackendDefaultSwitch {
  /** ISO time of that launch. */
  at: string
  /** Studio's version at that launch. */
  version: string
  /** What the handover moved or wrote (item labels). */
  moved: string[]
  /** What it did not do, one sentence each. */
  notDone: string[]
}

/** Settings → Connections's daemon line (MODE-02): what Studio is connected to. */
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
  /** K12: whether the owner trusts the daemon's key (adf identity trust-daemon); null when unknown or not reported. */
  trust: { state: 'trusted' | 'not-trusted' | 'not-applicable'; label: string | null; message: string } | null
  /** The daemon could not read this machine's OS keychain at start and runs on its passphrase file: why; null when not (or unknown). */
  keychainProblem: string | null
  logFile: string | null
}

export interface BackendSettingsPatch {
  /** Saved for the next launch (multi-runtime.md §7.2); Studio does not restart. */
  mode?: StudioRunMode
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
  /** Main only: the user confirmed plain HTTP to this origin for a saved connection. */
  trustInsecureOrigin?: string
}

export type BackendSettingsErrorCode =
  | 'invalid_mode'
  | 'invalid_url'
  | 'insecure_url_unconfirmed'
  | 'token_without_url'
  | 'invalid_token'
  | 'encryption_unavailable'
  | 'invalid_patch'
  | 'file_unreadable'
  | 'write_failed'
  | 'remote_not_configured'

export type BackendSettingsSaveResult =
  | { ok: true; view: BackendSettingsView; notices: string[] }
  | { ok: false; code: BackendSettingsErrorCode; error: string }

// --- Remote mode (design §9, tracker W4-B) ---------------------------------

/** What the daemon-side picker picks (§9.3): an agent file, a folder, or a folder plus a new file name. */
export type RemotePickKind = 'open-adf' | 'folder' | 'save-adf'

/** Main asks the renderer for a daemon-side pick. Paths are on the daemon's machine. */
export interface RemotePickRequest {
  requestId: string
  kind: RemotePickKind
  title: string
  /** The daemon's host, as the picker names it. */
  host: string
  /** save-adf: the proposed file name, without `.adf`. */
  defaultName?: string
  /** `import`: only folders the daemon imports into (tracked folders and the agents folder). */
  within?: 'import'
}

export type RemotePickAnswer =
  | { path: string }
  | { directory: string; name: string; replace?: boolean }

/** GET /fs/browse (W1-E): folders and `.adf` files only, inside the daemon's browse roots. */
export interface RemoteBrowseListing {
  path: string | null
  parent: string | null
  roots: Array<{ path: string; kind: 'home' | 'tracked' | 'agents' | 'configured' }>
  entries: Array<{ name: string; path: string; kind: 'directory' | 'adf'; size?: number; mtimeMs?: number }>
  truncated: boolean
}

export type RemoteBrowseResult = RemoteBrowseListing | { error: string; code?: string }

/** POST /fs/folders through REMOTE_FS_MKDIR. */
export type RemoteMkdirResult = { path: string } | { error: string; code?: string }
