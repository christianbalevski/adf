/**
 * "Agent template" merge/diff.
 *
 * The template (settings.agentTemplate) stores ONLY the user's overrides of
 * the code defaults. `mergeAgentTemplate` produces the effective creatable
 * config; `diffAgentTemplate` is its inverse and is what the settings UI
 * writes back, so a field left at its default never gets persisted and keeps
 * tracking the code default across releases.
 *
 * Both are generic deep operations over the whole config: plain objects merge
 * recursively, arrays REPLACE (the template `tools` list is a whole list, not
 * a patch), `undefined` in the template is skipped, `null` is a value
 * (limits.max_active_turns: null = unlimited). The keys in
 * `AGENT_TEMPLATE_EXCLUDED_KEYS` come from the file and its lifecycle and are
 * never read from or written to a template; `files` is seed content, not
 * config, and is passed through untouched.
 */

import type { AgentConfig, AgentTemplate } from '../types/adf-v02.types'

/** Config keys the template never carries: set per agent at create time. */
export const AGENT_TEMPLATE_EXCLUDED_KEYS = ['id', 'metadata', 'adf_version', 'name', 'description', 'state'] as const satisfies readonly (keyof AgentConfig)[]

/** Non-config template key holding seed file content. */
export const AGENT_TEMPLATE_FILES_KEY = 'files' as const

const EXCLUDED = new Set<string>([...AGENT_TEMPLATE_EXCLUDED_KEYS, AGENT_TEMPLATE_FILES_KEY])

/** Config keys the template may shape. */
export type AgentTemplateKey = Exclude<keyof AgentTemplate, typeof AGENT_TEMPLATE_FILES_KEY>

/** The config slice the template operates on (anything without the excluded keys). */
export type AgentTemplateBase = Omit<AgentConfig, (typeof AGENT_TEMPLATE_EXCLUDED_KEYS)[number]>

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
 * Excluded keys and `files` in the template are ignored. Returns a fresh
 * object; neither input is mutated.
 */
export function mergeAgentTemplate<T extends Partial<AgentTemplateBase>>(
  defaults: T,
  template: AgentTemplate | null | undefined
): T {
  const out = clone(defaults) as Record<string, unknown>
  if (!template) return out as T
  for (const [key, override] of Object.entries(template)) {
    if (EXCLUDED.has(key) || override === undefined) continue
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
 * Smallest override that turns `base` into `next`, or `undefined` when they
 * are equal. Objects keep only differing keys (recursively); arrays and
 * scalars are kept whole. A key that `next` lacks but `base` has cannot be
 * expressed (undefined is "skip") and is left to the default.
 */
function deepDiff(base: unknown, next: unknown): unknown {
  if (deepEqual(base, next)) return undefined
  if (next === undefined) return undefined
  if (isPlainObject(base) && isPlainObject(next)) {
    const section: Record<string, unknown> = {}
    for (const k of Object.keys(next)) {
      const d = deepDiff(base[k], next[k])
      if (d !== undefined) section[k] = d
    }
    return Object.keys(section).length > 0 ? section : undefined
  }
  return clone(next)
}

/**
 * Smallest template that turns `defaults` into `effective`. Excluded keys are
 * never emitted. Returns `{}` when nothing differs. Seed `files` are not part
 * of the config and are not produced here; callers carry them alongside.
 */
export function diffAgentTemplate(
  defaults: Partial<AgentTemplateBase>,
  effective: Partial<AgentTemplateBase>
): AgentTemplate {
  const out: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(defaults), ...Object.keys(effective)])
  for (const key of keys) {
    if (EXCLUDED.has(key)) continue
    const d = deepDiff((defaults as Record<string, unknown>)[key], (effective as Record<string, unknown>)[key])
    if (d !== undefined) out[key] = d
  }
  return out as AgentTemplate
}

/** True when the template overrides anything under one of `keys`. */
export function templateOverrides(template: AgentTemplate | null | undefined, keys: readonly (keyof AgentTemplate)[]): boolean {
  if (!template) return false
  return keys.some((k) => template[k] !== undefined)
}
