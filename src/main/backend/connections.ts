import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, StudioRunMode } from '../../shared/types/backend.types'
import type { ConnectionCurrent, ConnectionRow, ConnectionsView } from '../../shared/types/connection.types'
import type { RemoteDiscoveryUpdate } from '../../shared/types/remote-access-ipc.types'
import { forgetRemote, loadRemotes, readRemotesAsync, readRemoteToken, remoteNameFor, remotesFilePath, RemotesUnreadableError, storeRemoteToken, updateRemotes, type SavedRemote, type TokenStoreChoice } from '../cli/remotes'
import { helloRefusal, rateLimitedSentence, verifyHello } from '../services/remote-hello'
import { awaitKeychainAccess } from './daemon-secrets'
import { runMode, type BackendSettingsStore, type BootBackend, type SecretCodec, type StudioBackendConfig } from './backend-config'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { PinMismatchError } from './daemon-mode/connection'
import { runtimeOrder, SLOT_RUNTIME } from './daemon-mode/runtime-manager'

/**
 * Saved connections (docs/design/settings-scopes.md §5.2): one list for
 * Studio, `adf` and the terminal app. The list is `cli-remotes.json` next to
 * the settings file Studio's daemon uses; tokens are in the OS keychain
 * (`ADF` / `remote-token:<fingerprint>`), else the user-only
 * `cli-remote-tokens.json` (src/main/cli/remotes.ts). Studio adds no field
 * to that file. The remote URL of `studio-backend.json` stays a connection
 * of its own: one without a fingerprint. Every saved connection is in the
 * runtime set while it is saved (docs/design/multi-runtime.md §3.1).
 *
 * Electron-free. Tokens never leave Studio main.
 */

/** The environment remotes.ts reads, pointed at Studio's settings folder (the folder `adf` uses in a default install). */
export function remotesEnv(userDataDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ADF_DAEMON_SETTINGS: join(userDataDir, 'adf-settings.json') }
}

export function savedConnections(env: NodeJS.ProcessEnv): Record<string, SavedRemote> {
  return loadRemotes(env).remotes
}

/**
 * The saved connections as Studio main shows them (review item 9): read
 * with async IO on refresh only, never on a push. It refreshes when
 * cli-remotes.json changes on disk (adf wrote it; `watch`) and after Studio
 * writes it (the caller refreshes); `onChange` then pushes the list again.
 */
export class SavedConnectionsCache {
  private value: Record<string, SavedRemote> = {}
  /**
   * Why cli-remotes.json could not be read at the last refresh; null when it
   * was read (or is absent: nothing saved). While set, `get()` keeps the list
   * last read (empty at launch) and it is not "every saved connection":
   * nothing is dropped or reordered because of it.
   */
  unreadable: string | null = null
  /** The names of malformed entries at the last read (cli/remotes.ts keeps them on every write). */
  malformed: string[] = []
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly onChange?: () => void) {}

  /** The list as last read; no disk access. */
  get(): Record<string, SavedRemote> {
    return this.value
  }

  /** Every saved fingerprint (the "paired" marks of the discovery list). */
  fingerprints(): Set<string> {
    return new Set(Object.values(this.value).map((r) => r.fingerprint))
  }

  async refresh(): Promise<Record<string, SavedRemote>> {
    const read = await readRemotesAsync(this.env)
    if (read.unreadable) {
      const first = this.unreadable === null
      this.unreadable = read.unreadable
      if (first) this.onChange?.()
      return this.value
    }
    const next = read.file.remotes
    const changed = JSON.stringify(next) !== JSON.stringify(this.value) || this.unreadable !== null || JSON.stringify(read.malformed) !== JSON.stringify(this.malformed)
    this.unreadable = null
    this.malformed = read.malformed
    this.value = next
    if (changed) this.onChange?.()
    return next
  }

  /** Follow cli-remotes.json on disk (its folder: the file may not exist yet). */
  watch(): void {
    if (this.watcher) return
    const path = remotesFilePath(this.env)
    try {
      this.watcher = watch(dirname(path), (_event, file) => {
        if (file && String(file) !== basename(path)) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => { this.timer = null; void this.refresh().catch(() => {}) }, 100)
      })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null })
    } catch {
      this.watcher = null
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }
}

