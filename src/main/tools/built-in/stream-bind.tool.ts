import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolProviderFormat, ToolResult } from '../../../shared/types/tool.types'
import type { StreamBindingManager } from '../../runtime/stream-binding-manager'

const UmbilicalFilterSchema = z.object({
  event_types: z.array(z.string()).optional(),
  when: z.string().optional()
})

const EndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ws'), connection_id: z.string() }),
  z.object({
    kind: z.literal('process'),
    isolation: z.enum(['host', 'container_shared', 'container_isolated']),
    image: z.string().optional(),
    command: z.array(z.string()).min(1),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional()
  }),
  z.object({ kind: z.literal('tcp'), host: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal('umbilical'), filter: UmbilicalFilterSchema.optional() })
])

const InputSchema = z.object({
  a: EndpointSchema,
  b: EndpointSchema,
  bidirectional: z.boolean().optional(),
  options: z.object({
    idle_timeout_ms: z.number().int().positive().optional(),
    max_duration_ms: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
    flow_summary_interval_ms: z.number().int().positive().optional(),
    close_a_on_b_close: z.boolean().optional(),
    close_b_on_a_close: z.boolean().optional()
  }).optional()
})

export class StreamBindTool implements Tool {
  readonly name = 'stream_bind'
  readonly description = 'Bind two runtime-managed byte endpoints so bytes are pumped outside the agent loop. Supports WebSocket, TCP, host process, and umbilical source endpoints.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  constructor(private readonly manager: StreamBindingManager) {}

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    try {
      const result = await this.manager.bind(parsed)
      return { content: JSON.stringify(result), isError: false }
    } catch (err) {
      return { content: String(err instanceof Error ? err.message : err), isError: true }
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
