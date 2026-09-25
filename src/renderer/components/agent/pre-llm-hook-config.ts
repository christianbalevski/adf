import type { PreLlmHookConfig } from '../../../shared/types/adf-v02.types'

/** Keep these bounds in sync with PreLlmHookConfigSchema and the runtime guard. */
export const PRE_LLM_HOOK_MIN_TIMEOUT_MS = 1_000
export const PRE_LLM_HOOK_MAX_TIMEOUT_MS = 300_000
export const PRE_LLM_HOOK_MAX_LOOPS = 64
export const PRE_LLM_HOOK_LOOP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** The special membrane-facing target shown in the Studio target list. */
export const PRE_LLM_HOOK_MAIN_TARGET = 'main'

/** A draft target is either the main stream or a named inner loop. */
export type PreLlmHookTarget = string

/** `all` preserves the legacy all-stream selector; `targets` is the new row UI. */
export type PreLlmHookTargetMode = 'all' | 'targets'

/** String-backed editor state keeps incomplete values out of persisted config. */
export interface PreLlmHookDraft {
  source: string
  targetMode: PreLlmHookTargetMode
  targets: PreLlmHookTarget[]
  timeout_ms: string
}

export interface PreLlmHookDraftValidation {
  config?: PreLlmHookConfig
  errors: string[]
}

/**
 * Read every supported runtime shape without narrowing an existing selector:
 * `all` stays all, `main` becomes one Main row, and `loops` becomes named rows
 * with Main prepended only when include_main was persisted.
 */
export function preLlmHookDraftFromConfig(config?: PreLlmHookConfig): PreLlmHookDraft {
  if (!config) {
    // Main is the safe, useful default for a brand-new hook. It is only used
    // when no persisted config exists; legacy all configs remain all below.
    return { source: '', targetMode: 'targets', targets: [PRE_LLM_HOOK_MAIN_TARGET], timeout_ms: '' }
  }

  if ((config.scope ?? 'all') === 'all') {
    return { source: config.source, targetMode: 'all', targets: [], timeout_ms: config.timeout_ms === undefined ? '' : String(config.timeout_ms) }
  }

  const targets = config.scope === 'main'
    ? [PRE_LLM_HOOK_MAIN_TARGET]
    : [
        ...(config.include_main ? [PRE_LLM_HOOK_MAIN_TARGET] : []),
        ...(config.loops ?? []),
      ]
  return {
    source: config.source,
    targetMode: 'targets',
    targets,
    timeout_ms: config.timeout_ms === undefined ? '' : String(config.timeout_ms),
  }
}

function targetErrorName(name: string): string {
  return name || 'blank target'
}

/**
 * Convert target rows back to the exact backward-compatible runtime shape.
 * All remains an explicit mode, while Main + named loops uses loops with the
 * additive include_main flag because the runtime's loops array excludes main.
 */
export function validatePreLlmHookDraft(draft: PreLlmHookDraft): PreLlmHookDraftValidation {
  const errors: string[] = []
  const source = draft.source.trim()
  if (!source) errors.push('Enter a lambda source before saving.')

  const targets = draft.targets.map((target) => target.trim())
  let selectedLoops: string[] = []
  let includeMain = false

  if (draft.targetMode !== 'all' && draft.targetMode !== 'targets') {
    errors.push('Choose a valid hook target mode.')
  } else if (draft.targetMode === 'targets') {
    if (targets.length === 0) {
      errors.push('Add at least one hook target.')
    } else {
      const seen = new Set<string>()
      targets.forEach((name, index) => {
        if (!name) {
          errors.push(`Hook target ${index + 1} cannot be empty.`)
        } else if (name !== PRE_LLM_HOOK_MAIN_TARGET && !PRE_LLM_HOOK_LOOP_NAME_PATTERN.test(name)) {
          errors.push(`Hook target "${targetErrorName(name)}" must use 1–32 lowercase letters, digits, "_" or "-".`)
        } else if (seen.has(name)) {
          errors.push(`Hook target "${name}" is duplicated.`)
        }
        seen.add(name)
      })
      includeMain = targets.includes(PRE_LLM_HOOK_MAIN_TARGET)
      selectedLoops = targets.filter((name) => name !== PRE_LLM_HOOK_MAIN_TARGET)
      if (selectedLoops.length > PRE_LLM_HOOK_MAX_LOOPS) {
        errors.push(`Choose no more than ${PRE_LLM_HOOK_MAX_LOOPS} named inner loops.`)
      }
    }
  }

  const timeoutText = draft.timeout_ms.trim()
  let timeout: number | undefined
  if (timeoutText) {
    if (!/^[+]?\d+$/.test(timeoutText)) {
      errors.push(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS} ms.`)
    } else {
      timeout = Number(timeoutText)
      if (!Number.isSafeInteger(timeout) || timeout < PRE_LLM_HOOK_MIN_TIMEOUT_MS || timeout > PRE_LLM_HOOK_MAX_TIMEOUT_MS) {
        errors.push(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS} ms.`)
      }
    }
  }

  if (errors.length > 0) return { errors }

  const selection = draft.targetMode === 'all'
    ? { scope: 'all' as const }
    : includeMain
      ? selectedLoops.length > 0
        ? { scope: 'loops' as const, include_main: true, loops: selectedLoops }
        : { scope: 'main' as const }
      : { scope: 'loops' as const, loops: selectedLoops }

  // A target-mode draft with only Main naturally maps to legacy main scope;
  // a target-mode draft without Main must have at least one named loop.
  if (draft.targetMode === 'targets' && !includeMain && selectedLoops.length === 0) {
    return { errors: ['Add at least one hook target.'] }
  }

  return {
    errors,
    config: {
      source,
      ...selection,
      ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    },
  }
}
