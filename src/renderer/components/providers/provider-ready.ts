import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { catalogEntryForProvider, isSubscriptionType, type ProviderCatalogEntry } from '../../../shared/constants/provider-catalog'
import type { ProviderTestStatus } from './provider-status'

/**
 * The provider form has a credential: a signed-in subscription, a key, a
 * local server that needs none, or a keyless endpoint whose test passed.
 */
export function hasCredential(
  provider: Pick<ProviderConfig, 'type' | 'preset' | 'apiKey'>,
  status: ProviderTestStatus | undefined,
  signedIn: boolean,
): boolean {
  if (isSubscriptionType(provider.type)) return signedIn
  if ((provider.apiKey ?? '').trim()) return true
  if (catalogEntryForProvider(provider)?.keyOptional) return true
  return status === 'ok'
}

/**
 * A new agent can start on this provider: it has a default model, and
 * nothing says it lacks a credential. A row whose test is still out counts
 * as ready when it has a key (or needs none), so the home card does not
 * flicker while tests run.
 */
export function providerReady(provider: ProviderConfig, status: ProviderTestStatus | undefined): boolean {
  if (!(provider.defaultModel ?? '').trim()) return false
  if (status === 'unconfigured') return false
  if (isSubscriptionType(provider.type)) return true
  if (provider.apiKeyStatus === 'missing' || provider.apiKeyStatus === 'unavailable') return false
  // 'failed': main had a credential to try; the endpoint did not answer.
  return hasCredential(provider, status, false) || status === 'failed'
}

/**
 * The model to preselect from a fetched list: the catalog's example model
 * ("e.g. gpt-4o, o3-mini" → gpt-4o), exactly or as a prefix of a dated id,
 * else the first in the list.
 */
export function recommendedModel(entry: Pick<ProviderCatalogEntry, 'modelPlaceholder'> | undefined, models: readonly string[]): string | undefined {
  if (models.length === 0) return undefined
  const hint = entry?.modelPlaceholder?.match(/^e\.g\.\s*([^,\s]+)/i)?.[1]
  if (hint) {
    if (models.includes(hint)) return hint
    const dated = models.find((m) => m.startsWith(`${hint}-`))
    if (dated) return dated
  }
  return models[0]
}
