import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolProviderFormat, ToolResult } from '../../../shared/types/tool.types'
import type { StreamBindingManager } from '../../runtime/stream-binding-manager'

const InputSchema = z.object({})

export class StreamBindingsTool implements Tool {
  readonly name = 'stream_bindings'
  readonly description = 'List active stream bindings for this agent, including sanitized endpoint summaries and byte counters.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  constructor(private readonly manager: StreamBindingManager) {}

  async execute(_input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    return { content: JSON.stringify(this.manager.bindingsSummary()), isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
