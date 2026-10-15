/**
 * Concrete token stores for Phase 4 HTTP OAuth (docs/design/mcp-http-oauth.md,
 * decision #1 — HYBRID storage).
 *
 * Two backings implement the shared `McpOAuthStore` contract
 * (mcp-oauth.types.ts):
 *
 *  - `AppSettingsOAuthStore` — the Studio "signed-in" source of truth. Every
 *    server's record lives in ONE safeStorage-encrypted settings secret,
 *    `mcpOauthCredentials`, shaped `Record<serverUrl, McpOAuthRecord>`.
 *  - `AgentKeystoreOAuthStore` — the per-agent sealed copy. One
 *    envelope-sealed row per server in `adf_identity` under
 *    `mcp:<serverName>:oauth`, so the grant travels with the `.adf` and a
 *    daemon with a provisioned runtime key can connect + refresh.
 *
 * `captureOAuthToAgent` is the hybrid glue: on attach, the Settings-level
 * record is copied and sealed into the agent keystore (mirrors
 * captureCredentialFile in mcp-credential-files.ts).
 *
 * Security invariants (design doc): sealed at rest on BOTH backings — never
 * plaintext in `mcpServers` / `adf-settings.json` / the `.adf` config; the
 * blob joins the getAll()/http-api redaction rails; no token value is logged.
 *
 * Electron-free: the app store receives a SettingsService, the agent store an
 * AdfWorkspace-shaped handle — both injected, so this module is usable from
 * Studio, the daemon builder, and tests.
 */
import { createHash, randomBytes } from 'crypto'
import type {
  McpOAuthStore,
  McpOAuthRecord,
  McpOAuthInvalidateScope,
} from './mcp-oauth.types'
import { canonicalizeServerUrl } from './mcp-oauth.types'

/**
 * URL-binding guard shared by both stores' `get`. A record stamped with a
 * `serverUrl` may only be returned for the endpoint it was minted for — a
 * mismatch throws a fail-plainly error rather than handing a live token to a
 * different origin (a tampered `.adf` that swaps a server's URL while keeping
 * its name, per the store-keyed-by-name daemon gap). Legacy records with no
 * stored `serverUrl` are returned for back-compat, with a warning; every new
 * write stamps it. Never logs a token value.
 */
function assertRecordUrlBinding(record: McpOAuthRecord, requestedUrl: string, context: string): void {
  if (!record.serverUrl) {
    console.warn(
      `[MCP][oauth] ${context}: stored token has no pinned serverUrl (legacy record) — returning without URL-binding check`,
    )
    return
  }
  const pinned = canonicalizeServerUrl(record.serverUrl)
  const requested = canonicalizeServerUrl(requestedUrl)
  if (pinned !== requested) {
    throw new Error(
      `sealed OAuth token was minted for ${pinned}, not ${requested}; ` +
      'refusing to send credentials to a different endpoint',
    )
  }
}

/** The single safeStorage secret key holding every server's OAuth record. */
export const MCP_OAUTH_SETTINGS_KEY = 'mcpOauthCredentials'

/** Blob shape stored under MCP_OAUTH_SETTINGS_KEY. */
type OAuthBlob = Record<string, McpOAuthRecord>

/** A record with no surviving material is dropped from the blob/keystore. */
function isEmptyRecord(record: McpOAuthRecord): boolean {
  return !record.tokens && !record.clientInformation && !record.discoveryState
}

/**
 * Apply an invalidate scope to a record IN PLACE. Returns the record, or
 * undefined when nothing meaningful is left (caller drops it).
 * - 'all'    → nothing survives.
 * - 'tokens' → drop the access/refresh tokens; keep DCR client + discovery.
 * - 'client' → drop the DCR client registration (forces re-registration +
 *              re-consent) AND the tokens minted for it; keep discovery.
 */
function applyInvalidateScope(
  record: McpOAuthRecord,
  scope: McpOAuthInvalidateScope,
): McpOAuthRecord | undefined {
  if (scope === 'all') return undefined
  const next: McpOAuthRecord = { ...record, updatedAt: Date.now() }
  if (scope === 'tokens') {
    delete next.tokens
  } else if (scope === 'client') {
    delete next.clientInformation
    delete next.tokens
  }
  return isEmptyRecord(next) ? undefined : next
}

