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
} from '../../shared/types/backend.types'

/**
 * Backend selection at boot (design D9, §4.1): `studio-backend.json` in
 * Studio's userData says whether this Studio runs agents itself (embedded) or
 * is a client of an ADF daemon (local, remote). The file is read once, before
 * any IPC handler is registered; a change takes effect at the next launch.
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

/** Recovery override: `ADF_STUDIO_BACKEND=embedded` boots embedded whatever the file says. */
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
const DEFAULT_LABEL = 'the default, Local daemon'

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
  /**
   * What the user should know about this launch's backend, token-free: the
   * configured mode could not be used, or fields of the file were ignored.
   * Shown in Settings → Backend.
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
  /** A one-launch mode (source `session`): why, in words for Settings → Backend. */
  sessionReason?: string | null
  /**
   * Set at boot (first-launch.ts) when an earlier launch switched this
   * install from Embedded to the new default; Settings → Backend shows it.
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
    return `${check.url} is plain http to an address that is not loopback or a tailnet address, and sending the token over it is not confirmed. Confirm it in Settings → Backend, or use https:// or an SSH tunnel.`
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
      if (typeof r.token === 'string' && r.token.startsWith(SAFE_PREFIX)) config.remote.token = r.token
      else {
        warnings.push('remote.token is not an encrypted (safe:) token; ignored')
        dropped.push('the remote token, which was not stored encrypted')
      }
    }
  }
  // Mode remote without a usable URL stays remote: the connector refuses it
  // with a dialog that points at Settings → Backend. Falling back to embedded
  // here would autostart this computer's agents without a word (W4-B review).
  if (config.mode === 'remote' && !config.remote.url) warnings.push('mode is remote but there is no usable remote.url; Studio will say so at launch')
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
      problem: `the file could not be read (${code}); using ${DEFAULT_LABEL}, and Settings → Backend will not overwrite it`,
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
        problem: `the file could not be parsed or moved aside; using ${DEFAULT_LABEL}, and Settings → Backend will not overwrite it`,
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

  let mode = config.mode
  // The file asks for remote, but its URL may not be used. Studio still boots
  // remote, runs no agents, and the remote connector refuses with a dialog
  // naming the reason (W4-B review: no silent embedded boot, which would
  // autostart this computer's agents). Settings → Backend shows it too.
  const refusal = config.mode === 'remote' ? remoteTransportRefusal(config) : null
  if (refusal) {
    log.warn(`[Backend] ${configPath}: mode is remote, but ${refusal} Studio will not connect until it is fixed.`)
    notices.push(`The remote daemon cannot be used: ${refusal}`)
  }
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
  pendingSwitch: BackendSettingsView['pendingSwitch'] = null,
): BackendSettingsView {
  return {
    active: { mode: boot.mode, source: boot.source, notices: boot.notices ?? [], sessionReason: boot.sessionReason ?? null },
    remoteUrlProblem: remoteTransportRefusal(config),
    configured: {
      mode: config.mode,
      keepDaemonRunning: config.keepDaemonRunning,
      remoteUrl: config.remote.url,
      remoteTokenSaved: config.remote.token !== null,
      allowInsecureHttp: config.remote.allowInsecureHttp,
    },
    daemon,
    pendingSwitch,
    defaultSwitch: boot.defaultSwitch ?? null,
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
  opts: { codec: SecretCodec },
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
      // Remote moves nothing to another machine (§5.5); it is allowed once its
      // URL and token are saved (checked below).
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
  // A switch to remote needs a daemon Studio may talk to.
  if (patch.mode === 'remote' && patch.mode !== current.mode) {
    if (!next.remote.url) return fail('remote_not_configured', 'Save the remote daemon URL and token before switching to it.')
    const refusal = remoteTransportRefusal(next)
    if (refusal) return fail('insecure_url_unconfirmed', refusal)
    if (!next.remote.token) return fail('remote_not_configured', `Save the token for ${next.remote.url} before switching to it.`)
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
  log?: Log
  /** The daemon line of the view (daemon mode). */
  daemonStatus?: () => BackendDaemonStatus | null
  /**
   * A save that changes the mode (design D9, §11): show the switch dialog
   * (what moves, what happens to running agents). False cancels the save.
   */
  confirmModeSwitch?: (target: StudioBackendMode) => Promise<boolean>
  /** After a confirmed mode change is on disk: restart Studio into it. Returns a notice for the page. */
  applyModeSwitch?: (target: StudioBackendMode) => string | void
  /** keepDaemonRunning was saved with a new value (the running session follows it). */
  onKeepDaemonRunningChange?: (keep: boolean) => void
  /** A saved switch waiting for turns in flight (mode-switch.ts createModeSwitcher). */
  pendingSwitch?: () => BackendSettingsView['pendingSwitch']
  /** Restart into the waiting switch now; a notice, or null when none waits. */
  finishSwitchNow?: () => string | null
  /** Stop waiting; the target it was waiting for, or null when none waits. */
  cancelSwitch?: () => StudioBackendMode | null
  /** Once a switch's restart has started: the refusal for any later mode change or switch action. */
  restarting?: () => string | null
}): BackendSettingsStore {
  const log = deps.log ?? console
  let current = deps.boot.config
  let queue: Promise<unknown> = Promise.resolve()
  /** Fields the boot read ignored: the first write leaves them out of the file, and that save says so. */
  let droppedUnwritten = [...(deps.boot.dropped ?? [])]

  const view = (): BackendSettingsView => toBackendSettingsView(current, deps.boot, deps.codec, deps.daemonStatus?.() ?? null, deps.pendingSwitch?.() ?? null)

  const save = async (input: BackendSettingsPatch): Promise<BackendSettingsSaveResult> => {
    if (deps.boot.writeBlocked) return { ok: false, code: 'file_unreadable', error: deps.boot.writeBlocked }
    const { switchAction, ...rest } = input
    // Studio is restarting into a switch already: a mode change or a switch action now would not apply (nor be undone).
    const restarting = deps.restarting?.() ?? null
    if (restarting && (switchAction !== undefined || (rest.mode !== undefined && rest.mode !== current.mode))) {
      log.warn(`[Backend] Settings → Backend change refused: ${restarting}`)
      return { ok: false, code: 'restarting', error: restarting }
    }
    let patch: BackendSettingsPatch = rest
    if (switchAction !== undefined) {
      if (switchAction === 'finish-now') {
        const notice = deps.finishSwitchNow?.() ?? null
        return { ok: true, view: view(), notices: [notice ?? 'No switch is waiting.'] }
      }
      if (switchAction !== 'cancel') return fail('invalid_patch', 'Unknown switch action.') as BackendSettingsSaveResult
      const target = deps.cancelSwitch?.() ?? null
      if (!target) return { ok: true, view: view(), notices: ['No switch is waiting.'] }
      // The waiting switch had saved its mode: the running mode is saved again.
      log.log(`[Backend] Switch to ${target} cancelled; saving ${deps.boot.mode} as the mode again`)
      patch = { ...rest, mode: deps.boot.mode }
    }
    const previous = current
    const result = applyBackendPatch(current, patch, { codec: deps.codec })
    if (!result.ok) return result
    // A switch away from the running backend restarts Studio (D9); back to it is a plain save.
    const switching = result.config.mode !== current.mode && result.config.mode !== deps.boot.mode
    if (switching && deps.confirmModeSwitch && !await deps.confirmModeSwitch(result.config.mode)) {
      log.log(`[Backend] Switch to ${result.config.mode} cancelled in the switch dialog`)
      return { ok: false, code: 'switch_cancelled', error: 'Switch cancelled. Nothing changed.' }
    }
    if (result.changes.length > 0) {
      if (droppedUnwritten.length > 0) {
        result.notices.push(`studio-backend.json no longer holds ${droppedUnwritten.join('; ')}.`)
        log.log(`[Backend] This save leaves out what the boot read ignored: ${droppedUnwritten.join('; ')}`)
      }
      try {
        await mkdir(dirname(deps.boot.configPath), { recursive: true })
        await writeJsonAtomicAsync(deps.boot.configPath, result.config)
      } catch (err) {
        log.warn(`[Backend] Could not write ${deps.boot.configPath}: ${(err as Error)?.message ?? 'unknown error'}`)
        return { ok: false, code: 'write_failed', error: `Could not save ${deps.boot.configPath}.` }
      }
      current = result.config
      droppedUnwritten = []
      log.log(`[Backend] Settings → Backend saved: ${result.changes.join(', ')} (${switching ? 'Studio restarts into it now' : 'applies at next launch'})`)
    }
    const notices = [...result.notices]
    // Choosing the running mode while a switch waits for its turns is the latest choice: that switch is cancelled (as Cancel Switch).
    const replaced = !switching && result.config.mode !== previous.mode && switchAction === undefined ? deps.cancelSwitch?.() ?? null : null
    if (replaced) log.log(`[Backend] Switch to ${replaced} cancelled: ${result.config.mode} was chosen again`)
    if (switching) notices.push((deps.applyModeSwitch?.(result.config.mode)) || 'Studio restarts now.')
    else if (replaced) notices.push('Switch cancelled; Studio stays in this mode.')
    else if (result.config.mode !== previous.mode) notices.push('Studio already runs this mode; no restart is needed.')
    if (result.config.keepDaemonRunning !== previous.keepDaemonRunning) deps.onKeepDaemonRunningChange?.(result.config.keepDaemonRunning)
    if (switchAction === 'cancel') notices.splice(0, notices.length, 'Switch cancelled; Studio stays in this mode.')
    return { ok: true, view: view(), notices }
  }

  return {
    get: view,
    set: (patch) => {
      const run = queue.then(() => save(patch))
      queue = run.catch(() => {})
      return run
    },
    config: () => current,
  }
}
