/**
 * Where a built LLMProvider's settings came from, recorded by createProvider
 * at construction time. Consumers (the effective-runtime snapshot) read it off
 * the provider actually in use instead of re-deriving it, so the record can't
 * drift from what a host's provider factory really did. Providers built any
 * other way (mocks, embedder-supplied) simply have no origin.
 *
 * Never holds secrets: the key is reported only by source.
 */

import type { LLMProvider } from './provider.interface'
import type { ProviderConfig } from '../../shared/types/ipc.types'

export interface ProviderOrigin {
  /** 'agent' = the file's own providers[] entry; 'app' = the runtime's settings row. */
  source: 'agent' | 'app'
  config: Omit<ProviderConfig, 'apiKey'>
  apiKeySource: 'agent' | 'app' | 'none'
  paramsSource: 'agent_model' | 'provider' | 'none'
}

const origins = new WeakMap<LLMProvider, ProviderOrigin>()

export function recordProviderOrigin(provider: LLMProvider, origin: ProviderOrigin): void {
  origins.set(provider, origin)
}

export function describeProviderOrigin(provider: LLMProvider): ProviderOrigin | undefined {
  return origins.get(provider)
}
