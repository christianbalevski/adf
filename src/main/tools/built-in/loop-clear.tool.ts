import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  start: z.number().int().optional().describe(
    'Start index (inclusive). Supports negative indices like Python: -1 = last entry, -3 = third from end. Omit to start from the beginning.'
  ),
  end: z.number().int().optional().describe(
    'End index (exclusive). Supports negative indices. Omit to go to the end.'
  )
})

/**
 * Python-style slice deletion on adf_loop.
 *
 * Examples:
 *   loop_clear()              → clear all entries
 *   loop_clear(end: 5)        → clear first 5 entries
 *   loop_clear(start: -10)    → clear last 10 entries
 *   loop_clear(start: 2, end: 8) → clear entries 2..7
 */
export class LoopClearTool implements Tool {
  readonly name = 'loop_clear'
  readonly description =
    'Delete loop entries using Python-style slicing. ' +
    'Examples: clear all (no args), clear first 5 (end=5), clear all except last 5 (end=-5), ' +
    'clear last 10 (start=-10), clear range (start=2, end=8). ' +
    'If audit is enabled, entries are compressed and saved to the audit log before deletion.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { start, end } = input as z.infer<typeof InputSchema>

    try {
      const result = workspace.clearLoopSlice(start, end)

      const parts = [`Deleted ${result.deleted} loop entries.`]
      if (result.audited) parts.push('Entries saved to audit log before deletion.')
      if (result.deleted === 0) parts[0] = 'No entries matched the specified range.'

      return {
        content: parts.join(' '),
        isError: false
      }
    } catch (error) {
      return {
        content: `Failed to clear loop: ${String(error)}`,
        isError: true
      }
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
