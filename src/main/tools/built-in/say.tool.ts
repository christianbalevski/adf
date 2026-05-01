import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe('The text to emit — a status update, intermediate observation, or progress report.')
})

/**
 * Emit text to the conversation without ending the turn. Use for status
 * updates, intermediate observations, or progress reports.
 *
 * Unlike model thinking tokens (which are invisible/discarded), say
 * output is permanent and observable in the conversation history.
 */
export class SayTool implements Tool {
  readonly name = 'say'
  readonly description =
    'Emit text to the conversation without ending the turn. Use for status updates, intermediate observations, or progress reports.'
  readonly inputSchema = InputSchema
  readonly category = 'general' as const

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    input as z.infer<typeof InputSchema>

    return {
      content: 'ok',
      isError: false,
      endTurn: false
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
