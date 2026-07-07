import { describe, expect, it } from 'vitest'
import {
  encryptPayloadForDid,
  decryptPayloadWithEd25519,
  isEncryptedPayload,
  ENCRYPTED_CONTENT_TYPE
} from '../../../src/main/crypto/message-crypto'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import type { AlfPayload } from '../../../src/shared/types/adf-v02.types'

function makeAgent() {
  const keys = generateEd25519KeyPair()
  return { ...keys, did: publicKeyToDid(extractRawPublicKey(keys.publicKey)) }
}

const PAYLOAD: AlfPayload = {
  content: 'the launch code is 0000',
  content_type: 'text/plain',
  subject: 'secret',
  sent_at: '2026-07-06T12:00:00Z',
  signature: 'ed25519:fake-inner-sig'
}

describe('message payload encryption to a DID (spec §8.5 level 2)', () => {
  it('round-trips a payload using only the recipient DID', () => {
    const recipient = makeAgent()
    const sealed = encryptPayloadForDid(PAYLOAD, recipient.did)
    expect(sealed).not.toBeNull()
    expect(isEncryptedPayload(sealed!)).toBe(true)
    expect(sealed!.content_type).toBe(ENCRYPTED_CONTENT_TYPE)
    // Nothing sensitive visible in the encrypted form
    expect(JSON.stringify(sealed)).not.toContain('launch code')
    expect(sealed!.subject).toBeUndefined()
    expect(sealed!.signature).toBeUndefined()

    const opened = decryptPayloadWithEd25519(sealed!, recipient.privateKey)
    expect(opened).toEqual(PAYLOAD)
  })

  it('cannot be decrypted with a different agent key', () => {
    const recipient = makeAgent()
    const eavesdropper = makeAgent()
    const sealed = encryptPayloadForDid(PAYLOAD, recipient.did)!
    expect(decryptPayloadWithEd25519(sealed, eavesdropper.privateKey)).toBeNull()
  })

  it('rejects tampered ciphertext', () => {
    const recipient = makeAgent()
    const sealed = encryptPayloadForDid(PAYLOAD, recipient.did)!
    const blob = Buffer.from(sealed.content as string, 'base64')
    blob[blob.length - 1] ^= 0xff
    const tampered = { ...sealed, content: blob.toString('base64') }
    expect(decryptPayloadWithEd25519(tampered, recipient.privateKey)).toBeNull()
  })

  it('returns null for a non-DID recipient', () => {
    expect(encryptPayloadForDid(PAYLOAD, 'discord:12345')).toBeNull()
    expect(encryptPayloadForDid(PAYLOAD, 'not-a-did')).toBeNull()
  })

  it('does not mistake plaintext payloads for encrypted ones', () => {
    expect(isEncryptedPayload(PAYLOAD)).toBe(false)
    expect(isEncryptedPayload({ content: 'x', content_type: ENCRYPTED_CONTENT_TYPE, sent_at: 'now' })).toBe(false)
  })
})
