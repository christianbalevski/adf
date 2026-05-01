import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const FilterSchema = z.object({
  status: z.string().optional().describe('Filter by message status (e.g. "unread", "read", "archived" for inbox; "pending", "sent", "delivered", "failed" for outbox).'),
  from: z.string().optional().describe('Filter by sender ID (inbox only).'),
  source: z.string().optional().describe('Filter by source transport (e.g. "mesh", "telegram").'),
  before: z.number().int().optional().describe('Delete messages with timestamp before this value (epoch ms).'),
  thread_id: z.string().optional().describe('Filter by thread ID.')
})

const InputSchema = z.object({
  source: z.enum(['inbox', 'outbox']).describe('Which message store to delete from.'),
  filter: FilterSchema.refine(
    (f) => Object.values(f).some(v => v !== undefined),
    { message: 'At least one filter field is required to prevent accidental deletion of all messages.' }
  )
})

/**
 * Delete inbox or outbox messages by filter.
 * If audit is enabled, matched messages are compressed and saved to the audit log before deletion.
 */
export class MsgDeleteTool implements Tool {
  readonly name = 'msg_delete'
  readonly description =
    'Delete messages from inbox or outbox by filter. ' +
    'Requires at least one filter field (status, from, source, before, thread_id). ' +
    'If audit is enabled, messages are compressed and saved to the audit log before deletion.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { source, filter } = input as z.infer<typeof InputSchema>

    // Validate: from is only valid for inbox
    if (source === 'outbox' && filter.from) {
      return {
        content: 'The "from" filter is only available for inbox messages.',
        isError: true
      }
    }

    try {
      let result: { deleted: number; audited: boolean }

      if (source === 'inbox') {
        result = workspace.deleteInboxByFilter(filter)
      } else {
        const { from: _from, ...outboxFilter } = filter
        result = workspace.deleteOutboxByFilter(outboxFilter)
      }

      const parts = [`Deleted ${result.deleted} ${source} messages.`]
      if (result.audited) parts.push('Messages saved to audit log before deletion.')
      if (result.deleted === 0) parts[0] = `No ${source} messages matched the filter.`

      return {
        content: parts.join(' '),
        isError: false
      }
    } catch (error) {
      return {
        content: `Failed to delete ${source} messages: ${String(error)}`,
        isError: true
      }
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
