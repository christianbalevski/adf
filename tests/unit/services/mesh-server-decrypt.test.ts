import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { decryptAlfPayload } from '../../../src/main/services/mesh-server'
import { encryptPayloadForDid } from '../../../src/main/crypto/message-crypto'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import type { AlfMessage, AlfPayload } from '../../../src/shared/types/adf-v02.types'
import type { FastifyReply, FastifyRequest } from 'fastify'

function makeAgent() {
  const keys = generateEd25519KeyPair()
  return { keys, did: publicKeyToDid(extractRawPublicKey(keys.publicKey)) }
}

/** Fake reply capturing the first code().send() — mimics Fastify's chainable API. */
function makeReply() {
  const captured: { code?: number; body?: unknown } = {}
  const reply = {
    code(c: number) {
      captured.code = c
      return { send: (body: unknown) => { captured.body = body; return reply } }
    }
  } as unknown as FastifyReply
  return { reply, captured }
}

function makeRequest(message: AlfMessage, signingKey: Buffer | null): FastifyRequest {
  return {
    body: message,
    agent: {
      workspace: { getSigningKeys: () => (signingKey ? { privateKey: signingKey, publicKey: Buffer.alloc(0) } : null) }
    }
  } as unknown as FastifyRequest
}

const PLAINTEXT: AlfPayload = {
  content: 'the launch code is 0000',
  content_type: 'text/plain',
  sent_at: '2026-07-06T12:00:00Z',
  signature: 'ed25519:inner-sig'
}

function encryptedMessage(from: string, to: string, recipientDid: string): AlfMessage {
  return {
    version: '0.1', network: 'devnet', id: 'm1', timestamp: 'now',
    from, to, reply_to: 'http://x/mesh/inbox',
    payload: encryptPayloadForDid(PLAINTEXT, recipientDid)!
  }
}

describe('mesh-server decryptAlfPayload preHandler (HTTP inbox path)', () => {
  it('decrypts an encrypted payload in place with the recipient key', async () => {
    const recipient = makeAgent()
    const message = encryptedMessage('did:key:zSender', recipient.did, recipient.did)
    const { reply, captured } = makeReply()

    await decryptAlfPayload(makeRequest(message, recipient.keys.privateKey), reply)

    expect(captured.code).toBeUndefined() // no rejection
    expect(message.payload).toEqual(PLAINTEXT)
    expect(message.meta?.payload_encrypted).toBe(true)
  })

  it('rejects with 403 when encrypted to someone else', async () => {
    const recipient = makeAgent()
    const eavesdropper = makeAgent()
    const message = encryptedMessage('did:key:zSender', recipient.did, recipient.did)
    const { reply, captured } = makeReply()

    await decryptAlfPayload(makeRequest(message, eavesdropper.keys.privateKey), reply)

    expect(captured.code).toBe(403)
  })

  it('rejects with 500 when the agent has no signing key', async () => {
    const recipient = makeAgent()
    const message = encryptedMessage('did:key:zSender', recipient.did, recipient.did)
    const { reply, captured } = makeReply()

    await decryptAlfPayload(makeRequest(message, null), reply)

    expect(captured.code).toBe(500)
  })

  it('passes a plaintext payload through untouched', async () => {
    const message: AlfMessage = {
      version: '0.1', network: 'devnet', id: 'm1', timestamp: 'now',
      from: 'did:key:zSender', to: 'did:key:zRecipient', reply_to: 'http://x',
      payload: { content: 'hello', content_type: 'text/plain', sent_at: 'now' }
    }
    const { reply, captured } = makeReply()

    await decryptAlfPayload(makeRequest(message, makeAgent().keys.privateKey), reply)

    expect(captured.code).toBeUndefined()
    expect(message.payload.content).toBe('hello')
    expect(message.meta?.payload_encrypted).toBeUndefined()
  })
})
