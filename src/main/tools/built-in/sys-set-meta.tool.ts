import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { META_PROTECTION_LEVELS } from '../../../shared/types/adf-v02.types'

const ObjectSchema = z.object({
  key: z.string().describe('The metadata key to set.'),
  value: z
    .string()
    .describe('The value to store — or, when inc is true, the numeric amount to add.'),
  inc: z
    .boolean()
    .optional()
    .describe(
      'true: atomically ADD the numeric value to the current value instead of overwriting it (creates the key at value if missing). Use this for counters — read-then-write from concurrent tasks loses updates. false/omitted: overwrite.'
    ),
  protection: z
    .enum(META_PROTECTION_LEVELS)
    .optional()
    .describe(
      'Protection level for new keys. Ignored for existing keys. Default: none. Options: none (read/write/delete), readonly (read only), increment (value can only increase).'
    )
})

// Back-compat: the tool used to take `delta: number` instead of `inc`. Agents
// whose transcripts contain old-style calls may imitate them, so map
// { delta } → { value, inc: true }. A `delta` sent alongside `value` is
// dropped — an explicit value is a set.
const InputSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { delta, ...rest } = raw as Record<string, unknown>
    if (typeof delta === 'number' && rest.value === undefined) {
      return { ...rest, value: String(delta), inc: true }
    }
    if (delta !== undefined) return rest
  }
  return raw
}, ObjectSchema)

export class SysSetMetaTool implements Tool {
  readonly name = 'sys_set_meta'
  readonly description =
    'Write a key-value pair to adf_meta. Creates the key if missing, overwrites if present. Pass inc: true to atomically ADD the numeric value to the current value instead of overwriting — the safe way to update a shared counter from concurrent tasks. Protection level is set at creation and cannot be changed by the agent.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { key, value, inc, protection } = input as z.infer<typeof ObjectSchema>
    const isOverride = (input as Record<string, unknown>)?._protection_override === true

    const existing = workspace.getMetaProtection(key)

    // Atomic add. The only protection question a delta can raise is answered by
    // its SIGN — no read is needed, so there is no window for a concurrent
    // writer to make the decision stale.
    if (inc === true) {
      const delta = Number(value)
      if (!Number.isFinite(delta)) {
        return {
          content: `Cannot add to "${key}": inc requires a numeric value, got "${value}".`,
          isError: true
        }
      }
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
          content: `Cannot update "${key}": value (${delta}) must be positive — this key can only increase.`,
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

    // Absolute write.
    const absolute = value

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
    // Serialize the inner object schema, not the preprocess wrapper — the
    // legacy-delta shim is runtime-only and must not leak into the provider
    // schema. Plain optional fields keep strict providers (xAI, OpenAI strict
    // mode) happy; no root-level union is needed since inc is a mode flag.
    const schema = zodToJsonSchema(ObjectSchema) as Record<string, unknown>
    return {
      name: this.name,
      description: this.description,
      input_schema: schema
    }
  }
}
