/**
 * Daemon runtime encryption key (mcp-credential-identity Phase C).
 *
 * The headless daemon has no safeStorage, so its X25519 envelope key lives as
 * a 0600 file next to the daemon settings. Studio adds a credentials-envelope
 * keyslot wrapped to this key for every trusted daemon (settings key
 * `trustedDaemonEncKeys`), after which the daemon can unlock `env:credentials`
 * rows through the ordinary D10 runtime-slot cascade — same crypto, different
 * key custody.
 *
 * The key is minted once and then immutable: a corrupt or unreadable key file
 * throws instead of re-minting, because a fresh key would silently orphan
 * every envelope slot already wrapped to the old one (the same trap Studio's
 * `secretStatus === 'locked'` guard exists for).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, createPrivateKey, createPublicKey } from 'crypto'
import {
  generateX25519KeyPair,
  extractRawX25519PublicKey,
} from '../crypto/envelope-crypto'
import { protectSecretFile } from '../utils/secret-file'

export interface DaemonEncKey {
  /** X25519 private key, PKCS8 DER — feeds AdfWorkspace.unlockEnvelopes. */
  privateKeyPkcs8: Buffer
  /** Raw 32-byte public key — what Studio wraps keyslots to. */
  publicKeyRaw: Buffer
  /** Base64 of publicKeyRaw — the value the user pastes into Studio. */
  publicKeyB64: string
  /** Slot label (recipient_did) — stable fingerprint of the public key. */
  label: string
  keyPath: string
  pubKeyPath: string
}

const KEY_FILENAME = 'runtime-enc-key'

/** Stable slot label for a daemon key: `daemon:<sha256(pub) first 16 hex>`. */
export function daemonEncKeyLabel(publicKeyRaw: Buffer): string {
  return `daemon:${createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16)}`
}

interface KeyFileShape {
  v: number
  private_key_pkcs8: string
  public_key: string
}

/** Derive the raw public key from a PKCS8 private key (consistency check). */
function publicFromPrivate(privateKeyPkcs8: Buffer): Buffer {
  const pub = createPublicKey(createPrivateKey({ key: privateKeyPkcs8, format: 'der', type: 'pkcs8' }))
  return extractRawX25519PublicKey(pub.export({ format: 'der', type: 'spki' }) as Buffer)
}

/**
 * Ensure the daemon's X25519 envelope keypair exists at
 * `<settingsDir>/runtime-enc-key` (0600) with its shareable public half at
 * `runtime-enc-key.pub`. Stable across boots; never re-mints over an
 * existing file — corruption throws plainly instead (see module doc).
 */
export function ensureDaemonEncKey(settingsDir: string): DaemonEncKey {
  mkdirSync(settingsDir, { recursive: true })
  const keyPath = join(settingsDir, KEY_FILENAME)
  const pubKeyPath = keyPath + '.pub'

  let privateKeyPkcs8: Buffer
  if (existsSync(keyPath)) {
    let parsed: KeyFileShape
    try {
      parsed = JSON.parse(readFileSync(keyPath, 'utf-8')) as KeyFileShape
      if (typeof parsed?.private_key_pkcs8 !== 'string') throw new Error('missing private_key_pkcs8')
      privateKeyPkcs8 = Buffer.from(parsed.private_key_pkcs8, 'base64')
      // Round-trip through node crypto so a truncated/garbled key fails here,
      // not silently at unlock time.
      publicFromPrivate(privateKeyPkcs8)
    } catch (err) {
      throw new Error(
        `Daemon runtime encryption key at ${keyPath} is unreadable or corrupt ` +
        `(${err instanceof Error ? err.message : String(err)}). REFUSING to mint a replacement — a new key ` +
        'would orphan every credentials-envelope slot already wrapped to this daemon. Restore the file from ' +
        'backup, or delete it deliberately to start over (agents will need re-provisioning in Studio).',
      )
    }
    // Enforce permissions even if the file predates this check or was copied
    // (on Windows its own ACL, W5-D1), and on the revocation list next to it.
    protectSecretFile(keyPath)
    const revokedPath = join(settingsDir, REVOKED_FILENAME)
    if (existsSync(revokedPath)) protectSecretFile(revokedPath)
  } else {
    const kp = generateX25519KeyPair()
    privateKeyPkcs8 = kp.privateKey
    const record: KeyFileShape = {
      v: 1,
      private_key_pkcs8: kp.privateKey.toString('base64'),
      public_key: extractRawX25519PublicKey(kp.publicKey).toString('base64'),
    }
    writeFileSync(keyPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    protectSecretFile(keyPath)
  }

  const publicKeyRaw = publicFromPrivate(privateKeyPkcs8)
  const publicKeyB64 = publicKeyRaw.toString('base64')
  // (Re)write the pub sidecar so it always matches the private key.
  const pubLine = publicKeyB64 + '\n'
  if (!existsSync(pubKeyPath) || readFileSync(pubKeyPath, 'utf-8') !== pubLine) {
    writeFileSync(pubKeyPath, pubLine, { mode: 0o644 })
  }

  return {
    privateKeyPkcs8,
    publicKeyRaw,
    publicKeyB64,
    label: daemonEncKeyLabel(publicKeyRaw),
    keyPath,
    pubKeyPath,
  }
}

const REVOKED_FILENAME = KEY_FILENAME + '.revoked'

/**
 * Slot labels of daemon keys the owner revoked (`adf identity untrust-daemon`):
 * the daemon removes slots under these labels from every agent it opens.
 */
export function readRevokedDaemonKeyLabels(settingsDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(settingsDir, REVOKED_FILENAME), 'utf-8')) as { labels?: unknown }
    return Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string' && l.startsWith('daemon:')) : []
  } catch {
    return []
  }
}

/**
 * Revocation (`adf identity untrust-daemon`): replace the daemon's key with a
 * fresh one and record the old key's label as revoked. The label is recorded
 * first, so a crash in between leaves the old key in use with its slots
 * already marked for removal; the new key replaces the file atomically, and
 * the old private key is gone from it. Envelope slots wrapped to the old key
 * no longer open for this daemon; a copy of the old key file elsewhere still
 * opens them until they are removed.
 */
export function rotateDaemonEncKey(settingsDir: string): { key: DaemonEncKey; retiredLabel: string } {
  const current = ensureDaemonEncKey(settingsDir)
  const revoked = readRevokedDaemonKeyLabels(settingsDir)
  if (!revoked.includes(current.label)) {
    const revokedPath = join(settingsDir, REVOKED_FILENAME)
    writeFileSync(revokedPath + '.tmp', JSON.stringify({ v: 1, labels: [...revoked, current.label] }, null, 2) + '\n', { mode: 0o600 })
    protectSecretFile(revokedPath + '.tmp') // the ACL moves with the rename
    renameSync(revokedPath + '.tmp', revokedPath)
  }
  const kp = generateX25519KeyPair()
  const record: KeyFileShape = {
    v: 1,
    private_key_pkcs8: kp.privateKey.toString('base64'),
    public_key: extractRawX25519PublicKey(kp.publicKey).toString('base64'),
  }
  writeFileSync(current.keyPath + '.tmp', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  protectSecretFile(current.keyPath + '.tmp') // the ACL moves with the rename
  renameSync(current.keyPath + '.tmp', current.keyPath)
  try { chmodSync(current.keyPath, 0o600) } catch { /* windows / read-only fs */ }
  return { key: ensureDaemonEncKey(settingsDir), retiredLabel: current.label }
}
