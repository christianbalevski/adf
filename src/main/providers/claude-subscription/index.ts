import type { LLMProvider } from '../provider.interface'
import { ClaudeSubscriptionProvider } from './provider'
import { lastSupportedModels, listSupportedModels } from './session'

export { getClaudeAuthManager } from './auth-manager'
export type { ClaudeAuthStatus, ClaudeAuthFlow } from './types'

export interface ClaudeSubscriptionProviderOptions {
  /** Settings key of the provider entry (opaque, e.g. `custom:abc123`). */
  providerId: string
  /** User-facing provider name, used for usage tracking. */
  displayName: string
  modelId: string
  requestDelayMs?: number
  /** Custom request params (model.params / provider params). */
  extraParams?: Record<string, unknown>
}

export function createClaudeSubscriptionProvider(opts: ClaudeSubscriptionProviderOptions): LLMProvider {
  return new ClaudeSubscriptionProvider(opts)
}

/** Known plan models — fallback when Claude Code can't be asked. */
export const CLAUDE_SUBSCRIPTION_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-2',
  'claude-haiku-5-5',
]

/**
 * Models the signed-in plan can use, as reported by Claude Code. When
 * Claude Code can't be asked, the last list it gave (else the static one)
 * comes back with an `error` saying so. `refresh` asks Claude Code again
 * instead of using the cached list.
 */
export async function listClaudeSubscriptionModels(opts: { refresh?: boolean } = {}): Promise<{ models: string[]; error?: string }> {
  try {
    const models = await listSupportedModels(opts)
    if (models.length > 0) return { models }
    return { models: [...CLAUDE_SUBSCRIPTION_MODELS], error: 'Claude Code listed no models. Showing the built-in list.' }
  } catch (err) {
    const last = lastSupportedModels()
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\.?$/, '.')
    return last
      ? { models: last, error: `Claude Code could not list models: ${reason} Showing the last list.` }
      : { models: [...CLAUDE_SUBSCRIPTION_MODELS], error: `Claude Code could not list models: ${reason} Showing the built-in list.` }
  }
}
