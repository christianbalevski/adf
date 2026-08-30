import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import {
  LOOP_POOL_UNAVAILABLE,
  resolveLoopPool,
  type LoopPoolAccessor
} from '../../adf/loop-pool.types'

const InputSchema = z.object({})

/**
 * Read-only roster of this agent's cognition loops — discovery for `loop_send`.
 *
 * An ordinary declared tool (superseding the §7.1 "essential"): enabled+visible
 * in `DEFAULT_TOOLS`, owner-toggleable, and granted to a side loop only when
 * that loop's allow-list names it. Registered only while the agent has a loop.
 * `main` is always present in the roster even though it never appears in
 * `AgentConfig.loops`.
 */
export class LoopListTool implements Tool {
  readonly name = 'loop_list'
  readonly description =
    'List the cognition loops of this agent — name, goal, whether each is enabled, and whether it is running right now. ' +
    'Includes "main" (the loop that faces the outside world) and marks which one you are. Use it to pick a target for loop_send.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  private getPool: LoopPoolAccessor

  constructor(getPool: LoopPoolAccessor) {
    this.getPool = getPool
  }

  async execute(_input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const pool = resolveLoopPool(this.getPool)
    if (!pool) return { content: LOOP_POOL_UNAVAILABLE, isError: true }

    const self = workspace.getLoopName()

    try {
      const loops = pool.listLoops().map(loop => ({
        name: loop.name,
        goal: loop.goal,
        status: loop.status,
        enabled: loop.enabled,
        is_main: loop.isMain,
        is_you: loop.name === self
      }))

      return {
        content: JSON.stringify({ you: self, loops }, null, 2),
        isError: false
      }
    } catch (error) {
      return {
        content: `Failed to list loops: ${error instanceof Error ? error.message : String(error)}`,
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
