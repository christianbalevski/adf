import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  id: z.number().int().positive().describe('The timer ID to delete.')
})

/**
 * Delete a scheduled timer.
 */
export class DeleteTimerTool implements Tool {
  readonly name = 'sys_delete_timer'
  readonly description = 'Delete a scheduled timer by its ID. Use get_timers to see timer IDs.'
  readonly inputSchema = InputSchema
  readonly category = 'timer' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { id } = input as z.infer<typeof InputSchema>

    try {
      const timers = workspace.getTimers()
      const timer = timers.find(t => t.id === id)
      if (timer?.locked) {
        return {
          content: `Timer ${id} is locked and cannot be deleted. Only a human can unlock or delete it.`,
          isError: true
        }
      }

      const deleted = workspace.deleteTimer(id)

      if (deleted) {
        return {
          content: `Timer ${id} deleted successfully.`,
          isError: false
        }
      } else {
        return {
          content: `Timer ${id} not found.`,
          isError: true
        }
      }
    } catch (error) {
      return {
        content: `Failed to delete timer: ${String(error)}`,
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
