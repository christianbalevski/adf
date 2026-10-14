import { existsSync, readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { readJsonOrQuarantine, writeJsonAtomicAsync } from '../utils/atomic-json'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type {
  BackendDaemonStatus,
  BackendSettingsErrorCode,
  BackendSettingsPatch,
  BackendSettingsSaveResult,
  BackendSettingsView,
  StudioBackendMode,
  StudioBackendSource,
} from '../../shared/types/backend.types'

/**
 * Backend selection at boot (design D9, §4.1): `studio-backend.json` in
 * Studio's userData says whether this Studio runs agents itself (embedded) or
 * is a client of an ADF daemon (local, remote). The file is read once, before
 * any IPC handler is registered; a change takes effect at the next launch.
 *
 * No file means embedded, exactly as before backend selection existed.
 *
 * The remote token is stored as `safe:` (Electron safeStorage) and MUST NOT
 * reach logs or the renderer. Only `readRemoteToken` returns it, for the
 * daemon client in main.
 *
 * Electron-free: safeStorage is injected as a `SecretCodec`.
 */

export const BACKEND_CONFIG_FILE = 'studio-backend.json'

/** Recovery override: `ADF_STUDIO_BACKEND=embedded` boots embedded whatever the file says. */
export const BACKEND_ENV_OVERRIDE = 'ADF_STUDIO_BACKEND'

/** Switching between embedded and local daemon from Settings, with the handover (W4-A, handover.ts). */
export const MODE_SWITCH_AVAILABLE = true

/** Switching to a remote daemon from Settings (W4-B sets it when remote mode ships). */
export const REMOTE_SWITCH_AVAILABLE = false

const SAFE_PREFIX = 'safe:'
const MAX_TOKEN_LENGTH = 4096
/** Header-safe: printable ASCII without spaces, as `ADF_DAEMON_TOKEN` values are. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/

const MODES: readonly StudioBackendMode[] = ['embedded', 'local', 'remote']

export interface StudioBackendConfig {
  v: 1
  mode: StudioBackendMode
  /** Leave the daemon running when Studio quits (§8.3). Default off. */
  keepDaemonRunning: boolean
  remote: {
    url: string | null
    /** `safe:<base64>`; null when no token is saved. */
    token: string | null
    /** The user confirmed plain HTTP to a non-loopback, non-tailnet `url` (§9.2). */
    allowInsecureHttp: boolean
  }
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
  mode: StudioBackendMode
  source: StudioBackendSource
  configPath: string
  /** The file's contents, normalized (defaults when there is no file). */
  config: StudioBackendConfig
  /**
   * Set when the file exists but could not be read, or is corrupt and could
   * not be moved aside. Its bytes may be the only copy, so saves are refused.
   */
  writeBlocked: string | null
}

type Log = Pick<Console, 'log' | 'warn'>

export function defaultBackendConfig(): StudioBackendConfig {
  return { v: 1, mode: 'embedded', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } }
}

export function backendConfigPath(userDataDir: string): string {
  return join(userDataDir, BACKEND_CONFIG_FILE)
}

function isMode(value: unknown): value is StudioBackendMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * Normalize parsed file contents. Unknown or malformed fields fall back to
 * their defaults with a warning; warnings never contain the token.
 */
export function normalizeBackendConfig(raw: unknown): { config: StudioBackendConfig; warnings: string[] } {
  const config = defaultBackendConfig()
  const warnings: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) warnings.push('the file is not a JSON object; using embedded')
    return { config, warnings }
  }
  const obj = raw as Record<string, unknown>
  if (obj.mode !== undefined) {
    if (isMode(obj.mode)) config.mode = obj.mode
    else warnings.push(`unknown mode ${JSON.stringify(obj.mode)}; using embedded`)
  }
  if (obj.keepDaemonRunning !== undefined) config.keepDaemonRunning = obj.keepDaemonRunning === true
  const remote = obj.remote
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    const r = remote as Record<string, unknown>
    if (typeof r.url === 'string' && r.url) {
      const check = checkRemoteDaemonUrl(r.url)
      if (check.url) config.remote.url = check.url
      else warnings.push('remote.url is not a valid daemon URL; ignored')
    }
    config.remote.allowInsecureHttp = config.remote.url !== null && r.allowInsecureHttp === true
    // An unconfirmed plain-HTTP URL is never used (§9.2): drop it with its
    // token, so neither boot nor a later client sends the token over it.
    if (config.remote.url && !config.remote.allowInsecureHttp && checkRemoteDaemonUrl(config.remote.url).kind === 'insecure-http') {
      warnings.push('remote.url is plain http to an address that is not loopback or tailnet, and allowInsecureHttp is not set; ignored with its token')
      config.remote.url = null
    }
    if (r.token !== undefined && r.token !== null && config.remote.url) {
      if (typeof r.token === 'string' && r.token.startsWith(SAFE_PREFIX)) config.remote.token = r.token
      else warnings.push('remote.token is not an encrypted (safe:) token; ignored')
    }
  }
  if (config.mode === 'remote' && !config.remote.url) {
    warnings.push('mode is remote but there is no usable remote.url; using embedded')
    config.mode = 'embedded'
  }
  return { config, warnings }
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
      problem: `the file could not be read (${code}); using embedded, and Settings → Backend will not overwrite it`,
      writeBlocked: `${configPath} could not be read (${code}). Fix its permissions or delete it, then restart Studio.`,
    }
  }
  try {
    return { found: true, data: JSON.parse(raw.replace(/^\uFEFF/, '')), problem: null, writeBlocked: null }
  } catch {
    const { quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<unknown>(configPath)
    if (quarantinedTo) {
      return { found: true, data: null, problem: `the file could not be parsed and was moved to ${quarantinedTo}; using embedded`, writeBlocked: null }
    }
    if (corruptUnpreserved) {
      return {
        found: true,
        data: null,
        problem: 'the file could not be parsed or moved aside; using embedded, and Settings → Backend will not overwrite it',
        writeBlocked: `${configPath} is corrupt and could not be moved aside. Fix or delete it, then restart Studio.`,
      }
    }
    // Readable on the second read: the file changed in between.
    return { found: true, data: null, problem: 'the file changed while it was read; using embedded', writeBlocked: `${configPath} changed while Studio read it. Restart Studio.` }
  }
}

