/**
 * Mode-switch handover (design daemon-backend.md §11, §4.3, §5.3).
 *
 * Switching between embedded and local daemon mode MOVES the state the two
 * runtimes cannot share, so exactly one live copy exists at any time:
 *
 * | Item              | → local daemon                                        | → embedded                         |
 * |-------------------|-------------------------------------------------------|------------------------------------|
 * | Client settings   | adf-settings.json → studio-client-settings.json       | back                               |
 * | ChatGPT / Grok    | `<provider>/auth.json` (safeStorage) → `auth.daemon.json` (credential-cipher) | back           |
 * | App MCP OAuth     | `mcpOauthCredentials` (safeStorage) → the daemon's secret backend (DaemonAppOAuthStore) | back |
 * | Runtime identity  | keychain `studio-runtime:<scope>` written (Studio keeps its own copy) | the entry is deleted |
 *
 * Refresh tokens rotate: a copy left behind is invalidated the first time
 * the other side refreshes, which is why these are moves and not copies.
 *
 * Every move is idempotent and resumable: write the destination, verify it,
 * then delete the source. A crash at any point leaves at least one complete
 * copy, and the next run finishes the move (a destination equal to the
 * source just deletes the source). The handover runs at Studio's boot in the
 * new mode, before any backend handler or daemon is started, so nothing else
 * in this process holds these stores open.
 *
 * `<userData>/studio-handover.json` records which side holds the credentials
 * (`holder`). Moves back to embedded run only while it says `daemon`: a
 * daemon's own sessions (`adf auth login` on a CLI daemon) are never taken
 * by a Studio that did not hand them over. Client settings follow the active
 * mode whatever the marker says.
 *
 * Electron-free: Studio main injects safeStorage (`studioSecrets`), the
 * keychain the daemon reads (`daemonSecrets`) and the account-conflict
 * dialog (`chooseSession`). Never logs a secret value.
 */

import { promises as fsp } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { CLIENT_SETTINGS_KEYS } from '../../shared/constants/client-settings-keys'
import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import { deriveOwnerIdentity } from '../crypto/mnemonic-identity'
import { createAttestation, verifyAttestation } from '../services/attestation.service'
import { DaemonAppOAuthStore, daemonAppOAuthAccount, MCP_OAUTH_SETTINGS_KEY } from '../services/mcp-oauth-store'
import type { McpOAuthRecord } from '../services/mcp-oauth.types'
import { OWNER_MNEMONIC_ACCOUNT, type SecretBackend } from '../services/owner-secret-store'
import { settingsScope } from '../services/provider-key-store'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import {
  serializeStudioRuntimeEntry,
  studioRuntimeAccount,
  studioRuntimeScope,
  verifyStudioRuntimeEntry,
  type StudioRuntimeEntryInput,
} from '../daemon/studio-runtime-entry'

export const HANDOVER_MARKER_FILE = 'studio-handover.json'
const CLIENT_FILE = 'studio-client-settings.json'
const STUDIO_TOKEN_FILE = 'auth.json'
const DAEMON_TOKEN_FILE = 'auth.daemon.json'
const SAFE_PREFIX = 'safe:'
const AES_GCM_PREFIX = 'aesgcm:'

export type HandoverTarget = 'embedded' | 'local' | 'remote'

export type HandoverItemId = 'client-settings' | 'chatgpt' | 'grok' | 'mcp-oauth' | 'runtime-identity' | 'owner-phrase'

export type HandoverOutcome =
  /** The item now lives at the destination only. */
  | 'moved'
  /** Written (runtime identity entry, owner phrase mirror). */
  | 'written'
  /** Removed (the runtime identity entry on the way back to embedded). */
  | 'deleted'
  /** Nothing to do: already where it belongs, or absent. */
  | 'unchanged'
  /** Deliberately left where it is (the message says why). */
  | 'kept'
  /** The move failed; the source is untouched and the next boot retries. */
  | 'failed'

export interface HandoverItemResult {
  id: HandoverItemId
  label: string
  outcome: HandoverOutcome
  /** One sentence for the log and the summary dialog. Never contains a secret. */
  detail: string
}

export interface HandoverReport {
  target: HandoverTarget
  items: HandoverItemResult[]
  /** True when anything was written or deleted (the daemon then reloads its stores). */
  changed: boolean
  failed: boolean
}

/** What the switch dialog lists for one item (§11: "The switch dialog lists each moved item"). */
export interface HandoverPlanItem {
  id: HandoverItemId
  label: string
  detail: string
}

