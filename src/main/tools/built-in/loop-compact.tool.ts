import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  instructions: z.string().optional().describe(
    'Optional instructions for the compaction summarizer. Use this to highlight critical context, ' +
    'decisions, or state that must be preserved in the summary.'
  )
})

/**
 * Agent-initiated compaction signal. The actual LLM-powered compaction
 * (summary generation, loop clear, summary insertion) is handled by the
 * AgentExecutor in post-processing.
 */
export class LoopCompactTool implements Tool {
  readonly name = 'loop_compact'
  readonly description =
    'Compact conversation history. An LLM will summarize your conversation, clear old entries, ' +
    'and insert the summary so you retain context. Use when your context is getting large.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  async execute(_input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const totalEntries = workspace.getLoopCount()
    if (totalEntries === 0) {
      return {
        content: 'Nothing to compact — the loop is empty.',
        isError: false
      }
    }

    return {
      content: `Compaction initiated for ${totalEntries} loop entries. The conversation will be summarized and compressed.`,
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