/**
 * Ends a connection attempt with a sentence the user can act on; never holds
 * a token. `rate_limited` (the host answered the hello 429) is waited out:
 * `retryAfterMs` says how long.
 */
export class ConnectionError extends Error {
  constructor(readonly code: 'not_configured' | 'transport' | 'no_token' | 'keychain' | 'pinned' | 'unreachable' | 'unreadable' | 'rate_limited', message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ConnectionError'
  }
}

export function keychainSentence(name: string): string {
  return `The OS keychain did not give the token for ${name}; allow ADF Studio to use it, or pair again.`
}

/**
 * A saved connection's URL and token, for the connector and for Connect.
 * The keychain is read off the main thread first (awaitKeychainAccess), so a
 * macOS access prompt can be answered while Studio stays responsive; `onSlow`
 * says so where the user looks. A refused or failed read is an error, never
 * a silent fallback.
 */
export async function savedConnectionTarget(config: Pick<StudioBackendConfig, 'insecureHttpOrigins'>, name: string, env: NodeJS.ProcessEnv, hooks: { log?: (line: string) => void; onSlow?: () => void } = {}): Promise<{ url: string; token: string; remote: SavedRemote }> {
  // An unreadable list is not "no saved connection" (R2A-3): the file is named, and the connector retries it.
  const read = await readRemotesAsync(env)
  if (read.unreadable) throw new ConnectionError('unreadable', `${name} cannot be read from ${remotesFilePath(env)}: ${read.unreadable}; fix or remove it.`)
  const remote = read.file.remotes[name]
  if (!remote) throw new ConnectionError('not_configured', `No saved connection named "${name}".`)
  const check = checkRemoteDaemonUrl(remote.url)
  if (!check.url) throw new ConnectionError('transport', `The address of ${name} is not valid: ${check.reason ?? remote.url}`)
  if (check.kind === 'insecure-http' && !(config.insecureHttpOrigins ?? []).includes(remoteUrlOrigin(check.url) ?? '')) {
    throw new ConnectionError('transport', `${check.url} is plain http to an address that is not loopback or a tailnet address; pair ${name} in Studio to confirm the network, or use https://.`)
  }
  await awaitKeychainAccess(env, { log: hooks.log ?? (() => {}), onSlow: hooks.onSlow ?? (() => {}) })
  let token: string | null
  try {
    token = readRemoteToken(remote.fingerprint, env)
  } catch {
    token = null
  }
  if (!token) throw new ConnectionError('keychain', keychainSentence(name))
  return { url: check.url, token, remote }
}

/** The sentence of a pinned address that answers as another computer: one sentence, the token not sent. */
export function pinMismatchSentence(name: string, url: string, shown: string | null, pinned: string): string {
  return `${url} is not ${name} (fingerprint ${shown ?? 'none'}, paired as ${pinned}); the token was not sent.`
}

/**
 * Before a saved token goes to `url` (trust on first use, as `adf`): the
 * daemon there MUST answer the authenticated hello (remote-access.md
 * §5.2.1) with the fingerprint saved when it was paired, AND prove it holds
 * this token's device record. An older ADF, which cannot prove it, is
 * refused, never downgraded. Throws with a sentence; the token is not sent.
 */
export async function checkPinnedFingerprint(name: string, remote: Pick<SavedRemote, 'fingerprint'>, url: string, token: string, fetchImpl?: typeof fetch): Promise<void> {
  const check = await verifyHello(url, token, { fetch: fetchImpl, timeoutMs: 5_000 })
  // Down, or remote access off there: the token is not sent; the connector retries a host that is down.
  if (check.kind === 'none') throw new ConnectionError('unreachable', `${url} does not answer as ${name}; the token was not sent.`)
  // Too many hellos from here: not down, not refused; waited out, and the token is not sent meanwhile.
  if (check.kind === 'rate_limited') throw new ConnectionError('rate_limited', rateLimitedSentence(name), check.retryAfterMs)
  if (check.kind !== 'not_device_token' && check.hello.fingerprint !== remote.fingerprint) {
    throw new ConnectionError('pinned', pinMismatchSentence(name, url, check.hello.fingerprint, remote.fingerprint))
  }
  const refusal = helloRefusal(check, name, url)
  if (refusal) throw new ConnectionError('pinned', refusal)
}

