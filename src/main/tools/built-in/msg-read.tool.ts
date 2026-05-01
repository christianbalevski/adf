import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  status: z
    .enum(['unread', 'read', 'archived'])
    .optional()
    .describe('Filter by message status. Default: unread'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of messages to return. Default: all')
})

/**
 * Read messages from inbox.
 * Returns detailed message information.
 */
export class InboxReadTool implements Tool {
  readonly name = 'msg_read'
  readonly description =
    'Read messages from your inbox. Returns message details including sender, content, source transport, and metadata.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const status = parsed.status || 'unread'
    const limit = parsed.limit

    let messages = workspace.getInbox(status)
    if (limit) {
      messages = messages.slice(0, limit)
    }

    if (messages.length === 0) {
      return {
        content: `No ${status} messages in inbox.`,
        isError: false
      }
    }

    // Auto-mark unread messages as read so inbox notifications stop re-firing
    if (status === 'unread') {
      for (const msg of messages) {
        workspace.updateInboxStatus(msg.id, 'read')
      }
    }

    // Strip original_message field from LLM output (large tombstoned JSON not useful for the agent)
    const sanitized = messages.map(({ original_message, ...rest }) => rest)

    return {
      content: JSON.stringify(sanitized, null, 2),
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
