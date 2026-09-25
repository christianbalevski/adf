import type { PreLlmHookConfig } from '../../../shared/types/adf-v02.types'

/** Keep these bounds in sync with PreLlmHookConfigSchema and the runtime guard. */
export const PRE_LLM_HOOK_MIN_TIMEOUT_MS = 1_000
export const PRE_LLM_HOOK_MAX_TIMEOUT_MS = 300_000
export const PRE_LLM_HOOK_MAX_LOOPS = 64
export const PRE_LLM_HOOK_LOOP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export type PreLlmHookScopeDraft = 'all' | 'main' | 'loops'

/** String-backed editor state keeps an incomplete number draft out of config. */
export interface PreLlmHookDraft {
  source: string
  scope: PreLlmHookScopeDraft
  loops: string[]
  timeout_ms: string
}

export interface PreLlmHookDraftValidation {
  config?: PreLlmHookConfig
  errors: string[]
}

export function preLlmHookDraftFromConfig(config?: PreLlmHookConfig): PreLlmHookDraft {
  return {
    source: config?.source ?? '',
    scope: config?.scope ?? 'all',
    loops: [...(config?.loops ?? [])],
    timeout_ms: config?.timeout_ms === undefined ? '' : String(config.timeout_ms),
  }
}

/**
 * Convert the local editor draft to the exact optional runtime config. No
 * invalid or incomplete value is coerced into a saved config.
 */
export function validatePreLlmHookDraft(draft: PreLlmHookDraft): PreLlmHookDraftValidation {
  const errors: string[] = []
  const source = draft.source.trim()
  if (!source) errors.push('Enter a lambda source before saving.')

  if (draft.scope !== 'all' && draft.scope !== 'main' && draft.scope !== 'loops') {
    errors.push('Choose a valid hook scope.')
  }

  const loops = draft.loops.map((name) => name.trim())
  if (draft.scope === 'loops') {
    if (loops.length === 0) {
      errors.push('Add at least one named inner loop.')
    } else {
      if (loops.length > PRE_LLM_HOOK_MAX_LOOPS) {
        errors.push(`Choose no more than ${PRE_LLM_HOOK_MAX_LOOPS} named inner loops.`)
      }
      const seen = new Set<string>()
      loops.forEach((name, index) => {
        if (!name) {
          errors.push(`Named loop ${index + 1} cannot be empty.`)
        } else if (!PRE_LLM_HOOK_LOOP_NAME_PATTERN.test(name)) {
          errors.push(`Named loop "${name}" must use 1–32 lowercase letters, digits, "_" or "-".`)
        } else if (name === 'main') {
          errors.push('"main" is reserved; choose scope "Main only" instead.')
        } else if (seen.has(name)) {
          errors.push(`Named loop "${name}" is duplicated.`)
        }
        seen.add(name)
      })
    }
  }

  const timeoutText = draft.timeout_ms.trim()
  let timeout: number | undefined
  if (timeoutText) {
    // Runtime/schema requires an integer; reject decimal, blank, and non-finite
    // text instead of relying on input[type=number] browser coercion.
    if (!/^[+-]?\d+$/.test(timeoutText)) {
      errors.push(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS} ms.`)
    } else {
      timeout = Number(timeoutText)
      if (!Number.isSafeInteger(timeout) || timeout < PRE_LLM_HOOK_MIN_TIMEOUT_MS || timeout > PRE_LLM_HOOK_MAX_TIMEOUT_MS) {
        errors.push(`Timeout must be a whole number from ${PRE_LLM_HOOK_MIN_TIMEOUT_MS} to ${PRE_LLM_HOOK_MAX_TIMEOUT_MS} ms.`)
      }
    }
  }

  if (errors.length > 0) return { errors }
  return {
    errors,
    config: {
      source,
      ...(draft.scope !== 'all' ? { scope: draft.scope } : {}),
      ...(draft.scope === 'loops' ? { loops } : {}),
      ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    },
  }
}
