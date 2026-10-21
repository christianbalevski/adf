import { existsSync, readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { readJsonOrQuarantine, writeJsonAtomicAsync } from '../utils/atomic-json'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type {
  BackendDaemonStatus,
  BackendDefaultSwitch,
  BackendSettingsErrorCode,
  BackendSettingsPatch,
  BackendSettingsSaveResult,
  BackendSettingsView,
  StudioBackendMode,
  StudioBackendSource,
  StudioRunMode,
} from '../../shared/types/backend.types'

/**
 * Backend selection at boot (design D9, §4.1): `studio-backend.json` in
 * Studio's userData says whether this Studio runs agents itself (embedded) or
 * is a client of This computer's ADF daemon (local), with every saved
 * connection in its runtime set (docs/design/multi-runtime.md §3.1). The file
 * is read once, before any IPC handler is registered; a change takes effect at
 * the next launch. A file of an older Studio in `mode: remote` is run as
 * `local` (§7.3; runtime-migration.ts rewrites it).
 *
 * No file means DEFAULT_BACKEND_MODE, Local daemon (owner decision
 * 2026-10-16): new installs and 0.7.x installs upgrading alike. The first
 * boot writes that choice into the file (persistDefaultBackend), so a later
 * release sees an explicit mode. An explicit `mode: embedded` is honoured.
 *
 * The remote token is stored as `safe:` (Electron safeStorage) and MUST NOT
 * reach logs or the renderer. Only `readRemoteToken` returns it, for the
 * daemon client in main.
 *
 * Electron-free: safeStorage is injected as a `SecretCodec`.
 */

export const BACKEND_CONFIG_FILE = 'studio-backend.json'

/** Recovery override: `ADF_STUDIO_BACKEND=embedded` boots embedded whatever the file says; `remote` is read as `local`. */
export const BACKEND_ENV_OVERRIDE = 'ADF_STUDIO_BACKEND'

const SAFE_PREFIX = 'safe:'
const MAX_TOKEN_LENGTH = 4096
/** Header-safe: printable ASCII without spaces, as `ADF_DAEMON_TOKEN` values are. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/

const MODES: readonly StudioBackendMode[] = ['embedded', 'local', 'remote']

/**
 * The backend of a Studio with no `studio-backend.json` (owner decision
 * 2026-10-16): the ADF daemon on this computer. Also what a file that cannot
 * be read or names an unknown mode falls back to.
 */
export const DEFAULT_BACKEND_MODE: StudioBackendMode = 'local'
const DEFAULT_LABEL = 'the default, This computer'

export interface StudioBackendConfig {
  v: 1
  /** `remote`: an older Studio's file, migrated at the first launch of this version (multi-runtime.md §7.3). */
  mode: StudioBackendMode
  /** Leave the daemon running when Studio quits (§8.3). Default off. */
  keepDaemonRunning: boolean
  remote: {
    url: string | null
    /** `safe:<base64>`; null when no token is saved. */
    token: string | null
    /** The user confirmed plain HTTP to a non-loopback, non-tailnet `url` (§9.2). */
    allowInsecureHttp: boolean
    /**
     * The computer `url` and `token` came from by pairing (remote-access.md
     * §9.3); null or absent for a pasted token. It belongs to the token.
     */
    paired?: RemotePairedComputer | null
    /**
     * An older Studio's file in `mode: remote`: the saved connection it used
     * (a name in `cli-remotes.json`). Read only by the migration, which
     * removes it (multi-runtime.md §7.3).
     */
    name?: string | null
  }
  /**
   * Origins whose plain HTTP the user confirmed for a saved connection in
   * `cli-remotes.json` (that file has no such field, and `adf` asks each time).
   */
  insecureHttpOrigins?: string[]
  /**
   * The remote runtimes in the order Studio first saw them
   * (docs/design/multi-runtime.md §3.1): `remote:<name>` and `remote`.
   * Written only when it changes, so never while no remote is saved.
   */
  runtimeOrder?: string[]
}

/** At most this many runtime ids are kept in `runtimeOrder`. */
const MAX_RUNTIME_ORDER = 256

/** A saved connection name as `adf remotes` shows it: 1-64 characters, no control characters. */
export function validRemoteName(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** At most this many confirmed plain-HTTP origins are kept. */
const MAX_INSECURE_ORIGINS = 32

/** A remote computer paired from Settings → Connections (remote-access.md §9.3). */
export interface RemotePairedComputer {
  fingerprint: string
  name: string
  deviceId: string
  label: string
}

function readPaired(raw: unknown): RemotePairedComputer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const field = (key: string): string | null => {
    const value = r[key]
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null
  }
  const fingerprint = field('fingerprint'), name = field('name'), deviceId = field('deviceId'), label = field('label')
  return fingerprint && name && deviceId && label ? { fingerprint, name, deviceId, label } : null
}

export interface SecretCodec {
  available(): boolean
  /** Why `available()` is false, in words the user can act on. */
  unavailableReason?(): string | null
  /** Returns `safe:<base64>`. Throws when encryption is unavailable. */
  encrypt(plain: string): string
  /** Null when the value cannot be decrypted in this process. */
  decrypt(stored: string): string | null
}

export interface BootBackend {
  mode: StudioRunMode
  source: StudioBackendSource
  configPath: string
  /** The file's contents, normalized (defaults when there is no file). */
  config: StudioBackendConfig
  /**
   * Set when the file exists but could not be read, or is corrupt and could
   * not be moved aside. Its bytes may be the only copy, so saves are refused.
   */
  writeBlocked: string | null
  /**
   * What the user should know about this launch's backend, token-free: the
   * configured mode could not be used, or fields of the file were ignored.
   * Shown in Settings → Connections.
   */
  notices?: string[]
  /** File fields normalization ignored; the next save writes the file without them (that save says so). */
  dropped?: string[]
  /**
   * The file exists but its mode cannot be used: it could not be read or
   * parsed, it is not a JSON object, or it names an unknown mode. Boot asks
   * the user which backend to use before any credential moves
   * (first-launch.ts guardBoot); never a silent fallback.
   */
  fileProblem?: string | null
  /** A one-launch mode (source `session`): why, in words for Settings → Connections. */
  sessionReason?: string | null
  /**
   * The file says remote (an older Studio) and this launch runs it as This
   * computer, but the migration (multi-runtime.md §7.3, runtime-migration.ts)
   * was not written. Every save of this launch writes `mode: remote` with
   * this `remote.name`, so the next launch still migrates it; a save of
   * another mode ends it.
   */
  remoteModePending?: { name: string | null } | null
  /**
   * Set at boot (first-launch.ts) when an earlier launch switched this
   * install from Embedded to the new default; Settings → Connections shows it.
   */
  defaultSwitch?: BackendDefaultSwitch | null
}

type Log = Pick<Console, 'log' | 'warn'>

export function defaultBackendConfig(): StudioBackendConfig {
  return { v: 1, mode: DEFAULT_BACKEND_MODE, keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } }
}