/**
 * The connection's pinCheck (DaemonConnection): PinMismatchError for another
 * computer, any other error while nothing answers (a 429 carries
 * `retryAfterMs`: the check waits that long before it asks again).
 */
export function pinCheckFor(name: string, fingerprint: string, url: string, token: string, fetchImpl?: typeof fetch): () => Promise<void> {
  return async () => {
    try {
      await checkPinnedFingerprint(name, { fingerprint }, url, token, fetchImpl)
    } catch (err) {
      if (err instanceof ConnectionError && err.code === 'pinned') throw new PinMismatchError(err.message)
      throw err
    }
  }
}

/**
 * Before an unpinned token of the remote slot goes to `url`: a device token
 * (`adfd_…`) is sent only after the daemon there proved, by the
 * authenticated hello (remote-access.md §5.2.1), that it issued it, as for a
 * saved connection; there is no fingerprint to compare. Any other token is
 * the user's own choice and is not checked. Throws as checkPinnedFingerprint.
 */
export async function checkSlotToken(name: string, url: string, token: string, fetchImpl?: typeof fetch): Promise<void> {
  const check = await verifyHello(url, token, { fetch: fetchImpl, timeoutMs: 5_000 })
  if (check.kind === 'not_device_token' || check.kind === 'verified') return
  if (check.kind === 'none') throw new ConnectionError('unreachable', `${url} does not answer as ${name}; the token was not sent.`)
  if (check.kind === 'rate_limited') throw new ConnectionError('rate_limited', rateLimitedSentence(name), check.retryAfterMs)
  throw new ConnectionError('pinned', helloRefusal(check, name, url) ?? `${url} could not prove it is ${name}; the token was not sent.`)
}

/** checkSlotToken as the connection's pinCheck (every re-dial asks it again). */
export function slotCheckFor(name: string, url: string, token: string, fetchImpl?: typeof fetch): () => Promise<void> {
  return async () => {
    try {
      await checkSlotToken(name, url, token, fetchImpl)
    } catch (err) {
      if (err instanceof ConnectionError && err.code === 'pinned') throw new PinMismatchError(err.message)
      throw err
    }
  }
}

export interface SaveConnectionInput {
  url: string
  token: string
  fingerprint: string
  /** The host's computer name (hello): the saved name comes from it, as `adf pair` does. */
  hostName: string
  deviceId: string
  label: string
}

/**
 * Save a paired or added connection to `cli-remotes.json` and its token to
 * the keychain (or the user-only file). A fingerprint already saved keeps
 * its name; a new one gets the name `adf pair` would give.
 */
export async function saveConnection(env: NodeJS.ProcessEnv, input: SaveConnectionInput, opts: { confirmFile?: (why: string) => Promise<boolean>; now?: Date } = {}): Promise<{ name: string; store: TokenStoreChoice }> {
  const now = opts.now ?? new Date()
  // R2A-1: an unreadable list refuses before the token is stored, so a token saved for this computer is never
  // replaced by one the list then does not take (the host's new device would be removed, revoking it).
  const read = await readRemotesAsync(env)
  if (read.unreadable) throw new RemotesUnreadableError(remotesFilePath(env), read.unreadable)
  // The keychain, or the user-only file only after the user chose it (KEYCHAIN_FILE_COPY).
  const store = await storeRemoteToken(input.fingerprint, input.token, env, opts.confirmFile)
  // Under the lock adf takes too (updateRemotes): neither loses the other's change.
  const name = await updateRemotes(env, (file, malformed) => {
    const same = Object.entries(file.remotes).find(([, r]) => r.fingerprint === input.fingerprint)
    // A malformed entry's name is taken too: the user fixes or forgets it.
    const name = same?.[0] ?? remoteNameFor(input.hostName, { ...malformed, ...file.remotes })
    // A token added by hand knows no device id or label: the pairing's stay.
    file.remotes[name] = {
      url: input.url,
      fingerprint: input.fingerprint,
      deviceId: input.deviceId || same?.[1].deviceId || '',
      label: input.label || same?.[1].label || '',
      pairedAt: now.toISOString(),
      hostName: input.hostName,
    }
    return name
  })
  return { name, store }
}

