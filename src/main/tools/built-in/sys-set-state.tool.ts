import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { SETTABLE_STATES } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({
  state: z
    .enum(SETTABLE_STATES)
    .describe('The state to transition to. "idle" = idle but responsive to triggers. "hibernate" = deep idle, timers only. "off" = fully stopped.')
})

/**
 * Transition the agent to a new state and end the current turn.
 * The LLM can only set: idle, hibernate, off.
 * The runtime handles: active, suspended.
 */
export class SysSetStateTool implements Tool {
  readonly name = 'sys_set_state'
  readonly description =
    'Transition to a new state and end the current turn. Use "idle" to go idle but remain responsive to document edits, messages, and timers. Use "hibernate" for deep idle (timers only). Use "off" to fully stop.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const { state } = input as z.infer<typeof InputSchema>

    return {
      content: JSON.stringify({ target_state: state }),
      isError: false,
      endTurn: true
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
