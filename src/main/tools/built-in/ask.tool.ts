import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('The question to ask the human operator. Be specific about what you need to proceed.')
})

/**
 * Pose a question to the human operator and block until they respond.
 * Available in both interactive and autonomous modes.
 *
 * In autonomous mode, this pauses the agent — operators managing many
 * agents will only be interrupted for critical questions. The autonomous
 * system prompt instructs the agent to use this sparingly.
 *
 * The actual blocking/resume mechanism is handled by the executor, not
 * this tool. The tool returns a special marker that the executor detects.
 */
export class AskTool implements Tool {
  readonly name = 'ask'
  readonly description =
    'Ask the human operator a question and wait for their response. The turn pauses until the human replies. In autonomous mode, only use this when critically blocked and cannot proceed without human input.'
  readonly inputSchema = InputSchema
  readonly category = 'general' as const

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const { question } = input as z.infer<typeof InputSchema>

    // The executor intercepts 'ask' tool calls before they reach here.
    // If we somehow get here, return the question as a marker.
    return {
      content: JSON.stringify({ ask_question: question }),
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
