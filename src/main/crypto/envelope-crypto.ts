/**
 * Envelope Encryption Primitives (ADF_IDENTITY_SPEC D5–D8)
 *
 * A random 32-byte DEK encrypts secret rows; the DEK is wrapped once per
 * keyslot. Any slot opens the envelope. Slot types:
 *
 *  - Key slots (`owner` / `runtime`): X25519 ECDH with an ephemeral sender key
 *    → HKDF-SHA256 → AES-256-GCM over the DEK. Wrapping needs only the
 *    recipient's *public* key, so encrypting-to-owner never touches the seed.
 *  - Password slots: scrypt (N=2^17, r=8, p=1) → AES-256-GCM over the DEK.
 *    Deliberately not the legacy PBKDF2/100k path (spec §8.3 amendment).
 *
 * Node built-in `crypto` only — X25519 via diffieHellman, no new dependencies.
 * This module is pure key-wrapping; envelope *storage* (adf_identity rows,
 * slot policies per envelope) is layered on top in phase 3.
 */

import {
  randomBytes,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  scryptSync
} from 'crypto'
import { encrypt, decrypt } from './identity-crypto'

export const DEK_LENGTH = 32

/** Domain separation for the HKDF step; the envelope name is appended. */
export const ENVELOPE_HKDF_INFO_PREFIX = 'adf-envelope-v1:'

export type EnvelopeName = 'identity' | 'credentials'

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** N=2^17: ~134 MB, interactive-unlock grade. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 }
const SCRYPT_MAXMEM = 512 * 1024 * 1024
const PASSWORD_SALT_LENGTH = 32

/** DEK wrapped to an X25519 public key. All buffers base64. */
export interface KeySlotRecord {
  type: 'owner' | 'runtime'
  /** DID of the identity this slot belongs to — slot selection label, not used cryptographically */
  recipient_did: string
  /** Ephemeral sender X25519 public key, raw 32 bytes */
  ephemeral_pub: string
  iv: string
  /** ciphertext || 16-byte GCM auth tag */
  wrapped_dek: string
}

/** DEK wrapped to a password via scrypt. All buffers base64. */
export interface PasswordSlotRecord {
  type: 'password'
  kdf: 'scrypt'
  kdf_params: ScryptParams
  salt: string
  iv: string
  wrapped_dek: string
}

export type EnvelopeSlot = KeySlotRecord | PasswordSlotRecord

// ===========================================================================
// X25519 key handling
// ===========================================================================
// DER headers mirror the Ed25519 ones in identity-crypto.ts / mnemonic-identity.ts;
// X25519's OID is 1.3.101.110 (2b 65 6e) vs Ed25519's 1.3.101.112 (2b 65 70).

const X25519_PKCS8_HEADER = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex')

/** Generate an X25519 key pair (pkcs8/spki DER, matching the Ed25519 helpers). */
export function generateX25519KeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' }
  })
  return { privateKey: Buffer.from(privateKey), publicKey: Buffer.from(publicKey) }
}

/** Wrap a raw 32-byte X25519 scalar in PKCS8 DER (clamping happens inside the DH op). */
export function rawX25519PrivateToPkcs8(seed32: Buffer): Buffer {
  if (seed32.length !== 32) throw new Error(`Expected 32-byte X25519 private key, got ${seed32.length}`)
  return Buffer.concat([X25519_PKCS8_HEADER, seed32])
}

/** Reconstruct SPKI DER from a raw 32-byte X25519 public key. */
export function rawX25519PublicToSpki(raw32: Buffer): Buffer {
  if (raw32.length !== 32) throw new Error(`Expected 32-byte X25519 public key, got ${raw32.length}`)
  return Buffer.concat([X25519_SPKI_HEADER, raw32])
}

/** Extract the raw 32-byte public key from X25519 SPKI DER. */
export function extractRawX25519PublicKey(spkiDer: Buffer): Buffer {
  return spkiDer.subarray(spkiDer.length - 32)
}