export function backendConfigPath(userDataDir: string): string {
  return join(userDataDir, BACKEND_CONFIG_FILE)
}

function isMode(value: unknown): value is StudioBackendMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * Why Studio must not use the saved remote URL and token (design §9.2), or
 * null when it may: an unconfirmed plain-http address to a host that is not
 * loopback or tailnet. Checked wherever the token could be sent (boot,
 * `readRemoteToken`), so a stored but unconfirmed URL is shown in Settings
 * and kept in the file, yet never used.
 */
export function remoteTransportRefusal(config: StudioBackendConfig): string | null {
  const url = config.remote.url
  if (!url) return null
  const check = checkRemoteDaemonUrl(url)
  if (!check.url) return `The remote daemon URL is not valid: ${check.reason ?? url}`
  if (check.kind === 'insecure-http' && !config.remote.allowInsecureHttp) {
    return `${check.url} is plain http to an address that is not loopback or a tailnet address, and sending the token over it is not confirmed. Add the connection again in Settings → Connections and confirm it, or use https:// or an SSH tunnel.`
  }
  return null
}

/**
 * Normalize parsed file contents. Unknown or malformed fields fall back to
 * their defaults with a warning; warnings never contain the token. `dropped`
 * names, for the user, the fields a later save will not write back.
 */
