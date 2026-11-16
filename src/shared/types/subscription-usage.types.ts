/**
 * Subscription usage — how much of a signed-in subscription's quota is left.
 *
 * Sources are undocumented provider internals (Claude Code rate-limit events,
 * Codex `x-codex-*` headers, Codex's `wham/usage` endpoint, xAI rate-limit
 * headers). Any of them can change or vanish without notice, so every field
 * past `provider`/`status`/`windows` is optional and the UI renders whatever
 * is present. App-level data: never stored in an .adf file, never exposed to
 * agents.
 */

import type { SubscriptionType } from '../constants/provider-catalog'

/** The subscription a snapshot describes: its provider type (provider-catalog.ts). */
export type SubscriptionProviderId = SubscriptionType

/** One quota window, e.g. Claude's 5-hour limit or Codex's weekly limit. */
export interface SubscriptionUsageWindow {
  /** Stable key within a provider, e.g. `five_hour`, `seven_day`, `primary`, `secondary`. */
  key: string
  /** Display label, e.g. `5-hour`, `Weekly`, `Weekly (Opus)`. */
  label: string
  /** 0–100. Absent when the provider reported the window but no figure. */
  usedPercent?: number
  /** Epoch ms when the window resets. */
  resetsAt?: number
  /** Provider says requests are currently being refused on this window. */
  limited?: boolean
  /** Epoch ms this window's figures were last reported. */
  observedAt: number
}

/**
 * - `ok`: figures from a report within the freshness horizon. With `error`
 *   set, a later check failed; the figures are still current.
 * - `stale`: no figure within the freshness horizon; the last good ones are kept.
 * - `unavailable`: signed in, but the provider has not reported usage yet.
 * - `error`: no good figures at all and the latest attempt failed.
 * - `signed_out`: no subscription session.
 */
export type SubscriptionUsageStatus = 'ok' | 'stale' | 'unavailable' | 'error' | 'signed_out'

export interface SubscriptionUsageSnapshot {
  provider: SubscriptionProviderId
  status: SubscriptionUsageStatus
  /** Plan name as the provider reports it, e.g. `max`, `pro`, `plus`. */
  plan?: string
  /** Windows not yet past their reset; an expired one no longer describes the quota. */
  windows: SubscriptionUsageWindow[]
  /** Credits balance where the provider reports one (Codex). */
  credits?: { balance?: number; hasCredits?: boolean }
  /** Epoch ms of the most recent good report. */
  observedAt?: number
  /** Plain description of the latest failure, e.g. "Codex usage endpoint returned HTTP 404". */
  error?: string
  /** Epoch ms of the latest failure. */
  errorAt?: number
}

/** One history sample: a window's used percent at a point in time. */
export interface SubscriptionUsageSample {
  t: number
  provider: SubscriptionProviderId
  window: string
  usedPercent: number
}

export interface SubscriptionUsageState {
  snapshots: SubscriptionUsageSnapshot[]
}

export interface SubscriptionUsageHistoryRequest {
  /** Only samples at or after this epoch ms. */
  since?: number
}
