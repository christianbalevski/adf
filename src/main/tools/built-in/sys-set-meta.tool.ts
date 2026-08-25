import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { META_PROTECTION_LEVELS } from '../../../shared/types/adf-v02.types'

const InputSchema = z.object({
  key: z.string().describe('The metadata key to set.'),
  value: z.string().optional().describe('The value to store. Omit when using delta.'),
  delta: z
    .number()
    .optional()
    .describe(
      'Atomically ADD this number to the current value instead of overwriting it (creates the key at delta if missing). Use this for counters — read-then-write from concurrent tasks loses updates.'
    ),
  protection: z
    .enum(META_PROTECTION_LEVELS)
    .optional()
    .describe(
      'Protection level for new keys. Ignored for existing keys. Default: none. Options: none (read/write/delete), readonly (read only), increment (value can only increase).'
    )
}).refine((v) => (v.value === undefined) !== (v.delta === undefined), {
  message: 'Provide exactly one of "value" (absolute) or "delta" (atomic add).'
})

export class SysSetMetaTool implements Tool {
  readonly name = 'sys_set_meta'
  readonly description =
    'Write a key-value pair to adf_meta. Creates the key if missing, overwrites if present. Pass `delta` instead of `value` to atomically add to a numeric counter — the safe way to update a shared counter from concurrent tasks. Provide exactly ONE of `value` or `delta`, never both; when setting a value, omit `delta` entirely (do not send delta: 0). Protection level is set at creation and cannot be changed by the agent.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { key, value, delta, protection } = input as z.infer<typeof InputSchema>
    const isOverride = (input as Record<string, unknown>)?._protection_override === true

    const existing = workspace.getMetaProtection(key)

    // Atomic add. The only protection question a delta can raise is answered by
    // its SIGN — no read is needed, so there is no window for a concurrent
    // writer to make the decision stale.
    if (delta !== undefined) {
      if (existing === 'readonly' && !isOverride) {
        return {
          content: `Cannot write to "${key}": key is readonly.`,
          isError: true,
          protection: {
            kind: 'meta_protection', target: key, level: 'readonly',
            description: `Add ${delta} to meta "${key}" — key is readonly`
          }
        }
      }
      if (existing === 'increment' && delta <= 0 && !isOverride) {
        return {
          content: `Cannot update "${key}": delta (${delta}) must be positive — this key can only increase.`,
          isError: true,
          protection: {
            kind: 'meta_protection', target: key, level: 'increment',
            description: `Add ${delta} to meta "${key}" — must increase`
          }
        }
      }
      const next = workspace.incrementMeta(key, delta, protection)
      if (next === null) {
        return {
          content: `Cannot add to "${key}": the stored value is not numeric.`,
          isError: true
        }
      }
      const bypassed = isOverride && ((existing === 'readonly') || (existing === 'increment' && delta <= 0))
      if (bypassed) {
        workspace.insertLog?.('warn', 'protection', 'bypass', key,
          `Added ${delta} to protected meta "${key}" (${existing}) — human-approved override`)
        return { content: `OK: ${key} = ${next} (⚠ protection override: ${existing}, human-approved).`, isError: false }
      }
      return { content: `OK: ${key} = ${next}`, isError: false }
    }

    // Absolute write. `value` is present — the schema refine guarantees exactly
    // one of value/delta.
    const absolute = value as string

    // Tracks a REAL protection that an override just punched through, so a
    // silent bypass can't happen (No Secrets): audit + visible marker below.
    let bypassedLevel: 'readonly' | 'increment' | null = null

    if (existing === 'readonly') {
      if (!isOverride) {
        return {
          content: `Cannot write to "${key}": key is readonly.`,
          isError: true,
          protection: {
            kind: 'meta_protection', target: key, level: 'readonly',
            description: `Set meta "${key}" — key is readonly`
          }
        }
      }
      bypassedLevel = 'readonly'
    }

    if (existing === 'increment') {
      const currentVal = parseFloat(workspace.getMeta(key) ?? '0')
      const newVal = parseFloat(absolute)
      if (isNaN(currentVal) || isNaN(newVal)) {
        // Not overridable: an override cannot make a non-numeric value valid.
        return {
          content: `Cannot update "${key}": increment keys require numeric values.`,
          isError: true
        }
      }
      if (newVal <= currentVal) {
        if (!isOverride) {
          return {
            content: `Cannot update "${key}": new value (${newVal}) must be greater than current value (${currentVal}).`,
            isError: true,
            protection: {
              kind: 'meta_protection', target: key, level: 'increment',
              description: `Update meta "${key}" — must increase (current ${currentVal})`
            }
          }
        }
        bypassedLevel = 'increment'
      }
    }

    // New key: apply protection (default 'none')
    if (existing === null) {
      // Validate numeric initial value for increment keys
      if (protection === 'increment' && isNaN(parseFloat(absolute))) {
        return {
          content: `Cannot create increment key "${key}": initial value must be numeric.`,
          isError: true
        }
      }
      workspace.setMeta(key, absolute, protection)
    } else {
      workspace.setMeta(key, absolute)
    }

    if (bypassedLevel) {
      workspace.insertLog?.('warn', 'protection', 'bypass', key,
        `Wrote protected meta "${key}" (${bypassedLevel}) — human-approved override`)
      return {
        content: `OK (⚠ protection override: ${bypassedLevel}, human-approved).`,
        isError: false
      }
    }
    return { content: 'OK', isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    // zodToJsonSchema drops .refine(); the value/delta XOR lives in the
    // description and the runtime refine error instead of a root-level oneOf —
    // strict providers (xAI) reject root unions with non-object branches.
    const schema = zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    return {
      name: this.name,
      description: this.description,
      input_schema: schema
    }
  }
}
