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

/**
 * Meta keys that assert a runtime-verified fact about a message. They are
 * stamped by the ingress pipeline / transport AFTER verification and must never
 * be taken from the wire: `payload.meta` is attacker-controlled and is spread
 * into the stored inbox meta, so an unsanitized `identity_verified: true` there
 * would show as verified in the UI and in the agent's own `msg_read` output.
 */
export const TRUST_META_KEYS = [
  'message_verified',
  'payload_verified',
  'identity_verified',
  'payload_encrypted',
  'ws_remote_did'
] as const

/**
 * Remove runtime-only trust stamps from wire- or agent-supplied meta.
 * Returns the input unchanged when it carries none of them.
 */
export function stripTrustMeta<T extends Record<string, unknown> | undefined>(meta: T): T {
  if (!meta) return meta
  let cleaned: Record<string, unknown> | undefined
  for (const key of TRUST_META_KEYS) {
    if (key in meta) {
      cleaned ??= { ...meta }
      delete cleaned[key]
    }
  }
  return (cleaned ?? meta) as T
}

/**
 * Aliases the runtime assigns itself for locally originated messages
 * (see MeshManager.deliverOwnerMessage, which stores sender_alias 'owner').
 * A remote peer that puts the same string in `payload.sender_alias` would be
 * displayed identically, so a wire-supplied reserved alias is dropped and the
 * verified DID in `from` is shown instead. The claim survives verbatim in the
 * tombstoned `original_message`.
 */
const RESERVED_SENDER_ALIASES = new Set(['owner', 'system', 'user'])

function sanitizeSenderAlias(alias: string | undefined): string | undefined {
  if (!alias) return alias
  return RESERVED_SENDER_ALIASES.has(alias.trim().toLowerCase()) ? undefined : alias
}

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
      // Caller-supplied meta reaches here from agent tools (msg_send message_meta) —
      // never let it carry runtime verification stamps onto the wire.
      ...stripTrustMeta(opts.meta),
      ...(opts.owner && { owner: opts.owner }),
      ...(opts.cardUrl && { card: opts.cardUrl }),
    },
    payload: {
      meta: stripTrustMeta(opts.payloadMeta),
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
      // payload.meta is wire data — strip trust stamps before it can shadow the
      // runtime's own (see TRUST_META_KEYS).
      ...stripTrustMeta(p.meta),
      // Propagate verification/encryption stamps from message meta (set by ingress pipeline)
      ...(message.meta?.message_verified != null && { message_verified: message.meta.message_verified }),
      ...(message.meta?.payload_verified != null && { payload_verified: message.meta.payload_verified }),
      ...(message.meta?.identity_verified != null && { identity_verified: message.meta.identity_verified }),
      ...(message.meta?.payload_encrypted != null && { payload_encrypted: message.meta.payload_encrypted })
    },
    sender_alias: sanitizeSenderAlias(p.sender_alias),
    recipient_alias: p.recipient_alias,
    message_id: message.id,
    // `owner` is a sender claim. Keep it only when the message signature verified,
    // so it is attributable to the DID in `from`; an unsigned peer cannot plant
    // an ownership claim that reads as identity downstream.
    owner: message.meta?.message_verified === true
      ? (message.meta?.owner as string | undefined)
      : undefined,
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
    meta: stripTrustMeta(p.meta),
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
