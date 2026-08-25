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
