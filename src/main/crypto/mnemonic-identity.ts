/**
 * Mnemonic-Rooted Identity
 *
 * BIP-39 mnemonic → seed → SLIP-0010 hardened Ed25519 derivation for the
 * app-level owner identity. The mnemonic is the recovery artifact: entering
 * it on another machine re-derives the same owner DID.
 *
 * SLIP-0010 for Ed25519 supports hardened derivation only, so child keys are
 * unlinkable without disclosure — ownership is proven via delegation
 * attestations (attestation.service.ts), not derivation math.
 */

import { createHmac, createPrivateKey, createPublicKey } from 'crypto'
import { generateMnemonic as bip39Generate, validateMnemonic as bip39Validate, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { extractRawPublicKey, publicKeyToDid } from './identity-crypto'

/** Fixed derivation path for the owner root key. All segments hardened. */
export const OWNER_KEY_PATH = "m/44'/0'/0'"

const ED25519_CURVE = 'ed25519 seed'
const HARDENED_OFFSET = 0x80000000

/** Generate a fresh 12-word BIP-39 mnemonic (128 bits of entropy). */
export function generateMnemonic(): string {
  return bip39Generate(wordlist, 128)
}

/** True iff the phrase is a valid BIP-39 mnemonic (english wordlist). */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic.trim().toLowerCase(), wordlist)
}

/** BIP-39 mnemonic → 64-byte seed (empty passphrase). */
export function mnemonicToSeed(mnemonic: string): Buffer {
  return Buffer.from(mnemonicToSeedSync(mnemonic.trim().toLowerCase()))
}

/**
 * SLIP-0010 Ed25519 key derivation. Hardened-only (Ed25519 has no normal
 * derivation); non-hardened path segments throw.
 * Returns the 32-byte private key seed + chain code at the given path.
 */
export function slip10DeriveEd25519(seed: Buffer, path: string): { key: Buffer; chainCode: Buffer } {
  const master = createHmac('sha512', ED25519_CURVE).update(seed).digest()
  let key = master.subarray(0, 32)
  let chainCode = master.subarray(32)

  const segments = path.split('/')
  if (segments[0] !== 'm') throw new Error(`Invalid derivation path: ${path}`)

  for (const segment of segments.slice(1)) {
    if (!segment.endsWith("'")) {
      throw new Error(`Ed25519 SLIP-0010 requires hardened segments, got: ${segment}`)
    }
    const index = parseInt(segment.slice(0, -1), 10)
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
      throw new Error(`Invalid path segment: ${segment}`)
    }
    const indexBuf = Buffer.alloc(4)
    indexBuf.writeUInt32BE(index + HARDENED_OFFSET)
    const data = Buffer.concat([Buffer.from([0x00]), key, indexBuf])
    const digest = createHmac('sha512', chainCode).update(data).digest()
    key = digest.subarray(0, 32)
    chainCode = digest.subarray(32)
  }

  return { key: Buffer.from(key), chainCode: Buffer.from(chainCode) }
}

/**
 * Wrap a raw 32-byte Ed25519 private key seed in PKCS8 DER so it works with
 * the existing signEd25519/createPrivateKey pipeline.
 * Header mirrors rawPublicKeyToSpki in identity-crypto.ts.
 */
export function rawEd25519SeedToPkcs8(seed32: Buffer): Buffer {
  if (seed32.length !== 32) throw new Error(`Expected 32-byte Ed25519 seed, got ${seed32.length}`)
  const header = Buffer.from('302e020100300506032b657004220420', 'hex')
  return Buffer.concat([header, seed32])
}

/**
 * Derive the owner identity from a mnemonic: private key (PKCS8 DER),
 * public key (SPKI DER), and did:key. Deterministic — same mnemonic,
 * same DID, on any machine.
 */
export function deriveOwnerIdentity(mnemonic: string): { privateKeyPkcs8: Buffer; publicKeySpki: Buffer; did: string } {
  const seed = mnemonicToSeed(mnemonic)
  const { key } = slip10DeriveEd25519(seed, OWNER_KEY_PATH)
  const privateKeyPkcs8 = rawEd25519SeedToPkcs8(key)
  const keyObject = createPrivateKey({ key: privateKeyPkcs8, format: 'der', type: 'pkcs8' })
  const publicKeySpki = createPublicKey(keyObject).export({ format: 'der', type: 'spki' }) as Buffer
  const did = publicKeyToDid(extractRawPublicKey(Buffer.from(publicKeySpki)))
  return { privateKeyPkcs8, publicKeySpki: Buffer.from(publicKeySpki), did }
}
