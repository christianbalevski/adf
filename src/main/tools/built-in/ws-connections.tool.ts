import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { WsConnectionInfo } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({
  direction: z.enum(['inbound', 'outbound']).optional().describe('Filter by direction')
})

export type WsConnectionsListFn = (filter?: {
  direction?: 'inbound' | 'outbound'
}) => WsConnectionInfo[]

export class WsConnectionsTool implements Tool {
  readonly name = 'ws_connections'
  readonly description = 'List active WebSocket connections (both inbound and outbound).'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private listFn: WsConnectionsListFn

  constructor(listFn: WsConnectionsListFn) {
    this.listFn = listFn
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const connections = this.listFn(parsed.direction ? { direction: parsed.direction } : undefined)

    if (connections.length === 0) {
      return { content: 'No active WebSocket connections.', isError: false }
    }

    return {
      content: JSON.stringify(connections, null, 2),
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
