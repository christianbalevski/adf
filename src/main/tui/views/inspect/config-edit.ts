// Validate an agent config edited as text before it is PUT back.

import type { AgentConfig } from '../../api/types'
import { cjs } from '../../interop'
import { isPlainObject } from './format'

export type ConfigCheck =
  | { ok: true; config: AgentConfig; changedKeys: string[]; warnings: string[] }
  | { ok: false; errors: string[] }

type SafeParse = (value: unknown) => { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }

let schemaParse: SafeParse | null = null

async function loadSchema(): Promise<SafeParse> {
  if (schemaParse) return schemaParse
  const ns = cjs(await import('../../../adf/adf-schema'))
  const schema = ns.AgentConfigSchema as unknown as { safeParse: SafeParse }
  schemaParse = value => schema.safeParse(value)
  return schemaParse
}

/** Top-level keys whose values differ between two configs, sorted. */
export function changedKeysBetween(a: object, b: object): string[] {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  return [...keys].filter(key => JSON.stringify(x[key]) !== JSON.stringify(y[key])).sort()
}

export async function checkConfigText(text: string, original: AgentConfig | undefined): Promise<ConfigCheck> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!isPlainObject(parsed)) return { ok: false, errors: ['The config must be a JSON object.'] }
  let parse: SafeParse
  try {
    parse = await loadSchema()
  } catch (err) {
    return { ok: false, errors: [`Could not load the config schema: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const result = parse(parsed)
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.slice(0, 12).map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    }
  }
  const before = (original ?? {}) as Record<string, unknown>
  const changedKeys = changedKeysBetween(before, parsed)
  const warnings: string[] = []
  for (const key of ['id', 'handle', 'name'] as const) {
    if (original && before[key] !== undefined && parsed[key] !== before[key]) warnings.push(`${key} changes from ${JSON.stringify(before[key])} to ${JSON.stringify(parsed[key])}`)
  }
  return { ok: true, config: parsed as unknown as AgentConfig, changedKeys, warnings }
}
