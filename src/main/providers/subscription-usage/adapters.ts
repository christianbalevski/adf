/**
 * Pure mappers from each provider's raw usage report to snapshot figures.
 *
 * Every source is an undocumented provider internal, so each mapper takes
 * `unknown`-ish input, keeps only fields of the expected type, and returns
 * null when nothing usable is left. Nothing here throws on bad input.
 */
import type { ChatGPTResponseMeta } from '../chatgpt-subscription'
import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../../../shared/types/subscription-usage.types'

/** What one report contributes: windows merge by key into the stored snapshot. */
export type UsageReport = Pick<SubscriptionUsageSnapshot, 'plan' | 'credits'> & { windows: SubscriptionUsageWindow[] }

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A finite number, or a numeric string; anything else is undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const clampPercent = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.min(100, Math.max(0, n))

/** Epoch seconds or ms → epoch ms (values below 1e12 are seconds). */
export function epochMs(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/** `300` → `5-hour`, `10080` → `Weekly`. */
export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback
  if (minutes === 10080) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

function hasFigures(w: SubscriptionUsageWindow): boolean {
  return w.usedPercent !== undefined || w.resetsAt !== undefined || w.limited !== undefined
}

function report(windows: SubscriptionUsageWindow[], extra: Omit<UsageReport, 'windows'> = {}): UsageReport | null {
  const kept = windows.filter(hasFigures)
  if (kept.length === 0 && !extra.plan && !extra.credits) return null
  return { windows: kept, ...(extra.plan ? { plan: extra.plan } : {}), ...(extra.credits ? { credits: extra.credits } : {}) }
}

// --- Claude (Claude Code `rate_limit_event`) -----------------------------------------

const CLAUDE_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly (incl. extra usage)',
  overage: 'Extra usage',
}

function claudeWindow(key: string, utilization: unknown, resetsAt: unknown, now: number, limited?: boolean): SubscriptionUsageWindow {
  const fraction = num(utilization)
  const reset = epochMs(resetsAt)
  return {
    key,
    label: CLAUDE_LABELS[key] ?? key.replace(/_/g, ' '),
    ...(fraction !== undefined ? { usedPercent: clampPercent(fraction * 100) } : {}),
    ...(reset !== undefined ? { resetsAt: reset } : {}),
    ...(limited !== undefined ? { limited } : {}),
    observedAt: now,
  }
}

/**
 * One `SDKRateLimitInfo`. `resetsAt` is epoch seconds; `utilization` is a 0–1
 * fraction (Claude Code copies the `anthropic-ratelimit-unified-*-utilization`
 * header and itself shows `utilization * 100`), scaled here to 0–100.
 *
 * The event's own window is `rateLimitType`. Newer Claude Code builds also send
 * `unifiedWindows` (not in the SDK typings yet) with every window's figures;
 * those are read too when present, and the typed window wins on a clash.
 */
export function fromClaudeRateLimit(info: unknown, now: number): UsageReport | null {
  if (!info || typeof info !== 'object') return null
  const r = info as Record<string, unknown>
  const windows: SubscriptionUsageWindow[] = []
  if (r.unifiedWindows && typeof r.unifiedWindows === 'object') {
    for (const [key, w] of Object.entries(r.unifiedWindows as Record<string, unknown>)) {
      if (w && typeof w === 'object') {
        const { utilization, resetsAt } = w as Record<string, unknown>
        windows.push(claudeWindow(key, utilization, resetsAt, now))
      }
    }
  }
  const key = typeof r.rateLimitType === 'string' ? r.rateLimitType : undefined
  if (key) {
    const status = typeof r.status === 'string' ? r.status : undefined
    const own = claudeWindow(key, r.utilization, r.resetsAt, now, status ? status === 'rejected' : undefined)
    const i = windows.findIndex((w) => w.key === key)
    if (i >= 0) windows[i] = { ...windows[i], ...own }
    else windows.push(own)
  }
  return report(windows)
}

// --- ChatGPT / Codex ------------------------------------------------------------------

function codexWindow(key: 'primary' | 'secondary', w: { usedPercent?: unknown; minutes?: unknown; resetAt?: unknown; resetAfterSeconds?: unknown }, now: number): SubscriptionUsageWindow {
  const minutes = num(w.minutes)
  const after = num(w.resetAfterSeconds)
  const resetsAt = epochMs(w.resetAt) ?? (after !== undefined && after >= 0 ? now + Math.round(after * 1000) : undefined)
  const usedPercent = clampPercent(num(w.usedPercent))
  return {
    key,
    label: windowLabel(minutes, key === 'primary' ? 'Short window' : 'Long window'),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(usedPercent !== undefined ? { limited: usedPercent >= 100 } : {}),
    observedAt: now,
  }
}

