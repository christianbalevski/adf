import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  id: z.string().optional().describe('ID of a configured connection to start'),
  url: z.string().url().optional().describe('WebSocket URL for ad-hoc connection'),
  did: z.string().optional().describe('Expected remote DID'),
  lambda: z.string().optional().describe('Lambda handler for hot-path events (file:fn format)'),
  persist: z.boolean().optional().describe('Whether to save to ws_connections config (default: true). Set false for ephemeral connections.'),
  auto_reconnect: z.boolean().optional(),
  reconnect_delay_ms: z.number().optional(),
  keepalive_interval_ms: z.number().optional()
})

export type WsConnectFn = (opts: {
  id?: string
  url?: string
  did?: string
  lambda?: string
  persist?: boolean
  auto_reconnect?: boolean
  reconnect_delay_ms?: number
  keepalive_interval_ms?: number
}) => Promise<{ connection_id?: string; error?: string }>

export class WsConnectTool implements Tool {
  readonly name = 'ws_connect'
  readonly description =
    'Start a WebSocket connection. Either provide an ID of a configured connection, or a URL for an ad-hoc connection.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private connectFn: WsConnectFn

  constructor(connectFn: WsConnectFn) {
    this.connectFn = connectFn
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>

    if (!parsed.id && !parsed.url) {
      return { content: 'Either id or url is required.', isError: true }
    }

    const result = await this.connectFn(parsed)
    if (result.error) {
      return { content: result.error, isError: true }
    }

    return {
      content: `Connected. connection_id: ${result.connection_id}`,
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
