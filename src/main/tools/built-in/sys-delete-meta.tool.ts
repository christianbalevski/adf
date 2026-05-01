import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  key: z.string().describe('The metadata key to delete.')
})

export class SysDeleteMetaTool implements Tool {
  readonly name = 'sys_delete_meta'
  readonly description =
    'Delete a key from adf_meta. Protected keys (readonly or increment) cannot be deleted.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { key } = input as z.infer<typeof InputSchema>

    const protection = workspace.getMetaProtection(key)
    if (protection === 'readonly' || protection === 'increment') {
      return { content: `Cannot delete "${key}": key is protected (${protection}).`, isError: true }
    }

    const deleted = workspace.deleteMeta(key)
    return { content: deleted ? 'OK' : `Key "${key}" not found.`, isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
