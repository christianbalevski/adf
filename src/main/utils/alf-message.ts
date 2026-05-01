/**
 * ALF Message Utilities
 *
 * Centralized helpers for constructing, tombstoning, and flattening
 * ALF (Agentic Lingua Franca) messages.
 */

import { nanoid as _nanoid } from 'nanoid'

/** Short 10-char IDs — sufficient for per-agent uniqueness (inbox/outbox rows) */
const nanoid = () => _nanoid(10)

/** 20-char IDs for globally unique ALF message IDs */
const messageId = () => _nanoid(20)
import type {
  AlfMessage,
  AlfPayload,
  AlfAttachment,
  StoredAttachment,
  InboxMessage,
  OutboxMessage
} from '../../shared/types/adf-v02.types'

export interface BuildMessageOpts {
  from: string
  to: string
  replyTo?: string
  network?: string
  content: string | Record<string, unknown>
  contentType?: string
  cardUrl?: string        // URL to sender's card endpoint
  owner?: string          // owner DID
  subject?: string
  threadId?: string
  parentId?: string
  senderAlias?: string
  recipientAlias?: string
  attachments?: AlfAttachment[]
  meta?: Record<string, unknown>
  payloadMeta?: Record<string, unknown>
}

/**
 * Construct a full AlfMessage from options.
 */
export function buildAlfMessage(opts: BuildMessageOpts): AlfMessage {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    network: opts.network ?? 'devnet',
    id: messageId(),
    timestamp: now,
    from: opts.from,
    to: opts.to,
    reply_to: opts.replyTo ?? opts.from,
    meta: {
      ...opts.meta,
      ...(opts.owner && { owner: opts.owner }),
      ...(opts.cardUrl && { card: opts.cardUrl }),
    },
    payload: {
      meta: opts.payloadMeta,
      sender_alias: opts.senderAlias,
      recipient_alias: opts.recipientAlias,
      thread_id: opts.threadId,
      parent_id: opts.parentId ?? null,
      subject: opts.subject,
      content: opts.content,
      content_type: opts.contentType,
      attachments: opts.attachments,
      sent_at: now
    }
  }
}

/**
 * Create a tombstoned copy of a message — replaces payload.content
 * and payload.attachments with "[flattened]" for storage.
 */
export function tombstoneMessage(message: AlfMessage): string {
  const tombstoned = {
    ...message,
    payload: {
      ...message.payload,
      content: '[flattened]',
      attachments: message.payload.attachments ? '[flattened]' : undefined
    }
  }
  return JSON.stringify(tombstoned)
}

/**
 * Extract flattened inbox message fields from an ALF message.
 */
export function flattenMessageToInbox(
  message: AlfMessage,
  receivedAt: number
): Omit<InboxMessage, 'id'> {
  const p = message.payload
  const content = typeof p.content === 'string' ? p.content : JSON.stringify(p.content)
  const sentAt = p.sent_at ? new Date(p.sent_at).getTime() : undefined

  return {
    from: message.from,
    to: message.to,
    reply_to: message.reply_to,
    network: message.network,
    thread_id: p.thread_id,
    parent_id: p.parent_id ?? undefined,
    subject: p.subject,
    content,
    content_type: p.content_type,
    attachments: p.attachments?.map(a => storedAttachmentFromAlf(a)),
    meta: {
      ...p.meta,
      // Propagate verification stamps from message meta (set by ingress pipeline)
      ...(message.meta?.message_verified != null && { message_verified: message.meta.message_verified }),
      ...(message.meta?.payload_verified != null && { payload_verified: message.meta.payload_verified }),
      ...(message.meta?.identity_verified != null && { identity_verified: message.meta.identity_verified })
    },
    sender_alias: p.sender_alias,
    recipient_alias: p.recipient_alias,
    message_id: message.id,
    owner: message.meta?.owner as string | undefined,
    card: message.meta?.card as string | undefined,
    return_path: undefined,   // set by caller from transport context (NOT from message.reply_to)
    source: 'mesh',
    sent_at: sentAt,
    received_at: receivedAt,
    status: 'unread',
    original_message: tombstoneMessage(message)
  }
}

/**
 * Extract flattened outbox message fields from an ALF message.
 */
export function flattenMessageToOutbox(
  message: AlfMessage,
  createdAt: number
): Omit<OutboxMessage, 'id'> {
  const p = message.payload
  const content = typeof p.content === 'string' ? p.content : JSON.stringify(p.content)

  return {
    from: message.from,
    to: message.to,
    reply_to: message.reply_to,
    network: message.network,
    thread_id: p.thread_id,
    parent_id: p.parent_id ?? undefined,
    subject: p.subject,
    content,
    content_type: p.content_type,
    attachments: p.attachments?.map(a => storedAttachmentFromAlf(a)),
    meta: p.meta,
    sender_alias: p.sender_alias,
    recipient_alias: p.recipient_alias,
    message_id: message.id,
    owner: message.meta?.owner as string | undefined,
    card: message.meta?.card as string | undefined,
    return_path: undefined,   // set by caller from transport context
    created_at: createdAt,
    status: 'pending',
    original_message: tombstoneMessage(message)
  }
}

/**
 * Build an inline AlfAttachment from file data.
 */
export function alfAttachmentFromFile(
  filename: string,
  contentType: string,
  data: Buffer
): AlfAttachment {
  return {
    filename,
    content_type: contentType,
    transfer: 'inline',
    data: data.toString('base64'),
    size_bytes: data.length
  }
}

/**
 * Convert a wire AlfAttachment to a StoredAttachment.
 */
export function storedAttachmentFromAlf(
  alf: AlfAttachment,
  localPath?: string
): StoredAttachment {
  return {
    ...alf,
    path: localPath
  }
}
