import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  connection_id: z.string().optional().describe('Connection ID to close'),
  id: z.string().optional().describe('Config ID to disconnect')
})

export type WsDisconnectFn = (
  connectionId?: string,
  configId?: string
) => Promise<{ success: boolean; error?: string }>

export class WsDisconnectTool implements Tool {
  readonly name = 'ws_disconnect'
  readonly description = 'Close a WebSocket connection by connection_id or config id.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private disconnectFn: WsDisconnectFn

  constructor(disconnectFn: WsDisconnectFn) {
    this.disconnectFn = disconnectFn
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>

    if (!parsed.connection_id && !parsed.id) {
      return { content: 'Either connection_id or id is required.', isError: true }
    }

    const result = await this.disconnectFn(parsed.connection_id, parsed.id)
    if (!result.success) {
      return { content: result.error ?? 'Failed to disconnect.', isError: true }
    }

    return { content: 'Disconnected.', isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
