import type { InboxMessage } from '../../shared/types/adf-v02.types'

/**
 * The INBOX_UPDATED payload the renderer's inbox panel renders: every stored
 * message, unread first, as the workspace returns it (same shape as
 * DOC_GET_INBOX). Shared by the foreground and background adapter paths so
 * the two can't drift apart.
 */
export function inboxSnapshot(workspace: { getInbox(status: 'unread' | 'read' | 'archived'): InboxMessage[] }): {
  version: 1
  messages: InboxMessage[]
} {
  return {
    version: 1,
    messages: [...workspace.getInbox('unread'), ...workspace.getInbox('read'), ...workspace.getInbox('archived')],
  }
}
