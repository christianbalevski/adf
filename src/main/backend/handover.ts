/**
 * Mode-switch handover (design daemon-backend.md §11, §11.1, §4.3, §5.3).
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
 * copy, and the next run finishes the move. The handover runs at Studio's
 * boot in the new mode, before any backend handler or daemon is started.
 *
 * `<userData>/studio-handover.json` (HandoverMarker) records which side holds
 * the credentials, what the switch to local moved, and which sign-ins the
 * daemon had of its own before it. Moving back takes what Studio moved plus
 * what was signed in while Studio ran in local mode, never the daemon's own
 * earlier sign-ins (`adf auth login` on a CLI daemon). The marker flips back
 * to `studio` only when every item moved, or was found absent in a store
 * that was actually read; a store that cannot be read, a locked one, or a
 * daemon still running on these settings leaves it at `daemon`, and the next
 * start retries. A corrupt marker moves no credential at all.
 *
 * Electron-free: Studio main injects safeStorage (`studioSecrets`), the
 * keychain the daemon reads (`daemonSecrets`), the running-daemon check and
 * the account-conflict dialog. Never logs a secret value.
 */

import { promises as fsp } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { CLIENT_FILE_ONLY_KEYS, CLIENT_SETTINGS_KEYS } from '../../shared/constants/client-settings-keys'
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
/**
 * The session the accounts-conflict dialog did not keep, for one restore
 * (credential-cipher, as auth.daemon.json). Deleted after
 * REPLACED_TOKEN_MAX_AGE_DAYS (sweepReplacedSessions, every handover) or at
 * the next sign-in to its account (subscription-token-store signedIn).
 */
export const REPLACED_TOKEN_FILE = 'auth.replaced.json'
export const REPLACED_TOKEN_MAX_AGE_DAYS = 30
const SAFE_PREFIX = 'safe:'
const AES_GCM_PREFIX = 'aesgcm:'

export type HandoverTarget = 'embedded' | 'local' | 'remote'

export type HandoverItemId = 'client-settings' | 'chatgpt' | 'grok' | 'mcp-oauth' | 'runtime-identity' | 'owner-phrase' | 'handover-record'

export type HandoverOutcome =
  /** The item now lives at the destination only. */
  | 'moved'
  /** Written (runtime identity entry, owner phrase mirror). */
  | 'written'
  /** Removed (the runtime identity entry on the way back to embedded). */
  | 'deleted'
  /** Nothing to do: already where it belongs, or absent from a store that was read. */
  | 'unchanged'
  /** Left where it is; `pending` says whether a later start retries. */
  | 'kept'
  /** The move failed; the source is untouched and the next start retries. */
  | 'failed'

export interface HandoverItemResult {
  id: HandoverItemId
  label: string
  outcome: HandoverOutcome
  /** One sentence for the log and the summary dialog. Never contains a secret. */
  detail: string
  /** Not done: the credentials stay with the daemon's role (marker unchanged) and the next start retries. */
  pending?: boolean
}

export interface HandoverReport {
  target: HandoverTarget
  items: HandoverItemResult[]
  /** True when anything was written or deleted (the daemon then reloads its stores). */
  changed: boolean
  /** True when an item failed or is pending: the summary dialog shows it as a warning. */
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
  /**
   * Set where safeStorage only obfuscates (Linux `basic_text`): a sentence
   * saying so and what fixes it; null or absent where it really encrypts.
   */
  obfuscationOnly?(): string | null
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

type SubscriptionId = 'chatgpt' | 'grok'

/** Both sides hold a session of one provider for different accounts (§11 accounts conflict). */
export interface SessionConflict {
  provider: SubscriptionId
  label: string
  studio: { account: string; expiresAt: number }
  daemon: { account: string; expiresAt: number }
  /** Where the session not kept is saved, encrypted, for one restore. */
  replacedFile: string
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
  /**
   * A daemon running on these settings (it could refresh a token while it
   * moves): a sentence naming it, or null. Checked before the moves back to
   * embedded.
   */
  daemonRunning?: () => Promise<string | null>
  /** Which session to keep when both sides hold one for different accounts. Default: the source side's. */
  chooseSession?: (conflict: SessionConflict) => Promise<'studio' | 'daemon'>
  log?: (line: string) => void
  /** Tests: runs after a destination was written and verified, before its source is deleted. */
  beforeSourceDelete?: (id: HandoverItemId) => void | Promise<void>
}

export interface HandoverOptions {
  /**
   * This launch's mode is an override for one session (ADF_STUDIO_BACKEND,
   * or "embedded for this session" after a version mismatch): only client
   * keys move; credentials stay where the configured mode keeps them, and
   * the marker is not touched (§8.2).
   */
  sessionOnly?: boolean
}

type Json = Record<string, unknown>

const SUBSCRIPTIONS = [
  { id: 'chatgpt', dir: 'chatgpt-subscription', label: 'ChatGPT session' },
  { id: 'grok', dir: 'grok-subscription', label: 'Grok session' },
] as const

const CLIENT_KEYS: ReadonlySet<string> = new Set(CLIENT_SETTINGS_KEYS)
/** Client keys that never move into adf-settings.json (remote mode's recent files): they stay in the client file. */
const KEPT_CLIENT_KEYS: ReadonlySet<string> = new Set(CLIENT_FILE_ONLY_KEYS)
const movesToEmbedded = (key: string): boolean => CLIENT_KEYS.has(key) && !KEPT_CLIENT_KEYS.has(key)

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

interface SignIns {
  /** account_id per subscription */
  sessions: Partial<Record<SubscriptionId, string>>
  /** MCP server URLs */
  mcpServers: string[]
}

export interface HandoverMarker {
  v: 2
  holder: CredentialHolder
  updatedAt: string
  /** Studio wrote into the daemon's keychain at the switch to local (false: there was none it could share). */
  keychainUsed: boolean
  /** What the switch to local moved into the daemon's stores. */
  moved: SignIns
  /** The daemon's own sign-ins before the first switch: they never move to Studio. */
  daemonOwn: SignIns
  /** Set when the marker was missing and Studio's runtime entry was found: what was moved is unknown. */
  reconstructed?: boolean
}

export type MarkerState =
  | { state: 'absent' }
  | { state: 'corrupt'; detail: string }
  | { state: 'ok'; marker: HandoverMarker }

const emptySignIns = (): SignIns => ({ sessions: {}, mcpServers: [] })

export function handoverMarkerPath(userDataDir: string): string {
  return join(userDataDir, HANDOVER_MARKER_FILE)
}

function parseSignIns(raw: unknown): SignIns | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { sessions?: unknown; mcpServers?: unknown }
  const sessions: SignIns['sessions'] = {}
  if (r.sessions && typeof r.sessions === 'object') {
    for (const id of ['chatgpt', 'grok'] as const) {
      const v = (r.sessions as Record<string, unknown>)[id]
      if (typeof v === 'string') sessions[id] = v
    }
  }
  const mcpServers = Array.isArray(r.mcpServers) ? r.mcpServers.filter((u): u is string => typeof u === 'string') : []
  return { sessions, mcpServers }
}

