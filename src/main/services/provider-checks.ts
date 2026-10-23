/**
 * Provider connection checks: one cheap authenticated request per provider
 * (GET /models, or the subscription's sign-in state), with a per-session
 * result cache. Shared by Studio (dashboard, provider list, agent review,
 * the Settings "Test" button) and the daemon's dashboard and provider-test
 * routes. Each host keeps one instance, so each has its own session cache.
 *
 * Checks the host starts on its own go through autoCheck, which honours the
 * owner's `providerChecksEnabled` opt-out: off = no request, the last result
 * from this session if there is one, else 'unchecked' (a subscription's
 * check reads its sign-in state, never cached, and runs either way: it sends
 * nothing). An explicit Test click
 * calls test(cfg, true) directly. Requests time out after 5 s.
 */

import type { ProviderConfig } from '../../shared/types/ipc.types'
import { isSubscriptionType } from '../../shared/constants/provider-catalog'

export type ProviderCheckResult = 'ok' | 'failed' | 'unconfigured'

export interface ProviderChecksOptions {
  /** False when the owner turned automatic checks off (`providerChecksEnabled: false`). */
  isEnabled: () => boolean
}

export function providerTestCacheKey(cfg: ProviderConfig): string {
  // `id` alone isn't enough — the same provider id may have its key
  // rotated mid-session. Include the credentials so edits bust the cache.
  return `${cfg.id}::${cfg.type}::${cfg.baseUrl ?? ''}::${cfg.apiKey ? 'k' : '-'}`
}

export class ProviderChecks {
  /**
   * Per-session cache of provider connection test results.
   * Keyed by a snapshot of fields that materially affect the test
   * (type/baseUrl/apiKey-presence). Cleared on restart only.
   * Used by the home dashboard so revisiting the home screen doesn't
   * re-hit `/models` for every provider every time.
   */
  private readonly cache = new Map<string, ProviderCheckResult>()

  constructor(private readonly opts: ProviderChecksOptions) {}

  /** A check the host starts on its own: honours the opt-out (see file header). */
  async autoCheck(cfg: ProviderConfig): Promise<ProviderCheckResult | 'unchecked'> {
    // A subscription's check is its local sign-in state, no request: always run.
    if (!this.opts.isEnabled() && !isSubscriptionType(cfg.type)) {
      return this.cache.get(providerTestCacheKey(cfg)) ?? 'unchecked'
    }
    return this.test(cfg)
  }

  async test(cfg: ProviderConfig, force = false): Promise<ProviderCheckResult> {
    const cacheKey = providerTestCacheKey(cfg)
    if (force) this.cache.delete(cacheKey)
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const finish = (result: ProviderCheckResult) => {
      this.cache.set(cacheKey, result)
      return result
    }

    // Subscriptions: the sign-in state, read here and never cached, so a
    // sign-in after the first check shows at once (no request is made).
    if (cfg.type === 'chatgpt-subscription') {
      const { getChatGptAuthManager } = await import('../providers/chatgpt-subscription/auth-manager')
      return getChatGptAuthManager().isAuthenticated() ? 'ok' : 'unconfigured'
    }

    if (cfg.type === 'grok-subscription') {
      const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
      return getGrokAuthManager().isAuthenticated() ? 'ok' : 'unconfigured'
    }

    if (cfg.type === 'claude-subscription') {
      const { getClaudeAuthManager } = await import('../providers/claude-subscription/auth-manager')
      return await getClaudeAuthManager().isAuthenticated() ? 'ok' : 'unconfigured'
    }

    if (cfg.type === 'anthropic') {
      if (!cfg.apiKey) return finish('unconfigured')
      try {
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(5000),
        })
        return finish(response.ok ? 'ok' : 'failed')
      } catch {
        return finish('failed')
      }
    }

    if (cfg.type === 'openrouter') {
      if (!cfg.apiKey) return finish('unconfigured')
      try {
        const url = (cfg.baseUrl?.replace(/\/+$/, '') || 'https://openrouter.ai/api/v1') + '/models'
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(5000),
        })
        return finish(response.ok ? 'ok' : 'failed')
      } catch {
        return finish('failed')
      }
    }

    // openai + openai-compatible — both use /models with Bearer.
    // openai requires a key; openai-compatible may omit one (local proxies).
    if (cfg.type === 'openai' && !cfg.apiKey) return finish('unconfigured')
    if (cfg.type === 'openai-compatible' && !cfg.baseUrl) return finish('unconfigured')

    try {
      const baseUrl = cfg.type === 'openai' ? 'https://api.openai.com/v1' : cfg.baseUrl
      const url = baseUrl.replace(/\/+$/, '') + '/models'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
      return finish(response.ok ? 'ok' : 'failed')
    } catch {
      return finish('failed')
    }
  }
}
