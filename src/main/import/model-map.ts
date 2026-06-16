import type { ModelConfig } from '../../shared/types/adf-v02.types'

/** ADF's three concrete provider types. */
type ProviderType = 'anthropic' | 'openai' | 'openai-compatible'

/**
 * Normalize a source provider name to one of ADF's provider types.
 * Anything that isn't clearly Anthropic or first-party OpenAI is treated as
 * OpenAI-compatible (OpenRouter, Ollama, Together, local servers, …), which is
 * how those endpoints actually speak.
 */
export function normalizeProvider(name: string): ProviderType {
  const n = name.trim().toLowerCase()
  if (n.includes('anthropic') || n.includes('claude')) return 'anthropic'
  if (n === 'openai' || /^(gpt|o\d)/.test(n)) return 'openai'
  return 'openai-compatible'
}

/**
 * Parse a model reference. Source formats use `provider/model`
 * (e.g. "anthropic/claude-opus-4-8"); a bare string is treated as a model id.
 */
export function parseModelRef(ref?: string): { provider?: ProviderType; model_id?: string } {
  if (!ref) return {}
  const trimmed = ref.trim()
  if (trimmed === '') return {}
  const slash = trimmed.indexOf('/')
  if (slash === -1) return { model_id: trimmed }
  return {
    provider: normalizeProvider(trimmed.slice(0, slash)),
    model_id: trimmed.slice(slash + 1),
  }
}

/**
 * Build a partial ModelConfig from a model ref plus optional explicit provider
 * and token cap. Pushes a warning when the provider has to be inferred or is
 * non-first-party, because the user still has to attach credentials in Studio.
 */
export function buildModel(
  opts: { ref?: string; provider?: string; maxTokens?: number },
  warnings: string[],
): Partial<ModelConfig> | undefined {
  const parsed = parseModelRef(opts.ref)
  const provider = opts.provider ? normalizeProvider(opts.provider) : parsed.provider
  const model: Partial<ModelConfig> = {}
  if (provider) model.provider = provider
  if (parsed.model_id) model.model_id = parsed.model_id
  if (typeof opts.maxTokens === 'number') model.max_tokens = opts.maxTokens

  if (Object.keys(model).length === 0) return undefined
  if (provider === 'openai-compatible') {
    warnings.push(
      `Model "${opts.ref ?? parsed.model_id}" mapped to an OpenAI-compatible provider; ` +
      `set its base URL and API key under Providers in Studio before running.`,
    )
  } else if (provider) {
    warnings.push(`Attach a "${provider}" provider credential in Studio before running.`)
  }
  return model
}
