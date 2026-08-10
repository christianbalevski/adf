import { describe, expect, it } from 'vitest'
import { flattenMessageToInbox } from '../../../src/main/utils/alf-message'
import type { AlfMessage } from '../../../src/shared/types/adf-v02.types'

function message(meta: Record<string, unknown>): AlfMessage {
  return {
    version: '0.1', network: 'devnet', id: 'm1', timestamp: 'now',
    from: 'did:key:zSender', to: 'did:key:zRecipient', reply_to: 'http://x',
    meta,
    payload: { content: 'hi', content_type: 'text/plain', sent_at: '2026-07-07T00:00:00Z' }
  }
}

describe('flattenMessageToInbox — ingress stamp propagation', () => {
  it('carries verification and encryption stamps into the stored inbox meta', () => {
    const flat = flattenMessageToInbox(
      message({ message_verified: true, payload_verified: true, payload_encrypted: true }),
      Date.parse('2026-07-07T00:00:01Z')
    )
    expect(flat.meta?.message_verified).toBe(true)
    expect(flat.meta?.payload_verified).toBe(true)
    expect(flat.meta?.payload_encrypted).toBe(true)
  })

  it('omits stamps that were never set (plaintext, unsigned)', () => {
    const flat = flattenMessageToInbox(message({}), 0)
    expect(flat.meta && 'payload_encrypted' in flat.meta).toBe(false)
    expect(flat.meta && 'message_verified' in flat.meta).toBe(false)
  })

  it('propagates payload_encrypted:false explicitly (not just when true)', () => {
    const flat = flattenMessageToInbox(message({ payload_encrypted: false }), 0)
    expect(flat.meta?.payload_encrypted).toBe(false)
  })
})

describe('flattenMessageToInbox — wire-supplied trust claims', () => {
  it('never lets payload.meta carry verification stamps into the inbox', () => {
    const m = message({})
    m.payload.meta = {
      identity_verified: true,
      message_verified: true,
      payload_verified: true,
      payload_encrypted: true,
      ws_remote_did: 'did:key:zForged',
      topic: 'kept'
    }
    const flat = flattenMessageToInbox(m, 0)

    expect(flat.meta?.identity_verified).toBeUndefined()
    expect(flat.meta?.message_verified).toBeUndefined()
    expect(flat.meta?.payload_verified).toBeUndefined()
    expect(flat.meta?.payload_encrypted).toBeUndefined()
    expect(flat.meta?.ws_remote_did).toBeUndefined()
    // Non-trust payload meta still flows through
    expect(flat.meta?.topic).toBe('kept')
  })

  it('drops a reserved sender_alias so a peer cannot present itself as the owner', () => {
    const m = message({})
    m.payload.sender_alias = 'Owner'
    const flat = flattenMessageToInbox(m, 0)
    expect(flat.sender_alias).toBeUndefined()
    // The verified DID remains the authoritative sender field
    expect(flat.from).toBe('did:key:zSender')
    // ...and the claim is still recoverable from the tombstoned original
    expect(flat.original_message).toContain('Owner')
  })

  it('keeps an ordinary sender_alias', () => {
    const m = message({})
    m.payload.sender_alias = 'agent-1'
    expect(flattenMessageToInbox(m, 0).sender_alias).toBe('agent-1')
  })

  it('keeps meta.owner only when the message signature verified', () => {
    expect(flattenMessageToInbox(message({ owner: 'did:key:zBoss' }), 0).owner).toBeUndefined()
    expect(
      flattenMessageToInbox(message({ owner: 'did:key:zBoss', message_verified: true }), 0).owner
    ).toBe('did:key:zBoss')
  })
})
