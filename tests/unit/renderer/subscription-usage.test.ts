import { describe, it, expect } from 'vitest'
import {
  formatPercent,
  formatPlan,
  subscriptionProviderIds,
  subscriptionStatusLine,
  subscriptionTitle,
  subscriptionTokenTotals,
  tightestWindow,
  usageTone,
} from '../../../src/renderer/utils/subscription-usage'
import { timeUntil } from '../../../src/renderer/utils/relative-time'
import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../../../src/shared/types/subscription-usage.types'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN

const win = (key: string, usedPercent?: number, extra: Partial<SubscriptionUsageWindow> = {}): SubscriptionUsageWindow =>
  ({ key, label: key, usedPercent, observedAt: NOW, ...extra })

describe('timeUntil', () => {
  it('counts down in the two largest units', () => {
    expect(timeUntil(NOW + 2 * HOUR + 14 * MIN + 30_000, NOW)).toBe('2h 14m')
    expect(timeUntil(NOW + 3 * HOUR, NOW)).toBe('3h')
    expect(timeUntil(NOW + 12 * MIN, NOW)).toBe('12m')
    expect(timeUntil(NOW + 20_000, NOW)).toBe('under 1m')
    expect(timeUntil(NOW + 3 * 24 * HOUR + 4 * HOUR, NOW)).toBe('3d 4h')
  })

  it('says nothing for an absent or passed reset', () => {
    expect(timeUntil(undefined, NOW)).toBeNull()
    expect(timeUntil(NOW - 1, NOW)).toBeNull()
  })
})

describe('tightestWindow', () => {
  it('picks the highest used percent and skips windows without a figure', () => {
    expect(tightestWindow([win('five_hour', 42), win('seven_day', 71), win('opus')])?.key).toBe('seven_day')
  })
  it('is null when no window has a figure', () => {
    expect(tightestWindow([win('a'), win('b')])).toBeNull()
    expect(tightestWindow([])).toBeNull()
  })
})

describe('usageTone', () => {
  it('turns amber at 80 and red at 95, red when limited', () => {
    expect(usageTone(79.9)).toBe('normal')
    expect(usageTone(80)).toBe('warn')
    expect(usageTone(95)).toBe('critical')
    expect(usageTone(10, true)).toBe('critical')
    expect(usageTone(undefined)).toBe('normal')
  })
})

describe('labels', () => {
  it('formats plans and titles without inventing a plan', () => {
    expect(formatPlan('max')).toBe('Max')
    expect(formatPlan('max_20x')).toBe('Max 20x')
    expect(formatPlan(undefined)).toBeUndefined()
    expect(subscriptionTitle({ provider: 'claude-subscription', plan: 'max' })).toBe('Claude Max')
    expect(subscriptionTitle({ provider: 'chatgpt-subscription' })).toBe('ChatGPT')
  })
  it('renders an absent figure as a dash', () => {
    expect(formatPercent(undefined)).toBe('–')
    expect(formatPercent(41.6)).toBe('42%')
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('subscriptionStatusLine', () => {
  const base: SubscriptionUsageSnapshot = { provider: 'chatgpt-subscription', status: 'ok', windows: [] }
  it('is silent when current', () => {
    expect(subscriptionStatusLine(base, NOW)).toBeNull()
  })
  it('says when figures were last reported, and why they stopped', () => {
    expect(subscriptionStatusLine({ ...base, status: 'stale', observedAt: NOW - 3 * HOUR }, NOW)).toBe('Last reported 3h ago')
    expect(subscriptionStatusLine({ ...base, status: 'stale', observedAt: NOW - 3 * HOUR, error: 'HTTP 404' }, NOW))
      .toBe('Last reported 3h ago. ChatGPT stopped reporting usage: HTTP 404')
  })
  it('says a provider has not reported yet', () => {
    expect(subscriptionStatusLine({ ...base, provider: 'grok-subscription', status: 'unavailable' }, NOW)).toBe('Grok has not reported usage yet')
  })
  it('notes a failed check while the figures are still current', () => {
    expect(subscriptionStatusLine({ ...base, error: 'HTTP 500' }, NOW)).toBe('Latest ChatGPT usage check failed: HTTP 500')
  })
  it('passes the error through', () => {
    expect(subscriptionStatusLine({ ...base, status: 'error', error: 'HTTP 500' }, NOW)).toBe('ChatGPT usage not available: HTTP 500')
  })
})

describe('subscriptionTokenTotals', () => {
  it('sums tokens of every provider id that draws on a subscription, inside the days only', () => {
    const ids = subscriptionProviderIds([
      { id: 'custom:abc', type: 'claude-subscription' },
      { id: 'anthropic', type: 'anthropic' },
    ])
    expect(ids['claude-subscription']).toBe('claude-subscription')
    expect(ids['custom:abc']).toBe('claude-subscription')
    expect(ids.anthropic).toBeUndefined()
    const usage = {
      '2026-11-15': {
        'custom:abc': { 'claude-sonnet-5-5': { input: 100, output: 10 } },
        'claude-subscription': { 'claude-opus-5-5': { input: 5, output: 1 } },
        anthropic: { 'claude-opus-5-5': { input: 999, output: 999 } },
      },
      '2026-10-01': { 'custom:abc': { m: { input: 1000, output: 1000 } } },
    }
    expect(subscriptionTokenTotals(usage, ['2026-11-15', '2026-11-16'], ids)).toEqual({
      'claude-subscription': { input: 105, output: 11 },
    })
  })
})
