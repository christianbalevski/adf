import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { ChatInfoResult } from '../../../shared/types/channel-adapter.types'

const InputSchema = z.object({
  adapter: z
    .string()
    .min(1)
    .describe('Channel adapter type to query: "telegram", "discord", "slack", "whatsapp", ... Must be enabled and connected for this agent.'),
  chat_id: z
    .string()
    .min(1)
    .describe('Platform chat/channel id — the source_context.chat_id (or channel_id) from an inbox message. E.g. Telegram "-100123...", Slack "C0123...", WhatsApp "xyz@g.us".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Max participants to return (default 50).')
})

export type ChatInfoFn = (adapter: string, chatId: string, opts?: { limit?: number }) => Promise<ChatInfoResult>

/**
 * Read-only chat/channel metadata lookup through a connected channel adapter:
 * title, description, participant roster (truncated), counts.
 *
 * Declared `visible: false` by default — callable from sandbox code as
 * `adf.chat_info({ adapter, chat_id })` without occupying a slot in the LLM
 * tool schema. Flip `visible: true` in the agent's tool config to expose it
 * as a first-class tool.
 */
export class ChatInfoTool implements Tool {
  readonly name = 'chat_info'
  readonly description =
    'Look up a chat/channel you are in via a connected channel adapter: title, description, member roster (truncated), participant count. Read-only. Use when the meta.group context on an inbound message is not enough. Note: Telegram can only list admins; email has no live roster (recipients are in source_context.to/cc via msg_read).'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private chatInfoFn: ChatInfoFn

  constructor(chatInfoFn: ChatInfoFn) {
    this.chatInfoFn = chatInfoFn
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const result = await this.chatInfoFn(parsed.adapter, parsed.chat_id, parsed.limit ? { limit: parsed.limit } : undefined)

    if (!result.supported) {
      const hint = parsed.adapter === 'email'
        ? ' Email threads have no live roster — read the thread with msg_read; recipients are in source_context.to / source_context.cc.'
        : ''
      // Unsupported is a structured outcome, not an error — agents adapt to it.
      return {
        content: JSON.stringify({ supported: false, reason: result.reason + hint }),
        isError: false
      }
    }

    return {
      content: JSON.stringify(result.info, null, 2),
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
