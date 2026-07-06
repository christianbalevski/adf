import { describe, expect, it } from 'vitest'
import {
  generateDek,
  generateX25519KeyPair,
  extractRawX25519PublicKey,
  rawX25519PrivateToPkcs8,
  createKeySlot,
  openKeySlot,
  createPasswordSlot,
  openPasswordSlot,
  DEFAULT_SCRYPT_PARAMS
} from '../../../src/main/crypto/envelope-crypto'
import { deriveOwnerEncryptionKey, deriveOwnerIdentity, generateMnemonic } from '../../../src/main/crypto/mnemonic-identity'

describe('envelope key slots (ADF_IDENTITY_SPEC D8)', () => {
  it('round-trips a DEK through an X25519 key slot', () => {
    const dek = generateDek()
    const recipient = generateX25519KeyPair()
    const recipientPubRaw = extractRawX25519PublicKey(recipient.publicKey)

    const slot = createKeySlot(dek, 'identity', 'runtime', 'did:key:zRuntime', recipientPubRaw)
    expect(slot.type).toBe('runtime')
    expect(slot.recipient_did).toBe('did:key:zRuntime')

    const unwrapped = openKeySlot(slot, 'identity', recipient.privateKey)
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.equals(dek)).toBe(true)
  })

  it('fails with the wrong recipient key', () => {
    const dek = generateDek()
    const recipient = generateX25519KeyPair()
    const other = generateX25519KeyPair()

    const slot = createKeySlot(dek, 'identity', 'owner', 'did:key:zOwner', extractRawX25519PublicKey(recipient.publicKey))
    expect(openKeySlot(slot, 'identity', other.privateKey)).toBeNull()
  })

  it('binds the wrap to the envelope name (domain separation)', () => {
    const dek = generateDek()
    const recipient = generateX25519KeyPair()

    const slot = createKeySlot(dek, 'identity', 'owner', 'did:key:zOwner', extractRawX25519PublicKey(recipient.publicKey))
    expect(openKeySlot(slot, 'credentials', recipient.privateKey)).toBeNull()
    expect(openKeySlot(slot, 'identity', recipient.privateKey)).not.toBeNull()
  })

  it('rejects tampered slots (GCM auth)', () => {
    const dek = generateDek()
    const recipient = generateX25519KeyPair()
    const slot = createKeySlot(dek, 'credentials', 'owner', 'did:key:zOwner', extractRawX25519PublicKey(recipient.publicKey))

    const corrupted = Buffer.from(slot.wrapped_dek, 'base64')
    corrupted[0] ^= 0xff
    expect(openKeySlot({ ...slot, wrapped_dek: corrupted.toString('base64') }, 'credentials', recipient.privateKey)).toBeNull()
  })

  it('produces independent wraps per call (fresh ephemeral keys)', () => {
    const dek = generateDek()
    const recipient = generateX25519KeyPair()
    const pubRaw = extractRawX25519PublicKey(recipient.publicKey)

    const a = createKeySlot(dek, 'identity', 'owner', 'did:key:zOwner', pubRaw)
    const b = createKeySlot(dek, 'identity', 'owner', 'did:key:zOwner', pubRaw)
    expect(a.ephemeral_pub).not.toBe(b.ephemeral_pub)
    expect(a.wrapped_dek).not.toBe(b.wrapped_dek)
    expect(openKeySlot(a, 'identity', recipient.privateKey)!.equals(dek)).toBe(true)
    expect(openKeySlot(b, 'identity', recipient.privateKey)!.equals(dek)).toBe(true)
  })
})

describe('envelope password slots', () => {
  // Scrypt at production N=2^17 is deliberately slow; use it once for the
  // round-trip, then reduced params for the failure cases.
  const FAST: typeof DEFAULT_SCRYPT_PARAMS = { N: 1024, r: 8, p: 1 }

  it('round-trips a DEK at production scrypt parameters', () => {
    const dek = generateDek()
    const slot = createPasswordSlot(dek, 'correct horse battery staple')
    expect(slot.kdf).toBe('scrypt')
    expect(slot.kdf_params).toEqual(DEFAULT_SCRYPT_PARAMS)

    const unwrapped = openPasswordSlot(slot, 'correct horse battery staple')
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.equals(dek)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const dek = generateDek()
    const slot = createPasswordSlot(dek, 'right', FAST)
    expect(openPasswordSlot(slot, 'wrong')).toBeNull()
  })

  it('uses the recorded kdf params, and salts uniquely per slot', () => {
    const dek = generateDek()
    const a = createPasswordSlot(dek, 'pw', FAST)
    const b = createPasswordSlot(dek, 'pw', FAST)
    expect(a.salt).not.toBe(b.salt)
    expect(a.kdf_params).toEqual(FAST)
    expect(openPasswordSlot(a, 'pw')!.equals(dek)).toBe(true)
  })

  it('rejects unknown kdf identifiers', () => {
    const dek = generateDek()
    const slot = createPasswordSlot(dek, 'pw', FAST)
    expect(openPasswordSlot({ ...slot, kdf: 'pbkdf2' as 'scrypt' }, 'pw')).toBeNull()
  })
})

describe('owner encryption key derivation (ADF_IDENTITY_SPEC D7)', () => {
  it('is deterministic and distinct from the signing key', () => {
    const mnemonic = generateMnemonic()
    const a = deriveOwnerEncryptionKey(mnemonic)
    const b = deriveOwnerEncryptionKey(mnemonic)
    expect(a.publicKeyRaw.equals(b.publicKeyRaw)).toBe(true)
    expect(a.privateKeyPkcs8.equals(b.privateKeyPkcs8)).toBe(true)

    // Sibling path must not collide with the signing identity
    const signing = deriveOwnerIdentity(mnemonic)
    expect(a.privateKeyPkcs8.subarray(-32).equals(signing.privateKeyPkcs8.subarray(-32))).toBe(false)
  })

  it('differs across mnemonics', () => {
    const a = deriveOwnerEncryptionKey(generateMnemonic())
    const b = deriveOwnerEncryptionKey(generateMnemonic())
    expect(a.publicKeyRaw.equals(b.publicKeyRaw)).toBe(false)
  })

  it('the derived key actually works as a slot recipient (recovery path)', () => {
    const mnemonic = generateMnemonic()
    const owner = deriveOwnerEncryptionKey(mnemonic)
    const dek = generateDek()

    // Wrap with only the public key (seed cold) …
    const slot = createKeySlot(dek, 'credentials', 'owner', 'did:key:zOwner', owner.publicKeyRaw)
    // … recover with the mnemonic-derived private key.
    const recovered = deriveOwnerEncryptionKey(mnemonic)
    expect(openKeySlot(slot, 'credentials', recovered.privateKeyPkcs8)!.equals(dek)).toBe(true)
  })

  it('raw scalar round-trips through PKCS8 wrapping', () => {
    const kp = generateX25519KeyPair()
    const raw = kp.privateKey.subarray(-32)
    expect(rawX25519PrivateToPkcs8(Buffer.from(raw)).equals(kp.privateKey)).toBe(true)
  })
})
