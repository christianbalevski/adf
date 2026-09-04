/**
 * "New agent template" merge/diff.
 *
 * The template (settings.agentTemplate) stores ONLY the user's overrides of
 * the code defaults. `mergeAgentTemplate` produces the effective creatable
 * config; `diffAgentTemplate` is its inverse and is what the settings UI
 * writes back, so a field left at its default never gets persisted and keeps
 * tracking the code default across releases.
 *
 * Merge rules: plain objects merge recursively, arrays REPLACE (the template
 * `tools` list is a whole list, not a patch), `undefined` in the template is
 * skipped, `null` is a value (limits.max_active_turns: null = unlimited).
 */

import type { AgentConfig, AgentTemplate } from '../types/adf-v02.types'

/** The slice of AgentConfig the template can shape. */
export type AgentTemplateBase = Pick<
  AgentConfig,
  'model' | 'autonomous' | 'instructions' | 'tools' | 'limits' | 'security' | 'messaging'
>

export const AGENT_TEMPLATE_KEYS = [
  'model',
  'autonomous',
  'instructions',
  'tools',
  'limits',
  'security',
  'messaging',
] as const satisfies readonly (keyof AgentTemplate)[]

export type AgentTemplateKey = (typeof AGENT_TEMPLATE_KEYS)[number]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clone(v)
    return out as T
  }
  return value
}

/** Deep merge one value: objects recurse, arrays replace, undefined skipped. */
export function deepMergeTemplateValue<T>(base: T, override: unknown): T {
  if (override === undefined) return clone(base)
  if (Array.isArray(override)) return clone(override) as unknown as T
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = clone(base)
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined) continue
      out[k] = deepMergeTemplateValue(out[k], v)
    }
    return out as T
  }
  return clone(override) as T
}

/**
 * Effective creatable config = `defaults` with `template` overrides applied.
 * Returns a fresh object; neither input is mutated.
 */
export function mergeAgentTemplate<T extends AgentTemplateBase>(
  defaults: T,
  template: AgentTemplate | null | undefined
): T {
  const out = clone(defaults) as Record<string, unknown>
  if (!template) return out as T
  for (const key of AGENT_TEMPLATE_KEYS) {
    const override = template[key]
    if (override === undefined) continue
    out[key] = deepMergeTemplateValue(out[key], override)
  }
  return out as T
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false
    return true
  }
  return false
}

/**
 * Smallest template that turns `defaults` into `effective`. Object sections
 * keep only the differing keys; arrays and scalars are kept whole or dropped.
 * Returns `{}` when nothing differs.
 */
export function diffAgentTemplate(defaults: AgentTemplateBase, effective: AgentTemplateBase): AgentTemplate {
  const out: Record<string, unknown> = {}
  for (const key of AGENT_TEMPLATE_KEYS) {
    const base = defaults[key] as unknown
    const next = effective[key] as unknown
    if (deepEqual(base, next)) continue
    if (isPlainObject(base) && isPlainObject(next)) {
      const section: Record<string, unknown> = {}
      for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
        if (next[k] === undefined) continue
        if (!deepEqual(base[k], next[k])) section[k] = clone(next[k])
      }
      if (Object.keys(section).length > 0) out[key] = section
      continue
    }
    out[key] = clone(next)
  }
  return out as AgentTemplate
}

/** True when the template overrides anything under `key`. */
export function templateOverrides(template: AgentTemplate | null | undefined, keys: readonly AgentTemplateKey[]): boolean {
  if (!template) return false
  return keys.some((k) => template[k] !== undefined)
}
