import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  key: z
    .string()
    .optional()
    .describe('Key to look up. If omitted, returns all key-value pairs.')
})

export class SysGetMetaTool implements Tool {
  readonly name = 'sys_get_meta'
  readonly description =
    'Read metadata values from adf_meta. Pass a key to get one value, or omit to list all as "key\\tvalue" lines. Query adf_meta via db_query if you need protection levels.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { key } = input as z.infer<typeof InputSchema>

    if (key !== undefined) {
      const value = workspace.getMeta(key)
      if (value === null) {
        return { content: `Key "${key}" not found.`, isError: false }
      }
      return { content: value, isError: false }
    }

    const all = workspace.getAllMeta()
    if (all.length === 0) {
      return { content: 'No metadata entries.', isError: false }
    }
    return { content: all.map(e => `${e.key}\t${e.value}`).join('\n'), isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
