/**
 * Settings store migrations, shared by SettingsService (Studio) and
 * FileSettingsStore (daemon). Electron-free — pure functions over the
 * plain settings object, so BOTH processes apply identical backfills and
 * a store loaded by the daemon can never keep stale values (e.g. a
 * pre-existing partial compute.containerPackages missing VNC packages).
 *
 * Each migration mutates `data` in place and reports which top-level keys
 * changed so callers can persist exactly those keys.
 */

import { DEFAULT_TOOL_PROMPTS, DEFAULT_DYNAMIC_PROMPTS, MIND_PROMPT_SECTION, SOUL_PROMPT_SECTION } from '../constants/adf-defaults'
import { withBuiltInAdapterRegistrations } from '../constants/adapter-registry'
import { DEFAULT_COMPUTE_SETTINGS } from '../constants/compute-defaults'
import type { AdapterRegistration } from '../types/channel-adapter.types'

export interface SettingsMigrationResult {
  changed: boolean
  /** Top-level settings keys mutated by the migrations. */
  changedKeys: string[]
}

/** Required container packages that must always be present. */
const REQUIRED_CONTAINER_PACKAGES = DEFAULT_COMPUTE_SETTINGS.containerPackages

/**
 * The mind section text as shipped before the mind-wiki rework. Saved custom
 * base prompts containing this exact text are upgraded in place to the new
 * MIND_PROMPT_SECTION; kept verbatim so the replace can match.
 */
export const LEGACY_MIND_PROMPT_SECTION = `

## Your Mind

Your private working memory (\`mind.md\`), snapshotted at the start of each session. Keep it current with \`fs_write\` as you learn — it is how you carry context across sessions.

{{mind.md}}`

/**
 * Run every settings migration in the canonical order (adapters, compute,
 * tool prompts, soul, mind). Idempotent.
 */
export function applySettingsMigrations(data: Record<string, unknown>): SettingsMigrationResult {
  const changedKeys = new Set<string>()
  if (migrateBuiltInAdapters(data)) changedKeys.add('adapters')
  if (migrateComputeDefaults(data)) changedKeys.add('compute')
  if (migrateToolPrompts(data)) changedKeys.add('toolPrompts')
  if (migrateGlobalSystemPromptSoul(data)) changedKeys.add('globalSystemPrompt')
  if (migrateGlobalSystemPromptMind(data)) changedKeys.add('globalSystemPrompt')
  return { changed: changedKeys.size > 0, changedKeys: [...changedKeys] }
}

/**
 * Merge semantics for a settings set(): compute settings are updated from
 * several independent controls, so partial updates must merge into the
 * current value — an execution-target write cannot erase machine or
 * host-access settings (and vice versa). All other keys replace wholesale.
 */
export function mergeSettingsValue(current: unknown, key: string, value: unknown): unknown {
  if (key === 'compute' && value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...(current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}),
      ...(value as Record<string, unknown>),
    }
  }
  return value
}

/** Ensure built-in channel adapters are always available to the runtime. */
function migrateBuiltInAdapters(data: Record<string, unknown>): boolean {
  const saved = Array.isArray(data.adapters)
    ? data.adapters as AdapterRegistration[]
    : []
  const merged = withBuiltInAdapterRegistrations(saved)
  if (JSON.stringify(saved) !== JSON.stringify(merged)) {
    data.adapters = merged
    console.log('[Settings] Migrated adapters — added built-in channel adapters')
    return true
  }
  return false
}

/** Ensure saved compute settings include all required packages and fields. */
function migrateComputeDefaults(data: Record<string, unknown>): boolean {
  const saved = data.compute as Record<string, unknown> | undefined
  if (!saved) return false // No saved compute settings — DEFAULTS will apply

  // Remove stale Alpine package names that don't exist on Debian
  const STALE_PACKAGES = ['py3-pip', 'python3-full']  // Alpine names → python3-pip on Debian
  const savedPkgs = (saved.containerPackages as string[]) ?? []
  let merged = savedPkgs.filter((p) => !STALE_PACKAGES.includes(p))
  let changed = merged.length !== savedPkgs.length

  // Merge required packages into saved list
  for (const pkg of REQUIRED_CONTAINER_PACKAGES) {
    if (!merged.includes(pkg)) {
      merged.push(pkg)
      changed = true
    }
  }

  // Deduplicate
  const deduped = [...new Set(merged)]
  if (deduped.length !== merged.length) { merged = deduped; changed = true }

  if (changed) {
    saved.containerPackages = merged
  }

  // Ensure new fields exist with defaults
  if (!saved.containerImage) { saved.containerImage = DEFAULT_COMPUTE_SETTINGS.containerImage; changed = true }
  if (!saved.machineCpus) { saved.machineCpus = DEFAULT_COMPUTE_SETTINGS.machineCpus; changed = true }
  if (!saved.machineMemoryMb) { saved.machineMemoryMb = DEFAULT_COMPUTE_SETTINGS.machineMemoryMb; changed = true }
  if (!Array.isArray(saved.executionTargets)) { saved.executionTargets = []; changed = true }

  if (changed) {
    data.compute = saved
    console.log('[Settings] Migrated compute defaults — added missing packages/fields')
  }
  return changed
}