/** Structural slice of SettingsService the app store depends on. */
export interface OAuthSettingsHandle {
  getSecret(key: string): string | null
  setSecret(key: string, value: string): void
  delete(key: string): void
  isSafeStorageAvailable(): boolean
}

/**
 * App-level (Studio) store. The sign-in source of truth: one safeStorage
 * secret holds every server's record. Reads parse the blob; writes merge one
 * URL's record and rewrite the whole blob.
 */
export class AppSettingsOAuthStore implements McpOAuthStore {
  constructor(private readonly settings: OAuthSettingsHandle) {}

  private readBlob(): OAuthBlob {
    const raw = this.settings.getSecret(MCP_OAUTH_SETTINGS_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as OAuthBlob) : {}
    } catch {
      // A corrupt/undecryptable blob is treated as empty rather than crashing
      // connect — the user re-signs in. Never logs the value.
      return {}
    }
  }

  private writeBlob(blob: OAuthBlob): void {
    // Guard BEFORE writing: SettingsService.setSecret falls back to PLAINTEXT
    // when safeStorage is unavailable, which would strand OAuth tokens on disk
    // in the clear. Fail plainly instead.
    if (!this.settings.isSafeStorageAvailable()) {
      throw new Error(
        'Cannot store MCP OAuth tokens — OS secure storage (safeStorage) is unavailable on this system, ' +
        'and these tokens must never be written unencrypted. Enable the OS keychain/credential store and retry.',
      )
    }
    if (Object.keys(blob).length === 0) {
      this.settings.delete(MCP_OAUTH_SETTINGS_KEY)
      return
    }
    this.settings.setSecret(MCP_OAUTH_SETTINGS_KEY, JSON.stringify(blob))
  }

  async get(serverUrl: string): Promise<McpOAuthRecord | undefined> {
    const record = this.readBlob()[serverUrl]
    if (record) assertRecordUrlBinding(record, serverUrl, 'AppSettingsOAuthStore.get')
    return record
  }

  async save(serverUrl: string, record: McpOAuthRecord): Promise<void> {
    const blob = this.readBlob()
    blob[serverUrl] = { ...record, updatedAt: record.updatedAt || Date.now() }
    this.writeBlob(blob)
  }

  async invalidate(serverUrl: string, scope: McpOAuthInvalidateScope = 'all'): Promise<void> {
    const blob = this.readBlob()
    const existing = blob[serverUrl]
    if (!existing) return
    const next = applyInvalidateScope(existing, scope)
    if (next) blob[serverUrl] = next
    else delete blob[serverUrl]
    this.writeBlob(blob)
  }
}

/**
 * Structural slice of the daemon secret backend (owner-secret-store.ts
 * SecretBackend: the OS keychain, or the owner's passphrase-encrypted file).
 */
export interface OAuthSecretBackendHandle {
  isUnlocked(): boolean
  get(account: string): string | null
  set(account: string, value: string): void
  delete(account: string): void
}

/**
 * Daemon secret-backend accounts for the app-level MCP OAuth records of one
 * settings file (`scope` = settingsScope(settingsPath)):
 *
 *  - index  `mcp-oauth-credentials:<scope>`: `{"v":1,"servers":[<serverUrl>…]}`
 *  - record `mcp-oauth-credentials:<scope>:<serverKey>`: one McpOAuthRecord as
 *    JSON, `serverKey` = first 16 hex of sha256(serverUrl) (the exact blob key)
 *
 * Every value is chunked (`chunkedSecret*`): Windows Credential Manager caps a
 * credential at 2560 bytes (1280 UTF-16 characters), less than one access +
 * refresh JWT pair. Handover mapping (design daemon-backend.md §11): Studio's
 * `mcpOauthCredentials` blob `Record<serverUrl, McpOAuthRecord>` is
 * `exportBlob()` / `importBlob()`, one record per blob key, verbatim.
 */
export function daemonAppOAuthAccount(scope: string): string {
  return `mcp-oauth-credentials:${scope}`
}

/** Record account for one server URL under `indexAccount`. */
export function daemonAppOAuthRecordAccount(indexAccount: string, serverUrl: string): string {
  return `${indexAccount}:${createHash('sha256').update(serverUrl).digest('hex').slice(0, 16)}`
}

