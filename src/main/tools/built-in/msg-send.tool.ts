import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  recipient: z
    .string()
    .min(1)
    .optional()
    .describe('DID of the recipient agent (e.g., "did:key:..."). Required unless parent_id is provided, in which case the runtime resolves recipient from the inbox message. For adapter recipients use the format "type:id" (e.g., "telegram:123").'),
  address: z
    .string()
    .url()
    .optional()
    .describe('Delivery URL for mesh recipients (e.g., "http://127.0.0.1:7295/agent-handle/mesh/inbox"). Required unless parent_id is provided or sending to an adapter recipient.'),
  content: z
    .string()
    .min(1)
    .describe('The message content to send.'),
  subject: z
    .string()
    .optional()
    .describe('Optional subject line for the message.'),
  thread_id: z
    .string()
    .optional()
    .describe('Thread ID for grouping related messages into a conversation thread. Auto-inherited from parent message if parent_id is provided.'),
  parent_id: z
    .string()
    .optional()
    .describe('Message ID for threading/replies. If provided without recipient and address, the runtime resolves both from the referenced inbox message (from becomes recipient, reply_to becomes address).'),
  attachments: z
    .array(z.string())
    .optional()
    .describe('File paths within this agent\'s file store to attach (e.g. ["data.csv", "results/output.json"]).'),
  meta: z
    .record(z.unknown())
    .optional()
    .describe('Metadata included in the message payload. Encrypted along with content — only the recipient can read it. Use for private structured data between sender and recipient.'),
  message_meta: z
    .record(z.unknown())
    .optional()
    .describe('Metadata on the outer message. Always cleartext — visible to relays and intermediaries. Use for routing hints (e.g. { forward_to: "did:key:..." }), PoW proofs, TTL, priority.')
})

export type SendMessageFn = (
  recipient: string,
  address: string | undefined,
  content: string,
  subject?: string,
  threadId?: string,
  parentId?: string,
  attachments?: string[],
  meta?: Record<string, unknown>,
  messageMeta?: Record<string, unknown>
) => Promise<{ success: boolean; messageId?: string; statusCode?: number; error?: string }>

export type SendModeCheckFn = () => {
  sendMode: 'proactive' | 'respond_only' | 'listen_only'
  isMessageTriggered: boolean
}

/**
 * Resolves a bare handle against the local mesh registry.
 *
 * Returns:
 *   - `{ ok: true, address, did? }` — handle matched a local agent that is reachable from the caller's scope.
 *   - `{ ok: false, reason }` — handle matched a local agent, but the caller's scope is below the recipient's visibility tier.
 *   - `null` — no local agent has this handle.
 *
 * The closure also applies the visibility check so the tool surfaces the same reason strings
 * that the HTTP path would produce at 403 time.
 */
export type ResolveLocalHandleFn = (handle: string) =>
  | { ok: true; address: string; did?: string }
  | { ok: false; reason: string }
  | null

/**
 * Tool that allows an agent to send a message to another agent.
 * Bound to a specific agent via constructor injection.
 */
export class SendMessageTool implements Tool {
  readonly name = 'msg_send'
  readonly description =
    'Send a message to another agent. Modes: (1) recipient DID + address for direct remote send; (2) parent_id to reply (runtime resolves recipient and address from the inbox row); (3) bare handle with no address — works only for locally-registered agents on this runtime; the runtime resolves the address from the handle and enforces the recipient\'s visibility tier. For remote agents, always provide an explicit address from agent_discover. Adapter recipients use "type:id" (e.g. "telegram:123").'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private sendFn: SendMessageFn
  private checkFn: SendModeCheckFn
  private resolveLocalHandleFn: ResolveLocalHandleFn | null