export function normalizeBackendConfig(raw: unknown): { config: StudioBackendConfig; warnings: string[]; dropped: string[]; modeProblem: string | null } {
  const config = defaultBackendConfig()
  const warnings: string[] = []
  const dropped: string[] = []
  let modeProblem: string | null = null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) {
      modeProblem = 'the file is not a JSON object'
      warnings.push(`${modeProblem}; using ${DEFAULT_LABEL}`)
    }
    return { config, warnings, dropped, modeProblem }
  }
  const obj = raw as Record<string, unknown>
  if (obj.mode !== undefined) {
    if (isMode(obj.mode)) config.mode = obj.mode
    else {
      modeProblem = `the file names the unknown mode ${JSON.stringify(obj.mode)}`
      warnings.push(`unknown mode ${JSON.stringify(obj.mode)}; using ${DEFAULT_LABEL}`)
      dropped.push(`the unknown mode ${JSON.stringify(obj.mode)}`)
    }
  }
  if (obj.keepDaemonRunning !== undefined) config.keepDaemonRunning = obj.keepDaemonRunning === true
  const remote = obj.remote
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    const r = remote as Record<string, unknown>
    if (typeof r.url === 'string' && r.url) {
      const check = checkRemoteDaemonUrl(r.url)
      if (check.url) config.remote.url = check.url
      else {
        warnings.push('remote.url is not a valid daemon URL; ignored')
        dropped.push(`the remote daemon URL, which is not valid (${check.reason ?? 'not a URL'})`)
      }
    }
    config.remote.allowInsecureHttp = config.remote.url !== null && r.allowInsecureHttp === true
    // An unconfirmed plain-HTTP URL is kept (Settings shows it, a save keeps
    // it) but never used (§9.2): remoteTransportRefusal answers for it at
    // boot and in readRemoteToken, so the token is never sent over it.
    if (config.remote.url && !config.remote.allowInsecureHttp && checkRemoteDaemonUrl(config.remote.url).kind === 'insecure-http') {
      warnings.push('remote.url is plain http to an address that is not loopback or tailnet, and allowInsecureHttp is not set; it is not used until confirmed')
    }
    if (r.token !== undefined && r.token !== null && config.remote.url) {
      if (typeof r.token === 'string' && r.token.startsWith(SAFE_PREFIX)) {
        config.remote.token = r.token
        const paired = readPaired(r.paired)
        if (paired) config.remote.paired = paired
      } else {
        warnings.push('remote.token is not an encrypted (safe:) token; ignored')
        dropped.push('the remote token, which was not stored encrypted')
      }
    }
  }
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    const name = (remote as Record<string, unknown>).name
    if (validRemoteName(name)) config.remote.name = name
    else if (name !== undefined && name !== null) {
      warnings.push('remote.name is not a valid connection name; ignored')
      dropped.push('the saved connection name, which was not valid')
    }
  }
  if (Array.isArray(obj.insecureHttpOrigins)) {
    const origins = obj.insecureHttpOrigins.filter((o): o is string => typeof o === 'string' && remoteUrlOrigin(o) === o).slice(0, MAX_INSECURE_ORIGINS)
    if (origins.length > 0) config.insecureHttpOrigins = origins
  }
  if (Array.isArray(obj.runtimeOrder)) {
    const ids = obj.runtimeOrder.filter((id): id is string => typeof id === 'string' && (id === 'remote' || (id.startsWith('remote:') && validRemoteName(id.slice('remote:'.length)))))
    config.runtimeOrder = [...new Set(ids)].slice(0, MAX_RUNTIME_ORDER)
  }
  return { config, warnings, dropped, modeProblem }
}

/**
 * Read the file for boot. Strips a UTF-8 BOM (hand-edited on Windows). A
 * parse failure is handed to `readJsonOrQuarantine`, which moves the file
 * aside or reports that it could not.
 */