/** The `safe:` format of Studio's settings secrets and auth.json (Electron safeStorage). */
export interface StudioSecretCodec {
  available(): boolean
  /** `safe:<base64>`. Throws when encryption is unavailable. */
  encrypt(plain: string): string
  /** Null when this value cannot be decrypted here. */
  decrypt(stored: string): string | null
}

/** The daemon's at-rest cipher for auth.daemon.json (utils/credential-cipher.ts). */
export interface DaemonTokenCipher {
  encrypt(plain: string): string
  decrypt(raw: string): string | null
}

export interface SessionTokens {
  access_token: string
  refresh_token: string
  expires_at: number
  account_id: string
}

/** Both sides hold a session of one provider for different accounts (§11 accounts conflict). */
export interface SessionConflict {
  provider: 'chatgpt' | 'grok'
  label: string
  studio: { account: string; expiresAt: number }
  daemon: { account: string; expiresAt: number }
}

export interface HandoverDeps {
  userDataDir: string
  /** adf-settings.json: Studio's settings file, which the local daemon uses too. */
  settingsPath: string
  studioSecrets: StudioSecretCodec
  daemonCipher: DaemonTokenCipher
  /**
   * The secret store the local daemon reads: the OS keychain (or the test
   * keychain seam). Null when the daemon cannot share one with Studio (no
   * keychain, ADF_KEYCHAIN=0, or ADF_SECRET_STORE=file): then the runtime
   * identity and app MCP sign-ins stay with Studio (§5.3.1 fallback).
   */
  daemonSecrets: Pick<SecretBackend, 'get' | 'set' | 'delete' | 'isUnlocked'> | null
  /** Why `daemonSecrets` is null, for the dialog and the log. */
  daemonSecretsUnavailable?: string
  /** Which session to keep when both sides hold one for different accounts. Default: the source side's. */
  chooseSession?: (conflict: SessionConflict) => Promise<'studio' | 'daemon'>
  log?: (line: string) => void
  /** Tests: runs after a destination was written and verified, before its source is deleted. */
  beforeSourceDelete?: (id: HandoverItemId) => void | Promise<void>
}

type Json = Record<string, unknown>

const SUBSCRIPTIONS = [
  { id: 'chatgpt', dir: 'chatgpt-subscription', label: 'ChatGPT session' },
  { id: 'grok', dir: 'grok-subscription', label: 'Grok session' },
] as const

const CLIENT_KEYS: ReadonlySet<string> = new Set(CLIENT_SETTINGS_KEYS)

// --- files --------------------------------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** A JSON object file; null when absent. Throws on a corrupt file: a handover never overwrites what it cannot read. */
async function readJsonObject(path: string): Promise<Json | null> {
  const raw = await readText(path)
  if (raw === null) return null
  const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`)
  return parsed as Json
}

async function fingerprint(path: string): Promise<string> {
  try {
    const s = await fsp.stat(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'absent'
  }
}

/**
 * Read-modify-write of a JSON settings file another process (a running
 * daemon) may also write: the write happens only when the file is unchanged
 * since it was read, else the change is re-applied to the new contents.
 * `mutate` returns false when nothing changes.
 */
async function updateJsonFile(path: string, mutate: (data: Json) => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await fingerprint(path)
    const data = (await readJsonObject(path)) ?? {}
    if (!mutate(data)) return false
    if (await fingerprint(path) !== before) continue
    await fsp.mkdir(dirname(path), { recursive: true })
    await writeJsonAtomicAsync(path, data)
    return true
  }
  throw new Error(`${path} kept changing while Studio updated it`)
}

/** Atomic write of a token file, readable by the user only (as subscription-token-store writes it). */
async function writeTokenFile(path: string, value: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.handover.tmp`
  await fsp.writeFile(tmp, value, { mode: 0o600 })
  await fsp.rename(tmp, path)
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await fsp.unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

// --- marker -------------------------------------------------------------------

export type CredentialHolder = 'studio' | 'daemon'

export function handoverMarkerPath(userDataDir: string): string {
  return join(userDataDir, HANDOVER_MARKER_FILE)
}

/** Which side holds the moved credentials; `studio` when no switch ever moved them. */
export async function readCredentialHolder(userDataDir: string): Promise<CredentialHolder> {
  try {
    const marker = await readJsonObject(handoverMarkerPath(userDataDir))
    return marker?.holder === 'daemon' ? 'daemon' : 'studio'
  } catch {
    // Unreadable marker: assume the daemon holds them, so a move back is tried (each item is idempotent).
    return 'daemon'
  }
}

async function writeCredentialHolder(userDataDir: string, holder: CredentialHolder): Promise<void> {
  await fsp.mkdir(userDataDir, { recursive: true })
  await writeJsonAtomicAsync(handoverMarkerPath(userDataDir), { v: 1, holder, updatedAt: new Date().toISOString() })
}

// --- helpers --------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Studio's settings secret: `safe:` decrypted, a plain (legacy, no-keychain) value as is. */
function studioSecret(deps: HandoverDeps, settings: Json, key: string): string | null {
  const raw = settings[key]
  if (typeof raw !== 'string' || raw === '') return null
  return raw.startsWith(SAFE_PREFIX) ? deps.studioSecrets.decrypt(raw) : raw
}

function parseTokens(text: string | null): SessionTokens | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<SessionTokens>
    return typeof parsed.refresh_token === 'string' && typeof parsed.access_token === 'string' ? parsed as SessionTokens : null
  } catch {
    return null
  }
}

