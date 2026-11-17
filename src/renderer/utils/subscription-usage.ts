import type { ProviderConfig, TokenUsageData } from '../../shared/types/ipc.types'
import type { SubscriptionProviderId, SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../../shared/types/subscription-usage.types'
import { SUBSCRIPTION_TYPES, findCatalogEntry, isSubscriptionType } from '../../shared/constants/provider-catalog'
import { relativeTime } from './relative-time'

/**
 * Display helpers for subscription usage (Settings → Usage, the status-bar
 * pill). Figures a provider did not report stay absent: they render as "–",
 * never as 0.
 */

/** Each provider's own usage page, opened in the browser. Grok's is its Settings → Usage tab. */
export const SUBSCRIPTION_USAGE_PAGES: Record<SubscriptionProviderId, string> = {
  'claude-subscription': 'https://claude.ai/settings/usage',
  'chatgpt-subscription': 'https://chatgpt.com/codex/settings/usage',
  'grok-subscription': 'https://grok.com/?_s=usage',
}

/** The catalog label: `Claude`, `ChatGPT`, `Grok`. */
export function subscriptionName(provider: SubscriptionProviderId): string {
  return findCatalogEntry(provider)?.label ?? provider
}

/** `max` → `Max`, `max_20x` → `Max 20x`; absent stays absent. */
export function formatPlan(plan: string | undefined): string | undefined {
  const words = plan?.trim().split(/[_\s-]+/).filter(Boolean)
  if (!words?.length) return undefined
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

/** Provider name and plan, e.g. `Claude Max`; the name alone when no plan was reported. */
export function subscriptionTitle(s: Pick<SubscriptionUsageSnapshot, 'provider' | 'plan'>): string {
  const plan = formatPlan(s.plan)
  return plan ? `${subscriptionName(s.provider)} ${plan}` : subscriptionName(s.provider)
}

/** `42%`, or `–` when the provider gave no figure. */
export function formatPercent(v: number | undefined): string {
  return v == null || !Number.isFinite(v) ? '–' : `${Math.round(v)}%`
}

/** The window with the highest used percent; null when no window carries a figure. */
export function tightestWindow(windows: readonly SubscriptionUsageWindow[]): SubscriptionUsageWindow | null {
  let best: SubscriptionUsageWindow | null = null
  for (const w of windows) {
    if (w.usedPercent == null || !Number.isFinite(w.usedPercent)) continue
    if (!best || w.usedPercent > (best.usedPercent as number)) best = w
  }
  return best
}

export type UsageTone = 'normal' | 'warn' | 'critical'

/** Amber from 80%, red from 95%; a window the provider says is refusing requests is red. */
export function usageTone(usedPercent: number | undefined, limited = false): UsageTone {
  if (limited) return 'critical'
  if (usedPercent == null) return 'normal'
  if (usedPercent >= 95) return 'critical'
  if (usedPercent >= 80) return 'warn'
  return 'normal'
}

export const TONE_FILL: Record<UsageTone, string> = {
  normal: 'bg-green-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500',
}

export const TONE_STROKE: Record<UsageTone, string> = {
  normal: 'stroke-green-500',
  warn: 'stroke-amber-500',
  critical: 'stroke-red-500',
}

export const TONE_TEXT: Record<UsageTone, string> = {
  normal: '',
  warn: 'text-amber-600 dark:text-amber-400',
  critical: 'text-[var(--adf-ui-danger)]',
}

/**
 * The plain status line under a subscription, or null when its figures are
 * current. Never a number the provider did not give.
 */
export function subscriptionStatusLine(s: SubscriptionUsageSnapshot, now: number): string | null {
  const name = subscriptionName(s.provider)
  switch (s.status) {
    case 'ok':
      // The figures are current; a later failed check is only a note.
      return s.error ? `Latest ${name} usage check failed: ${s.error}` : null
    case 'stale': {
      const when = s.observedAt != null ? `Last reported ${relativeTime(s.observedAt, now)}` : 'Not recently reported'
      return s.error ? `${when}. ${name} stopped reporting usage: ${s.error}` : when
    }
    case 'unavailable':
      return `${name} has not reported usage yet`
    case 'error':
      return s.error ? `${name} usage not available: ${s.error}` : `${name} usage not available`
    case 'signed_out':
      return 'Not signed in'
  }
}

/** Ids of configured providers → the subscription they draw on. A catalog id is its own type. */
export function subscriptionProviderIds(providers: readonly Pick<ProviderConfig, 'id' | 'type'>[] | undefined): Record<string, SubscriptionProviderId> {
  const out: Record<string, SubscriptionProviderId> = {}
  for (const id of SUBSCRIPTION_TYPES) out[id] = id
  for (const p of providers ?? []) {
    if (isSubscriptionType(p.type)) out[p.id] = p.type
  }
  return out
}

export interface SubscriptionTokenTotals {
  input: number
  output: number
}

/**
 * Tokens per subscription over `days` (YYYY-MM-DD keys). Token usage is keyed
 * by provider id; `idMap` (subscriptionProviderIds) says which ids draw on a
 * subscription. Subscriptions with no usage in the window are absent.
 */
export function subscriptionTokenTotals(
  usage: TokenUsageData,
  days: readonly string[],
  idMap: Record<string, SubscriptionProviderId>,
): Partial<Record<SubscriptionProviderId, SubscriptionTokenTotals>> {
  const out: Partial<Record<SubscriptionProviderId, SubscriptionTokenTotals>> = {}
  for (const day of days) {
    const providers = usage[day]
    if (!providers) continue
    for (const [providerId, models] of Object.entries(providers)) {
      const sub = idMap[providerId]
      if (!sub) continue
      const t = (out[sub] ??= { input: 0, output: 0 })
      for (const e of Object.values(models)) {
        t.input += e.input
        t.output += e.output
      }
    }
  }
  return out
}