  constructor(sendFn: SendMessageFn, checkFn: SendModeCheckFn, resolveLocalHandleFn?: ResolveLocalHandleFn) {
    this.sendFn = sendFn
    this.checkFn = checkFn
    this.resolveLocalHandleFn = resolveLocalHandleFn ?? null
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    let { recipient, address } = parsed
    const { content, subject, parent_id, attachments, meta, message_meta } = parsed
    let { thread_id } = parsed

    // Resolve recipient, address, and thread_id from parent_id if not provided
    if (parent_id) {
      const allInboxMessages = [
        ...workspace.getInbox('unread'),
        ...workspace.getInbox('read'),
        ...workspace.getInbox('archived')
      ]
      const parentMsg = allInboxMessages.find(msg => msg.id === parent_id)
      if (!parentMsg) {
        return {
          content: `No inbox message found with id "${parent_id}". Cannot resolve recipient.`,
          isError: true
        }
      }
      // Use || (not ??) so an empty-string `from` (identity-less legacy rows) falls through to sender_alias.
      if (!recipient) recipient = parentMsg.from || parentMsg.sender_alias || ''
      if (!address && parentMsg.reply_to) address = parentMsg.reply_to
      if (!thread_id && parentMsg.thread_id) thread_id = parentMsg.thread_id
      if (!thread_id) thread_id = parent_id
    }

    if (!recipient) {
      if (parent_id) {
        return {
          content: `Parent inbox message "${parent_id}" has no sender identifier (its \`from\` and \`sender_alias\` are both empty). Pass \`recipient\` explicitly.`,
          isError: true
        }
      }
      return {
        content: 'Either recipient or parent_id is required.',
        isError: true
      }
    }

    // Bare-handle shortcut: if the recipient is a bare handle (no `:`) and no
    // address was provided, try resolving it against locally-registered agents.
    // This is intentionally local-only — remote addressing requires agent_discover
    // discovery plus an explicit address. Asymmetry is documented in the tool description.
    const isBareHandle = !recipient.startsWith('did:') && !recipient.includes(':')
    if (isBareHandle && !address && !parent_id) {
      const resolved = this.resolveLocalHandleFn?.(recipient) ?? null
      if (!resolved) {
        return {
          content: `msg_send: no local agent with handle "${recipient}". For remote agents, provide an explicit address from agent_discover.`,
          isError: true
        }
      }
      if (!resolved.ok) {
        return {
          content: `msg_send: ${resolved.reason} (recipient "${recipient}")`,
          isError: true
        }
      }
      address = resolved.address
      if (resolved.did) recipient = resolved.did
    }

    // Recipient + address accepted unconditionally: the address is the delivery mechanism,
    // the recipient is whatever the sender calls the receiver (handle, DID, label). No identity
    // claim is made by the send. Adapter-prefixed recipients route internally and need no address.
    // parent_id replies came through the resolver above. Everything else is rejected.
    //
    // Known sharp edge: a bare string like `http://foo.com` passes the `includes(':')` check and
    // is treated as adapter `"http"`; it will fail loudly at adapter dispatch. Adapter-registry
    // lookup is a follow-up.
    const isAdapterRecipient = !recipient.startsWith('did:') && recipient.includes(':')
    if (!address && !isAdapterRecipient && !parent_id) {
      return {
        content: 'msg_send requires address, adapter-prefixed recipient, or parent_id.',
        isError: true
      }
    }

    // Enforce messaging mode
    const { sendMode, isMessageTriggered } = this.checkFn()

    if (sendMode === 'listen_only') {
      return {
        content: 'This agent is configured with messaging mode "listen_only" and cannot send messages.',
        isError: true
      }
    }

    if (sendMode === 'respond_only' && !isMessageTriggered) {
      // Check if this is a reply to a valid inbox message
      let isValidReply = false
      if (parent_id) {
        const allInboxMessages = [
          ...workspace.getInbox('unread'),
          ...workspace.getInbox('read'),
          ...workspace.getInbox('archived')
        ]
        isValidReply = allInboxMessages.some(msg => msg.id === parent_id)
      }

      if (!isValidReply) {
        return {
          content:
            'This agent is configured with messaging mode "respond_only" and can only send messages when replying to a message in the inbox (use parent_id parameter) or during a turn triggered by an incoming message.',
          isError: true
        }
      }
    }

    const result = await this.sendFn(recipient, address, content, subject, thread_id, parent_id, attachments, meta, message_meta)
    if (!result.success) {
      return {
        content: result.error ?? 'Failed to send message.',
        isError: true
      }
    }

    const attachLabel = attachments && attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ''
    const statusLabel = result.statusCode != null ? ` Status: ${result.statusCode}.` : ''
    return {
      content: `Message sent to ${recipient}.${statusLabel}${attachLabel}`,
      isError: false
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