/** The account a session belongs to, for the conflict dialog: the e-mail in the access token when there is one, else the account id. */
export function sessionAccountLabel(tokens: SessionTokens): string {
  try {
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf-8')) as Record<string, unknown>
    const profile = payload['https://api.openai.com/profile'] as { email?: unknown } | undefined
    const email = typeof payload.email === 'string' ? payload.email : typeof profile?.email === 'string' ? profile.email : null
    if (email) return email
  } catch { /* not a JWT */ }
  return tokens.account_id || 'unknown account'
}

function decryptStudioToken(deps: HandoverDeps, raw: string): string | null {
  if (raw.startsWith(SAFE_PREFIX)) return deps.studioSecrets.decrypt(raw)
  // Studio falls back to the key-file cipher without safeStorage; plaintext is a pre-split legacy file.
  return raw.startsWith(AES_GCM_PREFIX) ? deps.daemonCipher.decrypt(raw) : raw
}

function encryptStudioToken(deps: HandoverDeps, plain: string): string {
  // As subscription-token-store writes in Studio: safeStorage, else the key-file cipher.
  return deps.studioSecrets.available() ? deps.studioSecrets.encrypt(plain) : deps.daemonCipher.encrypt(plain)
}

// --- client settings --------------------------------------------------------------

async function moveClientSettings(target: HandoverTarget, deps: HandoverDeps, legacyClientFile: boolean): Promise<HandoverItemResult> {
  const label = 'Client settings'
  const clientPath = join(deps.userDataDir, CLIENT_FILE)
  const result = (outcome: HandoverOutcome, detail: string): HandoverItemResult => ({ id: 'client-settings', label, outcome, detail })
  if (target === 'embedded') {
    const client = await readJsonObject(clientPath)
    const moving = Object.fromEntries(Object.entries(client ?? {}).filter(([key]) => CLIENT_KEYS.has(key)))
    const keys = Object.keys(moving)
    if (client === null) return result('unchanged', `no ${CLIENT_FILE}`)
    if (keys.length > 0) {
      await updateJsonFile(deps.settingsPath, (data) => {
        let changed = false
        for (const key of keys) if (!isDeepStrictEqual(data[key], moving[key])) { data[key] = moving[key]; changed = true }
        return changed
      })
      const written = (await readJsonObject(deps.settingsPath)) ?? {}
      const wrong = keys.filter((key) => !isDeepStrictEqual(written[key], moving[key]))
      if (wrong.length > 0) return result('failed', `${deps.settingsPath} does not hold ${wrong.join(', ')} after the write; ${CLIENT_FILE} kept`)
    }
    await deps.beforeSourceDelete?.('client-settings')
    await unlinkIfExists(clientPath)
    return result(keys.length > 0 ? 'moved' : 'unchanged', keys.length > 0
      ? `${keys.length} keys moved from ${CLIENT_FILE} into ${deps.settingsPath}`
      : `${CLIENT_FILE} held no client keys; removed`)
  }

  const settings = (await readJsonObject(deps.settingsPath)) ?? {}
  const moving = Object.fromEntries(Object.entries(settings).filter(([key]) => CLIENT_KEYS.has(key)))
  const keys = Object.keys(moving)
  if (keys.length === 0) return result('unchanged', `no client keys in ${deps.settingsPath}`)
  const client = (await readJsonObject(clientPath)) ?? {}
  // The settings file is the newer copy (embedded Studio wrote it), except
  // for a client file an earlier build seeded without a switch: its values
  // are what daemon mode last showed.
  const merged = legacyClientFile ? { ...moving, ...client } : { ...client, ...moving }
  await fsp.mkdir(deps.userDataDir, { recursive: true })
  await writeJsonAtomicAsync(clientPath, merged)
  const written = (await readJsonObject(clientPath)) ?? {}
  const wrong = keys.filter((key) => !isDeepStrictEqual(written[key], merged[key]))
  if (wrong.length > 0) return result('failed', `${CLIENT_FILE} does not hold ${wrong.join(', ')} after the write; ${deps.settingsPath} kept`)
  await deps.beforeSourceDelete?.('client-settings')
  await updateJsonFile(deps.settingsPath, (data) => {
    let changed = false
    for (const key of keys) if (key in data) { delete data[key]; changed = true }
    return changed
  })
  return result('moved', `${keys.length} keys moved from ${deps.settingsPath} into ${CLIENT_FILE}${legacyClientFile ? ' (values daemon mode last showed kept)' : ''}`)
}

