import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { META_PROTECTION_LEVELS } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({
  key: z.string().describe('The metadata key to set.'),
  value: z.string().describe('The value to store.'),
  protection: z
    .enum(META_PROTECTION_LEVELS)
    .optional()
    .describe(
      'Protection level for new keys. Ignored for existing keys. Default: none. Options: none (read/write/delete), readonly (read only), increment (value can only increase).'
    )
})

export class SysSetMetaTool implements Tool {
  readonly name = 'sys_set_meta'
  readonly description =
    'Write a key-value pair to adf_meta. Creates the key if missing, overwrites if present. Protection level is set at creation and cannot be changed by the agent.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { key, value, protection } = input as z.infer<typeof InputSchema>

    const existing = workspace.getMetaProtection(key)

    if (existing === 'readonly') {
      return { content: `Cannot write to "${key}": key is readonly.`, isError: true }
    }

    if (existing === 'increment') {
      const currentVal = parseFloat(workspace.getMeta(key) ?? '0')
      const newVal = parseFloat(value)
      if (isNaN(currentVal) || isNaN(newVal)) {
        return {
          content: `Cannot update "${key}": increment keys require numeric values.`,
          isError: true
        }
      }
      if (newVal <= currentVal) {
        return {
          content: `Cannot update "${key}": new value (${newVal}) must be greater than current value (${currentVal}).`,
          isError: true
        }
      }
    }

    // New key: apply protection (default 'none')
    if (existing === null) {
      // Validate numeric initial value for increment keys
      if (protection === 'increment' && isNaN(parseFloat(value))) {
        return {
          content: `Cannot create increment key "${key}": initial value must be numeric.`,
          isError: true
        }
      }
      workspace.setMeta(key, value, protection)
    } else {
      workspace.setMeta(key, value)
    }

    return { content: 'OK', isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
