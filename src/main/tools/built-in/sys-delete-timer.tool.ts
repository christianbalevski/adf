import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { MAIN_LOOP } from '../../adf/derive-loop-config'

const InputSchema = z.object({
  id: z.number().int().positive().describe('The timer ID to delete.')
})

/**
 * Delete a scheduled timer.
 */
export class DeleteTimerTool implements Tool {
  readonly name = 'sys_delete_timer'
  readonly description = 'Delete a timer by its ID (active or expired). Use sys_list_timers to see timer IDs; expired timers are history entries and can be deleted to clean up.'
  readonly inputSchema = InputSchema
  readonly category = 'timer' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { id } = input as z.infer<typeof InputSchema>

    try {
      const timers = workspace.getTimers()
      const timer = timers.find(t => t.id === id)
      // A side loop deletes only the timers it set. Unscoped, one could clear
      // main's charter timers by id — ids it can no longer see through
      // sys_list_timers, but ids are guessable integers.
      const self = workspace.getLoopName()
      if (timer && self !== MAIN_LOOP && (timer.loop ?? MAIN_LOOP) !== self) {
        return {
          content: `Timer ${id} belongs to another loop of this agent. A loop can only delete the timers it set.`,
          isError: true
        }
      }
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