export async function readHandoverMarker(userDataDir: string): Promise<MarkerState> {
  const path = handoverMarkerPath(userDataDir)
  let data: Json | null
  try {
    data = await readJsonObject(path)
  } catch (err) {
    return { state: 'corrupt', detail: `${path} cannot be read (${errorText(err)})` }
  }
  if (!data) return { state: 'absent' }
  if (data.holder !== 'daemon' && data.holder !== 'studio') return { state: 'corrupt', detail: `${path} names no credential holder` }
  if (data.v === 1) {
    // Development builds of W4-A: no record of what moved; the daemon held nothing of its own then.
    return { state: 'ok', marker: { v: 2, holder: data.holder, updatedAt: String(data.updatedAt ?? ''), keychainUsed: true, moved: emptySignIns(), daemonOwn: emptySignIns() } }
  }
  const moved = parseSignIns(data.moved)
  const daemonOwn = parseSignIns(data.daemonOwn)
  if (data.v !== 2 || !moved || !daemonOwn || typeof data.keychainUsed !== 'boolean') return { state: 'corrupt', detail: `${path} is not a handover record this Studio reads` }
  return { state: 'ok', marker: { v: 2, holder: data.holder, updatedAt: String(data.updatedAt ?? ''), keychainUsed: data.keychainUsed, moved, daemonOwn, ...(data.reconstructed === true ? { reconstructed: true } : {}) } }
}

async function writeMarker(userDataDir: string, marker: HandoverMarker): Promise<void> {
  await fsp.mkdir(userDataDir, { recursive: true })
  await writeJsonAtomicAsync(handoverMarkerPath(userDataDir), { ...marker, updatedAt: new Date().toISOString() })
}

