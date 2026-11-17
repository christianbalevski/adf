/**
 * The app's subscription-usage service, wired to the real auth managers.
 * App-level data in `<userData>/subscription-usage.json`; never in an .adf
 * file, never exposed to agents.
 *
 * Claude is read passively off Claude Code's own rate-limit events: ADF never
 * reads Claude Code's credentials (claude-subscription/auth-manager.ts).
 */
import { getUserDataPath } from '../../utils/user-data-path'
import type { SubscriptionProviderId } from '../../../shared/types/subscription-usage.types'
import { getChatGptAuthManager } from '../chatgpt-subscription/auth-manager'
import { getGrokAuthManager } from '../grok-subscription/auth-manager'
import { getClaudeAuthManager } from '../claude-subscription/auth-manager'
import { SubscriptionUsageService, defaultFilePath, type SubscriptionAccount } from './service'
import { probeCodexUsage, probeGrokUsage } from './probes'
import type { UsageReport } from './adapters'

/** Claude's sign-in is read by running Claude Code, so a 60 s poll reuses it for this long. */
const CLAUDE_ACCOUNT_TTL_MS = 5 * 60_000
let claudeAccount: { at: number; value: Promise<SubscriptionAccount | undefined> } | null = null

async function readClaudeAccount(): Promise<SubscriptionAccount | undefined> {
  const status = await getClaudeAuthManager().getAuthStatus()
  return { signedIn: status.authenticated, ...(status.authenticated && status.plan ? { plan: status.plan } : {}) }
}

/** Sign-in state, and Claude's plan (its reports carry none). ChatGPT and Grok read local state; Claude's is cached. */
async function account(provider: SubscriptionProviderId, fresh = false): Promise<SubscriptionAccount | undefined> {
  try {
    switch (provider) {
      case 'chatgpt-subscription': return { signedIn: getChatGptAuthManager().getAuthStatus().authenticated }
      case 'grok-subscription': return { signedIn: getGrokAuthManager().getAuthStatus().authenticated }
      case 'claude-subscription': {
        if (fresh || !claudeAccount || Date.now() - claudeAccount.at >= CLAUDE_ACCOUNT_TTL_MS) {
          claudeAccount = { at: Date.now(), value: readClaudeAccount().catch(() => undefined) }
        }
        return await claudeAccount.value
      }
    }
  } catch {
    return undefined
  }
}

let instance: SubscriptionUsageService | null = null

export function getSubscriptionUsageService(): SubscriptionUsageService {
  instance ??= new SubscriptionUsageService({
    filePath: defaultFilePath(getUserDataPath()),
    account,
    probes: {
      'chatgpt-subscription': () => probeCodexUsage(getChatGptAuthManager()),
      'grok-subscription': () => probeGrokUsage(getGrokAuthManager()),
    },
  })
  return instance
}

/**
 * Record a report read off an agent call. Builds the report lazily and
 * swallows every failure: usage tracking must never affect the call itself.
 */
export function recordSubscriptionUsage(provider: SubscriptionProviderId, build: () => UsageReport | null): void {
  try {
    getSubscriptionUsageService().record(provider, build())
  } catch (err) {
    console.warn(`[SubscriptionUsage] could not record ${provider} usage:`, err)
  }
}

/** Flush on quit, only if the service was ever used. */
export function flushSubscriptionUsage(): void {
  instance?.flush()
}