/** Characters per keychain value; under the Windows 1280-character cap with room for the account metadata. */
export const SECRET_CHUNK_CHARS = 1000
/** Most chunks one value may have (a head with more is not a generation `isGeneration` accepts). */
export const MAX_SECRET_CHUNKS = 999

/**
 * Chunked secret value with generations. The head account holds
 * `{"v":1,"gen":<hex>,"n":<chunks>,"sha256":<hex of the value>}`; chunk i of
 * a generation is at `<account>#<gen>:<i>`. A write stores a new generation,
 * then flips the head to it, then deletes the old generation, so a crash at
 * any point leaves the head on one complete generation (old or new), never a
 * mix of both (an access token of one write with the refresh token of
 * another). A head whose chunks do not hash to `sha256` reads as absent.
 *
 * Chunks a crash left behind are listed in the head (`pending` before the
 * flip, `prev` after it) and deleted by the next write. Chunks end on code
 * point boundaries, never inside a surrogate pair.
 */
interface ChunkHead {
  v: 1
  gen?: string
  n?: number
  sha256?: string
  /** A generation being written (crash before the flip leaves it orphaned). */
  pending?: { gen: string; n: number }
  /** The generation the last flip replaced (crash before its deletion leaves it orphaned). */
  prev?: { gen: string; n: number }
}