function readBootFile(configPath: string): { found: boolean; data: unknown; problem: string | null; writeBlocked: string | null } {
  if (!existsSync(configPath)) return { found: false, data: null, problem: null, writeBlocked: null }
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown error'
    return {
      found: true,
      data: null,
      problem: `the file could not be read (${code}); using ${DEFAULT_LABEL}, and Settings → Connections will not overwrite it`,
      writeBlocked: `${configPath} could not be read (${code}). Fix its permissions or delete it, then restart Studio.`,
    }
  }
  try {
    return { found: true, data: JSON.parse(raw.replace(/^\uFEFF/, '')), problem: null, writeBlocked: null }
  } catch {
    const { quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<unknown>(configPath)
    if (quarantinedTo) {
      return { found: true, data: null, problem: `the file could not be parsed and was moved to ${quarantinedTo}; using ${DEFAULT_LABEL}`, writeBlocked: null }
    }
    if (corruptUnpreserved) {
      return {
        found: true,
        data: null,
        problem: `the file could not be parsed or moved aside; using ${DEFAULT_LABEL}, and Settings → Connections will not overwrite it`,
        writeBlocked: `${configPath} is corrupt and could not be moved aside. Fix or delete it, then restart Studio.`,
      }
    }
    // Readable on the second read: the file changed in between.
    return { found: true, data: null, problem: `the file changed while it was read; using ${DEFAULT_LABEL}`, writeBlocked: `${configPath} changed while Studio read it. Restart Studio.` }
  }
}

/**
 * Decide the backend for this launch. Synchronous and called once, before
 * any IPC handler is registered (D9). With no file and no override it is a
 * single existence check, logs nothing and resolves DEFAULT_BACKEND_MODE
 * with source `default`; persistDefaultBackend then writes it.
 */
export function resolveBootBackend(configPath: string, env: NodeJS.ProcessEnv, log: Log = console): BootBackend {
  const file = readBootFile(configPath)
  const { config, warnings, dropped, modeProblem } = normalizeBackendConfig(file.data)
  if (file.problem) warnings.push(file.problem)
  for (const w of warnings) log.warn(`[Backend] ${configPath}: ${w}`)
  const notices: string[] = []
  if (file.problem) notices.push(`studio-backend.json: ${file.problem}.`)
  if (dropped.length > 0) notices.push(`studio-backend.json: ignored ${dropped.join('; ')}.`)

  // An older Studio's remote mode: This computer, with that connection in the runtime set (multi-runtime.md §7.3).
  let mode: StudioRunMode = runMode(config.mode)
  if (config.mode === 'remote') log.log(`[Backend] ${configPath} says remote (an older Studio): this launch runs This computer, with that connection in the runtime set`)
  let source: StudioBackendSource = file.found ? 'file' : 'default'
  const override = env[BACKEND_ENV_OVERRIDE]?.trim().toLowerCase()
  if (override) {
    if (isMode(override)) {
      mode = runMode(override)
      source = 'env'
      if (override === 'remote') log.log(`[Backend] ${BACKEND_ENV_OVERRIDE}=remote is read as local: every saved connection is in the runtime set`)
    } else {
      log.warn(`[Backend] Ignoring ${BACKEND_ENV_OVERRIDE}=${JSON.stringify(override)}: expected embedded, local or remote`)
    }
  }
  if (source === 'env') log.log(`[Backend] ${mode} (from ${BACKEND_ENV_OVERRIDE}; ${configPath} says ${config.mode})`)
  else if (source === 'file') log.log(`[Backend] ${mode} (from ${configPath})`)
  const fileProblem = file.found ? (file.problem ?? modeProblem) : null
  return { mode, source, configPath, config, writeBlocked: file.writeBlocked, notices, dropped, fileProblem }
}

/**
 * First boot without `studio-backend.json` (source `default`): write the
 * mode this launch resolved, so a later release reads an explicit choice
 * instead of its own default. Not for an override launch (`env`,
 * `session`), nor when the file exists but could not be read. Returns
 * whether the file was written; logged either way, never throws.
 */