/**
 * Decide the backend for this launch. Synchronous and called once, before
 * any IPC handler is registered (D9). With no file and no override it is a
 * single existence check and logs nothing.
 */
export function resolveBootBackend(configPath: string, env: NodeJS.ProcessEnv, log: Log = console): BootBackend {
  const file = readBootFile(configPath)
  const { config, warnings } = normalizeBackendConfig(file.data)
  if (file.problem) warnings.push(file.problem)
  for (const w of warnings) log.warn(`[Backend] ${configPath}: ${w}`)

  let mode = config.mode
  let source: StudioBackendSource = file.found ? 'file' : 'default'
  const override = env[BACKEND_ENV_OVERRIDE]?.trim().toLowerCase()
  if (override) {
    if (isMode(override)) {
      mode = override
      source = 'env'
    } else {
      log.warn(`[Backend] Ignoring ${BACKEND_ENV_OVERRIDE}=${JSON.stringify(override)}: expected embedded, local or remote`)
    }
  }
  if (source === 'env') log.log(`[Backend] ${mode} (from ${BACKEND_ENV_OVERRIDE}; ${configPath} says ${config.mode})`)
  else if (source === 'file') log.log(`[Backend] ${mode} (from ${configPath})`)
  return { mode, source, configPath, config, writeBlocked: file.writeBlocked }
}

/** The saved remote token in plain text, for the daemon client in main only. */
export function readRemoteToken(config: StudioBackendConfig, codec: SecretCodec): string | null {
  return config.remote.token ? codec.decrypt(config.remote.token) : null
}

export function toBackendSettingsView(config: StudioBackendConfig, boot: Pick<BootBackend, 'mode' | 'source'>, codec: SecretCodec, daemon: BackendDaemonStatus | null = null): BackendSettingsView {
  return {
    active: { mode: boot.mode, source: boot.source },
    configured: {
      mode: config.mode,
      keepDaemonRunning: config.keepDaemonRunning,
      remoteUrl: config.remote.url,
      remoteTokenSaved: config.remote.token !== null,
      allowInsecureHttp: config.remote.allowInsecureHttp,
    },
    modeSwitchAvailable: MODE_SWITCH_AVAILABLE,
    remoteSwitchAvailable: REMOTE_SWITCH_AVAILABLE,
    daemon,
    encryptionAvailable: codec.available(),
    encryptionUnavailableReason: codec.available() ? null : (codec.unavailableReason?.() ?? null),
  }
}

export type ApplyPatchResult =
  | { ok: true; config: StudioBackendConfig; notices: string[]; changes: string[] }
  | { ok: false; code: BackendSettingsErrorCode; error: string }

function fail(code: BackendSettingsErrorCode, error: string): ApplyPatchResult {
  return { ok: false, code, error }
}

/**
 * Apply a Settings → Backend patch. Pure: returns the next config, or an
 * error the renderer shows as is. `changes` is a token-free summary for the
 * log; `notices` tell the user about side effects of their save.
 *
 * The token is bound to the URL's origin (§9.2: sent only to that origin), so
 * changing the origin without entering a new token removes the saved one.
 */