// --- ChatGPT / Grok -----------------------------------------------------------------

async function moveSubscription(
  sub: (typeof SUBSCRIPTIONS)[number],
  toDaemon: boolean,
  deps: HandoverDeps,
): Promise<HandoverItemResult> {
  const dir = join(deps.userDataDir, sub.dir)
  const studioPath = join(dir, STUDIO_TOKEN_FILE)
  const daemonPath = join(dir, DAEMON_TOKEN_FILE)
  const result = (outcome: HandoverOutcome, detail: string): HandoverItemResult => ({ id: sub.id, label: sub.label, outcome, detail })
  const sourcePath = toDaemon ? studioPath : daemonPath
  const destPath = toDaemon ? daemonPath : studioPath
  const sourceRaw = await readText(sourcePath)
  if (sourceRaw === null) return result('unchanged', 'no session to move')
  const source = parseTokens(toDaemon ? decryptStudioToken(deps, sourceRaw) : deps.daemonCipher.decrypt(sourceRaw))
  if (!source) {
    return result('kept', `${sourcePath} cannot be read here; left in place (sign in again on the ${toDaemon ? 'daemon' : 'Studio'} side if needed)`)
  }
  const destRaw = await readText(destPath)
  const dest = destRaw === null ? null : parseTokens(toDaemon ? deps.daemonCipher.decrypt(destRaw) : decryptStudioToken(deps, destRaw))

  let keep: SessionTokens = source
  let note = ''
  if (dest && dest.refresh_token !== source.refresh_token) {
    if (dest.account_id && dest.account_id === source.account_id) {
      // One account, two token sets: only the most recently refreshed one is still valid.
      keep = dest.expires_at > source.expires_at ? dest : source
      note = `; both sides held ${sessionAccountLabel(source)}, the more recently refreshed session kept`
    } else {
      const conflict: SessionConflict = {
        provider: sub.id,
        label: sub.label,
        studio: { account: sessionAccountLabel(toDaemon ? source : dest), expiresAt: (toDaemon ? source : dest).expires_at },
        daemon: { account: sessionAccountLabel(toDaemon ? dest : source), expiresAt: (toDaemon ? dest : source).expires_at },
      }
      const choice = deps.chooseSession ? await deps.chooseSession(conflict) : (toDaemon ? 'studio' : 'daemon')
      keep = (choice === 'studio') === toDaemon ? source : dest
      const dropped = keep === source ? dest : source
      note = `; both sides were signed in (Studio: ${conflict.studio.account}, daemon: ${conflict.daemon.account}); kept ${sessionAccountLabel(keep)}, signed out ${sessionAccountLabel(dropped)}`
    }
  }

  const plain = JSON.stringify(keep)
  if (!dest || dest.refresh_token !== keep.refresh_token) {
    const encrypted = toDaemon ? deps.daemonCipher.encrypt(plain) : encryptStudioToken(deps, plain)
    await writeTokenFile(destPath, encrypted)
    const check = await readText(destPath)
    const back = parseTokens(check === null ? null : toDaemon ? deps.daemonCipher.decrypt(check) : decryptStudioToken(deps, check))
    if (!back || back.refresh_token !== keep.refresh_token) {
      return result('failed', `${destPath} did not read back after the write; ${sourcePath} kept`)
    }
  }
  await deps.beforeSourceDelete?.(sub.id)
  await unlinkIfExists(sourcePath)
  return result('moved', `${sessionAccountLabel(keep)} moved from ${sourcePath} to ${destPath}${note}`)
}

// --- app-level MCP OAuth --------------------------------------------------------------

function newerRecord(a: McpOAuthRecord | undefined, b: McpOAuthRecord | undefined): McpOAuthRecord | undefined {
  if (!a) return b
  if (!b) return a
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
}

function daemonOAuthStore(deps: HandoverDeps): DaemonAppOAuthStore | null {
  if (!deps.daemonSecrets) return null
  return new DaemonAppOAuthStore(deps.daemonSecrets, daemonAppOAuthAccount(settingsScope(deps.settingsPath)))
}