export async function persistDefaultBackend(boot: BootBackend, log: Log = console): Promise<boolean> {
  if (boot.source !== 'default' || boot.writeBlocked) return false
  try {
    await mkdir(dirname(boot.configPath), { recursive: true })
    await writeJsonAtomicAsync(boot.configPath, boot.config)
    log.log(`[Backend] No ${BACKEND_CONFIG_FILE}: this launch runs the default, ${boot.config.mode}; saved it to ${boot.configPath}`)
    return true
  } catch (err) {
    log.warn(`[Backend] Could not save the default backend to ${boot.configPath}: ${(err as Error)?.message ?? 'unknown error'}; the next launch resolves the default again`)
    return false
  }
}

/**
 * The saved remote token in plain text, for the daemon client in main only.
 * Null when the transport rule refuses the saved URL (remoteTransportRefusal):
 * the token is never handed out for an address it may not be sent to.
 */
export function readRemoteToken(config: StudioBackendConfig, codec: SecretCodec): string | null {
  if (remoteTransportRefusal(config)) return null
  return config.remote.token ? codec.decrypt(config.remote.token) : null
}

export function toBackendSettingsView(
  config: StudioBackendConfig,
  boot: Pick<BootBackend, 'mode' | 'source' | 'notices' | 'defaultSwitch' | 'sessionReason'>,
  codec: SecretCodec,
  daemon: BackendDaemonStatus | null = null,
): BackendSettingsView {
  return {
    active: { mode: boot.mode, source: boot.source, notices: boot.notices ?? [], sessionReason: boot.sessionReason ?? null },
    remoteUrlProblem: remoteTransportRefusal(config),
    configured: {
      mode: runMode(config.mode),
      keepDaemonRunning: config.keepDaemonRunning,
      remoteUrl: config.remote.url,
      remoteTokenSaved: config.remote.token !== null,
      allowInsecureHttp: config.remote.allowInsecureHttp,
      remotePaired: config.remote.paired ? { fingerprint: config.remote.paired.fingerprint, name: config.remote.paired.name, label: config.remote.paired.label } : null,
    },
    daemon,
    defaultSwitch: boot.defaultSwitch ?? null,
    encryptionAvailable: codec.available(),
    encryptionUnavailableReason: codec.available() ? null : (codec.unavailableReason?.() ?? null),
  }
}

/** The mode a launch runs for a file's mode: `remote` (an older Studio's) is `local` (multi-runtime.md §7.3). */
export function runMode(mode: StudioBackendMode): StudioRunMode {
  return mode === 'remote' ? 'local' : mode
}

export type ApplyPatchResult =
  | { ok: true; config: StudioBackendConfig; notices: string[]; changes: string[] }
  | { ok: false; code: BackendSettingsErrorCode; error: string }

function fail(code: BackendSettingsErrorCode, error: string): ApplyPatchResult {
  return { ok: false, code, error }
}

/**
 * Apply a Settings → Connections patch. Pure: returns the next config, or an
 * error the renderer shows as is. `changes` is a token-free summary for the
 * log; `notices` tell the user about side effects of their save.
 *
 * The token is bound to the URL's origin (§9.2: sent only to that origin), so
 * changing the origin without entering a new token removes the saved one.
 */
