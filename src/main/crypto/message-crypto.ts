/**
 * Message Crypto — payload encryption to recipient DIDs (spec §8.5 level 2)
 *
 * An agent's DID encodes its Ed25519 signing key. Encryption needs an X25519
 * Diffie-Hellman key, so we use the standard birational Ed25519 → X25519
 * conversion (libsodium's crypto_sign_ed25519_pk_to_curve25519; the same
 * mapping age uses for ssh-ed25519 recipients) via the audited @noble/curves.
 * That means an agent can encrypt to any peer knowing ONLY its DID — no key
 * publication, no handshake.
 *
 * Same-key-for-sign-and-DH is safe here because the derived key is domain
 * separated: HKDF info "adf-msg-v1" never overlaps the envelope ("adf-envelope-
 * v1:*") or signature domains.
 *
 * Wire shape: the whole original payload (including its inner signature) is
 * serialized and sealed with an ephemeral-ECDH-derived key. The encrypted
 * payload rides in the normal AlfPayload fields:
 *   content       = base64(iv || ciphertext || gcm-tag)
 *   content_type  = 'application/x-adf-encrypted'
 *   meta.enc      = { v: 1, alg: 'x25519-hkdf-aes256gcm', epk: base64(ephemeral X25519 pub) }
 *   sent_at       = copied from the plaintext payload (already public on the message envelope)
 */

import { hkdfSync, diffieHellman, createPrivateKey, createPublicKey } from 'crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { AlfPayload } from '../../shared/types/adf-v02.types'
import { didToPublicKey } from './identity-crypto'
import {
  generateX25519KeyPair,
  extractRawX25519PublicKey,
  rawX25519PrivateToPkcs8,
  rawX25519PublicToSpki,
  sealWithDek,
  openWithDek
} from './envelope-crypto'

const MESSAGE_HKDF_INFO = 'adf-msg-v1'
export const ENCRYPTED_CONTENT_TYPE = 'application/x-adf-encrypted'

interface EncMeta {
  v: number
  alg: string
  epk: string
}

/** Convert an Ed25519 raw public key (32 bytes) to its X25519 form. */
export function ed25519PublicToX25519(rawEd25519Pub: Buffer): Buffer {
  return Buffer.from(ed25519.utils.toMontgomery(rawEd25519Pub))
}

/** Convert an Ed25519 PKCS8 private key to an X25519 PKCS8 private key. */
export function ed25519PrivateToX25519Pkcs8(ed25519Pkcs8: Buffer): Buffer {
  // Ed25519 PKCS8 is a fixed 16-byte header + 32-byte seed (mirrors the
  // header constants in identity-crypto/envelope-crypto).
  const seed = ed25519Pkcs8.subarray(ed25519Pkcs8.length - 32)
  return rawX25519PrivateToPkcs8(Buffer.from(ed25519.utils.toMontgomerySecret(seed)))
}

function deriveMessageKey(sharedSecret: Buffer, ephemeralPubRaw: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, ephemeralPubRaw, MESSAGE_HKDF_INFO, 32))
}

/**
 * Encrypt an ALF payload to a recipient DID. Returns the encrypted payload,
 * or null when the DID does not decode to an Ed25519 key.
 */
export function encryptPayloadForDid(payload: AlfPayload, recipientDid: string): AlfPayload | null {
  const rawEdPub = didToPublicKey(recipientDid)
  if (!rawEdPub) return null

  let recipientXPub: Buffer
  try {
    recipientXPub = ed25519PublicToX25519(rawEdPub)
  } catch {
    return null // low-order / invalid point
  }

  const ephemeral = generateX25519KeyPair()
  const ephemeralPubRaw = extractRawX25519PublicKey(ephemeral.publicKey)
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({ key: ephemeral.privateKey, format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: rawX25519PublicToSpki(recipientXPub), format: 'der', type: 'spki' })
  })
  const key = deriveMessageKey(sharedSecret, ephemeralPubRaw)
  const sealed = sealWithDek(Buffer.from(JSON.stringify(payload), 'utf-8'), key)

  const enc: EncMeta = { v: 1, alg: 'x25519-hkdf-aes256gcm', epk: ephemeralPubRaw.toString('base64') }
  return {
    content: sealed.toString('base64'),
    content_type: ENCRYPTED_CONTENT_TYPE,
    meta: { enc },
    sent_at: payload.sent_at
  }
}

/** True when a payload carries the level-2 encrypted shape. */
export function isEncryptedPayload(payload: AlfPayload): boolean {
  return payload.content_type === ENCRYPTED_CONTENT_TYPE && !!(payload.meta?.enc as EncMeta | undefined)?.epk
}

/**
 * Decrypt an encrypted payload with the recipient's Ed25519 private key
 * (PKCS8 DER — the agent's signing key). Returns the original payload, or
 * null on any failure (not encrypted to this key, tampered, malformed).
 */
export function decryptPayloadWithEd25519(payload: AlfPayload, ed25519PrivatePkcs8: Buffer): AlfPayload | null {
  if (!isEncryptedPayload(payload) || typeof payload.content !== 'string') return null
  try {
    const enc = payload.meta!.enc as EncMeta
    const ephemeralPubRaw = Buffer.from(enc.epk, 'base64')
    const xPriv = ed25519PrivateToX25519Pkcs8(ed25519PrivatePkcs8)
    const sharedSecret = diffieHellman({
      privateKey: createPrivateKey({ key: xPriv, format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: rawX25519PublicToSpki(ephemeralPubRaw), format: 'der', type: 'spki' })
    })
    const key = deriveMessageKey(sharedSecret, ephemeralPubRaw)
    const plain = openWithDek(Buffer.from(payload.content, 'base64'), key)
    if (!plain) return null
    return JSON.parse(plain.toString('utf-8')) as AlfPayload
  } catch {
    return null
  }
}
