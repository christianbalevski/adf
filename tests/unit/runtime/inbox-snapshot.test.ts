import { describe, expect, it } from 'vitest'
import { inboxSnapshot } from '../../../src/main/runtime/inbox-snapshot'
import type { InboxMessage } from '../../../src/shared/types/adf-v02.types'

function message(id: string, status: InboxMessage['status']): InboxMessage {
  return {
    id,
    from: `did:key:z6Mk${id}`,
    sender_alias: `sender-${id}`,
    subject: `subject ${id}`,
    content: `body ${id}`,
    status,
    received_at: 1_700_000_000_000,
  } as InboxMessage
}

describe('inboxSnapshot', () => {
  it('sends every stored message as-is, unread first', () => {
    // The background adapter path left archived messages out, unlike the
    // foreground path and DOC_GET_INBOX.
    const byStatus: Record<string, InboxMessage[]> = {
      unread: [message('u1', 'unread')],
      read: [message('r1', 'read')],
      archived: [message('a1', 'archived')],
    }
    const snapshot = inboxSnapshot({ getInbox: (status) => byStatus[status] })

    expect(snapshot.version).toBe(1)
    expect(snapshot.messages.map((m) => m.id)).toEqual(['u1', 'r1', 'a1'])
    expect(snapshot.messages[0]).toEqual(byStatus.unread[0])
    expect(snapshot.messages[0]).toMatchObject({ from: 'did:key:z6Mku1', content: 'body u1', sender_alias: 'sender-u1' })
  })
})