export function applyBackendPatch(
  current: StudioBackendConfig,
  patch: BackendSettingsPatch,
  /**
   * `paired`: main only, when a pairing saves this URL and token (remote-access.md §9.3); never from the renderer's patch.
   */
  opts: { codec: SecretCodec; paired?: RemotePairedComputer },
): ApplyPatchResult {
  const next: StudioBackendConfig = { ...current, remote: { ...current.remote }, ...(current.insecureHttpOrigins ? { insecureHttpOrigins: [...current.insecureHttpOrigins] } : {}) }
  const notices: string[] = []
  const changes: string[] = []

  // The patch crosses IPC from the renderer: check every field's type first.
  const fieldTypes: Array<[keyof BackendSettingsPatch, 'string' | 'boolean' | 'string|null', BackendSettingsErrorCode]> = [
    ['mode', 'string', 'invalid_mode'],
    ['keepDaemonRunning', 'boolean', 'invalid_patch'],
    ['remoteUrl', 'string|null', 'invalid_url'],
    ['remoteToken', 'string', 'invalid_token'],
    ['clearRemoteToken', 'boolean', 'invalid_patch'],
    ['allowInsecureHttp', 'boolean', 'invalid_patch'],
    ['insecureHttpOrigin', 'string', 'invalid_patch'],
    ['trustInsecureOrigin', 'string', 'invalid_patch'],
  ]
  for (const [field, type, code] of fieldTypes) {
    const value: unknown = patch[field]
    if (value === undefined) continue
    const okType = type === 'string|null' ? value === null || typeof value === 'string' : typeof value === type
    if (!okType) return fail(code, `${field} has the wrong type.`)
  }

  if (patch.mode !== undefined) {
    // multi-runtime.md §7.1: there is no remote mode; a saved connection is connected while it is saved.
    if ((patch.mode as string) === 'remote') return fail('invalid_mode', 'Remote mode is gone; use Add in Settings → Connections.')
    if (!isMode(patch.mode)) return fail('invalid_mode', 'Unknown backend mode.')
    if (patch.mode !== current.mode) {
      next.mode = patch.mode
      changes.push(`mode=${patch.mode}`)
    }
  }

  if (patch.trustInsecureOrigin !== undefined) {
    const origin = remoteUrlOrigin(patch.trustInsecureOrigin)
    if (!origin || origin !== patch.trustInsecureOrigin) return fail('invalid_patch', 'trustInsecureOrigin is not an origin.')
    const origins = next.insecureHttpOrigins ?? []
    if (!origins.includes(origin)) {
      next.insecureHttpOrigins = [...origins, origin].slice(-MAX_INSECURE_ORIGINS)
      changes.push(`plain http confirmed for ${origin}`)
    }
  }

  if (patch.keepDaemonRunning !== undefined && patch.keepDaemonRunning !== current.keepDaemonRunning) {
    next.keepDaemonRunning = patch.keepDaemonRunning
    changes.push(`keepDaemonRunning=${next.keepDaemonRunning}`)
  }

  let originChanged = false
  if (patch.remoteUrl !== undefined) {
    const raw = (patch.remoteUrl ?? '').trim()
    if (!raw) {
      if (current.remote.url !== null || current.remote.token !== null) {
        if (current.remote.token !== null) notices.push('The saved token was removed with the URL.')
        next.remote = { url: null, token: null, allowInsecureHttp: false }
        changes.push('remote URL and token removed')
      }
    } else {
      const check = checkRemoteDaemonUrl(raw)
      if (!check.url) return fail('invalid_url', check.reason ?? 'Invalid URL.')
      if (check.url !== current.remote.url) {
        if (remoteUrlOrigin(check.url) !== remoteUrlOrigin(current.remote.url)) {
          originChanged = true
          if (current.remote.token !== null && patch.remoteToken === undefined) {
            notices.push('The saved token was removed because the daemon address changed. Enter the token for the new address.')
            changes.push('remote token removed (origin changed)')
          }
          next.remote.token = null
          next.remote.allowInsecureHttp = false
        }
        next.remote.url = check.url
        changes.push(`remote URL=${check.url}`)
      }
    }
  }

  if (patch.allowInsecureHttp !== undefined) {
    // A confirmation counts only for the origin it names. An earlier one
    // survives only while the origin stays the same, so a stale `true` sent
    // with a new address does not carry over.
    const nextOrigin = remoteUrlOrigin(next.remote.url)
    const fresh = patch.insecureHttpOrigin !== undefined && patch.insecureHttpOrigin === nextOrigin
    const kept = !originChanged && current.remote.allowInsecureHttp
    const allow = patch.allowInsecureHttp && nextOrigin !== null && (fresh || kept)
    if (allow !== next.remote.allowInsecureHttp) changes.push(`allowInsecureHttp=${allow}`)
    next.remote.allowInsecureHttp = allow
  }

  if (patch.clearRemoteToken && next.remote.token !== null) {
    next.remote.token = null
    changes.push('remote token removed')
  }
  // The pairing record belongs to the token: another token, or none, drops it.
  if (next.remote.paired && (next.remote.token === null || patch.remoteToken !== undefined)) delete next.remote.paired

  if (patch.remoteToken !== undefined) {
    const token = patch.remoteToken.trim()
    if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
      return fail('invalid_token', 'The token must be printable characters without spaces.')
    }
    if (!next.remote.url) return fail('token_without_url', 'Enter the daemon URL before the token.')
    if (!opts.codec.available()) {
      return fail('encryption_unavailable', opts.codec.unavailableReason?.() ?? 'The OS keychain is not available, so the token cannot be stored encrypted. It was not saved.')
    }
    try {
      next.remote.token = opts.codec.encrypt(token)
    } catch {
      return fail('encryption_unavailable', 'The token could not be encrypted. It was not saved.')
    }
    changes.push('remote token saved')
    if (opts.paired) {
      next.remote.paired = { ...opts.paired }
      changes.push(`paired with ${opts.paired.name} (${opts.paired.fingerprint})`)
    }
  }

  // Only a save that touches the remote fields is checked, so an unrelated
  // save (mode, keepDaemonRunning) is never blocked by the stored URL.
  const touchesRemote = patch.remoteUrl !== undefined || patch.remoteToken !== undefined || patch.allowInsecureHttp !== undefined
  const unconfirmedHttp = !!next.remote.url && !next.remote.allowInsecureHttp && checkRemoteDaemonUrl(next.remote.url).kind === 'insecure-http'
  // Withdrawing the confirmation of the saved address is allowed (W0-E
  // follow-up): the URL and token stay saved but are not used until the
  // user confirms again or changes the address.
  const withdrawn = unconfirmedHttp && current.remote.allowInsecureHttp && next.remote.url === current.remote.url
    && patch.allowInsecureHttp === false && patch.remoteToken === undefined
  if (withdrawn) {
    notices.push(`Studio will not send the token to ${next.remote.url} until you confirm plain http for it again.`)
  } else if (touchesRemote && unconfirmedHttp) {
    return fail('insecure_url_unconfirmed', 'This http:// address is not loopback or a tailnet address. Confirm that you trust this network, or use https://.')
  }
  return { ok: true, config: next, notices, changes }
}

