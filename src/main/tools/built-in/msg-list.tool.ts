import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({})

/**
 * Check inbox for unread messages.
 * Returns count of unread, read, and archived messages.
 */
export class InboxCheckTool implements Tool {
  readonly name = 'msg_list'
  readonly description =
    'Check your inbox for messages. Returns counts of unread, read, and archived messages.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  async execute(_input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const unreadMessages = workspace.getInbox('unread')
    const readMessages = workspace.getInbox('read')
    const archivedMessages = workspace.getInbox('archived')

    const summary = {
      unread: unreadMessages.length,
      read: readMessages.length,
      archived: archivedMessages.length,
      total: unreadMessages.length + readMessages.length + archivedMessages.length
    }

    const message = [
      `Inbox status:`,
      `- Unread: ${summary.unread}`,
      `- Read: ${summary.read}`,
      `- Archived: ${summary.archived}`,
      `- Total: ${summary.total}`
    ].join('\n')

    return {
      content: message,
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
