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

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<unknown>
  readonly category: ToolCategory
  /** If true, requires human-in-the-loop approval before execution */
  readonly requireApproval?: boolean

  execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult>
  toProviderFormat(): ToolProviderFormat
}