/**
 * Prompt keys that no longer inject anywhere and should be dropped from saved
 * settings. adf_shell: the shell guide moved into the ShellTool description so
 * it rides with the schema (hidden shell = zero context).
 */
const STALE_TOOL_PROMPT_KEYS = ['adf_shell']

/** Backfill new tool prompt keys from defaults into saved settings. */
function migrateToolPrompts(data: Record<string, unknown>): boolean {
  const saved = data.toolPrompts as Record<string, string> | undefined
  if (!saved) return false // No saved toolPrompts — DEFAULTS will apply

  let changed = false
  for (const [key, value] of Object.entries({ ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS })) {
    if (!(key in saved)) {
      saved[key] = value
      changed = true
    }
  }
  for (const key of STALE_TOOL_PROMPT_KEYS) {
    if (key in saved) {
      delete saved[key]
      changed = true
    }
  }
  if (changed) {
    data.toolPrompts = saved
    console.log('[Settings] Migrated toolPrompts — added missing keys / removed stale keys')
  }
  return changed
}

/**
 * Ensure a persisted custom base prompt injects soul.md. Runs before the mind
 * migration so a prompt missing both sections gains them in the default
 * soul-then-mind order. Idempotent.
 */
function migrateGlobalSystemPromptSoul(data: Record<string, unknown>): boolean {
  const prompt = data.globalSystemPrompt
  if (typeof prompt !== 'string') return false
  if (prompt.includes('{{soul.md}}')) return false
  data.globalSystemPrompt = prompt.trimEnd() + SOUL_PROMPT_SECTION
  console.log('[Settings] Migrated globalSystemPrompt — backfilled {{soul.md}} injection')
  return true
}

/** Normalize CRLF to LF so string matching is line-ending agnostic. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Ensure a persisted custom base prompt still injects mind, with current
 * guidance. Two cases, both idempotent:
 * - The prompt contains the pre-rework mind section verbatim → replace it in
 *   place with the new MIND_PROMPT_SECTION (mind-wiki rules).
 * - The prompt lacks the `{{mind.md}}` token entirely (saved before the
 *   placeholder existed) → append the new section.
 * Prompts with the token but custom surrounding text are left untouched —
 * the user edited them deliberately.
 *
 * Matching and replacement run on `\r\n`→`\n` normalized copies of both the
 * prompt and the constants, so a CRLF-saved prompt (or a CRLF build of the
 * constants) still migrates. When the legacy section is replaced, the stored
 * result is the normalized prompt (LF line endings throughout).
 */
function migrateGlobalSystemPromptMind(data: Record<string, unknown>): boolean {
  const prompt = data.globalSystemPrompt
  if (typeof prompt !== 'string') return false
  const normalizedPrompt = normalizeEol(prompt)
  const normalizedLegacy = normalizeEol(LEGACY_MIND_PROMPT_SECTION)
  if (normalizedPrompt.includes(normalizedLegacy)) {
    data.globalSystemPrompt = normalizedPrompt.replace(normalizedLegacy, normalizeEol(MIND_PROMPT_SECTION))
    console.log('[Settings] Migrated globalSystemPrompt — upgraded legacy mind section to mind-wiki rules')
    return true
  }
  if (prompt.includes('{{mind.md}}')) return false
  data.globalSystemPrompt = prompt.trimEnd() + MIND_PROMPT_SECTION
  console.log('[Settings] Migrated globalSystemPrompt — backfilled {{mind.md}} injection')
  return true
}
