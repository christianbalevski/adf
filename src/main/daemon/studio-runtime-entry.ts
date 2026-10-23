/**
 * Studio's runtime identity in the OS keychain, for the local daemon to adopt
 * (design daemon-backend.md §5.3, D10).
 *
 * In `local` mode one machine and one OS user is one runtime: the daemon
 * signs with Studio's runtime key, stamps Studio's runtime DID and unlocks
 * with Studio's runtime encryption key. Studio main writes the entry when it
 * switches to `local` (W4-A); the daemon reads and verifies it at boot and on
 * every identity refresh (daemon-identity.ts). No HTTP route carries it.
 *
 * Entry: service `ADF` (KEYCHAIN_SERVICE), account
 * `studio-runtime:<studioRuntimeScope(settingsPath)>`, value = the JSON of
 * StudioRuntimeEntryV1 (`serializeStudioRuntimeEntry`). The scope ties the
 * entry to one settings file (canonical path: native realpath, case-folded
 * on Windows and macOS), so a daemon on another settings file never adopts
 * it, and two spellings of one path agree.
 *
 * The daemon adopts an entry only when ALL of these hold; otherwise it keeps
 * its own runtime and logs the reason (never key material):
 *  - `v` is 1 and every field has its type;
 *  - `runtimeDelegation.issuer` is the owner DID in the settings file, and
 *    its role is `runtime`;
 *  - the DID derived from `runtimePrivateKey` equals `runtimeDid`, equals the
 *    delegation subject, and equals `runtimeDid` in the settings file;
 *  - the delegation signature verifies (and has not expired);
 *  - the public key derived from `runtimeEncPrivateKey` equals
 *    `runtimeEncPublicKey` in the entry and in the settings file.
 *
 * Electron-free; Studio main imports the type and the serializer.
 */

