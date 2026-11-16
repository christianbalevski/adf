import type { z } from 'zod'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../shared/types/tool.types'

export type ToolCategory =
  | 'document'
  | 'filesystem'
  | 'communication'
  | 'external'
  | 'timer'
  | 'self'
  | 'general'
  | 'database'
  | 'system'

/** Per-call context the registry hands a tool. */
export interface ToolCallContext {
  /** Aborted when the owner interrupts the turn that made the call, or cancels its task. A long-running tool stops on it. */
  signal?: AbortSignal
  /** Set when the call runs as an `adf_tasks` row (`_async`); inherited by nested calls. */
  taskId?: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<unknown>
  readonly category: ToolCategory
  /** If true, requires human-in-the-loop approval before execution */
  readonly requireApproval?: boolean

  execute(input: unknown, workspace: AdfWorkspace, context?: ToolCallContext): Promise<ToolResult>
  toProviderFormat(): ToolProviderFormat
}
