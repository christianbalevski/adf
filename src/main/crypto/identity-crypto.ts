/**
 * Identity Crypto Utilities
 *
 * Pure functions for AES-256-GCM encryption, PBKDF2 key derivation,
 * Ed25519 key pair generation, and DID:key formatting.
 * Uses Node.js built-in `crypto` only — no external dependencies.
 */

import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'crypto'

// Constants
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_KEY_LENGTH = 32 // AES-256
const PBKDF2_DIGEST = 'sha512'
const SALT_LENGTH = 32
const IV_LENGTH = 12 // GCM nonce
const AUTH_TAG_LENGTH = 16

export interface KdfParams {
  iterations: number
  digest: string
  keyLength: number
}

const DEFAULT_KDF_PARAMS: KdfParams = {
  iterations: PBKDF2_ITERATIONS,
  digest: PBKDF2_DIGEST,
  keyLength: PBKDF2_KEY_LENGTH
}

/**
 * Derive an AES-256 key from a password using PBKDF2.
 */
export function deriveKey(password: string, salt: Buffer, params?: KdfParams): Buffer {
  const p = params ?? DEFAULT_KDF_PARAMS
  return pbkdf2Sync(password, salt, p.iterations, p.keyLength, p.digest)
}

/**
 * Generate a random 32-byte salt for PBKDF2.
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH)
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns ciphertext (encrypted data || 16-byte auth tag) and a 12-byte IV.
 */
export function encrypt(plaintext: Buffer, derivedKey: Buffer): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    iv
  }
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Expects ciphertext = [encrypted data || 16-byte auth tag].
 * Throws on wrong password (auth tag mismatch).
 */
export function decrypt(ciphertext: Buffer, derivedKey: Buffer, iv: Buffer): Buffer {
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LENGTH)
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/**
 * Generate an Ed25519 key pair.
 * Returns DER-encoded keys (pkcs8 for private, spki for public).
 */
export function generateEd25519KeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' }
  })
  return {
    privateKey: Buffer.from(privateKey),
    publicKey: Buffer.from(publicKey)
  }
}

/**
 * Extract raw 32-byte public key from SPKI DER encoding.
 * Ed25519 SPKI has a 12-byte header before the 32-byte key.
 */
export function extractRawPublicKey(spkiDer: Buffer): Buffer {
  // SPKI for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  return spkiDer.subarray(spkiDer.length - 32)
}

// Base58btc alphabet (Bitcoin)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Encode a Buffer to base58btc (Bitcoin alphabet).
 */
export function base58btcEncode(data: Buffer): string {
  // Count leading zeros
  let zeros = 0
  for (let i = 0; i < data.length && data[i] === 0; i++) {
    zeros++
  }

  // Convert to BigInt for base conversion
  let num = BigInt('0x' + (data.length > 0 ? data.toString('hex') : '0'))
  const chars: string[] = []

  while (num > 0n) {
    const remainder = Number(num % 58n)
    num = num / 58n
    chars.push(BASE58_ALPHABET[remainder])
  }

  // Add leading '1's for each leading zero byte
  for (let i = 0; i < zeros; i++) {
    chars.push('1')
  }

  return chars.reverse().join('')
}

/**
 * Convert a raw Ed25519 public key to a did:key identifier.
 * Format: did:key:z<base58btc(0xed01 + raw_public_key)>
 */
export function publicKeyToDid(rawPublicKey: Buffer): string {
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey])
  return `did:key:z${base58btcEncode(prefixed)}`
}

export function getDefaultKdfParams(): KdfParams {
  return { ...DEFAULT_KDF_PARAMS }
}

// ===========================================================================
// Ed25519 Signing / Verification
// ===========================================================================

/**
 * Sign data with an Ed25519 private key (PKCS8 DER format).
 * Returns base64-encoded signature.
 */
export function signEd25519(data: Buffer, privateKeyDer: Buffer): string {
  const keyObject = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
  const signature = sign(null, data, keyObject)
  return signature.toString('base64')
}

/**
 * Verify an Ed25519 signature.
 * Public key as SPKI DER format, signature as base64 string.
 */
export function verifyEd25519(data: Buffer, signatureBase64: string, publicKeyDer: Buffer): boolean {
  try {
    const keyObject = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
    return verify(null, data, keyObject, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/**
 * Reconstruct SPKI DER from a raw 32-byte Ed25519 public key.
 * Ed25519 SPKI header: 30 2a 30 05 06 03 2b 65 70 03 21 00
 */
export function rawPublicKeyToSpki(rawKey: Buffer): Buffer {
  const header = Buffer.from('302a300506032b6570032100', 'hex')
  return Buffer.concat([header, rawKey])
}

/**
 * Decode a base58btc string to a Buffer (inverse of base58btcEncode).
 */
export function base58btcDecode(str: string): Buffer {
  let num = 0n
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`)
    num = num * 58n + BigInt(idx)
  }

  // Count leading '1's (zero bytes)
  let leadingZeros = 0
  for (const char of str) {
    if (char !== '1') break
    leadingZeros++
  }

  // Convert BigInt to bytes
  const hex = num === 0n ? '' : num.toString(16)
  const paddedHex = hex.length % 2 ? '0' + hex : hex
  const dataBytes = Buffer.from(paddedHex, 'hex')
  const zeros = Buffer.alloc(leadingZeros)
  return Buffer.concat([zeros, dataBytes])
}

/**
 * Extract the raw 32-byte Ed25519 public key from a did:key identifier.
 * Format: did:key:z<base58btc(0xed01 + raw_public_key)>
 * Returns null if the DID format is invalid.
 */
export function didToPublicKey(did: string): Buffer | null {
  if (!did.startsWith('did:key:z')) return null
  try {
    const encoded = did.slice('did:key:z'.length)
    const decoded = base58btcDecode(encoded)
    // Strip 2-byte multicodec prefix (0xed 0x01 = Ed25519 public key)
    if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return null
    return decoded.subarray(2)
  } catch {
    return null
  }
}