import { createHash, createPrivateKey, createPublicKey } from 'crypto'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import { extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'
import { extractRawX25519PublicKey } from '../crypto/envelope-crypto'
import { verifyAttestation } from '../services/attestation.service'

export const STUDIO_RUNTIME_ACCOUNT_PREFIX = 'studio-runtime:'
export const STUDIO_RUNTIME_ENTRY_VERSION = 1

/** Keychain account for the settings file with this scope (studioRuntimeScope). */
export function studioRuntimeAccount(scope: string): string {
  return `${STUDIO_RUNTIME_ACCOUNT_PREFIX}${scope}`
}

/**
 * Canonical form of a settings path, as the agent lease canonicalizes agent
 * files (W0-C): native realpath (resolves junctions, 8.3 names and the real
 * case), long-path prefix stripped, then case-folded on Windows and macOS.
 * Falls back to path.resolve for a path that does not exist yet.
 */
export function canonicalSettingsPath(settingsPath: string, platform: NodeJS.Platform = process.platform): string {
  let path = resolve(settingsPath)
  try {
    path = realpathSync.native(path)
  } catch { /* not created yet */ }
  if (path.startsWith('\\\\?\\')) path = path.slice(4)
  if (platform === 'win32') return path.replace(/\//g, '\\').toLowerCase()
  if (platform === 'darwin') return path.normalize('NFC').toLowerCase()
  return path
}

/**
 * Scope of the `studio-runtime:` account: sha256 of the canonical settings
 * path, first 12 hex characters. Studio main (W4-A) and the daemon MUST both
 * use this function. (Not settingsScope: changing that one would orphan the
 * provider keys and daemon runtime keys already stored under it.)
 */
export function studioRuntimeScope(settingsPath: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(canonicalSettingsPath(settingsPath, platform)).digest('hex').slice(0, 12)
}

/**
 * Value of the `studio-runtime:<scope>` keychain entry. Every key field is
 * Studio's own settings value, verbatim, so the writer copies and the reader
 * compares without re-encoding.
 */
export interface StudioRuntimeEntryV1 {
  v: 1
  /** Studio's `runtimeDid`: did:key of the Ed25519 runtime signing key. */
  runtimeDid: string
  /** Studio's `runtimeDelegation`: owner-signed, role `runtime`, subject `runtimeDid`. */
  runtimeDelegation: AlfAttestation
  /** Studio's `runtimePrivateKey` secret: base64 PKCS8 DER, Ed25519. */
  runtimePrivateKey: string
  /** Studio's `runtimeEncPrivateKey` secret: base64 PKCS8 DER, X25519. */
  runtimeEncPrivateKey: string
  /** Studio's `runtimeEncPublicKey`: base64 of the raw 32-byte X25519 public key. */
  runtimeEncPublicKey: string
  /** ISO 8601 time Studio wrote the entry. Diagnostics only. */
  writtenAt: string
}

export type StudioRuntimeEntryInput = Omit<StudioRuntimeEntryV1, 'v' | 'writtenAt'> & { writtenAt?: string }

/** The keychain value for an entry. Studio main (W4-A) writes exactly this. */
export function serializeStudioRuntimeEntry(input: StudioRuntimeEntryInput): string {
  const entry: StudioRuntimeEntryV1 = {
    v: STUDIO_RUNTIME_ENTRY_VERSION,
    runtimeDid: input.runtimeDid,
    runtimeDelegation: input.runtimeDelegation,
    runtimePrivateKey: input.runtimePrivateKey,
    runtimeEncPrivateKey: input.runtimeEncPrivateKey,
    runtimeEncPublicKey: input.runtimeEncPublicKey,
    writtenAt: input.writtenAt ?? new Date().toISOString(),
  }
  return JSON.stringify(entry)
}

export type StudioRuntimeRejectReason =
  | 'malformed'
  | 'unsupported_version'
  | 'no_owner'
  | 'owner_mismatch'
  | 'bad_signing_key'
  | 'subject_mismatch'
  | 'bad_delegation'
  | 'runtime_did_mismatch'
  | 'enc_key_mismatch'
  /** An entry exists only under the uncanonicalized path's scope (written by a Studio build that did not canonicalize). */
  | 'scope_mismatch'

/** A verified entry, decoded for use. Never log or serialize it. */
export interface AdoptedStudioRuntime {
  runtimeDid: string
  runtimeDelegation: AlfAttestation
  runtimePrivateKeyB64: string
  runtimeEncPrivateKeyB64: string
  runtimeEncPublicKeyB64: string
}

export type StudioRuntimeVerification =
  | { ok: true; runtime: AdoptedStudioRuntime }
  /** `detail` names DIDs and fields only, never key bytes; safe to log and return. */
  | { ok: false; reason: StudioRuntimeRejectReason; detail: string }

export interface StudioRuntimeExpectations {
  /** `ownerDid` in the settings file. */
  ownerDid: unknown
  /** Studio's `runtimeDid` in the settings file. */
  runtimeDid: unknown
  /** Studio's `runtimeEncPublicKey` in the settings file. */
  runtimeEncPublicKey: unknown
}

function reject(reason: StudioRuntimeRejectReason, detail: string): StudioRuntimeVerification {
  return { ok: false, reason, detail }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The attestation fields only (issuer, subject, role, issued_at, expires_at,
 * scope, signature), so nothing else in the entry rides along into settings
 * reads or /ping. Verification runs on this copy.
 */
function normalizeDelegation(raw: unknown): AlfAttestation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  for (const field of ['issuer', 'subject', 'role', 'issued_at', 'signature'] as const) {
    if (!isNonEmptyString(d[field])) return null
  }
  for (const field of ['expires_at', 'scope'] as const) {
    if (d[field] !== undefined && typeof d[field] !== 'string') return null
  }
  // v2 signs every field: kept whole, for verifyAttestation to judge.
  if (d.v === 2) return d as unknown as AlfAttestation
  return {
    issuer: d.issuer as string,
    subject: d.subject as string,
    role: d.role as string,
    issued_at: d.issued_at as string,
    ...(d.expires_at !== undefined ? { expires_at: d.expires_at as string } : {}),
    ...(d.scope !== undefined ? { scope: d.scope as string } : {}),
    signature: d.signature as string,
  }
}

/** Verify a raw keychain value against the settings file (see module doc). */
export function verifyStudioRuntimeEntry(raw: string, expected: StudioRuntimeExpectations): StudioRuntimeVerification {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return reject('malformed', 'the entry is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('malformed', 'the entry is not a JSON object')
  const entry = parsed as Record<string, unknown>
  if (entry.v !== STUDIO_RUNTIME_ENTRY_VERSION) {
    return typeof entry.v === 'number'
      ? reject('unsupported_version', `entry version ${entry.v} is not supported (this daemon reads version ${STUDIO_RUNTIME_ENTRY_VERSION})`)
      : reject('malformed', 'the entry has no version field')
  }
  for (const field of ['runtimeDid', 'runtimePrivateKey', 'runtimeEncPrivateKey', 'runtimeEncPublicKey'] as const) {
    if (!isNonEmptyString(entry[field])) return reject('malformed', `field ${field} is missing or not a string`)
  }
  const delegation = normalizeDelegation(entry.runtimeDelegation)
  if (!delegation) return reject('malformed', 'field runtimeDelegation is missing or not an attestation')
  const runtimeDid = entry.runtimeDid as string

  if (!isNonEmptyString(expected.ownerDid)) return reject('no_owner', 'the settings file has no owner DID to check the delegation against')
  if (delegation.role !== 'runtime') return reject('bad_delegation', `the delegation has role "${String(delegation.role)}", not "runtime"`)
  if (delegation.issuer !== expected.ownerDid) {
    return reject('owner_mismatch', `the delegation is issued by ${delegation.issuer}, but this machine's owner is ${expected.ownerDid}`)
  }

  let derivedDid: string
  try {
    const key = createPrivateKey({ key: Buffer.from(entry.runtimePrivateKey as string, 'base64'), format: 'der', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'ed25519') return reject('bad_signing_key', 'runtimePrivateKey is not an Ed25519 key')
    derivedDid = publicKeyToDid(extractRawPublicKey(createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer))
  } catch {
    return reject('bad_signing_key', 'runtimePrivateKey is not a readable PKCS8 key')
  }
  if (derivedDid !== runtimeDid) return reject('subject_mismatch', `the signing key belongs to ${derivedDid}, not the entry's runtimeDid ${runtimeDid}`)
  if (delegation.subject !== derivedDid) return reject('subject_mismatch', `the delegation certifies ${delegation.subject}, not the signing key's ${derivedDid}`)
  if (!verifyAttestation(delegation, { expectedSubject: derivedDid })) {
    return reject('bad_delegation', `the delegation signature from ${delegation.issuer} does not verify, or it has expired`)
  }
  if (expected.runtimeDid !== derivedDid) {
    return reject('runtime_did_mismatch', `the settings file's runtimeDid is ${isNonEmptyString(expected.runtimeDid) ? expected.runtimeDid : '(none)'}, not ${derivedDid}`)
  }

  let derivedEncPublic: string
  try {
    const key = createPrivateKey({ key: Buffer.from(entry.runtimeEncPrivateKey as string, 'base64'), format: 'der', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'x25519') return reject('enc_key_mismatch', 'runtimeEncPrivateKey is not an X25519 key')
    derivedEncPublic = extractRawX25519PublicKey(createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
  } catch {
    return reject('enc_key_mismatch', 'runtimeEncPrivateKey is not a readable PKCS8 key')
  }
  if (derivedEncPublic !== entry.runtimeEncPublicKey) {
    return reject('enc_key_mismatch', "runtimeEncPrivateKey does not match the entry's runtimeEncPublicKey")
  }
  if (derivedEncPublic !== expected.runtimeEncPublicKey) {
    return reject('enc_key_mismatch', "runtimeEncPrivateKey does not match runtimeEncPublicKey in the settings file")
  }

  return {
    ok: true,
    runtime: {
      runtimeDid: derivedDid,
      runtimeDelegation: delegation,
      runtimePrivateKeyB64: entry.runtimePrivateKey as string,
      runtimeEncPrivateKeyB64: entry.runtimeEncPrivateKey as string,
      runtimeEncPublicKeyB64: derivedEncPublic,
    },
  }
}
