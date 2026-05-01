import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolProviderFormat, ToolResult } from '../../../shared/types/tool.types'
import type { StreamBindingManager } from '../../runtime/stream-binding-manager'

const InputSchema = z.object({
  binding_id: z.string().min(1)
})

export class StreamUnbindTool implements Tool {
  readonly name = 'stream_unbind'
  readonly description = 'Terminate an active stream binding by ID.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  constructor(private readonly manager: StreamBindingManager) {}

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    try {
      const result = await this.manager.unbind(parsed.binding_id)
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
