import type { LLMProvider } from '../provider.interface'
import { ClaudeSubscriptionProvider } from './provider'
import { listSupportedModels } from './session'

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
  'claude-fable-5-1',
  'claude-haiku-4-5',
]

/**
 * Models the signed-in plan can use, as reported by Claude Code, falling
 * back to the static list when Claude Code is missing or signed out.
 */
export async function listClaudeSubscriptionModels(): Promise<string[]> {
  try {
    const models = await listSupportedModels()
    return models.length > 0 ? models : [...CLAUDE_SUBSCRIPTION_MODELS]
  } catch {
    return [...CLAUDE_SUBSCRIPTION_MODELS]
  }
}