function readHead(backend: OAuthSecretBackendHandle, account: string): ChunkHead | null {
  const raw = backend.get(account)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ChunkHead
    return parsed && parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

function isGeneration(g: unknown): g is { gen: string; n: number } {
  const value = g as { gen?: unknown; n?: unknown } | undefined
  return !!value && typeof value.gen === 'string' && /^[0-9a-f]{1,32}$/.test(value.gen) &&
    typeof value.n === 'number' && Number.isInteger(value.n) && value.n > 0 && value.n <= MAX_SECRET_CHUNKS
}

function deleteGeneration(backend: OAuthSecretBackendHandle, account: string, g: { gen: string; n: number }): void {
  for (let i = 0; i < g.n; i++) backend.delete(`${account}#${g.gen}:${i}`)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Split into chunks of at most `size` UTF-16 units, never between the halves of a surrogate pair. */
export function splitOnCodePoints(value: string, size: number = SECRET_CHUNK_CHARS): string[] {
  // A chunk must hold a whole surrogate pair, or a high surrogate would never advance.
  if (!Number.isInteger(size) || size < 2) throw new RangeError(`chunk size must be an integer of at least 2, not ${size}`)
  const chunks: string[] = []
  let start = 0
  while (start < value.length) {
    let end = Math.min(start + size, value.length)
    const last = value.charCodeAt(end - 1)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    chunks.push(value.slice(start, end))
    start = end
  }
  return chunks.length > 0 ? chunks : ['']
}

export function chunkedSecretWrite(backend: OAuthSecretBackendHandle, account: string, value: string): void {
  const head = readHead(backend, account)
  // Leftovers of an earlier crash (never referenced by a live head).
  for (const leftover of [head?.pending, head?.prev]) if (isGeneration(leftover)) deleteGeneration(backend, account, leftover)
  const current = head && isGeneration(head) ? { gen: head.gen!, n: head.n! } : null
  const chunks = splitOnCodePoints(value)
  // Checked before anything is written: a head with more chunks would read as absent.
  if (chunks.length > MAX_SECRET_CHUNKS) {
    throw new Error(`Secret ${account} is too large for the secret store (${chunks.length} chunks of ${SECRET_CHUNK_CHARS} characters; at most ${MAX_SECRET_CHUNKS})`)
  }
  const next = { gen: randomBytes(8).toString('hex'), n: chunks.length }
  const live: ChunkHead = current ? { v: 1, gen: current.gen, n: current.n, sha256: head!.sha256 } : { v: 1 }
  backend.set(account, JSON.stringify({ ...live, pending: next }))
  chunks.forEach((chunk, i) => backend.set(`${account}#${next.gen}:${i}`, chunk))
  backend.set(account, JSON.stringify({ v: 1, gen: next.gen, n: next.n, sha256: sha256Hex(value), ...(current ? { prev: current } : {}) }))
  if (current) {
    deleteGeneration(backend, account, current)
    backend.set(account, JSON.stringify({ v: 1, gen: next.gen, n: next.n, sha256: sha256Hex(value) }))
  }
}

/** The whole value, or null when absent, incomplete or not matching its checksum. */
export function chunkedSecretRead(backend: OAuthSecretBackendHandle, account: string): string | null {
  const head = readHead(backend, account)
  if (!head || !isGeneration(head) || typeof head.sha256 !== 'string') return null
  const parts: string[] = []
  for (let i = 0; i < head.n!; i++) {
    const part = backend.get(`${account}#${head.gen}:${i}`)
    if (part === null) return null
    parts.push(part)
  }
  const value = parts.join('')
  if (sha256Hex(value) !== head.sha256) {
    console.warn(`[MCP][oauth] Secret ${account} does not match its checksum; treating it as absent`)
    return null
  }
  return value
}

/**
 * Chunks first, head last: a crash in between leaves a head whose chunks are
 * gone (it reads as absent, and the next write or delete finds every
 * generation through it), never chunks no head lists.
 */
export function chunkedSecretDelete(backend: OAuthSecretBackendHandle, account: string): void {
  const head = readHead(backend, account)
  if (head) {
    for (const g of [isGeneration(head) ? { gen: head.gen!, n: head.n! } : null, head.pending, head.prev]) {
      if (isGeneration(g)) deleteGeneration(backend, account, g)
    }
  }
  backend.delete(account)
}

/**
 * App-level (daemon) store: the daemon's counterpart of AppSettingsOAuthStore,
 * on the daemon secret backend instead of safeStorage. Same records, same URL
 * binding; one chunked account per server (see daemonAppOAuthAccount). Reads
 * return nothing while the backend is locked; writes fail plainly then
 * (FileSecretBackend.set throws), so a token is never stored anywhere
 * unencrypted.
 */
export class DaemonAppOAuthStore implements McpOAuthStore {
  constructor(
    private readonly backend: OAuthSecretBackendHandle,
    private readonly account: string,
  ) {}

  /** False while the secret backend is locked (passphrase file not unlocked). */
  available(): boolean {
    return this.backend.isUnlocked()
  }

  private readJson(account: string): unknown {
    if (!this.backend.isUnlocked()) return null
    let raw: string | null
    try {
      raw = chunkedSecretRead(this.backend, account)
    } catch (err) {
      // Keychain read failure: same contract as a corrupt record (re-sign in).
      // The message comes from the keychain binding, never from the value.
      console.warn(`[MCP][oauth] DaemonAppOAuthStore: secret store read failed (${err instanceof Error ? err.message : String(err)})`)
      return null
    }
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  /** Every server URL with a stored record (metadata only, for status listings). */
  listServerUrls(): string[] {
    const index = this.readJson(this.account) as { v?: unknown; servers?: unknown } | null
    return index?.v === 1 && Array.isArray(index.servers) ? index.servers.filter((s): s is string => typeof s === 'string') : []
  }

  private writeIndex(servers: string[]): void {
    if (servers.length === 0) chunkedSecretDelete(this.backend, this.account)
    else chunkedSecretWrite(this.backend, this.account, JSON.stringify({ v: 1, servers }))
  }

  private readRecord(serverUrl: string): McpOAuthRecord | undefined {
    const record = this.readJson(daemonAppOAuthRecordAccount(this.account, serverUrl))
    return record && typeof record === 'object' && !Array.isArray(record) ? record as McpOAuthRecord : undefined
  }

  private writeRecord(serverUrl: string, record: McpOAuthRecord | undefined): void {
    const servers = this.listServerUrls()
    if (record) {
      chunkedSecretWrite(this.backend, daemonAppOAuthRecordAccount(this.account, serverUrl), JSON.stringify(record))
      if (!servers.includes(serverUrl)) this.writeIndex([...servers, serverUrl])
    } else {
      chunkedSecretDelete(this.backend, daemonAppOAuthRecordAccount(this.account, serverUrl))
      if (servers.includes(serverUrl)) this.writeIndex(servers.filter((s) => s !== serverUrl))
    }
  }

  async get(serverUrl: string): Promise<McpOAuthRecord | undefined> {
    const record = this.readRecord(serverUrl)
    if (record) assertRecordUrlBinding(record, serverUrl, 'DaemonAppOAuthStore.get')
    return record
  }

  async save(serverUrl: string, record: McpOAuthRecord): Promise<void> {
    this.writeRecord(serverUrl, { ...record, updatedAt: record.updatedAt || Date.now() })
  }

  async invalidate(serverUrl: string, scope: McpOAuthInvalidateScope = 'all'): Promise<void> {
    const existing = this.readRecord(serverUrl)
    if (!existing) return
    this.writeRecord(serverUrl, applyInvalidateScope(existing, scope))
  }

  /** Every record as Studio's `mcpOauthCredentials` blob (handover to embedded mode). */
  exportBlob(): OAuthBlob {
    const blob: OAuthBlob = {}
    for (const url of this.listServerUrls()) {
      const record = this.readRecord(url)
      if (record) blob[url] = record
    }
    return blob
  }

  /**
   * Move the records of an older account of the same settings file (before
   * the canonical scope, studioRuntimeScope) into this one: write, read back,
   * then delete the old record. Returns how many moved; a crash leaves the
   * old copy, and the next call finishes.
   */
  adoptLegacyAccount(legacyAccount: string): number {
    if (legacyAccount === this.account || !this.backend.isUnlocked()) return 0
    const legacy = new DaemonAppOAuthStore(this.backend, legacyAccount)
    let moved = 0
    for (const url of legacy.listServerUrls()) {
      const record = legacy.readRecord(url)
      if (record && !this.readRecord(url)) this.writeRecord(url, record)
      if (record && !this.readRecord(url)) continue
      legacy.writeRecord(url, undefined)
      moved++
    }
    if (moved > 0) console.log(`[MCP][oauth] Moved ${moved} app-level sign-in(s) from ${legacyAccount} to ${this.account}`)
    return moved
  }

  /** Store every record of a Studio `mcpOauthCredentials` blob (handover to local mode). */
  importBlob(blob: OAuthBlob): void {
    for (const [url, record] of Object.entries(blob)) {
      if (record && typeof record === 'object') this.writeRecord(url, record)
    }
  }
}

/**
 * AdfWorkspace-shaped slice the agent store depends on. AdfWorkspace satisfies
 * this structurally (setIdentitySealed / getIdentityDecrypted / getIdentityRow
 * / deleteIdentity), so sub-task D can pass the live workspace directly.
 */
export interface OAuthKeystoreHandle {
  /** Seal-or-fail: throws when the credentials envelope is locked. */
  setIdentitySealed(purpose: string, value: string): void
  /**
   * Force the row's code_access flag. Called with `false` after every seal so a
   * pre-existing (agent-created) row cannot leave the sealed OAuth token
   * readable from agent code — setIdentitySealed preserves the flag on an
   * existing row, which is the poisoning vector this closes.
   */
  setIdentityCodeAccess(purpose: string, codeAccess: boolean): boolean
  /** Null both for an ABSENT row AND a locked envelope — pair with getIdentityRow. */
  getIdentityDecrypted(purpose: string, derivedKey: Buffer | null): string | null
  /** Row presence distinguishes absent (bootstrap) from locked (fail plainly). */
  getIdentityRow(purpose: string): { purpose: string } | null
  deleteIdentity(purpose: string): boolean
}

/** Keystore namespace for a server's sealed OAuth record. */
export function oauthKeystorePurpose(serverName: string): string {
  return `mcp:${serverName}:oauth`
}

/**
 * Per-agent sealed store. Keyed at construction by the server NAME (the
 * keystore namespace, `mcp:<serverName>:oauth`), while the interface's
 * `serverUrl` param stays what the OAuth provider keys on — a single sealed
 * row per server holds the record for its pinned URL. The url arguments are
 * accepted for contract compatibility but the row is name-scoped; connect
 * pins the url→name mapping, so this cannot cross records.
 */
export class AgentKeystoreOAuthStore implements McpOAuthStore {
  private readonly purpose: string

  constructor(
    private readonly keystore: OAuthKeystoreHandle,
    serverName: string,
    private readonly derivedKey: Buffer | null = null,
  ) {
    this.purpose = oauthKeystorePurpose(serverName)
  }

  /**
   * Seal-or-fail write that ALSO forces the row out of code-readability. The
   * OAuth token is runtime/refresh-only by design; forcing code_access=false
   * after every seal defeats the poisoning path where agent code pre-creates
   * `mcp:<name>:oauth` (via set_identity, code_access=true) so a later seal
   * lands the real token in a code-readable row.
   */
  private sealAndHide(value: string): void {
    this.keystore.setIdentitySealed(this.purpose, value)
    this.keystore.setIdentityCodeAccess(this.purpose, false)
  }

  async get(serverUrl: string): Promise<McpOAuthRecord | undefined> {
    const raw = this.keystore.getIdentityDecrypted(this.purpose, this.derivedKey)
    if (raw == null) {
      // getIdentityDecrypted() is null for an ABSENT row AND a locked
      // envelope. A present-but-locked row must fail plainly (mirrors
      // materializeCredentialFiles) — silently returning null would strand the
      // sealed grant behind an opaque server-side 401.
      if (this.keystore.getIdentityRow(this.purpose) != null) {
        throw new Error(
          `MCP OAuth token for "${this.purpose}" exists in the keystore but the credentials envelope is ` +
          'locked in this runtime — open the agent in ADF Studio once, or provision a daemon runtime key.',
        )
      }
      return undefined
    }
    let record: McpOAuthRecord
    try {
      record = JSON.parse(raw) as McpOAuthRecord
    } catch {
      throw new Error(`Identity row "${this.purpose}" is not an MCP OAuth record (expected JSON).`)
    }
    // URL binding: this store is keyed by server NAME and would otherwise hand
    // the sealed token back for ANY requested url. Refuse when the pinned url
    // does not match the requested one.
    assertRecordUrlBinding(record, serverUrl, `AgentKeystoreOAuthStore.get(${this.purpose})`)
    return record
  }

  async save(_serverUrl: string, record: McpOAuthRecord): Promise<void> {
    // Seal-or-fail: setIdentitySealed throws on a locked envelope; a token is
    // never written unsealed. code_access is forced false on every write.
    this.sealAndHide(JSON.stringify({ ...record, updatedAt: record.updatedAt || Date.now() }))
  }

  async invalidate(_serverUrl: string, scope: McpOAuthInvalidateScope = 'all'): Promise<void> {
    if (scope === 'all') {
      this.keystore.deleteIdentity(this.purpose)
      return
    }
    // A scoped clear needs the current record; re-sealing requires an unlocked
    // envelope, so this only runs in an auth-capable runtime.
    const existing = await this.get(_serverUrl)
    if (!existing) return
    const next = applyInvalidateScope(existing, scope)
    if (next) this.sealAndHide(JSON.stringify(next))
    else this.keystore.deleteIdentity(this.purpose)
  }
}

/**
 * Capture-on-attach: read the Settings-level record for `serverUrl` and seal a
 * copy into the agent keystore (mirrors captureCredentialFile). This is the
 * hybrid glue — a Studio sign-in becomes a portable, daemon-capable agent
 * grant. Returns false (no-op) when the app store holds nothing for the url.
 */
export async function captureOAuthToAgent(
  appStore: AppSettingsOAuthStore,
  agentStore: AgentKeystoreOAuthStore,
  serverUrl: string,
): Promise<boolean> {
  const record = await appStore.get(serverUrl)
  if (!record) return false
  // Stamp the pinned url onto the sealed copy so the agent keystore (which is
  // keyed by server NAME) can refuse to hand this token back for a different
  // endpoint. The app record is already stamped at mint; re-stamp defensively.
  await agentStore.save(serverUrl, { ...record, serverUrl: canonicalizeServerUrl(serverUrl) })
  return true
}

/**
 * Connect-path store selection (documented convention for sub-task D).
 *
 * Prefer the AGENT-sealed store whenever an agent context exists: it is
 * portable (travels with the `.adf`) and daemon-capable (refresh runs from any
 * runtime with a provisioned key), and on a locked envelope its `get` fails
 * plainly with the actionable sign-in message — which IS the desired
 * daemon-without-a-key behavior. Fall back to the app-level Studio store only
 * when there is no agent context (e.g. a Settings-only registration test).
 */
export function resolveOAuthStoreForConnect(opts: {
  agentStore?: AgentKeystoreOAuthStore
  appStore?: AppSettingsOAuthStore
}): McpOAuthStore | undefined {
  return opts.agentStore ?? opts.appStore
}
