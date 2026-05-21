/**
 * Apply a global "default provider" to a CreateAgentOptions payload.
 *
 * Rule: if the caller did not specify a model provider (empty string or undefined),
 * fill it in from the configured default provider:
 *   - model.provider     = defaultProvider.id
 *   - model.model_id     = defaultProvider.defaultModel ?? ''  (left empty if not set)
 *   - providers (agent)  = adds an AdfProviderConfig copy of the default (sans secrets),
 *                          unless one with the same id is already present.
 *
 * If the caller already set a provider, or no default is configured, the options
 * are returned unchanged. The agent .adf stays self-contained because the default
 * provider's metadata (id/type/name/baseUrl/defaultModel/params/requestDelayMs)
 * is copied into agent.providers.
 */

import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdfProviderConfig, CreateAgentOptions } from '../../shared/types/adf-v02.types'

/** Strip credential-style fields from an app-level ProviderConfig to produce an AdfProviderConfig copy. */
function toAdfProviderConfig(p: ProviderConfig): AdfProviderConfig {
  const adf: AdfProviderConfig = {
    id: p.id,
    type: p.type as AdfProviderConfig['type'],
    name: p.name,
    baseUrl: p.baseUrl,
  }
  if (p.defaultModel) adf.defaultModel = p.defaultModel
  if (p.params) adf.params = p.params
  if (typeof p.requestDelayMs === 'number') adf.requestDelayMs = p.requestDelayMs
  return adf
}

export function applyDefaultProviderToOptions(
  options: CreateAgentOptions,
  defaultProvider: ProviderConfig | undefined
): CreateAgentOptions {
  if (!defaultProvider) return options

  const existingProvider = options.model?.provider
  if (existingProvider && existingProvider.length > 0) {
    // Caller already specified a provider — leave everything alone.
    return options
  }

  const adfCopy = toAdfProviderConfig(defaultProvider)
  const existingAgentProviders = options.providers ?? []
  const hasMatch = existingAgentProviders.some((p) => p.id === defaultProvider.id)

  return {
    ...options,
    model: {
      ...(options.model ?? {}),
      provider: defaultProvider.id,
      model_id: defaultProvider.defaultModel ?? '',
    },
    providers: hasMatch ? existingAgentProviders : [...existingAgentProviders, adfCopy],
  }
}
