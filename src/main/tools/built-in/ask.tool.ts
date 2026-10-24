import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const OptionSchema = z.object({
  label: z.string().min(1).describe('Short choice text, e.g. "Postgres".'),
  description: z.string().optional().describe('One line on what picking it means, e.g. "Needs a server; better for concurrent writes".')
})

const QuestionSchema = z.object({
  question: z.string().min(1).describe('The full question.'),
  options: z
    .array(OptionSchema)
    .min(1)
    .optional()
    .describe('Choices to pick from. Omit for a free-text answer. "Other" is always offered.'),
  multiple: z.boolean().optional().describe('Allow picking several options.')
})

export const AskInputSchema = z.object({
  questions: z
    .array(QuestionSchema)
    .min(1)
    .describe('One or more questions, shown together as a form. The human may skip any of them.')
})

/**
 * Pose questions to the human operator and block until they respond.
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
    'Ask the human operator one or more questions as a form and wait for their answers. The turn pauses until they submit. ' +
    'Free-text question: {"question": "Anything I should avoid?"}. ' +
    'Choice question: {"question": "Which database?", "options": [{"label": "Postgres", "description": "Needs a server"}, {"label": "SQLite", "description": "Single file"}]}. ' +
    'Answers come back as Q:/A: pairs; skipped questions read "(skipped)". ' +
    'In autonomous mode, only use this when critically blocked and cannot proceed without human input.'
  readonly inputSchema = AskInputSchema
  readonly category = 'general' as const

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    // The executor intercepts 'ask' tool calls before they reach here.
    // If we somehow get here, return the questions as a marker.
    const { questions } = input as z.infer<typeof AskInputSchema>
    return {
      content: JSON.stringify({ ask_questions: questions }),
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