function deriveWrapKey(sharedSecret: Buffer, ephemeralPubRaw: Buffer, envelope: EnvelopeName): Buffer {
  return Buffer.from(
    hkdfSync('sha256', sharedSecret, ephemeralPubRaw, ENVELOPE_HKDF_INFO_PREFIX + envelope, 32)
  )
}

// ===========================================================================
// Slot creation / opening
// ===========================================================================

export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH)
}

/**
 * Wrap a DEK to a recipient's X25519 public key (raw 32 bytes).
 * Only the public key is needed — the owner slot is written without the seed.
 */
export function createKeySlot(
  dek: Buffer,
  envelope: EnvelopeName,
  type: 'owner' | 'runtime',
  recipientDid: string,
  recipientPublicRaw: Buffer
): KeySlotRecord {
  const ephemeral = generateX25519KeyPair()
  const ephemeralPubRaw = extractRawX25519PublicKey(ephemeral.publicKey)
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({ key: ephemeral.privateKey, format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: rawX25519PublicToSpki(recipientPublicRaw), format: 'der', type: 'spki' })
  })
  const wrapKey = deriveWrapKey(sharedSecret, ephemeralPubRaw, envelope)
  const { ciphertext, iv } = encrypt(dek, wrapKey)
  return {
    type,
    recipient_did: recipientDid,
    ephemeral_pub: ephemeralPubRaw.toString('base64'),
    iv: iv.toString('base64'),
    wrapped_dek: ciphertext.toString('base64')
  }
}

/**
 * Unwrap a key slot with the recipient's X25519 private key (PKCS8 DER).
 * Returns null on any failure (wrong key, tampered slot, malformed record).
 */
export function openKeySlot(
  slot: KeySlotRecord,
  envelope: EnvelopeName,
  recipientPrivatePkcs8: Buffer
): Buffer | null {
  try {
    const ephemeralPubRaw = Buffer.from(slot.ephemeral_pub, 'base64')
    const sharedSecret = diffieHellman({
      privateKey: createPrivateKey({ key: recipientPrivatePkcs8, format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: rawX25519PublicToSpki(ephemeralPubRaw), format: 'der', type: 'spki' })
    })
    const wrapKey = deriveWrapKey(sharedSecret, ephemeralPubRaw, envelope)
    const dek = decrypt(Buffer.from(slot.wrapped_dek, 'base64'), wrapKey, Buffer.from(slot.iv, 'base64'))
    return dek.length === DEK_LENGTH ? dek : null
  } catch {
    return null
  }
}

/** Wrap a DEK to a password via scrypt (D8 — never the legacy PBKDF2 path). */
export function createPasswordSlot(
  dek: Buffer,
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS
): PasswordSlotRecord {
  const salt = randomBytes(PASSWORD_SALT_LENGTH)
  const wrapKey = scryptSync(password, salt, DEK_LENGTH, { ...params, maxmem: SCRYPT_MAXMEM })
  const { ciphertext, iv } = encrypt(dek, wrapKey)
  return {
    type: 'password',
    kdf: 'scrypt',
    kdf_params: { ...params },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    wrapped_dek: ciphertext.toString('base64')
  }
}

/** Unwrap a password slot. Returns null on wrong password or malformed record. */
export function openPasswordSlot(slot: PasswordSlotRecord, password: string): Buffer | null {
  try {
    if (slot.kdf !== 'scrypt') return null
    const wrapKey = scryptSync(password, Buffer.from(slot.salt, 'base64'), DEK_LENGTH, {
      ...slot.kdf_params,
      maxmem: SCRYPT_MAXMEM
    })
    const dek = decrypt(Buffer.from(slot.wrapped_dek, 'base64'), wrapKey, Buffer.from(slot.iv, 'base64'))
    return dek.length === DEK_LENGTH ? dek : null
  } catch {
    return null
  }
}
