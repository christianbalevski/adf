import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, StudioBackendMode } from '../../shared/types/backend.types'
import type { ConnectionCurrent, ConnectionRow, ConnectionsView } from '../../shared/types/connection.types'
import type { RemoteDiscoveryUpdate } from '../../shared/types/remote-access-ipc.types'
import { deleteRemoteToken, loadRemotes, loadRemotesAsync, readRemoteToken, remoteNameFor, remotesFilePath, storeRemoteToken, updateRemotes, type SavedRemote, type TokenStoreChoice } from '../cli/remotes'
import { awaitKeychainAccess } from './daemon-secrets'
import { PairingClient } from './remote-access/client'
import type { BootBackend, SecretCodec, StudioBackendConfig } from './backend-config'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { PinMismatchError } from './daemon-mode/connection'

/**
 * Saved connections (docs/design/settings-scopes.md §5.2): one list for
 * Studio, `adf` and the terminal app. The list is `cli-remotes.json` next to
 * the settings file Studio's daemon uses; tokens are in the OS keychain
 * (`ADF` / `remote-token:<fingerprint>`), else the user-only
 * `cli-remote-tokens.json` (src/main/cli/remotes.ts). Studio adds no field
 * to that file. The remote URL of `studio-backend.json` stays a connection
 * of its own: one without a fingerprint.
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
    const next = (await loadRemotesAsync(this.env)).remotes
    const changed = JSON.stringify(next) !== JSON.stringify(this.value)
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

/** Ends a connection attempt with a sentence the user can act on; never holds a token. */
export class ConnectionError extends Error {
  constructor(readonly code: 'not_configured' | 'transport' | 'no_token' | 'keychain' | 'pinned' | 'unreachable', message: string) {
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
  const remote = (await loadRemotesAsync(env)).remotes[name]
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
 * daemon there MUST answer /remote/hello with the fingerprint saved when it
 * was paired. Throws with a sentence; the token is not sent.
 */
export async function checkPinnedFingerprint(name: string, remote: Pick<SavedRemote, 'fingerprint'>, url: string, fetchImpl?: typeof fetch): Promise<void> {
  let fingerprint: string | null = null
  try {
    const hello = await new PairingClient(url, fetchImpl).hello({ timeoutMs: 5_000 })
    fingerprint = typeof hello?.fingerprint === 'string' ? hello.fingerprint : null
  } catch {
    // Down, or remote access off there: the token is not sent; the connector retries a host that is down.
    throw new ConnectionError('unreachable', `${url} does not answer as ${name}; the token was not sent.`)
  }
  if (fingerprint !== remote.fingerprint) {
    throw new ConnectionError('pinned', pinMismatchSentence(name, url, fingerprint, remote.fingerprint))
  }
}

/** The connection's pinCheck (DaemonConnection): PinMismatchError for another computer, any other error while nothing answers. */
export function pinCheckFor(name: string, fingerprint: string, url: string, fetchImpl?: typeof fetch): () => Promise<void> {
  return async () => {
    try {
      await checkPinnedFingerprint(name, { fingerprint }, url, fetchImpl)
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
  // The keychain, or the user-only file only after the user chose it (KEYCHAIN_FILE_COPY).
  const store = await storeRemoteToken(input.fingerprint, input.token, env, opts.confirmFile)
  // Under the lock adf takes too (updateRemotes): neither loses the other's change.
  const name = await updateRemotes(env, (file) => {
    const same = Object.entries(file.remotes).find(([, r]) => r.fingerprint === input.fingerprint)
    const name = same?.[0] ?? remoteNameFor(input.hostName, file.remotes)
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
 * remote URL slot is then empty; remote mode uses the saved name. Keychain
 * only: when it does not take the token the slot stays, and its pin is
 * still checked (remote/connector.ts). Returns the saved name, or null.
 */
export async function migratePairedSlot(boot: Pick<BootBackend, 'config' | 'configPath' | 'writeBlocked'>, codec: SecretCodec, env: NodeJS.ProcessEnv, log: Pick<Console, 'log' | 'warn'> = console): Promise<string | null> {
  const slot = boot.config.remote
  if (boot.writeBlocked || !slot.url || !slot.token || !slot.paired) return null
  const token = codec.decrypt(slot.token)
  if (!token) return null
  let name: string
  try {
    name = (await saveConnection(env, { url: slot.url, token, fingerprint: slot.paired.fingerprint, hostName: slot.paired.name, deviceId: slot.paired.deviceId, label: slot.paired.label })).name
  } catch (err) {
    log.warn(`[Connection] Kept the paired remote URL in studio-backend.json: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  const origin = remoteUrlOrigin(slot.url)
  const next: StudioBackendConfig = {
    ...boot.config,
    remote: { url: null, token: null, allowInsecureHttp: false, ...(boot.config.mode === 'remote' && !slot.name ? { name } : slot.name ? { name: slot.name } : {}) },
    ...(slot.allowInsecureHttp && origin ? { insecureHttpOrigins: [...new Set([...(boot.config.insecureHttpOrigins ?? []), origin])] } : {}),
  }
  await writeJsonAtomicAsync(boot.configPath, next)
  boot.config = next
  log.log(`[Connection] Moved the paired remote URL ${slot.url} to the saved connection "${name}" (pinned to ${slot.paired.fingerprint})`)
  return name
}

/** Forget a saved connection and its token (`adf remotes forget`). The host still lists the device. */
export async function forgetConnection(env: NodeJS.ProcessEnv, name: string): Promise<boolean> {
  const removed = await updateRemotes(env, (file) => {
    const remote = file.remotes[name]
    if (!remote) return null
    delete file.remotes[name]
    if (file.default === name) file.default = null
    // Another name may hold the same computer; its token stays.
    return { remote, shared: Object.values(file.remotes).some((r) => r.fingerprint === remote.fingerprint) }
  })
  if (!removed) return false
  if (!removed.shared) deleteRemoteToken(removed.remote.fingerprint, env)
  return true
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return null }
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
  /** The mode this launch runs, and its saved connection (remote). */
  active: { mode: StudioBackendMode; remoteName: string | null; config: StudioBackendConfig }
  /** What studio-backend.json holds now (the next launch). */
  configured: StudioBackendConfig
  daemon: BackendDaemonStatus | null
  saved: Record<string, SavedRemote>
  discovery: RemoteDiscoveryUpdate | null
}

/** The connection this launch uses (settings-scopes.md §4.1, §5.4). */
export function currentConnection(input: Pick<ConnectionsViewInput, 'active' | 'daemon' | 'saved'>): ConnectionCurrent {
  const { mode, remoteName, config } = input.active
  if (mode === 'embedded') return { id: 'embedded', kind: 'embedded', name: 'Inside Studio', url: null, state: 'connected' }
  const state = input.daemon ? LINK_STATE[input.daemon.connection] : 'connecting'
  if (mode === 'local') return { id: 'local', kind: 'local', name: 'This computer', url: null, state }
  if (remoteName) return { id: `remote:${remoteName}`, kind: 'remote', name: remoteName, url: input.saved[remoteName]?.url ?? input.daemon?.url ?? null, state }
  const url = config.remote.url
  return { id: 'remote', kind: 'remote', name: config.remote.paired?.name ?? hostOf(url) ?? 'Remote computer', url, state }
}

/**
 * The Connection page's rows (settings-scopes.md §5.1): This computer;
 * Inside Studio while it runs or is saved; each saved connection; each
 * computer found whose fingerprint is not saved. A found computer whose
 * fingerprint is saved is that saved row (never a second row), so a Paired
 * row never offers Pair.
 */
export function buildConnectionsView(input: ConnectionsViewInput): ConnectionsView {
  const current = currentConnection(input)
  const configuredId = input.configured.mode === 'remote' ? (input.configured.remote.name ? `remote:${input.configured.remote.name}` : 'remote') : input.configured.mode
  const inUse = (id: string) => current.id === id
  const plain = (id: string, kind: 'local' | 'embedded', name: string): ConnectionRow => ({
    id, kind, name,
    state: inUse(id) ? current.state : null,
    action: inUse(id) ? null : 'connect',
    url: null, address: null, fingerprint: null, encrypted: true, pairingOpen: false, removable: false,
  })
  const rows: ConnectionRow[] = [plain('local', 'local', 'This computer')]
  if (current.kind === 'embedded' || input.configured.mode === 'embedded') rows.push(plain('embedded', 'embedded', 'Inside Studio (legacy)'))

  const saved: ConnectionRow[] = []
  const savedRow = (id: string, name: string, url: string | null, fingerprint: string | null): ConnectionRow => ({
    id, kind: 'saved', name,
    state: inUse(id) ? current.state : 'paired',
    action: inUse(id) ? null : 'connect',
    url, address: hostOf(url), fingerprint, encrypted: encryptedUrl(url), pairingOpen: false,
    // The one in use too (e.g. it no longer connects): Remove switches to This computer first.
    removable: true,
  })
  for (const name of Object.keys(input.saved).sort((a, b) => a.localeCompare(b))) {
    const remote = input.saved[name]
    saved.push(savedRow(`remote:${name}`, name, remote.url, remote.fingerprint))
  }
  // The remote URL of studio-backend.json: one row, unless its paired fingerprint is a saved connection not in use.
  const slot = input.configured.remote.url ? input.configured.remote : input.active.mode === 'remote' && !input.active.remoteName ? input.active.config.remote : null
  if (slot?.url) {
    const fp = slot.paired?.fingerprint ?? null
    const twin = fp ? saved.find((r) => r.fingerprint === fp) : undefined
    const row = savedRow('remote', slot.paired?.name ?? hostOf(slot.url) ?? 'Remote computer', slot.url, fp)
    if (!twin) saved.push(row)
    else if (inUse('remote')) saved.splice(saved.indexOf(twin), 1, row)
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
  const configuredName = configuredId === 'local' ? 'This computer'
    : configuredId === 'embedded' ? 'Inside Studio'
    : input.configured.remote.name ?? input.configured.remote.paired?.name ?? hostOf(input.configured.remote.url) ?? 'Remote computer'
  return {
    current,
    next: configuredId !== current.id ? { id: configuredId, name: configuredName } : null,
    rows: [...rows, ...saved, ...found],
    discovery: input.discovery ? { browsing: input.discovery.browsing, problem: input.discovery.problem } : null,
  }
}