async function moveMcpOAuth(toDaemon: boolean, deps: HandoverDeps): Promise<HandoverItemResult> {
  const label = 'MCP sign-ins'
  const result = (outcome: HandoverOutcome, detail: string): HandoverItemResult => ({ id: 'mcp-oauth', label, outcome, detail })
  const store = daemonOAuthStore(deps)
  const settings = (await readJsonObject(deps.settingsPath)) ?? {}
  const rawStudio = settings[MCP_OAUTH_SETTINGS_KEY]
  const studioText = studioSecret(deps, settings, MCP_OAUTH_SETTINGS_KEY)
  let studioBlob: Record<string, McpOAuthRecord> = {}
  if (studioText) {
    try { studioBlob = JSON.parse(studioText) as Record<string, McpOAuthRecord> } catch { studioBlob = {} }
  }
  if (toDaemon) {
    if (rawStudio === undefined) return result('unchanged', 'no app-level MCP sign-ins in Studio')
    if (studioText === null) return result('kept', `${MCP_OAUTH_SETTINGS_KEY} cannot be decrypted here; left in Studio's settings`)
    if (!store) return result('kept', `left in Studio: ${deps.daemonSecretsUnavailable ?? 'the daemon has no keychain Studio can write'}; agents keep their own sealed copies`)
    if (!store.available()) return result('kept', 'left in Studio: the daemon\'s secret store is locked')
    const existing = store.exportBlob()
    const urls = Object.keys(studioBlob)
    for (const url of urls) {
      const winner = newerRecord(studioBlob[url], existing[url])
      if (winner && !isDeepStrictEqual(winner, existing[url])) store.importBlob({ [url]: winner })
    }
    const after = store.exportBlob()
    const missing = urls.filter((url) => !after[url])
    if (missing.length > 0) return result('failed', `the daemon's store does not hold ${missing.length} of ${urls.length} servers after the write; Studio's copy kept`)
    await deps.beforeSourceDelete?.('mcp-oauth')
    await updateJsonFile(deps.settingsPath, (data) => {
      if (!(MCP_OAUTH_SETTINGS_KEY in data)) return false
      delete data[MCP_OAUTH_SETTINGS_KEY]
      return true
    })
    return result(urls.length > 0 ? 'moved' : 'unchanged', `${urls.length} server sign-in(s) moved into the daemon's secret store`)
  }

  if (!store) return result('unchanged', deps.daemonSecretsUnavailable ?? 'no daemon secret store to move back from')
  if (!store.available()) return result('kept', 'left in the daemon: its secret store is locked')
  const daemonBlob = store.exportBlob()
  const urls = Object.keys(daemonBlob)
  if (urls.length === 0) return result('unchanged', 'no app-level MCP sign-ins in the daemon')
  if (!deps.studioSecrets.available()) return result('kept', 'left in the daemon: OS secure storage is not available to Studio, and MCP tokens are never stored unencrypted')
  if (studioText === null && rawStudio !== undefined) return result('kept', `Studio's ${MCP_OAUTH_SETTINGS_KEY} cannot be decrypted here; nothing moved`)
  const merged: Record<string, McpOAuthRecord> = { ...studioBlob }
  for (const url of urls) merged[url] = newerRecord(merged[url], daemonBlob[url])!
  await updateJsonFile(deps.settingsPath, (data) => {
    data[MCP_OAUTH_SETTINGS_KEY] = deps.studioSecrets.encrypt(JSON.stringify(merged))
    return true
  })
  const reread = studioSecret(deps, (await readJsonObject(deps.settingsPath)) ?? {}, MCP_OAUTH_SETTINGS_KEY)
  let back: Record<string, McpOAuthRecord> = {}
  try { back = reread ? JSON.parse(reread) as Record<string, McpOAuthRecord> : {} } catch { back = {} }
  if (urls.some((url) => !back[url])) return result('failed', `Studio's settings do not hold every server after the write; the daemon's copy kept`)
  await deps.beforeSourceDelete?.('mcp-oauth')
  for (const url of urls) await store.invalidate(url, 'all')
  return result('moved', `${urls.length} server sign-in(s) moved back into Studio's settings`)
}

// --- runtime identity -----------------------------------------------------------------

export interface RuntimeEntrySync {
  outcome: 'written' | 'unchanged' | 'skipped' | 'failed'
  detail: string
}

