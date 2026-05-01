import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  message_ids: z
    .union([z.string(), z.array(z.string())])
    .describe('Message ID or array of message IDs to update'),
  status: z
    .enum(['read', 'archived', 'delete'])
    .describe('New status: "read", "archived", or "delete" (delete only works on archived messages)')
})

/**
 * Update the status of inbox messages.
 * Can mark messages as read, archived, or delete them (only if already archived).
 */
export class InboxUpdateTool implements Tool {
  readonly name = 'msg_update'
  readonly description =
    'Update the status of one or more inbox messages. Mark as read/archived, or delete archived messages. Supports batch operations by passing an array of message IDs.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const { message_ids, status } = parsed

    // Normalize to array
    const ids = Array.isArray(message_ids) ? message_ids : [message_ids]

    // Get all messages to validate
    const allMessages = workspace.getInbox()
    const results: string[] = []
    const errors: string[] = []

    for (const id of ids) {
      const message = allMessages.find(m => m.id === id)

      if (!message) {
        errors.push(`Message "${id}" not found`)
        continue
      }

      // Validate delete operation
      if (status === 'delete') {
        if (message.status !== 'archived') {
          errors.push(`Message "${id}" must be archived before deleting (current status: ${message.status})`)
          continue
        }
        workspace.deleteInboxMessage(id)
        results.push(`Deleted message "${id}"`)
      } else {
        workspace.updateInboxStatus(id, status)
        results.push(`Message "${id}" marked as ${status}`)
      }
    }

    // Build response
    const parts: string[] = []
    if (results.length > 0) {
      parts.push(results.join('\n'))
    }
    if (errors.length > 0) {
      parts.push('\nErrors:\n' + errors.join('\n'))
    }

    return {
      content: parts.join('\n'),
      isError: errors.length > 0 && results.length === 0
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