export interface BackendSettingsStore {
  get(): BackendSettingsView
  set(patch: BackendSettingsPatch): Promise<BackendSettingsSaveResult>
  /** Main only: save the URL and token a pairing returned, with the paired computer (remote-access.md §9.3). */
  savePairing(patch: Pick<BackendSettingsPatch, 'remoteUrl' | 'remoteToken' | 'allowInsecureHttp' | 'insecureHttpOrigin'>, paired: RemotePairedComputer): Promise<BackendSettingsSaveResult>
  /** Current config (main only; holds the encrypted token). */
  config(): StudioBackendConfig
  /**
   * Save the order of the remote runtimes (multi-runtime.md §3.1). Written
   * only when it differs from the saved one; never throws (a failed write is
   * logged and the order stays in memory for this launch).
   */
  setRuntimeOrder(order: readonly string[]): Promise<boolean>
}

/**
 * Settings → Connections state for one Studio process. Studio main is the only
 * writer of `studio-backend.json` (§4.2), so the boot read stays the source
 * of truth and saves go straight to disk. Saves are serialized. A saved mode
 * applies at the next launch (multi-runtime.md §7.2): nothing restarts.
 */
export function createBackendSettingsStore(deps: {
  boot: BootBackend
  codec: SecretCodec
  log?: Log
  /** The daemon line of the view (daemon mode). */
  daemonStatus?: () => BackendDaemonStatus | null
  /** keepDaemonRunning was saved with a new value (the running session follows it). */
  onKeepDaemonRunningChange?: (keep: boolean) => void
}): BackendSettingsStore {
  const log = deps.log ?? console
  let current = deps.boot.config
  let queue: Promise<unknown> = Promise.resolve()
  /** Fields the boot read ignored: the first write leaves them out of the file, and that save says so. */
  let droppedUnwritten = [...(deps.boot.dropped ?? [])]

  const view = (): BackendSettingsView => toBackendSettingsView(current, deps.boot, deps.codec, deps.daemonStatus?.() ?? null)
  /** The file as written: still remote mode while the migration of an older Studio's file is pending. */
  const onDisk = (config: StudioBackendConfig): StudioBackendConfig => {
    const pending = deps.boot.remoteModePending
    if (!pending || config.mode !== 'local') return config
    return { ...config, mode: 'remote', remote: { ...config.remote, name: pending.name } }
  }
  const written = (config: StudioBackendConfig): void => {
    // Another mode chosen: the file no longer says remote.
    if (deps.boot.remoteModePending && config.mode !== 'local') deps.boot.remoteModePending = null
  }

  const save = async (patch: BackendSettingsPatch, paired?: RemotePairedComputer): Promise<BackendSettingsSaveResult> => {
    if (deps.boot.writeBlocked) return { ok: false, code: 'file_unreadable', error: deps.boot.writeBlocked }
    const previous = current
    const result = applyBackendPatch(current, patch, { codec: deps.codec, ...(paired ? { paired } : {}) })
    if (!result.ok) return result
    if (result.changes.length > 0) {
      if (droppedUnwritten.length > 0) {
        result.notices.push(`studio-backend.json no longer holds ${droppedUnwritten.join('; ')}.`)
        log.log(`[Backend] This save leaves out what the boot read ignored: ${droppedUnwritten.join('; ')}`)
      }
      try {
        await mkdir(dirname(deps.boot.configPath), { recursive: true })
        await writeJsonAtomicAsync(deps.boot.configPath, onDisk(result.config))
      } catch (err) {
        log.warn(`[Backend] Could not write ${deps.boot.configPath}: ${(err as Error)?.message ?? 'unknown error'}`)
        return { ok: false, code: 'write_failed', error: `Could not save ${deps.boot.configPath}.` }
      }
      written(result.config)
      current = result.config
      droppedUnwritten = []
      log.log(`[Backend] Settings → Connections saved: ${result.changes.join(', ')} (applies at the next launch)`)
    }
    const notices = [...result.notices]
    // A mode chosen (multi-runtime.md §7.2): the page's "Next launch: <name>." with Restart says it; the one this launch runs is just saved.
    if (result.config.mode !== previous.mode && result.config.mode === deps.boot.mode) notices.push('Saved.')
    if (result.config.keepDaemonRunning !== previous.keepDaemonRunning) deps.onKeepDaemonRunningChange?.(result.config.keepDaemonRunning)
    return { ok: true, view: view(), notices }
  }

  return {
    get: view,
    set: (patch) => {
      const run = queue.then(() => save(patch))
      queue = run.catch(() => {})
      return run
    },
    savePairing: (patch, paired) => {
      const { remoteUrl, remoteToken, allowInsecureHttp, insecureHttpOrigin } = patch
      const run = queue.then(() => save({ remoteUrl, remoteToken, allowInsecureHttp, insecureHttpOrigin }, paired))
      queue = run.catch(() => {})
      return run
    },
    setRuntimeOrder: (order) => {
      const run = queue.then(async () => {
        const next = [...order]
        if ((current.runtimeOrder ?? []).join('\n') === next.join('\n') && (current.runtimeOrder !== undefined || next.length === 0)) return false
        if (deps.boot.writeBlocked) {
          log.warn(`[Backend] The runtime order is not saved: ${deps.boot.writeBlocked}`)
          return false
        }
        const config: StudioBackendConfig = { ...current, runtimeOrder: next }
        try {
          await mkdir(dirname(deps.boot.configPath), { recursive: true })
          await writeJsonAtomicAsync(deps.boot.configPath, onDisk(config))
        } catch (err) {
          log.warn(`[Backend] Could not save the runtime order to ${deps.boot.configPath}: ${(err as Error)?.message ?? 'unknown error'}`)
          return false
        }
        current = config
        if (droppedUnwritten.length > 0) log.log(`[Backend] Saving the runtime order left out what the boot read ignored: ${droppedUnwritten.join('; ')}`)
        log.log(`[Backend] Runtime order saved: ${next.length ? next.join(', ') : '(none)'}`)
        return true
      })
      queue = run.catch(() => {})
      return run
    },
    config: () => current,
  }
}