export function applyBackendPatch(
  current: StudioBackendConfig,
  patch: BackendSettingsPatch,
  opts: { codec: SecretCodec; allowModeChange: boolean; allowRemoteSwitch?: boolean },
): ApplyPatchResult {
  const next: StudioBackendConfig = { ...current, remote: { ...current.remote } }
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
  ]
  for (const [field, type, code] of fieldTypes) {
    const value: unknown = patch[field]
    if (value === undefined) continue
    const okType = type === 'string|null' ? value === null || typeof value === 'string' : typeof value === type
    if (!okType) return fail(code, `${field} has the wrong type.`)
  }

  if (patch.mode !== undefined) {
    if (!isMode(patch.mode)) return fail('invalid_mode', 'Unknown backend mode.')
    if (patch.mode !== current.mode) {
      // Back to embedded is always allowed: it is the recovery path from a
      // hand-edited file, and embedded needs no handover.
      if (!opts.allowModeChange && patch.mode !== 'embedded') return fail('mode_switch_unavailable', 'Switching the backend is available in a later build.')
      if (patch.mode === 'remote' && !(opts.allowRemoteSwitch ?? REMOTE_SWITCH_AVAILABLE)) {
        return fail('mode_switch_unavailable', 'Switching to a remote daemon from Settings is available in a later build.')
      }
      next.mode = patch.mode
      changes.push(`mode=${patch.mode}`)
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
  }

  // Only a save that touches the remote fields is checked, so an unrelated
  // save (mode, keepDaemonRunning) is never blocked by the stored URL.
  const touchesRemote = patch.remoteUrl !== undefined || patch.remoteToken !== undefined || patch.allowInsecureHttp !== undefined
  if (touchesRemote && next.remote.url && !next.remote.allowInsecureHttp && checkRemoteDaemonUrl(next.remote.url).kind === 'insecure-http') {
    return fail('insecure_url_unconfirmed', 'This http:// address is not loopback or a tailnet address. Confirm that you trust this network, or use https://.')
  }

  return { ok: true, config: next, notices, changes }
}

export interface BackendSettingsStore {
  get(): BackendSettingsView
  set(patch: BackendSettingsPatch): Promise<BackendSettingsSaveResult>
  /** Current config (main only; holds the encrypted token). */
  config(): StudioBackendConfig
}

/**
 * Settings → Backend state for one Studio process. Studio main is the only
 * writer of `studio-backend.json` (§4.2), so the boot read stays the source
 * of truth and saves go straight to disk. Saves are serialized.
 */
export function createBackendSettingsStore(deps: {
  boot: BootBackend
  codec: SecretCodec
  allowModeChange?: boolean
  allowRemoteSwitch?: boolean
  log?: Log
  /** The daemon line of the view (daemon mode). */
  daemonStatus?: () => BackendDaemonStatus | null
  /**
   * A save that changes the mode (design D9, §11): show the switch dialog
   * (what moves, what happens to running agents). False cancels the save.
   */
  confirmModeSwitch?: (target: StudioBackendMode) => Promise<boolean>
  /** After a confirmed mode change is on disk: restart Studio into it. */
  applyModeSwitch?: (target: StudioBackendMode) => void
}): BackendSettingsStore {
  const log = deps.log ?? console
  let current = deps.boot.config
  let queue: Promise<unknown> = Promise.resolve()

  const save = async (patch: BackendSettingsPatch): Promise<BackendSettingsSaveResult> => {
    if (deps.boot.writeBlocked) return { ok: false, code: 'file_unreadable', error: deps.boot.writeBlocked }
    const result = applyBackendPatch(current, patch, { codec: deps.codec, allowModeChange: deps.allowModeChange ?? MODE_SWITCH_AVAILABLE, allowRemoteSwitch: deps.allowRemoteSwitch })
    if (!result.ok) return result
    // A switch away from the running backend restarts Studio (D9); back to it is a plain save.
    const switching = result.config.mode !== current.mode && result.config.mode !== deps.boot.mode
    if (switching && deps.confirmModeSwitch && !await deps.confirmModeSwitch(result.config.mode)) {
      log.log(`[Backend] Switch to ${result.config.mode} cancelled in the switch dialog`)
      return { ok: false, code: 'switch_cancelled', error: 'Switch cancelled. Nothing changed.' }
    }
    if (result.changes.length > 0) {
      try {
        await mkdir(dirname(deps.boot.configPath), { recursive: true })
        await writeJsonAtomicAsync(deps.boot.configPath, result.config)
      } catch (err) {
        log.warn(`[Backend] Could not write ${deps.boot.configPath}: ${(err as Error)?.message ?? 'unknown error'}`)
        return { ok: false, code: 'write_failed', error: `Could not save ${deps.boot.configPath}.` }
      }
      current = result.config
      log.log(`[Backend] Settings → Backend saved: ${result.changes.join(', ')} (${switching ? 'Studio restarts into it now' : 'applies at next launch'})`)
    }
    if (switching && deps.applyModeSwitch) deps.applyModeSwitch(result.config.mode)
    return { ok: true, view: toBackendSettingsView(current, deps.boot, deps.codec, deps.daemonStatus?.() ?? null), notices: result.notices }
  }

  return {
    get: () => toBackendSettingsView(current, deps.boot, deps.codec, deps.daemonStatus?.() ?? null),
    set: (patch) => {
      const run = queue.then(() => save(patch))
      queue = run.catch(() => {})
      return run
    },
    config: () => current,
  }
}
