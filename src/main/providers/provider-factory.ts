import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { LLMProvider } from './provider.interface'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import { AiSdkProvider } from './ai-sdk-provider'
import { getChatGptAuthManager } from './chatgpt-subscription/auth-manager'
import { createChatGPTSubscriptionProvider } from './chatgpt-subscription'

/**
 * Pool AI SDK provider instances by key to reuse HTTP connections.
 * Critical at 100+ concurrent agents.
 */
const anthropicPool = new Map<string, ReturnType<typeof createAnthropic>>()
const openaiPool = new Map<string, ReturnType<typeof createOpenAI>>()
const customPool = new Map<string, ReturnType<typeof createOpenAICompatible>>()

export interface ProviderSettingsStore {
  getProvider(id: string): ProviderConfig | undefined
}

function getAnthropicProvider(apiKey: string) {
  let provider = anthropicPool.get(apiKey)
  if (!provider) {
    provider = createAnthropic({ apiKey })
    anthropicPool.set(apiKey, provider)
  }
  return provider
}

function getOpenAIProvider(apiKey: string) {
  let provider = openaiPool.get(apiKey)
  if (!provider) {
    provider = createOpenAI({ apiKey })
    openaiPool.set(apiKey, provider)
  }
  return provider
}

function getOpenAICompatibleProvider(baseUrl: string, apiKey?: string) {
  const poolKey = `${baseUrl}::${apiKey ?? ''}`
  let provider = customPool.get(poolKey)
  if (!provider) {
    provider = createOpenAICompatible({
      name: 'custom',
      baseURL: baseUrl,
      apiKey: apiKey || undefined
    })
    customPool.set(poolKey, provider)
  }
  return provider
}

/**
 * Create a custom fetch wrapper that injects extra params into the request body.
 * Preserves the current behavior where users can set `{key: "frequency_penalty", value: "0.5"}`
 * and null values remove keys.
 */
function createParamInjector(extraParams: Record<string, unknown>): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        // Merge extra params — null values remove keys
        for (const [k, v] of Object.entries(extraParams)) {
          if (v === null) {
            delete body[k]
          } else {
            body[k] = v
          }
        }
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // Not JSON — pass through unchanged
      }
    }
    return globalThis.fetch(input, init)
  }
}

/**
 * Create the appropriate LLM provider based on the agent's config and app settings.
 * If `resolvedProvider` is given (pre-resolved from ADF identity), use it instead of app settings.
 */
export function createProvider(
  config: AgentConfig,
  settings: ProviderSettingsStore,
  resolvedProvider?: ProviderConfig
): LLMProvider {
  const providerKey = config.model.provider
  const cfg = resolvedProvider ?? settings.getProvider(providerKey)

  if (!cfg) {
    throw new Error(
      `Provider "${providerKey}" not found. Configure it in Settings → Providers.`
    )
  }

  const modelId = config.model.model_id || cfg.defaultModel || ''
  const delayMs = cfg.requestDelayMs ?? 0
  // Use the user-assigned display name for token usage tracking
  const displayName = cfg.name || providerKey

  if (cfg.type === 'anthropic') {
    const anthropic = getAnthropicProvider(cfg.apiKey)
    const model = anthropic(modelId) as LanguageModel
    return new AiSdkProvider(model, displayName, modelId, delayMs, { providerId: providerKey })
  }

  if (cfg.type === 'openai') {
    const openai = getOpenAIProvider(cfg.apiKey)
    const model = openai(modelId) as LanguageModel
    return new AiSdkProvider(model, displayName, modelId, delayMs, { providerId: providerKey })
  }

  if (cfg.type === 'chatgpt-subscription') {
    const authManager = getChatGptAuthManager()

    // Parse model.params for chatgpt-subscription (same logic as openai-compatible)
    const chatgptParamSource = config.model.params !== undefined
      ? config.model.params
      : cfg.params
    const chatgptExtraParams: Record<string, unknown> = {}
    if (chatgptParamSource) {
      for (const { key, value } of chatgptParamSource) {
        if (!key) continue
        if (value === '') {
          chatgptExtraParams[key] = null
        } else {
          try {
            chatgptExtraParams[key] = JSON.parse(value)
          } catch {
            chatgptExtraParams[key] = value
          }
        }
      }
    }
    const hasParams = Object.keys(chatgptExtraParams).length > 0

    const { provider, setInstructions, getResponseMeta } = createChatGPTSubscriptionProvider(
      authManager,
      hasParams ? chatgptExtraParams : undefined
    )
    const model = provider.responses(modelId) as LanguageModel
    return new AiSdkProvider(model, displayName, modelId, delayMs, {
      providerId: providerKey,
      forwardProviderParams: 'openai',
      onBeforeRequest: (system) => setInstructions(system),
      streamOnly: true,
      getResponseMeta
    })
  }

  // openai-compatible path
  // Convert params arrays to Record, JSON-parsing values where possible.
  // Empty string values become null (tells the provider to remove that key).
  //
  // When model.params is defined (even []), it is the authoritative source —
  // the UI copies provider defaults into model.params on provider selection,
  // so any subsequent edits (including clearing all params) must be honored.
  // Provider-level cfg.params are only used as fallback when model.params is undefined
  // (e.g. legacy ADFs that never went through the provider selection UI).
  const paramSource = config.model.params !== undefined
    ? config.model.params
    : cfg.params
  const extraParams: Record<string, unknown> = {}
  if (paramSource) {
    for (const { key, value } of paramSource) {
      if (!key) continue
      if (value === '') {
        extraParams[key] = null
      } else {
        try {
          extraParams[key] = JSON.parse(value)
        } catch {
          extraParams[key] = value
        }
      }
    }
  }

  const hasExtraParams = Object.keys(extraParams).length > 0

  // When extra params are needed, create a fresh provider with custom fetch
  // so the param injector is scoped to this specific provider instance
  if (hasExtraParams) {
    const provider = createOpenAICompatible({
      name: providerKey,
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey || undefined,
      fetch: createParamInjector(extraParams)
    })
    const model = provider(modelId) as LanguageModel
    return new AiSdkProvider(model, displayName, modelId, delayMs, { providerId: providerKey })
  }

  const provider = getOpenAICompatibleProvider(cfg.baseUrl, cfg.apiKey || undefined)
  const model = provider(modelId) as LanguageModel
  return new AiSdkProvider(model, displayName, modelId, delayMs, { providerId: providerKey })
}
