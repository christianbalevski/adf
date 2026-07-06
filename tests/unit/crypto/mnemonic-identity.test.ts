import { describe, expect, it } from 'vitest'
import { createPrivateKey, createPublicKey } from 'crypto'
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  slip10DeriveEd25519,
  rawEd25519SeedToPkcs8,
  deriveOwnerIdentity,
  OWNER_KEY_PATH
} from '../../../src/main/crypto/mnemonic-identity'
import { signEd25519, verifyEd25519, extractRawPublicKey, publicKeyToDid, didToPublicKey } from '../../../src/main/crypto/identity-crypto'

// Official SLIP-0010 Ed25519 test vector 1 (seed 000102030405060708090a0b0c0d0e0f)
const SLIP10_SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')

describe('slip10DeriveEd25519', () => {
  it('derives the SLIP-0010 master key for Ed25519 (test vector 1, chain m)', () => {
    const { key, chainCode } = slip10DeriveEd25519(SLIP10_SEED, 'm')
    expect(key.toString('hex')).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7')
    expect(chainCode.toString('hex')).toBe('90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb')
  })

  it("derives m/0' (test vector 1)", () => {
    const { key, chainCode } = slip10DeriveEd25519(SLIP10_SEED, "m/0'")
    expect(key.toString('hex')).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3')
    expect(chainCode.toString('hex')).toBe('8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69')
  })

  it("derives m/0'/1'/2'/2'/1000000000' (test vector 1, deep chain)", () => {
    const { key } = slip10DeriveEd25519(SLIP10_SEED, "m/0'/1'/2'/2'/1000000000'")
    expect(key.toString('hex')).toBe('8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793')
  })

  it('rejects non-hardened segments', () => {
    expect(() => slip10DeriveEd25519(SLIP10_SEED, 'm/0')).toThrow(/hardened/)
  })

  it('rejects paths not starting with m', () => {
    expect(() => slip10DeriveEd25519(SLIP10_SEED, "44'/0'")).toThrow(/Invalid derivation path/)
  })
})

describe('rawEd25519SeedToPkcs8', () => {
  it('produces a PKCS8 key Node crypto accepts, matching the SLIP-0010 public key', () => {
    // Vector 1 chain m public key: 00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed
    // (leading 00 is SLIP-0010's ed25519 padding byte; raw key is the remaining 32 bytes)
    const { key } = slip10DeriveEd25519(SLIP10_SEED, 'm')
    const pkcs8 = rawEd25519SeedToPkcs8(key)
    const pub = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
      .export({ format: 'der', type: 'spki' }) as Buffer
    expect(extractRawPublicKey(Buffer.from(pub)).toString('hex'))
      .toBe('a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed')
  })

  it('rejects wrong-length seeds', () => {
    expect(() => rawEd25519SeedToPkcs8(Buffer.alloc(31))).toThrow(/32-byte/)
  })
})

describe('mnemonic generation + validation', () => {
  it('generates a valid 12-word mnemonic', () => {
    const m = generateMnemonic()
    expect(m.split(' ')).toHaveLength(12)
    expect(validateMnemonic(m)).toBe(true)
  })

  it('rejects invalid mnemonics', () => {
    expect(validateMnemonic('not a real mnemonic phrase at all okay word word word word')).toBe(false)
    expect(validateMnemonic('')).toBe(false)
  })

  it('is case/whitespace tolerant', () => {
    const m = generateMnemonic()
    expect(validateMnemonic('  ' + m.toUpperCase() + '  ')).toBe(true)
  })
})

describe('mnemonicToSeed', () => {
  it('matches the BIP-39 reference vector (abandon x11 + about)', () => {
    const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    expect(seed.toString('hex')).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
    )
  })
})

describe('deriveOwnerIdentity', () => {
  it('is deterministic: same mnemonic → same DID', () => {
    const m = generateMnemonic()
    const a = deriveOwnerIdentity(m)
    const b = deriveOwnerIdentity(m)
    expect(a.did).toBe(b.did)
    expect(a.privateKeyPkcs8.equals(b.privateKeyPkcs8)).toBe(true)
  })

  it('different mnemonics → different DIDs', () => {
    expect(deriveOwnerIdentity(generateMnemonic()).did)
      .not.toBe(deriveOwnerIdentity(generateMnemonic()).did)
  })

  it('produces a did:key that round-trips and signs/verifies with the existing pipeline', () => {
    const { privateKeyPkcs8, publicKeySpki, did } = deriveOwnerIdentity(generateMnemonic())
    expect(did.startsWith('did:key:z')).toBe(true)
    expect(publicKeyToDid(extractRawPublicKey(publicKeySpki))).toBe(did)
    expect(didToPublicKey(did)!.equals(extractRawPublicKey(publicKeySpki))).toBe(true)

    const data = Buffer.from('adf identity test')
    const sig = signEd25519(data, privateKeyPkcs8)
    expect(verifyEd25519(data, sig, publicKeySpki)).toBe(true)
    expect(verifyEd25519(Buffer.from('tampered'), sig, publicKeySpki)).toBe(false)
  })

  it('uses the fixed owner path', () => {
    expect(OWNER_KEY_PATH).toBe("m/44'/0'/0'")
  })
})