/**
 * Write (or rewrite) the `studio-runtime:<scope>` keychain entry from
 * Studio's settings (§5.3.1), with `serializeStudioRuntimeEntry` and nothing
 * else. When the stored delegation is not signed by the current owner (an
 * owner switch, a restore), it is re-signed with the owner phrase when one is
 * at hand, as embedded Studio's ensureRuntimeKey does. Unchanged values are
 * not rewritten. Also used after an owner import in daemon mode.
 */
export async function syncStudioRuntimeEntry(deps: HandoverDeps, opts: { ownerPhrase?: string | null } = {}): Promise<RuntimeEntrySync> {
  if (!deps.daemonSecrets) return { outcome: 'skipped', detail: deps.daemonSecretsUnavailable ?? 'no keychain the daemon can read' }
  const settings = (await readJsonObject(deps.settingsPath)) ?? {}
  const ownerDid = typeof settings.ownerDid === 'string' ? settings.ownerDid : null
  const runtimeDid = typeof settings.runtimeDid === 'string' ? settings.runtimeDid : null
  const runtimeEncPublicKey = typeof settings.runtimeEncPublicKey === 'string' ? settings.runtimeEncPublicKey : null
  const runtimePrivateKey = studioSecret(deps, settings, 'runtimePrivateKey')
  const runtimeEncPrivateKey = studioSecret(deps, settings, 'runtimeEncPrivateKey')
  if (!ownerDid || !runtimeDid || !runtimeEncPublicKey || !runtimePrivateKey || !runtimeEncPrivateKey) {
    return { outcome: 'skipped', detail: 'Studio has no complete runtime identity yet; the daemon uses its own runtime' }
  }
  const account = studioRuntimeAccount(studioRuntimeScope(deps.settingsPath))
  const current = deps.daemonSecrets.get(account)
  let delegation = settings.runtimeDelegation as AlfAttestation | undefined
  const valid = !!delegation && delegation.issuer === ownerDid && verifyAttestation(delegation, { expectedSubject: runtimeDid })
  if (!valid && current) {
    // A delegation re-signed earlier (Studio's settings keep the old one
    // until embedded Studio re-signs it): keep the entry while it verifies
    // and carries Studio's current keys.
    const existing = verifyStudioRuntimeEntry(current, { ownerDid, runtimeDid, runtimeEncPublicKey })
    if (existing.ok && existing.runtime.runtimePrivateKeyB64 === runtimePrivateKey && existing.runtime.runtimeEncPrivateKeyB64 === runtimeEncPrivateKey) {
      return { outcome: 'unchanged', detail: `keychain entry ${account} is current` }
    }
  }
  if (!valid) {
    const phrase = opts.ownerPhrase ?? studioSecret(deps, settings, 'ownerMnemonic') ?? deps.daemonSecrets.get(OWNER_MNEMONIC_ACCOUNT)
    let signed = false
    if (phrase) {
      try {
        const owner = deriveOwnerIdentity(phrase)
        if (owner.did === ownerDid) {
          delegation = createAttestation({ issuer: ownerDid, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() }, owner.privateKeyPkcs8)
          signed = true
        }
      } catch { /* not a phrase */ }
    }
    if (!signed) return { outcome: 'skipped', detail: `Studio's runtime delegation is not signed by the owner ${ownerDid} and no owner phrase is at hand to re-sign it; the daemon uses its own runtime` }
  }
  const input: StudioRuntimeEntryInput = { runtimeDid, runtimeDelegation: delegation!, runtimePrivateKey, runtimeEncPrivateKey, runtimeEncPublicKey }
  if (current) {
    try {
      const { writtenAt: _w, v: _v, ...fields } = JSON.parse(current) as Json
      if (isDeepStrictEqual(fields, { ...input })) return { outcome: 'unchanged', detail: `keychain entry ${account} is current` }
    } catch { /* rewrite a malformed entry */ }
  }
  deps.daemonSecrets.set(account, serializeStudioRuntimeEntry(input))
  const check = verifyStudioRuntimeEntry(deps.daemonSecrets.get(account) ?? '', { ownerDid, runtimeDid, runtimeEncPublicKey })
  if (!check.ok) return { outcome: 'failed', detail: `keychain entry ${account} was written but does not verify (${check.reason}: ${check.detail})` }
  return { outcome: 'written', detail: `keychain entry ${account} written${valid ? '' : ' with a delegation re-signed by the current owner'}` }
}

