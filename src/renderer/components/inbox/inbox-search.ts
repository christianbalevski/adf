import type { InboxMessage, RendererOutboxMessage } from '../../../shared/types/adf.types'

/** Case-insensitive match over sender (address and alias), subject and body. */
export function matchesInboxSearch(message: InboxMessage, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [message.from, message.sender_alias, message.subject, message.content]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(q))
}

/** Sent messages: recipient (address and alias), subject and body. */
export function matchesOutboxSearch(message: RendererOutboxMessage, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [message.to, message.recipient_alias, message.subject, message.content]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(q))
}