/** Which side holds the moved credentials (`daemon` for a corrupt marker: nothing is assumed moved back). */
export async function readCredentialHolder(userDataDir: string): Promise<CredentialHolder> {
  const read = await readHandoverMarker(userDataDir)
  return read.state === 'ok' ? read.marker.holder : read.state === 'corrupt' ? 'daemon' : 'studio'
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

/** Whether a moved-back session is written with the key-file cipher instead of safeStorage. */
function studioTokenUsesKeyFile(deps: HandoverDeps): boolean {
  return !deps.studioSecrets.available() || !!deps.studioSecrets.obfuscationOnly?.()
}

function encryptStudioToken(deps: HandoverDeps, plain: string): string {
  // safeStorage, else the key-file cipher (subscription-token-store reads both).
  // Under basic_text the key-file cipher is used, which encrypts where basic_text only obfuscates.
  return studioTokenUsesKeyFile(deps) ? deps.daemonCipher.encrypt(plain) : deps.studioSecrets.encrypt(plain)
}

async function readDaemonTokens(deps: HandoverDeps, sub: (typeof SUBSCRIPTIONS)[number]): Promise<{ raw: string | null; tokens: SessionTokens | null }> {
  const raw = await readText(join(deps.userDataDir, sub.dir, DAEMON_TOKEN_FILE))
  return { raw, tokens: raw === null ? null : parseTokens(deps.daemonCipher.decrypt(raw)) }
}

// --- client settings --------------------------------------------------------------

async function moveClientSettings(target: HandoverTarget, deps: HandoverDeps): Promise<HandoverItemResult> {
  const label = 'Client settings'
  const clientPath = join(deps.userDataDir, CLIENT_FILE)
  const result = (outcome: HandoverOutcome, detail: string): HandoverItemResult => ({ id: 'client-settings', label, outcome, detail })
  if (target === 'embedded') {
    const client = await readJsonObject(clientPath)
    const moving = Object.fromEntries(Object.entries(client ?? {}).filter(([key]) => movesToEmbedded(key)))
    const keys = Object.keys(moving)
    if (client === null) return result('unchanged', `no ${CLIENT_FILE}`)
    // Remote mode's recent files are paths on another machine: embedded never
    // gets them (it opens and sweeps its recent paths). They stay in the
    // client file for the next remote session.
    const kept = Object.fromEntries(Object.entries(client).filter(([key]) => KEPT_CLIENT_KEYS.has(key)))
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
    const keptKeys = Object.keys(kept)
    if (keptKeys.length > 0) await writeJsonAtomicAsync(clientPath, kept)
    else await unlinkIfExists(clientPath)
    const keptNote = keptKeys.length > 0 ? `; ${keptKeys.join(', ')} (remote mode only) kept in ${CLIENT_FILE}` : ''
    return result(keys.length > 0 ? 'moved' : 'unchanged', keys.length > 0
      ? `${keys.length} keys moved from ${CLIENT_FILE} into ${deps.settingsPath}${keptNote}`
      : keptKeys.length > 0 ? `${CLIENT_FILE} held no client keys to move${keptNote}` : `${CLIENT_FILE} held no client keys; removed`)
  }

  const settings = (await readJsonObject(deps.settingsPath)) ?? {}
  const moving = Object.fromEntries(Object.entries(settings).filter(([key]) => CLIENT_KEYS.has(key)))
  const keys = Object.keys(moving)
  if (keys.length === 0) return result('unchanged', `no client keys in ${deps.settingsPath}`)
  const client = (await readJsonObject(clientPath)) ?? {}
  // adf-settings.json holds the newer value of every key it has (embedded
  // Studio wrote it last). A client file left by an earlier build's one-time
  // seed only contributes keys the settings file does not hold.
  const stale = keys.filter((key) => key in client && !isDeepStrictEqual(client[key], moving[key]))
  const merged = { ...client, ...moving }
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
  return result('moved', `${keys.length} keys moved from ${deps.settingsPath} into ${CLIENT_FILE}${stale.length ? ` (older values of ${stale.join(', ')} in ${CLIENT_FILE} replaced)` : ''}`)
}

// --- ChatGPT / Grok -----------------------------------------------------------------

interface SessionMove {
  item: HandoverItemResult
  /** The account now on the destination side, when one moved there. */
  movedAccount?: string
}

async function moveSubscription(
  sub: (typeof SUBSCRIPTIONS)[number],
  toDaemon: boolean,
  deps: HandoverDeps,
  marker: HandoverMarker | null,
): Promise<SessionMove> {
  const dir = join(deps.userDataDir, sub.dir)
  const studioPath = join(dir, STUDIO_TOKEN_FILE)
  const daemonPath = join(dir, DAEMON_TOKEN_FILE)
  const replacedPath = join(dir, REPLACED_TOKEN_FILE)
  const result = (outcome: HandoverOutcome, detail: string, pending = false): SessionMove => ({ item: { id: sub.id, label: sub.label, outcome, detail, ...(pending ? { pending } : {}) } })
  const sourcePath = toDaemon ? studioPath : daemonPath
  const destPath = toDaemon ? daemonPath : studioPath
  const sourceRaw = await readText(sourcePath)
  if (sourceRaw === null) return result('unchanged', 'no session to move')
  const source = parseTokens(toDaemon ? decryptStudioToken(deps, sourceRaw) : deps.daemonCipher.decrypt(sourceRaw))
  if (!source) {
    return result('kept', `${sourcePath} cannot be read here; left in place. Sign out there (or delete it) if it is no longer needed.`, !toDaemon)
  }
  if (!toDaemon && marker) {
    // The daemon's own sign-in from before the switch stays with it.
    const own = marker.daemonOwn.sessions[sub.id]
    if (own && own === source.account_id && marker.moved.sessions[sub.id] !== source.account_id) {
      return result('unchanged', `${sessionAccountLabel(source)} is the daemon's own session (signed in before the switch); it stays with the daemon`)
    }
  }
  const destRaw = await readText(destPath)
  const dest = destRaw === null ? null : parseTokens(toDaemon ? deps.daemonCipher.decrypt(destRaw) : decryptStudioToken(deps, destRaw))

  let keep: SessionTokens = source
  let note = ''
  if (dest && dest.refresh_token !== source.refresh_token) {
    if (dest.account_id && dest.account_id === source.account_id) {
      if (toDaemon && marker?.daemonOwn.sessions[sub.id] === dest.account_id) {
        // The daemon signed in to this account itself before the switch: two
        // independent logins, two refresh-token families, both valid. Each
        // side keeps its own; Studio's stays with Studio for the way back.
        return result('kept', `Studio and the daemon are each signed in to ${sessionAccountLabel(source)} on their own; the daemon uses its session, Studio's stays with Studio for the switch back`)
      }
      // One account, two token sets of one family (a move resumed after the
      // other side refreshed): the more recently refreshed one is current.
      // The other is saved once anyway, in case it was a separate login.
      keep = dest.expires_at > source.expires_at ? dest : source
      const dropped = keep === source ? dest : source
      await writeTokenFile(replacedPath, deps.daemonCipher.encrypt(JSON.stringify(dropped)))
      note = `; both sides held ${sessionAccountLabel(source)}, the more recently refreshed session kept (the other saved encrypted in ${replacedPath})`
    } else {
      const studio = toDaemon ? source : dest
      const daemon = toDaemon ? dest : source
      const conflict: SessionConflict = {
        provider: sub.id,
        label: sub.label,
        studio: { account: sessionAccountLabel(studio), expiresAt: studio.expires_at },
        daemon: { account: sessionAccountLabel(daemon), expiresAt: daemon.expires_at },
        replacedFile: replacedPath,
      }
      const choice = deps.chooseSession ? await deps.chooseSession(conflict) : (toDaemon ? 'studio' : 'daemon')
      keep = choice === 'studio' ? studio : daemon
      const dropped = keep === source ? dest : source
      // The account not kept is saved once, encrypted with the daemon's cipher (the format of auth.daemon.json).
      await writeTokenFile(replacedPath, deps.daemonCipher.encrypt(JSON.stringify(dropped)))
      note = `; both sides were signed in (Studio: ${conflict.studio.account}, daemon: ${conflict.daemon.account}); kept ${sessionAccountLabel(keep)}, signed out ${sessionAccountLabel(dropped)} (saved encrypted in ${replacedPath}: stop the daemon and rename it to ${DAEMON_TOKEN_FILE} to use that account in the daemon)`
    }
  }

  if (!dest || dest.refresh_token !== keep.refresh_token) {
    const plain = JSON.stringify(keep)
    const encrypted = toDaemon ? deps.daemonCipher.encrypt(plain) : encryptStudioToken(deps, plain)
    await writeTokenFile(destPath, encrypted)
    const check = await readText(destPath)
    const back = parseTokens(check === null ? null : toDaemon ? deps.daemonCipher.decrypt(check) : decryptStudioToken(deps, check))
    if (!back || back.refresh_token !== keep.refresh_token) {
      return result('failed', `${destPath} did not read back after the write; ${sourcePath} kept`, true)
    }
  }
  await deps.beforeSourceDelete?.(sub.id)
  await unlinkIfExists(sourcePath)
  // Without safeStorage, or with Linux basic_text, the moved-back session is written with the key-file cipher.
  // (Embedded Studio itself writes basic_text when that is all it has; its next token refresh does so again.)
  if (!toDaemon && studioTokenUsesKeyFile(deps)) {
    const why = deps.studioSecrets.obfuscationOnly?.() ?? 'OS secure storage is not available'
    note += `; encrypted with the key-file cipher (${why.replace(/\.$/, '')})`
  }
  // Recorded as moved only when Studio's own session went over (a conflict won by the daemon's session leaves it the daemon's).
  return { item: { id: sub.id, label: sub.label, outcome: 'moved', detail: `${sessionAccountLabel(keep)} moved from ${sourcePath} to ${destPath}${note}` }, ...(keep === source ? { movedAccount: keep.account_id } : {}) }
}

// --- app-level MCP OAuth --------------------------------------------------------------

function newerRecord(a: McpOAuthRecord | undefined, b: McpOAuthRecord | undefined): McpOAuthRecord | undefined {
  if (!a) return b
  if (!b) return a
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
}

/** The daemon's app-level MCP store, on the canonical scope (the studio-runtime entry's), legacy records adopted. */
function daemonOAuthStore(deps: HandoverDeps): DaemonAppOAuthStore | null {
  if (!deps.daemonSecrets) return null
  const store = new DaemonAppOAuthStore(deps.daemonSecrets, daemonAppOAuthAccount(studioRuntimeScope(deps.settingsPath)))
  try { store.adoptLegacyAccount(daemonAppOAuthAccount(settingsScope(deps.settingsPath))) } catch { /* the daemon adopts them at its boot */ }
  return store
}

interface McpMove {
  item: HandoverItemResult
  movedUrls?: string[]
}

async function moveMcpOAuth(toDaemon: boolean, deps: HandoverDeps, marker: HandoverMarker | null): Promise<McpMove> {
  const label = 'MCP sign-ins'
  const result = (outcome: HandoverOutcome, detail: string, pending = false): McpMove => ({ item: { id: 'mcp-oauth', label, outcome, detail, ...(pending ? { pending } : {}) } })
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
    return { item: { id: 'mcp-oauth', label, outcome: urls.length > 0 ? 'moved' : 'unchanged', detail: `${urls.length} server sign-in(s) moved into the daemon's secret store` }, movedUrls: urls }
  }

  if (!store) {
    // Studio wrote nothing there at the switch: nothing of its own can be in a store it cannot read.
    if (marker && !marker.keychainUsed) return result('unchanged', `Studio moved no sign-in into the daemon's store (${deps.daemonSecretsUnavailable ?? 'no keychain'})`)
    return result('kept', `the keychain the daemon uses cannot be opened here (${deps.daemonSecretsUnavailable ?? 'no keychain'}); MCP sign-ins stay with the daemon and Studio retries at the next start`, true)
  }
  if (!store.available()) return result('kept', 'the daemon\'s secret store is locked; MCP sign-ins stay with the daemon and Studio retries at the next start', true)
  const daemonBlob = store.exportBlob()
  // What Studio moved, and what was signed in while it ran in local mode; never the daemon's own earlier sign-ins.
  const own = new Set(marker?.daemonOwn.mcpServers ?? [])
  const movedBefore = new Set(marker?.moved.mcpServers ?? [])
  const urls = Object.keys(daemonBlob).filter((url) => movedBefore.has(url) || !own.has(url))
  const ownKept = Object.keys(daemonBlob).length - urls.length
  const ownNote = ownKept > 0 ? `; ${ownKept} sign-in(s) the daemon had before the switch stay with it` : ''
  if (urls.length === 0) return result('unchanged', `no app-level MCP sign-ins of Studio's in the daemon${ownNote}`)
  if (!deps.studioSecrets.available()) return result('kept', 'OS secure storage is not available to Studio, and MCP tokens are never stored unencrypted; they stay with the daemon', true)
  // basic_text: moved back as embedded Studio stores them (mcp-oauth-store), with a note; tracker §6 has the store-wide fix.
  const weak = deps.studioSecrets.obfuscationOnly?.() ?? null
  if (studioText === null && rawStudio !== undefined) return result('kept', `Studio's ${MCP_OAUTH_SETTINGS_KEY} cannot be decrypted here; nothing moved`, true)
  const merged: Record<string, McpOAuthRecord> = { ...studioBlob }
  for (const url of urls) merged[url] = newerRecord(merged[url], daemonBlob[url])!
  await updateJsonFile(deps.settingsPath, (data) => {
    data[MCP_OAUTH_SETTINGS_KEY] = deps.studioSecrets.encrypt(JSON.stringify(merged))
    return true
  })
  const reread = studioSecret(deps, (await readJsonObject(deps.settingsPath)) ?? {}, MCP_OAUTH_SETTINGS_KEY)
  let back: Record<string, McpOAuthRecord> = {}
  try { back = reread ? JSON.parse(reread) as Record<string, McpOAuthRecord> : {} } catch { back = {} }
  if (urls.some((url) => !back[url])) return result('failed', 'Studio\'s settings do not hold every server after the write; the daemon\'s copy kept', true)
  await deps.beforeSourceDelete?.('mcp-oauth')
  for (const url of urls) await store.invalidate(url, 'all')
  return { item: { id: 'mcp-oauth', label, outcome: 'moved', detail: `${urls.length} server sign-in(s) moved back into Studio's settings${ownNote}${weak ? `; stored with safeStorage's basic_text obfuscation, as Studio stores them on this machine (${weak.replace(/\.$/, '')})` : ''}` }, movedUrls: urls }
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
 * `dryRun` (the switch dialog's plan): the same answer, nothing written.
 */
export async function syncStudioRuntimeEntry(deps: HandoverDeps, opts: { ownerPhrase?: string | null; dryRun?: boolean } = {}): Promise<RuntimeEntrySync> {
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
  if (opts.dryRun) return { outcome: 'written', detail: `keychain entry ${account} would be written${valid ? '' : ' with a delegation re-signed by the current owner'}` }
  deps.daemonSecrets.set(account, serializeStudioRuntimeEntry(input))
  const check = verifyStudioRuntimeEntry(deps.daemonSecrets.get(account) ?? '', { ownerDid, runtimeDid, runtimeEncPublicKey })
  if (!check.ok) return { outcome: 'failed', detail: `keychain entry ${account} was written but does not verify (${check.reason}: ${check.detail})` }
  return { outcome: 'written', detail: `keychain entry ${account} written${valid ? '' : ' with a delegation re-signed by the current owner'}` }
}

/** Remove `studio-runtime:<scope>` (switch back to embedded: no copy of Studio's runtime keys outlives local mode). */
function deleteStudioRuntimeEntry(deps: HandoverDeps, marker: HandoverMarker | null): HandoverItemResult {
  const result = (outcome: HandoverOutcome, detail: string, pending = false): HandoverItemResult => ({ id: 'runtime-identity', label: 'Runtime identity', outcome, detail, ...(pending ? { pending } : {}) })
  if (!deps.daemonSecrets) {
    if (marker && !marker.keychainUsed) return result('unchanged', 'Studio wrote no runtime entry at the switch (no keychain the daemon could read)')
    return result('kept', `the keychain cannot be opened here (${deps.daemonSecretsUnavailable ?? 'no keychain'}), so the copy of Studio's runtime key in it is not deleted yet; Studio retries at the next start`, true)
  }
  const account = studioRuntimeAccount(studioRuntimeScope(deps.settingsPath))
  if (deps.daemonSecrets.get(account) === null) return result('unchanged', `no keychain entry ${account}`)
  deps.daemonSecrets.delete(account)
  if (deps.daemonSecrets.get(account) !== null) return result('failed', `keychain entry ${account} could not be deleted`, true)
  return result('deleted', `keychain entry ${account} deleted`)
}

/** Whether mirrorOwnerPhrase would write: a keychain the daemon reads without the entry, and Studio's valid phrase of the owner on record. */
function ownerPhraseToMirror(deps: HandoverDeps, settings: Json): boolean {
  if (!deps.daemonSecrets || deps.daemonSecrets.get(OWNER_MNEMONIC_ACCOUNT)) return false
  const phrase = studioSecret(deps, settings, 'ownerMnemonic')
  try {
    return !!phrase && deriveOwnerIdentity(phrase).did === settings.ownerDid
  } catch {
    return false
  }
}

/** Whether Studio's runtime entry is in the keychain the daemon reads (the way back to embedded deletes it). */
function hasStudioRuntimeEntry(deps: HandoverDeps): boolean {
  return !!deps.daemonSecrets && deps.daemonSecrets.get(studioRuntimeAccount(studioRuntimeScope(deps.settingsPath))) !== null
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
 * credentials, or when the record is gone but Studio has a runtime identity
 * (its entry may be in the keychain).
 */
export async function handoverNeedsKeychain(target: HandoverTarget, userDataDir: string, opts: HandoverOptions = {}): Promise<boolean> {
  if (target === 'remote' || opts.sessionOnly) return false
  const settings = await readJsonObject(join(userDataDir, 'adf-settings.json')).catch(() => null)
  if (target === 'embedded') {
    const read = await readHandoverMarker(userDataDir)
    if (read.state === 'ok') return read.marker.holder === 'daemon'
    return read.state === 'absent' && typeof settings?.runtimeDid === 'string'
  }
  return !!settings && ['ownerMnemonic', 'runtimePrivateKey', MCP_OAUTH_SETTINGS_KEY].some((key) => settings[key] !== undefined)
}

/** The daemon's sign-ins now, read before the first switch moves anything (they stay the daemon's). */
async function daemonSignIns(deps: HandoverDeps): Promise<SignIns> {
  const own = emptySignIns()
  for (const sub of SUBSCRIPTIONS) {
    const { tokens } = await readDaemonTokens(deps, sub)
    if (tokens?.account_id) own.sessions[sub.id] = tokens.account_id
  }
  const store = daemonOAuthStore(deps)
  if (store?.available()) own.mcpServers = store.listServerUrls()
  return own
}

/**
 * Read-only: what a switch to `target` would move, for the switch dialog;
 * exactly what runHandover at the next start changes, read from the stores
 * themselves (REM-19), whatever mode this launch runs: to remote, client
 * keys only; to embedded, what this computer's daemon stores hold for
 * Studio (after local, or remote after local), and nothing else; to local,
 * what Studio holds and the runtime entry when it would be written.
 */
export async function planHandover(target: HandoverTarget, deps: HandoverDeps): Promise<HandoverPlanItem[]> {
  const items: HandoverPlanItem[] = []
  const settings = (await readJsonObject(deps.settingsPath).catch(() => null)) ?? {}
  const clientPath = join(deps.userDataDir, CLIENT_FILE)
  if (target === 'embedded') {
    const client = await readJsonObject(clientPath).catch(() => null)
    const n = Object.keys(client ?? {}).filter(movesToEmbedded).length
    if (n > 0) items.push({ id: 'client-settings', label: 'Client settings', detail: `${n} settings (theme, recent files, …) move back into adf-settings.json` })
  } else {
    const n = Object.keys(settings).filter((key) => CLIENT_KEYS.has(key)).length
    if (n > 0) items.push({ id: 'client-settings', label: 'Client settings', detail: `${n} settings (theme, recent files, …) move into studio-client-settings.json` })
  }
  if (target === 'remote') return items
  const read = await readHandoverMarker(deps.userDataDir)
  if (read.state === 'corrupt') {
    items.push({ id: 'handover-record', label: 'Sign-ins', detail: `not moved: ${read.detail}. Fix or delete it; until then ChatGPT, Grok and MCP sign-ins stay where they are` })
    return items
  }
  const toDaemon = target === 'local'
  const marker = read.state === 'ok' ? read.marker : null
  if (!toDaemon && marker?.holder !== 'daemon') {
    // No record, but Studio's runtime entry is in the keychain (a switch to local happened): it is deleted.
    if (read.state === 'absent' && typeof settings.runtimeDid === 'string' && hasStudioRuntimeEntry(deps)) {
      items.push({ id: 'runtime-identity', label: 'Runtime identity', detail: 'the keychain copy of Studio\'s runtime key, if any, is deleted' })
    }
    return items
  }
  for (const sub of SUBSCRIPTIONS) {
    const raw = await readText(join(deps.userDataDir, sub.dir, toDaemon ? STUDIO_TOKEN_FILE : DAEMON_TOKEN_FILE)).catch(() => null)
    if (raw === null) continue
    const tokens = parseTokens(toDaemon ? decryptStudioToken(deps, raw) : deps.daemonCipher.decrypt(raw))
    if (!toDaemon && tokens && marker?.daemonOwn.sessions[sub.id] === tokens.account_id && marker.moved.sessions[sub.id] !== tokens.account_id) continue
    items.push({ id: sub.id, label: sub.label, detail: `${tokens ? sessionAccountLabel(tokens) : 'a session'} moves ${toDaemon ? 'to the daemon' : 'back to Studio'}` })
  }
  if (toDaemon) {
    if (settings[MCP_OAUTH_SETTINGS_KEY] !== undefined) {
      items.push(deps.daemonSecrets
        ? { id: 'mcp-oauth', label: 'MCP sign-ins', detail: 'app-level MCP server sign-ins move into the daemon\'s keychain entries' }
        : { id: 'mcp-oauth', label: 'MCP sign-ins', detail: `stay in Studio (${deps.daemonSecretsUnavailable ?? 'no keychain'}); agents use their own sealed copies` })
    }
    if (ownerPhraseToMirror(deps, settings)) {
      items.push({ id: 'owner-phrase', label: 'Owner phrase', detail: 'copied into the OS keychain entry ADF / owner-mnemonic, as embedded Studio does; Studio keeps it' })
    }
    if (!deps.daemonSecrets) {
      if (typeof settings.runtimeDid === 'string') items.push({ id: 'runtime-identity', label: 'Runtime identity', detail: `not shared: ${deps.daemonSecretsUnavailable ?? 'no keychain'}. The daemon runs as its own runtime, and files it stamps show as "recognized" in Studio's review. Agents made in Studio unlock their credentials in the daemon only through the owner phrase, which stays in Studio: restore it there (adf identity restore); adf identity trust-daemon then lets them unlock without it` })
    } else if ((await syncStudioRuntimeEntry(deps, { dryRun: true })).outcome === 'written') {
      // Only when the boot would write it: a current entry (local → remote → local) is left as it is.
      items.push({ id: 'runtime-identity', label: 'Runtime identity', detail: 'Studio\'s runtime key is written to the OS keychain so the daemon signs as this runtime' })
    }
  } else {
    const store = daemonOAuthStore(deps)
    if (store?.available()) {
      const own = new Set(marker?.daemonOwn.mcpServers ?? [])
      const moved = new Set(marker?.moved.mcpServers ?? [])
      const n = store.listServerUrls().filter((url) => moved.has(url) || !own.has(url)).length
      if (n > 0) items.push({ id: 'mcp-oauth', label: 'MCP sign-ins', detail: `${n} server sign-in(s) move back into Studio` })
    }
    if (hasStudioRuntimeEntry(deps)) items.push({ id: 'runtime-identity', label: 'Runtime identity', detail: 'the keychain copy of Studio\'s runtime key is deleted' })
  }
  return items
}

/**
 * Move everything that belongs to the side of `target` there (see the module
 * comment). Never throws: each item's failure is reported, its source kept,
 * and the next start retries.
 */
/**
 * Delete each `auth.replaced.json` older than REPLACED_TOKEN_MAX_AGE_DAYS
 * (by its write time). Logged per file; never throws. Returns the deleted paths.
 */
export async function sweepReplacedSessions(userDataDir: string, opts: { now?: number; log?: (line: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const cutoff = (opts.now ?? Date.now()) - REPLACED_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const deleted: string[] = []
  for (const sub of SUBSCRIPTIONS) {
    const path = join(userDataDir, sub.dir, REPLACED_TOKEN_FILE)
    try {
      const st = await fsp.stat(path)
      if (!st.isFile() || st.mtimeMs > cutoff) continue
      await fsp.unlink(path)
      deleted.push(path)
      log(`[Handover] Deleted ${path}: the ${sub.label} set aside by the accounts dialog is older than ${REPLACED_TOKEN_MAX_AGE_DAYS} days`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[Handover] Could not check ${path}: ${errorText(err)}`)
    }
  }
  return deleted
}

export async function runHandover(target: HandoverTarget, deps: HandoverDeps, opts: HandoverOptions = {}): Promise<HandoverReport> {
  const log = deps.log ?? ((line: string) => console.log(line))
  await sweepReplacedSessions(deps.userDataDir, { log })
  const items: HandoverItemResult[] = []
  const record = (item: HandoverItemResult): void => {
    items.push(item)
    const line = `[Handover] ${item.label}: ${item.outcome}${item.pending ? ' (retried at the next start)' : ''} (${item.detail})`
    if (item.outcome === 'failed' || item.pending) console.warn(line)
    else if (item.outcome !== 'unchanged') log(line)
  }
  const run = async <T extends { item: HandoverItemResult }>(id: HandoverItemId, label: string, step: () => Promise<T>): Promise<T | null> => {
    try {
      const out = await step()
      record(out.item)
      return out
    } catch (err) {
      record({ id, label, outcome: 'failed', detail: `${errorText(err)}; the source is kept and the next start retries`, pending: true })
      return null
    }
  }
  const wrap = (item: Promise<HandoverItemResult>) => item.then((i) => ({ item: i }))

  await run('client-settings', 'Client settings', () => wrap(moveClientSettings(target, deps)))

  if (opts.sessionOnly) {
    log(`[Handover] ${target} for this session only: client keys follow it; ChatGPT, Grok and MCP sign-ins and the runtime identity stay where the configured mode keeps them`)
  } else if (target !== 'remote') {
    const read = await readHandoverMarker(deps.userDataDir)
    const settings = await readJsonObject(deps.settingsPath).catch(() => null)
    if (read.state === 'corrupt') {
      record({ id: 'handover-record', label: 'Sign-ins', outcome: 'kept', detail: `not moved: ${read.detail}. Fix or delete it, then restart Studio; until then ChatGPT, Grok and MCP sign-ins stay where they are`, pending: true })
    } else if (target === 'local') {
      await toLocal(deps, read.state === 'ok' ? read.marker : null, run)
    } else {
      let marker = read.state === 'ok' ? read.marker : null
      if (!marker && deps.daemonSecrets && typeof settings?.runtimeDid === 'string' && deps.daemonSecrets.get(studioRuntimeAccount(studioRuntimeScope(deps.settingsPath))) !== null) {
        // The record is gone, but Studio's runtime entry shows a switch to local happened.
        marker = { v: 2, holder: 'daemon', updatedAt: '', keychainUsed: true, moved: emptySignIns(), daemonOwn: emptySignIns(), reconstructed: true }
      }
      if (marker?.holder === 'daemon') await toEmbedded(deps, marker, run, record)
    }
  }

  const changed = items.some((i) => i.outcome === 'moved' || i.outcome === 'written' || i.outcome === 'deleted')
  const failed = items.some((i) => i.outcome === 'failed' || i.pending === true)
  if (changed || failed) log(`[Handover] Switch to ${target}: ${items.filter((i) => i.outcome !== 'unchanged').map((i) => `${i.label} ${i.outcome}`).join(', ')}`)
  return { target, items, changed, failed }
}

type Runner = <T extends { item: HandoverItemResult }>(id: HandoverItemId, label: string, step: () => Promise<T>) => Promise<T | null>

async function toLocal(deps: HandoverDeps, existing: HandoverMarker | null, run: Runner): Promise<void> {
  // Recorded first, with the daemon's own sign-ins as they are before anything moves: a crash from here on resumes in either direction.
  let marker: HandoverMarker = existing?.holder === 'daemon'
    ? { ...existing, keychainUsed: existing.keychainUsed || !!deps.daemonSecrets }
    : { v: 2, holder: 'daemon', updatedAt: '', keychainUsed: !!deps.daemonSecrets, moved: emptySignIns(), daemonOwn: await daemonSignIns(deps) }
  await writeMarker(deps.userDataDir, marker)
  await run('owner-phrase', 'Owner phrase', () => mirrorOwnerPhrase(deps).then((item) => ({ item })))
  await run('runtime-identity', 'Runtime identity', async () => {
    const sync = await syncStudioRuntimeEntry(deps)
    return { item: { id: 'runtime-identity' as const, label: 'Runtime identity', outcome: sync.outcome === 'skipped' ? 'kept' as const : sync.outcome, detail: sync.detail } }
  })
  for (const sub of SUBSCRIPTIONS) {
    const out = await run(sub.id, sub.label, () => moveSubscription(sub, true, deps, marker))
    if (out?.movedAccount) marker = { ...marker, moved: { ...marker.moved, sessions: { ...marker.moved.sessions, [sub.id]: out.movedAccount } } }
  }
  const mcp = await run('mcp-oauth', 'MCP sign-ins', () => moveMcpOAuth(true, deps, marker))
  if (mcp?.movedUrls?.length) marker = { ...marker, moved: { ...marker.moved, mcpServers: [...new Set([...marker.moved.mcpServers, ...mcp.movedUrls])] } }
  await writeMarker(deps.userDataDir, marker)
}

async function toEmbedded(deps: HandoverDeps, marker: HandoverMarker, run: Runner, record: (item: HandoverItemResult) => void): Promise<void> {
  // A daemon still running on these settings could refresh a token after it moved, invalidating Studio's copy.
  const running = deps.daemonRunning ? await deps.daemonRunning().catch(() => null) : null
  if (running) {
    record({ id: 'handover-record', label: 'Sign-ins', outcome: 'kept', pending: true, detail: `not moved back: ${running} and could refresh a token while Studio moves it. Stop it (adf daemon stop) and restart Studio; until then ChatGPT, Grok and MCP sign-ins stay with the daemon` })
    return
  }
  const pending: boolean[] = []
  const note = (out: { item: HandoverItemResult } | null) => pending.push(!out || out.item.pending === true || out.item.outcome === 'failed')
  if (marker.reconstructed) {
    // Without the record Studio cannot tell its sign-ins from the daemon's own: they stay with the daemon (said once).
    record({ id: 'handover-record', label: 'Sign-ins', outcome: 'kept', detail: `${HANDOVER_MARKER_FILE} is missing, so Studio cannot tell its sign-ins from the daemon's own; ChatGPT, Grok and MCP sign-ins stay with the daemon. Sign in again in Studio where needed` })
  } else {
    for (const sub of SUBSCRIPTIONS) note(await run(sub.id, sub.label, () => moveSubscription(sub, false, deps, marker)))
    note(await run('mcp-oauth', 'MCP sign-ins', () => moveMcpOAuth(false, deps, marker)))
  }
  note(await run('runtime-identity', 'Runtime identity', async () => ({ item: deleteStudioRuntimeEntry(deps, marker) })))
  if (!pending.some(Boolean)) {
    await writeMarker(deps.userDataDir, { v: 2, holder: 'studio', updatedAt: '', keychainUsed: false, moved: emptySignIns(), daemonOwn: emptySignIns() })
  }
}