/** Remove `studio-runtime:<scope>` (switch back to embedded: no copy of Studio's runtime keys outlives local mode). */
export function deleteStudioRuntimeEntry(deps: HandoverDeps): RuntimeEntrySync {
  if (!deps.daemonSecrets) return { outcome: 'skipped', detail: 'no keychain' }
  const account = studioRuntimeAccount(studioRuntimeScope(deps.settingsPath))
  if (deps.daemonSecrets.get(account) === null) return { outcome: 'unchanged', detail: `no keychain entry ${account}` }
  deps.daemonSecrets.delete(account)
  if (deps.daemonSecrets.get(account) !== null) return { outcome: 'failed', detail: `keychain entry ${account} could not be deleted` }
  return { outcome: 'written', detail: `keychain entry ${account} deleted` }
}

/** Embedded Studio mirrors the owner phrase into the keychain when one exists; the daemon reads it there. */
async function mirrorOwnerPhrase(deps: HandoverDeps): Promise<HandoverItemResult> {
  const result = (outcome: HandoverOutcome, detail: string): HandoverItemResult => ({ id: 'owner-phrase', label: 'Owner phrase', outcome, detail })
  if (!deps.daemonSecrets) return result('kept', deps.daemonSecretsUnavailable ?? 'no keychain the daemon can read')
  if (deps.daemonSecrets.get(OWNER_MNEMONIC_ACCOUNT)) return result('unchanged', 'already in the keychain')
  const settings = (await readJsonObject(deps.settingsPath)) ?? {}
  const phrase = studioSecret(deps, settings, 'ownerMnemonic')
  if (!phrase) return result('unchanged', 'Studio holds no owner phrase')
  try {
    if (deriveOwnerIdentity(phrase).did !== settings.ownerDid) return result('kept', 'Studio\'s phrase is not the owner on record; not mirrored')
  } catch {
    return result('kept', 'Studio\'s owner phrase is not valid; not mirrored')
  }
  deps.daemonSecrets.set(OWNER_MNEMONIC_ACCOUNT, phrase)
  return result('written', 'mirrored into the keychain entry ADF / owner-mnemonic, as embedded Studio does')
}

// --- plan and run ----------------------------------------------------------------------

/**
 * Whether a handover to `target` can touch the keychain the daemon reads, so
 * Studio opens it only then: to local when Studio holds an owner phrase, a
 * runtime key or MCP sign-ins; back to embedded while the daemon holds the
 * credentials.
 */
export async function handoverNeedsKeychain(target: HandoverTarget, userDataDir: string): Promise<boolean> {
  if (target === 'remote') return false
  if (target === 'embedded') return await readCredentialHolder(userDataDir) === 'daemon'
  const settings = await readJsonObject(join(userDataDir, 'adf-settings.json')).catch(() => null)
  return !!settings && ['ownerMnemonic', 'runtimePrivateKey', MCP_OAUTH_SETTINGS_KEY].some((key) => settings[key] !== undefined)
}

/** Read-only: what a switch to `target` would move, for the switch dialog. */
export async function planHandover(target: HandoverTarget, deps: HandoverDeps): Promise<HandoverPlanItem[]> {
  const items: HandoverPlanItem[] = []
  const settings = (await readJsonObject(deps.settingsPath).catch(() => null)) ?? {}
  const clientPath = join(deps.userDataDir, CLIENT_FILE)
  if (target === 'embedded') {
    const client = await readJsonObject(clientPath).catch(() => null)
    const n = Object.keys(client ?? {}).filter((key) => CLIENT_KEYS.has(key)).length
    if (n > 0) items.push({ id: 'client-settings', label: 'Client settings', detail: `${n} settings (theme, recent files, …) move back into adf-settings.json` })
  } else {
    const n = Object.keys(settings).filter((key) => CLIENT_KEYS.has(key)).length
    if (n > 0) items.push({ id: 'client-settings', label: 'Client settings', detail: `${n} settings (theme, recent files, …) move into studio-client-settings.json` })
  }
  if (target === 'remote') return items
  const toDaemon = target === 'local'
  if (!toDaemon && await readCredentialHolder(deps.userDataDir) !== 'daemon') return items
  for (const sub of SUBSCRIPTIONS) {
    const raw = await readText(join(deps.userDataDir, sub.dir, toDaemon ? STUDIO_TOKEN_FILE : DAEMON_TOKEN_FILE)).catch(() => null)
    if (raw === null) continue
    const tokens = parseTokens(toDaemon ? decryptStudioToken(deps, raw) : deps.daemonCipher.decrypt(raw))
    items.push({ id: sub.id, label: sub.label, detail: `${tokens ? sessionAccountLabel(tokens) : 'a session'} moves ${toDaemon ? 'to the daemon' : 'back to Studio'}` })
  }
  if (toDaemon) {
    if (settings[MCP_OAUTH_SETTINGS_KEY] !== undefined) {
      items.push(deps.daemonSecrets
        ? { id: 'mcp-oauth', label: 'MCP sign-ins', detail: 'app-level MCP server sign-ins move into the daemon\'s keychain entries' }
        : { id: 'mcp-oauth', label: 'MCP sign-ins', detail: `stay in Studio (${deps.daemonSecretsUnavailable ?? 'no keychain'}); agents use their own sealed copies` })
    }
    items.push(deps.daemonSecrets
      ? { id: 'runtime-identity', label: 'Runtime identity', detail: 'Studio\'s runtime key is written to the OS keychain so the daemon signs as this runtime' }
      : { id: 'runtime-identity', label: 'Runtime identity', detail: `not shared: ${deps.daemonSecretsUnavailable ?? 'no keychain'}. The daemon runs as its own runtime, and files it stamps show as "recognized" in Studio's review` })
  } else {
    const store = daemonOAuthStore(deps)
    const n = store?.available() ? store.listServerUrls().length : 0
    if (n > 0) items.push({ id: 'mcp-oauth', label: 'MCP sign-ins', detail: `${n} server sign-in(s) move back into Studio` })
    items.push({ id: 'runtime-identity', label: 'Runtime identity', detail: 'the keychain copy of Studio\'s runtime key is deleted' })
  }
  return items
}