/**
 * The paired remote URL of studio-backend.json (a pairing saved before the
 * shared list) moves into cli-remotes.json and the keychain on its first use
 * (settings-scopes.md §9), so it is pinned like every saved connection. The
 * remote URL slot is then empty; an older Studio's remote mode names the saved
 * connection, for the migration (runtime-migration.ts). Keychain only: when
 * it does not take the token the slot stays, and its pin is still checked
 * (remote/connector.ts). A slot whose computer is already a saved connection
 * (slotTwin) only goes: that connection keeps its own token, and forgetting
 * it (`adf remotes forget`) leaves no slot to come back. Returns the saved
 * name, or null. Nothing moves while cli-remotes.json cannot be read.
 */
export async function migratePairedSlot(boot: Pick<BootBackend, 'config' | 'configPath' | 'writeBlocked'>, codec: SecretCodec, env: NodeJS.ProcessEnv, log: Pick<Console, 'log' | 'warn'> = console): Promise<string | null> {
  const slot = boot.config.remote
  if (boot.writeBlocked || !slot.url || !slot.paired) return null
  const read = await readRemotesAsync(env)
  if (read.unreadable) {
    log.warn(`[Connection] Kept the paired remote URL in studio-backend.json: ${read.unreadable}`)
    return null
  }
  let name = slotTwin(boot.config, read.file.remotes)
  const twin = name !== null
  // The twin's own token must be readable before the slot's goes (a twin without one would leave no token at all).
  if (name && !(await tokenReadable(env, slot.paired.fingerprint))) {
    log.warn(`[Connection] Kept the paired remote URL ${slot.url} of studio-backend.json: the token of the saved connection "${name}" (same computer) cannot be read from the OS keychain`)
    return null
  }
  if (!name) {
    const token = slot.token ? codec.decrypt(slot.token) : null
    if (!token) return null
    try {
      name = (await saveConnection(env, { url: slot.url, token, fingerprint: slot.paired.fingerprint, hostName: slot.paired.name, deviceId: slot.paired.deviceId, label: slot.paired.label })).name
    } catch (err) {
      log.warn(`[Connection] Kept the paired remote URL in studio-backend.json: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  const origin = remoteUrlOrigin(slot.url)
  const next: StudioBackendConfig = {
    ...boot.config,
    remote: { url: null, token: null, allowInsecureHttp: false, ...(boot.config.mode === 'remote' && !slot.name ? { name } : slot.name ? { name: slot.name } : {}) },
    ...(slot.allowInsecureHttp && origin ? { insecureHttpOrigins: [...new Set([...(boot.config.insecureHttpOrigins ?? []), origin])] } : {}),
  }
  await writeJsonAtomicAsync(boot.configPath, next)
  boot.config = next
  log.log(twin
    ? `[Connection] Removed the paired remote URL ${slot.url} of studio-backend.json: it is the saved connection "${name}" (${slot.paired.fingerprint}), which keeps its own token`
    : `[Connection] Moved the paired remote URL ${slot.url} to the saved connection "${name}" (pinned to ${slot.paired.fingerprint})`)
  return name
}

/** Whether the saved token of `fingerprint` can be read (the keychain read off the main thread first). */
async function tokenReadable(env: NodeJS.ProcessEnv, fingerprint: string): Promise<boolean> {
  await awaitKeychainAccess(env, { log: () => {}, onSlow: () => {} })
  try {
    return !!readRemoteToken(fingerprint, env)
  } catch {
    return false
  }
}

/**
 * The saved connection the remote slot of studio-backend.json is (paired
 * with its fingerprint; runtimeSlot hides the slot behind it), or null.
 */
export function slotTwin(config: Pick<StudioBackendConfig, 'remote'>, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): string | null {
  const fp = config.remote.url ? config.remote.paired?.fingerprint : undefined
  return fp ? Object.entries(saved).find(([, r]) => r.fingerprint === fp)?.[0] ?? null : null
}

/**
 * While Studio runs, cli-remotes.json gained the computer of the remote slot
 * (`adf pair`, Studio's Add): the slot goes, URL and token, as at launch
 * (migratePairedSlot). The saved connection was already the runtime; later
 * `adf remotes forget` of it then forgets the computer, as Studio's Remove
 * does. Returns the connection's name, or null (no twin, or the save failed:
 * said in the log).
 */
export async function clearTwinSlot(store: Pick<BackendSettingsStore, 'config' | 'set'>, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>, env: NodeJS.ProcessEnv, log: Pick<Console, 'log' | 'warn'> = console): Promise<string | null> {
  const name = slotTwin(store.config(), saved)
  if (!name) return null
  const url = store.config().remote.url
  // The twin's own token must be readable before the slot's goes (a twin without one would leave no token at all).
  if (!(await tokenReadable(env, saved[name].fingerprint))) {
    log.warn(`[Connection] Kept the remote URL ${url} of studio-backend.json beside the saved connection "${name}" (same computer): its token cannot be read from the OS keychain`)
    return null
  }
  const result = await store.set({ remoteUrl: null })
  if (!result.ok) {
    log.warn(`[Connection] Kept the remote URL ${url} of studio-backend.json beside the saved connection "${name}" (same computer): ${result.error}`)
    return null
  }
  log.log(`[Connection] Removed the remote URL ${url} of studio-backend.json: it is the saved connection "${name}" (same fingerprint), which keeps its own token`)
  return name
}

/** Forget a saved connection and its token, as `adf remotes forget` does (forgetRemote). The host still lists the device. */
export async function forgetConnection(env: NodeJS.ProcessEnv, name: string): Promise<boolean> {
  const forgot = await forgetRemote(env, name)
  if (!forgot) return false
  if (forgot.tokenError) throw new Error(`${name} was removed, but its token could not be: ${forgot.tokenError}`)
  return true
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return null }
}

/** The name of the remote slot of studio-backend.json: the paired computer's, else the address's host. */
export function slotName(remote: Pick<StudioBackendConfig['remote'], 'url' | 'paired'>): string {
  return remote.paired?.name ?? hostOf(remote.url) ?? 'Remote computer'
}

/**
 * The remote slot of studio-backend.json as a runtime of the set
 * (multi-runtime.md §3.1): while it holds a URL, unless it was paired with a
 * computer that is also a saved connection (that connection is the runtime;
 * the Connection page shows one row for both).
 */
export function runtimeSlot(config: Pick<StudioBackendConfig, 'remote'>, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): { name: string; url: string } | null {
  const url = config.remote.url
  if (!url) return null
  const fp = config.remote.paired?.fingerprint
  if (fp && Object.values(saved).some((r) => r.fingerprint === fp)) return null
  return { name: slotName(config.remote), url }
}

function encryptedUrl(url: string | null): boolean {
  if (!url) return false
  const kind = checkRemoteDaemonUrl(url).kind
  return kind === 'tailnet' || kind === 'https' || kind === 'loopback'
}

export const LINK_STATE: Record<BackendDaemonStatus['connection'], ConnectionCurrent['state']> = {
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'retrying',
  failed: 'not-connected',
}

export interface ConnectionsViewInput {
  /** The mode this launch runs. */
  active: { mode: StudioRunMode }
  /** What studio-backend.json holds now (the next launch). */
  configured: StudioBackendConfig
  daemon: BackendDaemonStatus | null
  saved: Record<string, SavedRemote>
  discovery: RemoteDiscoveryUpdate | null
  /**
   * This computer's launch: the state of each runtime of the set, by id
   * (multi-runtime.md §6.5). A saved connection not in it yet is connecting.
   * Absent (Inside Studio): the runtime set is not loaded, and saved
   * connections are listed with no state (§7.2).
   */
  runtimeStates?: Record<string, ConnectionCurrent['state']>
}

/** The connection this launch uses (settings-scopes.md §4.1, §5.4): This computer, or Inside Studio. */
export function currentConnection(input: Pick<ConnectionsViewInput, 'active' | 'daemon'>): ConnectionCurrent {
  if (input.active.mode === 'embedded') return { id: 'embedded', kind: 'embedded', name: 'Inside Studio', url: null, state: 'connected' }
  return { id: 'local', kind: 'local', name: 'This computer', url: null, state: input.daemon ? LINK_STATE[input.daemon.connection] : 'connecting' }
}

/**
 * The Connection page's rows (multi-runtime.md §6.5): This computer; Inside
 * Studio while it runs or is saved; each saved connection, with its state
 * and Remove; each computer found whose fingerprint is not saved, with Add.
 * A found computer whose fingerprint is saved is that saved row (never a
 * second row).
 */
export function buildConnectionsView(input: ConnectionsViewInput): ConnectionsView {
  const current = currentConnection(input)
  const configuredId = runMode(input.configured.mode)
  const inUse = (id: string) => current.id === id
  const plain = (id: string, kind: 'local' | 'embedded', name: string): ConnectionRow => ({
    id, kind, name,
    state: inUse(id) ? current.state : null,
    // Saved for the next launch (§7.2).
    action: inUse(id) ? null : 'connect',
    url: null, address: null, fingerprint: null, encrypted: true, pairingOpen: false, removable: false,
  })
  const rows: ConnectionRow[] = [plain('local', 'local', 'This computer')]
  if (current.kind === 'embedded' || configuredId === 'embedded') rows.push(plain('embedded', 'embedded', 'Inside Studio (legacy)'))

  const saved: ConnectionRow[] = []
  const states = input.runtimeStates
  const savedRow = (id: string, name: string, url: string | null, fingerprint: string | null): ConnectionRow => ({
    id, kind: 'saved', name,
    // Saving connects (§12 item 2): a saved connection not in the set yet is connecting. Inside Studio: no state.
    state: states ? states[id] ?? 'connecting' : null,
    action: null,
    url, address: hostOf(url), fingerprint, encrypted: encryptedUrl(url), pairingOpen: false,
    removable: true,
  })
  // The remote URL of studio-backend.json: one row, unless its paired fingerprint is a saved connection (runtimeSlot).
  const slot = runtimeSlot(input.configured, input.saved)
  // In the runtime set's order (§3.1): the order added, as the status bar and the Settings picker.
  for (const id of runtimeOrder(input.configured.runtimeOrder ?? [], input.saved, slot)) {
    if (id === SLOT_RUNTIME && slot) { saved.push(savedRow(SLOT_RUNTIME, slot.name, slot.url, input.configured.remote.paired?.fingerprint ?? null)); continue }
    const name = id.slice('remote:'.length)
    const remote = input.saved[name]
    if (remote) saved.push(savedRow(id, name, remote.url, remote.fingerprint))
  }

  const found: ConnectionRow[] = []
  for (const entry of input.discovery?.entries ?? []) {
    const match = saved.find((r) => r.fingerprint === entry.fingerprint)
    if (match) {
      match.pairingOpen = match.pairingOpen || entry.pairingOpen
      continue
    }
    found.push({
      id: `found:${entry.fingerprint}@${entry.url}`, kind: 'found', name: entry.name,
      state: 'not-paired', action: 'pair',
      url: entry.url, address: entry.address, fingerprint: entry.fingerprint, encrypted: entry.encrypted,
      pairingOpen: entry.pairingOpen, removable: false,
    })
  }
  return {
    current,
    next: configuredId !== current.id ? { id: configuredId, name: configuredId === 'local' ? 'This computer' : 'Inside Studio (legacy)' } : null,
    rows: [...rows, ...saved, ...found],
    discovery: input.discovery ? { browsing: input.discovery.browsing, problem: input.discovery.problem } : null,
  }
}
