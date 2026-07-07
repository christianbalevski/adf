import { describe, expect, it } from 'vitest'
import { createDefaultPipeline, type MessagingPipelineContext } from '../../../src/main/services/alf-pipeline'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../../../src/main/crypto/identity-crypto'
import { isEncryptedPayload } from '../../../src/main/crypto/message-crypto'
import type { AlfMessage, SecurityConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

function makeAgent() {
  const keys = generateEd25519KeyPair()
  const did = publicKeyToDid(extractRawPublicKey(keys.publicKey))
  // The pipeline only touches workspace.getSigningKeys — a stub suffices.
  const workspace = { getSigningKeys: () => keys } as unknown as AdfWorkspace
  return { keys, did, workspace }
}

function makeMessage(from: string, to: string): AlfMessage {
  return {
    version: '0.1',
    network: 'test',
    id: 'msg-1',
    timestamp: '2026-07-06T12:00:00Z',
    from,
    to,
    reply_to: 'ws://localhost:1234',
    payload: {
      content: 'the launch code is 0000',
      content_type: 'text/plain',
      sent_at: '2026-07-06T12:00:00Z'
    }
  }
}

function ctx(
  agent: ReturnType<typeof makeAgent>,
  remoteDid: string,
  direction: 'egress' | 'ingress',
  security: SecurityConfig,
  isLocal = false
): MessagingPipelineContext {
  return { direction, workspace: agent.workspace, localDid: agent.did, remoteDid, isLocal, security, derivedKey: null }
}

const LEVEL2: SecurityConfig = { allow_unsigned: true, level: 2 }

describe('default pipeline level 2 (sign + encrypt)', () => {
  it('encrypts on egress and the recipient round-trips it on ingress', async () => {
    const pipeline = createDefaultPipeline()
    const sender = makeAgent()
    const recipient = makeAgent()

    const egress = await pipeline.processEgress(
      makeMessage(sender.did, recipient.did),
      ctx(sender, recipient.did, 'egress', LEVEL2)
    )
    expect(egress.rejected).toBeUndefined()
    expect(isEncryptedPayload(egress.data.payload)).toBe(true)
    expect(egress.data.signature).toMatch(/^ed25519:/) // outer signature over encrypted form
    expect(JSON.stringify(egress.data)).not.toContain('launch code')

    const ingress = await pipeline.processIngress(
      egress.data,
      ctx(recipient, sender.did, 'ingress', LEVEL2)
    )
    expect(ingress.rejected).toBeUndefined()
    expect(ingress.data.payload.content).toBe('the launch code is 0000')
    expect(ingress.data.meta?.message_verified).toBe(true)
    expect(ingress.data.meta?.payload_verified).toBe(true) // inner author signature survived encryption
    expect(ingress.data.meta?.payload_encrypted).toBe(true)
  })

  it('rejects ingress when the message was encrypted to someone else', async () => {
    const pipeline = createDefaultPipeline()
    const sender = makeAgent()
    const recipient = makeAgent()
    const eavesdropper = makeAgent()

    const egress = await pipeline.processEgress(
      makeMessage(sender.did, recipient.did),
      ctx(sender, recipient.did, 'egress', LEVEL2)
    )
    const intercepted = await pipeline.processIngress(
      egress.data,
      ctx(eavesdropper, sender.did, 'ingress', LEVEL2)
    )
    expect(intercepted.rejected?.code).toBe(403)
  })

  it('level 1 signs without encrypting', async () => {
    const pipeline = createDefaultPipeline()
    const sender = makeAgent()
    const recipient = makeAgent()

    const egress = await pipeline.processEgress(
      makeMessage(sender.did, recipient.did),
      ctx(sender, recipient.did, 'egress', { allow_unsigned: true, level: 1 })
    )
    expect(egress.rejected).toBeUndefined()
    expect(isEncryptedPayload(egress.data.payload)).toBe(false)
    expect(egress.data.signature).toMatch(/^ed25519:/)
    expect(egress.data.payload.signature).toMatch(/^ed25519:/)
  })

  it('skips encryption for same-runtime local delivery', async () => {
    const pipeline = createDefaultPipeline()
    const sender = makeAgent()
    const recipient = makeAgent()

    const egress = await pipeline.processEgress(
      makeMessage(sender.did, recipient.did),
      ctx(sender, recipient.did, 'egress', LEVEL2, true)
    )
    expect(egress.rejected).toBeUndefined()
    expect(isEncryptedPayload(egress.data.payload)).toBe(false)
  })

  it('passes non-DID recipients (channel adapters) through unencrypted', async () => {
    const pipeline = createDefaultPipeline()
    const sender = makeAgent()

    const egress = await pipeline.processEgress(
      makeMessage(sender.did, 'discord:12345'),
      ctx(sender, 'discord:12345', 'egress', LEVEL2)
    )
    expect(egress.rejected).toBeUndefined()
    expect(isEncryptedPayload(egress.data.payload)).toBe(false)
  })
})
