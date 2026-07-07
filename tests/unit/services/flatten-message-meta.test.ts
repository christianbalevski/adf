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