/**
 * Move everything that belongs to the side of `target` there (see the module
 * comment). Never throws: each item's failure is reported, its source kept,
 * and the next boot retries.
 */
export async function runHandover(target: HandoverTarget, deps: HandoverDeps): Promise<HandoverReport> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const items: HandoverItemResult[] = []
  const run = async (id: HandoverItemId, label: string, step: () => Promise<HandoverItemResult>): Promise<void> => {
    let item: HandoverItemResult
    try {
      item = await step()
    } catch (err) {
      item = { id, label, outcome: 'failed', detail: `${errorText(err)}; the source is kept and the next start retries` }
    }
    items.push(item)
    const line = `[Handover] ${item.label}: ${item.outcome} (${item.detail})`
    if (item.outcome === 'failed') console.warn(line)
    else if (item.outcome !== 'unchanged') log(line)
  }

  const holder = await readCredentialHolder(deps.userDataDir)
  const markerExists = (await readText(handoverMarkerPath(deps.userDataDir)).catch(() => null)) !== null
  // An earlier build seeded the client file once without a switch (no marker).
  const legacyClientFile = !markerExists && (await readText(join(deps.userDataDir, CLIENT_FILE)).catch(() => null)) !== null

  await run('client-settings', 'Client settings', () => moveClientSettings(target, deps, legacyClientFile))

  if (target === 'local') {
    // Recorded first: a crash from here on resumes the move in either direction.
    if (holder !== 'daemon') await writeCredentialHolder(deps.userDataDir, 'daemon')
    await run('owner-phrase', 'Owner phrase', () => mirrorOwnerPhrase(deps))
    await run('runtime-identity', 'Runtime identity', async () => {
      const sync = await syncStudioRuntimeEntry(deps)
      return { id: 'runtime-identity', label: 'Runtime identity', outcome: sync.outcome === 'skipped' ? 'kept' : sync.outcome, detail: sync.detail }
    })
    for (const sub of SUBSCRIPTIONS) await run(sub.id, sub.label, () => moveSubscription(sub, true, deps))
    await run('mcp-oauth', 'MCP sign-ins', () => moveMcpOAuth(true, deps))
  } else if (target === 'embedded' && holder === 'daemon') {
    for (const sub of SUBSCRIPTIONS) await run(sub.id, sub.label, () => moveSubscription(sub, false, deps))
    await run('mcp-oauth', 'MCP sign-ins', () => moveMcpOAuth(false, deps))
    await run('runtime-identity', 'Runtime identity', async () => {
      const removed = deleteStudioRuntimeEntry(deps)
      return { id: 'runtime-identity', label: 'Runtime identity', outcome: removed.outcome === 'written' ? 'deleted' : removed.outcome === 'skipped' ? 'unchanged' : removed.outcome, detail: removed.detail }
    })
    if (!items.some((i) => i.outcome === 'failed')) await writeCredentialHolder(deps.userDataDir, 'studio')
  }

  const changed = items.some((i) => i.outcome === 'moved' || i.outcome === 'written' || i.outcome === 'deleted')
  const failed = items.some((i) => i.outcome === 'failed')
  if (changed || failed) log(`[Handover] Switch to ${target}: ${items.filter((i) => i.outcome !== 'unchanged').map((i) => `${i.label} ${i.outcome}`).join(', ')}`)
  return { target, items, changed, failed }
}