function credits(balance: unknown, hasCredits: unknown): UsageReport['credits'] | undefined {
  const b = num(balance)
  const has = typeof hasCredits === 'boolean' ? hasCredits : undefined
  if (b === undefined && has === undefined) return undefined
  return { ...(b !== undefined ? { balance: b } : {}), ...(has !== undefined ? { hasCredits: has } : {}) }
}

/** Percent 0–100, window in minutes, reset-at epoch seconds or reset-after seconds. */
export function fromCodexHeaders(meta: ChatGPTResponseMeta | undefined, now: number): UsageReport | null {
  if (!meta) return null
  return report([
    codexWindow('primary', { usedPercent: meta.primaryUsedPercent, minutes: meta.primaryWindowMinutes, resetAt: meta.primaryResetAt, resetAfterSeconds: meta.primaryResetAfterSeconds }, now),
    codexWindow('secondary', { usedPercent: meta.secondaryUsedPercent, minutes: meta.secondaryWindowMinutes, resetAt: meta.secondaryResetAt }, now),
  ], { plan: meta.planType, credits: credits(meta.creditsBalance, meta.creditsHasCredits) })
}

/**
 * `GET chatgpt.com/backend-api/wham/usage`, shaped after the open-source Codex
 * CLI's RateLimitStatusPayload. Unknown fields are ignored; a wrong type on
 * one field drops that field only.
 */
function usageWindow(key: 'primary' | 'secondary', raw: unknown, now: number): SubscriptionUsageWindow | null {
  if (!isRecord(raw)) return null
  const seconds = num(raw.limit_window_seconds)
  return codexWindow(key, { usedPercent: raw.used_percent, minutes: seconds ? Math.round(seconds / 60) : undefined, resetAt: raw.reset_at, resetAfterSeconds: raw.reset_after_seconds }, now)
}

/** Null when the body carries no usable figure (shape drift, empty object). */
export function fromCodexUsage(body: unknown, now: number): UsageReport | null {
  if (!isRecord(body)) return null
  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : {}
  const c = isRecord(body.credits) ? body.credits : {}
  const windows = [usageWindow('primary', rateLimit.primary_window, now), usageWindow('secondary', rateLimit.secondary_window, now)]
    .filter((w): w is SubscriptionUsageWindow => w !== null)
  const extra = { plan: typeof body.plan_type === 'string' && body.plan_type ? body.plan_type : undefined, credits: credits(c.balance, c.has_credits) }
  // A plan name alone is not usage; the endpoint answered without figures.
  if (!windows.some(hasFigures) && !extra.credits) return null
  return report(windows, extra)
}

// --- Grok (Grok Build's `GET cli-chat-proxy.grok.com/v1/billing?format=credits`) ----

const GROK_PERIOD_LABELS: Record<string, string> = {
  USAGE_PERIOD_TYPE_WEEKLY: 'Weekly',
  USAGE_PERIOD_TYPE_MONTHLY: 'Monthly',
}

/** USD cents as `{ "val": n }`; proto3 JSON omits a zero, so `{}` is 0. */
function cents(v: unknown): number | undefined {
  if (!isRecord(v)) return undefined
  return v.val === undefined ? 0 : num(v.val)
}

/**
 * The shared weekly (or monthly) pool: `creditUsagePercent` and
 * `currentPeriod`, falling back to the older `used` / `monthlyLimit` and
 * `billingPeriodEnd`. proto3 JSON omits a zero, so with a period present and
 * no figure the pool is at 0%, as Grok Build reads it. Purchased credits are
 * `prepaidBalance`, in cents, shown only when there are some.
 */
export function fromGrokCredits(body: unknown, now: number): UsageReport | null {
  const config = isRecord(body) && isRecord(body.config) ? body.config : null
  if (!config) return null
  const used = cents(config.used)
  const limit = cents(config.monthlyLimit)
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {}
  const end = typeof period.end === 'string' ? period.end : typeof config.billingPeriodEnd === 'string' ? config.billingPeriodEnd : undefined
  const resetsAt = end !== undefined && Number.isFinite(Date.parse(end)) ? Date.parse(end) : undefined
  const usedPercent = clampPercent(
    num(config.creditUsagePercent)
      ?? (used !== undefined && limit ? (100 * used) / limit : undefined)
      ?? (config.creditUsagePercent === undefined && resetsAt !== undefined ? 0 : undefined),
  )
  const label = (typeof period.type === 'string' && GROK_PERIOD_LABELS[period.type]) || 'Usage'
  const prepaid = cents(config.prepaidBalance)
  const window: SubscriptionUsageWindow = {
    key: 'pool',
    label,
    ...(usedPercent !== undefined ? { usedPercent, limited: usedPercent >= 100 } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    observedAt: now,
  }
  return report([window], prepaid ? { credits: { balance: prepaid / 100 } } : {})
}
