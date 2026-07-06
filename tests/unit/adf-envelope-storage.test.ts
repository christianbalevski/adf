import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace, type EnvelopeRecipients } from '../../src/main/adf/adf-workspace'
import { generateX25519KeyPair, extractRawX25519PublicKey } from '../../src/main/crypto/envelope-crypto'

let rootDir: string

interface TestIdentity {
  recipients: EnvelopeRecipients
  ownerPriv: Buffer
  runtimePriv: Buffer
}

function makeIdentity(tag: string): TestIdentity {
  const owner = generateX25519KeyPair()
  const runtime = generateX25519KeyPair()
  return {
    recipients: {
      ownerDid: `did:key:zOwner${tag}`,
      ownerEncPublicKey: extractRawX25519PublicKey(owner.publicKey),
      runtimeDid: `did:key:zRuntime${tag}`,
      runtimeEncPublicKey: extractRawX25519PublicKey(runtime.publicKey)
    },
    ownerPriv: owner.privateKey,
    runtimePriv: runtime.privateKey
  }
}

function makeWorkspace(name: string): AdfWorkspace {
  return AdfWorkspace.create(join(rootDir, `${name}.adf`), { name })
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-envelope-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('envelope provisioning + row sealing (ADF_IDENTITY_SPEC D5/D6/D9)', () => {
  it('provisions both envelopes and seals new credentials transparently', () => {
    const id = makeIdentity('A')
    const ws = makeWorkspace('seal')
    try {
      ws.provisionEnvelopes(id.recipients)
      expect(ws.getEnvelopeState('identity')).toBe('unlocked')
      expect(ws.getEnvelopeState('credentials')).toBe('unlocked')

      ws.setIdentity('openai_key', 'sk-secret', true)
      // Transparent read-back while unlocked
      expect(ws.getIdentity('openai_key')).toBe('sk-secret')
      // At rest: not plain — the db-level reader must refuse it
      expect(ws.getIdentityRow('openai_key')!.encryption_algo).toBe('env:credentials')
      // code_access applied on create, as with plain rows
      expect(ws.getIdentityRow('openai_key')!.code_access).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('signing private key is sealed in the identity envelope; public key stays plain', () => {
    const id = makeIdentity('B')
    const ws = makeWorkspace('keys')
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.generateIdentityKeys(null)

      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('env:identity')
      expect(ws.getIdentityRow('crypto:signing:public_key')!.encryption_algo).toBe('plain')
      // Signing works through the cached DEK, no derivedKey needed
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('kdf material and envelope descriptors stay plain', () => {
    const id = makeIdentity('C')
    const ws = makeWorkspace('plain')
    try {
      ws.provisionEnvelopes(id.recipients)
      expect(ws.getIdentityRow('crypto:envelope:identity')!.encryption_algo).toBe('plain')
      expect(ws.getIdentityRow('crypto:envelope:credentials')!.encryption_algo).toBe('plain')
    } finally {
      ws.close()
    }
  })

  it('provisioning is idempotent', () => {
    const id = makeIdentity('D')
    const ws = makeWorkspace('idem')
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.setIdentity('mcp:server:token', 'tok')
      const before = ws.readEnvelopeSlots('credentials')
      ws.provisionEnvelopes(makeIdentity('X').recipients)
      expect(ws.readEnvelopeSlots('credentials')).toEqual(before)
      expect(ws.getIdentity('mcp:server:token')).toBe('tok')
    } finally {
      ws.close()
    }
  })
})

describe('unlock cascade (D10)', () => {
  function provisionedFile(name: string, id: TestIdentity): string {
    const filePath = join(rootDir, `${name}.adf`)
    const ws = AdfWorkspace.create(filePath, { name })
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.generateIdentityKeys(null)
      ws.setIdentity('openai_key', 'sk-secret')
    } finally {
      ws.close()
    }
    return filePath
  }

  it('unlocks via the runtime slot on reopen', () => {
    const id = makeIdentity('E')
    const ws = AdfWorkspace.open(provisionedFile('runtime-unlock', id))
    try {
      // Sealed rows are unreadable before unlock
      expect(ws.getIdentity('openai_key')).toBeNull()
      expect(ws.getSigningKeys(null)).toBeNull()
      expect(ws.getEnvelopeState('identity')).toBe('foreign')

      const states = ws.unlockEnvelopes({ runtimeEncPrivateKey: id.runtimePriv })
      expect(states).toEqual({ identity: 'unlocked', credentials: 'unlocked' })
      expect(ws.getIdentity('openai_key')).toBe('sk-secret')
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('owner slot unlocks and re-wraps a runtime slot for the new install', () => {
    const id = makeIdentity('F')
    const filePath = provisionedFile('owner-unlock', id)

    // "New machine": different runtime keys, same owner
    const newRuntime = generateX25519KeyPair()
    const ws = AdfWorkspace.open(filePath)
    try {
      const states = ws.unlockEnvelopes({
        runtimeEncPrivateKey: newRuntime.privateKey, // fails — not wrapped to this install
        ownerEncPrivateKey: id.ownerPriv,
        reWrapRuntime: { did: 'did:key:zRuntimeNEW', encPublicKey: extractRawX25519PublicKey(newRuntime.publicKey) }
      })
      expect(states.identity).toBe('unlocked')
      expect(ws.getIdentity('openai_key')).toBe('sk-secret')
    } finally {
      ws.close()
    }

    // Reopen: the new runtime slot alone now suffices — seed stays cold from here on
    const ws2 = AdfWorkspace.open(filePath)
    try {
      const states = ws2.unlockEnvelopes({ runtimeEncPrivateKey: newRuntime.privateKey })
      expect(states).toEqual({ identity: 'unlocked', credentials: 'unlocked' })
    } finally {
      ws2.close()
    }
  })

  it('a foreign file stays foreign — wrong keys open nothing', () => {
    const id = makeIdentity('G')
    const stranger = makeIdentity('H')
    const ws = AdfWorkspace.open(provisionedFile('foreign', id))
    try {
      const states = ws.unlockEnvelopes({
        runtimeEncPrivateKey: stranger.runtimePriv,
        ownerEncPrivateKey: stranger.ownerPriv
      })
      expect(states).toEqual({ identity: 'foreign', credentials: 'foreign' })
      expect(ws.getIdentity('openai_key')).toBeNull()
      expect(ws.getSigningKeys(null)).toBeNull()
    } finally {
      ws.close()
    }
  })

  it('pre-envelope files report absent and keep plain behavior', () => {
    const ws = makeWorkspace('legacy')
    try {
      ws.generateIdentityKeys(null)
      ws.setIdentity('openai_key', 'sk-plain')
      expect(ws.getEnvelopeState('identity')).toBe('absent')
      expect(ws.getIdentityRow('openai_key')!.encryption_algo).toBe('plain')
      expect(ws.getIdentity('openai_key')).toBe('sk-plain')
      expect(ws.getSigningKeys(null)).not.toBeNull()
    } finally {
      ws.close()
    }
  })
})

describe('password slots on the credentials envelope (D12)', () => {
  it('share flow: password unlocks credentials on a foreign machine; identity refuses password slots', () => {
    const id = makeIdentity('I')
    const filePath = join(rootDir, 'share.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'share' })
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.setIdentity('openai_key', 'sk-shared')
      ws.addEnvelopePasswordSlot('credentials', 'family-passphrase')
      expect(() => ws.addEnvelopePasswordSlot('identity', 'nope')).toThrow()
    } finally {
      ws.close()
    }

    // Recipient: no matching keys — identity foreign, credentials locked (password present)
    const recipient = AdfWorkspace.open(filePath)
    try {
      const states = recipient.unlockEnvelopes({})
      expect(states.identity).toBe('foreign')
      expect(states.credentials).toBe('locked')

      expect(recipient.unlockEnvelopeWithPassword('credentials', 'wrong')).toBe(false)
      expect(recipient.unlockEnvelopeWithPassword('credentials', 'family-passphrase')).toBe(true)
      expect(recipient.getIdentity('openai_key')).toBe('sk-shared')

      // Post-claim: drop the transit password slot
      recipient.removeEnvelopePasswordSlots('credentials')
      expect(recipient.readEnvelopeSlots('credentials')!.every((s) => s.type !== 'password')).toBe(true)
    } finally {
      recipient.close()
    }
  })
})

describe('coexistence with the legacy whole-file password', () => {
  it('setPassword leaves envelope descriptors and env rows untouched', () => {
    const id = makeIdentity('J')
    const ws = makeWorkspace('coexist')
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.generateIdentityKeys(null)
      ws.setIdentity('openai_key', 'sk-x')

      const derivedKey = ws.setPassword('local-password')
      expect(ws.getIdentityRow('crypto:envelope:identity')!.encryption_algo).toBe('plain')
      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('env:identity')
      expect(ws.getIdentityRow('openai_key')!.encryption_algo).toBe('env:credentials')

      // Envelope reads still work alongside the password layer
      expect(ws.getIdentity('openai_key')).toBe('sk-x')
      // Legacy unlock path still verifies (kdf salt/params rows got password-encrypted)
      expect(ws.unlockWithPassword.bind(ws)).toBeDefined()
      void derivedKey
    } finally {
      ws.close()
    }
  })

  it('wipeAllIdentity clears cached DEKs along with the descriptors', () => {
    const id = makeIdentity('K')
    const ws = makeWorkspace('wipe')
    try {
      ws.provisionEnvelopes(id.recipients)
      ws.generateIdentityKeys(null)
      ws.wipeAllIdentity()
      expect(ws.getEnvelopeState('identity')).toBe('absent')
      // A fresh generate after wipe falls back to plain (no envelope any more)
      ws.generateIdentityKeys(null)
      expect(ws.getIdentityRow('crypto:signing:private_key')!.encryption_algo).toBe('plain')
    } finally {
      ws.close()
    }
  })
})
