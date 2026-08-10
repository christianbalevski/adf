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
 * Filter fields each table actually supports. A field that is not in this list
 * is silently ignored when the WHERE clause is built, which would turn a
 * narrow-looking call (e.g. outbox + `source`) into an unfiltered DELETE.
 */
const SUPPORTED_FILTER_KEYS: Record<'inbox' | 'outbox', readonly string[]> = {
  inbox: ['status', 'from', 'source', 'before', 'thread_id'],
  outbox: ['status', 'before', 'thread_id']
}

/**
 * Delete inbox or outbox messages by filter.
 * If audit is enabled, matched messages are compressed and saved to the audit log before deletion.
 */
export class MsgDeleteTool implements Tool {
  readonly name = 'msg_delete'
  readonly description =
    'Delete messages from inbox or outbox by filter. ' +
    'Requires at least one filter field: inbox supports status, from, source, before, thread_id; ' +
    'outbox supports status, before, thread_id (from/source are inbox-only and are rejected for outbox). ' +
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

    // Reject filters whose fields the target table cannot honour. Unsupported
    // fields are dropped when the WHERE clause is built, so accepting them
    // would execute an unfiltered DELETE over the whole table.
    const supported = SUPPORTED_FILTER_KEYS[source]
    const supplied = Object.entries(filter as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k]) => k)
    if (supplied.length === 0) {
      return {
        content: 'At least one filter field is required to prevent accidental deletion of all messages.',
        isError: true
      }
    }
    const unsupported = supplied.filter(k => !supported.includes(k))
    if (unsupported.length > 0) {
      return {
        content: `Filter field(s) not supported for ${source}: ${unsupported.join(', ')}. Supported ${source} filters: ${supported.join(', ')}.`,
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
