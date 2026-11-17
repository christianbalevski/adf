import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fromClaudeRateLimit,
  fromCodexHeaders,
  fromCodexUsage,
  fromGrokCredits,
  type UsageReport,
} from '../../../src/main/providers/subscription-usage/adapters'
import { probeCodexUsage, probeGrokUsage } from '../../../src/main/providers/subscription-usage/probes'
import {
  FRESH_MS,
  PROBE_BACKOFF_MS,
  SAMPLE_INTERVAL_MS,
  SubscriptionUsageService,
  type SubscriptionUsageDeps,
} from '../../../src/main/providers/subscription-usage/service'
import type { SubscriptionProviderId, SubscriptionUsageSnapshot } from '../../../src/shared/types/subscription-usage.types'

const NOW = 1_800_000_000_000

describe('Claude rate-limit events', () => {
  it('maps one event to its window: fraction → percent, seconds → ms', () => {
    const r = fromClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_800_003_600 }, NOW)
    expect(r?.windows).toEqual([{ key: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: 1_800_003_600_000, limited: false, observedAt: NOW }])
  })

  it('marks a rejected window limited and labels unknown types plainly', () => {
    const r = fromClaudeRateLimit({ status: 'rejected', rateLimitType: 'seven_day_future', utilization: 1 }, NOW)
    expect(r?.windows[0]).toMatchObject({ key: 'seven_day_future', label: 'seven day future', usedPercent: 100, limited: true })
  })

  it('reads unifiedWindows when present; the typed window wins on a clash', () => {
    const r = fromClaudeRateLimit({
      status: 'allowed', rateLimitType: 'seven_day', utilization: 0.3,
      unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1_800_000_100 }, seven_day: { utilization: 0.2, resetsAt: 1_800_500_000 } },
    }, NOW)
    expect(r?.windows.map((w) => [w.key, w.usedPercent, w.resetsAt])).toEqual([['five_hour', 10, 1_800_000_100_000], ['seven_day', 30, 1_800_500_000_000]])
  })

  it('drops events it cannot key or read', () => {
    expect(fromClaudeRateLimit({ status: 'allowed', utilization: 0.5 }, NOW)).toBeNull()
    expect(fromClaudeRateLimit(null, NOW)).toBeNull()
    expect(fromClaudeRateLimit('nope', NOW)).toBeNull()
    // Wrong types: the window is kept only for the fields that parse.
    const r = fromClaudeRateLimit({ rateLimitType: 'five_hour', utilization: 'lots', resetsAt: {} }, NOW)
    expect(r).toBeNull()
  })
})

describe('Codex headers', () => {
  it('maps primary/secondary windows, plan and credits', () => {
    const r = fromCodexHeaders({
      planType: 'plus', primaryUsedPercent: 12.5, primaryWindowMinutes: 300, primaryResetAfterSeconds: 600,
      secondaryUsedPercent: 40, secondaryWindowMinutes: 10080, secondaryResetAt: 1_800_100_000,
      creditsBalance: 5, creditsHasCredits: true,
    }, NOW)
    expect(r).toEqual({
      plan: 'plus',
      credits: { balance: 5, hasCredits: true },
      windows: [
        { key: 'primary', label: '5-hour', usedPercent: 12.5, resetsAt: NOW + 600_000, limited: false, observedAt: NOW },
        { key: 'secondary', label: 'Weekly', usedPercent: 40, resetsAt: 1_800_100_000_000, limited: false, observedAt: NOW },
      ],
    })
  })

  it('returns null when no x-codex-* header was present, and ignores NaN', () => {
    expect(fromCodexHeaders({}, NOW)).toBeNull()
    expect(fromCodexHeaders({ primaryUsedPercent: Number('garbage') }, NOW)).toBeNull()
    expect(fromCodexHeaders(undefined, NOW)).toBeNull()
  })
})

describe('Codex usage endpoint body', () => {
  const body = {
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 120, reset_at: 1_800_000_120 },
      secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: 1_800_001_000 },
    },
    credits: { has_credits: false, unlimited: false, balance: '0' },
    new_field: { anything: true },
  }

  it('extracts what is present, tolerating extra fields and numeric strings', () => {
    const r = fromCodexUsage(body, NOW)
    expect(r?.plan).toBe('pro')
    expect(r?.credits).toEqual({ balance: 0, hasCredits: false })
    expect(r?.windows.map((w) => [w.key, w.label, w.usedPercent, w.resetsAt])).toEqual([
      ['primary', '5-hour', 7, 1_800_000_120_000],
      ['secondary', 'Weekly', 55, 1_800_001_000_000],
    ])
  })

  it('survives shape drift field by field', () => {
    const r = fromCodexUsage({ plan_type: 3, rate_limit: { primary_window: { used_percent: 'x', reset_after_seconds: 60 }, secondary_window: 'gone' } }, NOW)
    expect(r?.plan).toBeUndefined()
    expect(r?.windows).toEqual([{ key: 'primary', label: 'Short window', resetsAt: NOW + 60_000, observedAt: NOW }])
    expect(fromCodexUsage({ rate_limit: 'renamed' }, NOW)).toBeNull()
    expect(fromCodexUsage({ plan_type: 'plus' }, NOW)).toBeNull()
    expect(fromCodexUsage([], NOW)).toBeNull()
    expect(fromCodexUsage(null, NOW)).toBeNull()
  })
})

describe('Codex usage probe', () => {
  const auth = { getValidAccessToken: async () => 'tok', getAccountId: () => 'acct' }
  const json = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch

  it('sends the Codex auth headers and parses the body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      expect(h.Authorization).toBe('Bearer tok')
      expect(h['ChatGPT-Account-ID']).toBe('acct')
      expect(h.originator).toBe('codex_cli_rs')
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } }), { status: 200 })
    })
    const r = await probeCodexUsage(auth, fetchImpl as unknown as typeof fetch, () => NOW)
    expect(r.windows[0].usedPercent).toBe(20)
  })

  it.each([
    [json(404, 'not found'), 'Codex usage endpoint returned HTTP 404'],
    [json(500, '{}'), 'Codex usage endpoint returned HTTP 500'],
    [json(200, '<html>'), 'Codex usage endpoint returned a response that is not JSON'],
    [json(200, '{"unrelated":1}'), 'Codex usage endpoint returned no usage figures ADF can read'],
    [(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }) as unknown as typeof fetch, 'Codex usage endpoint did not answer within 8 s'],
    [(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch, 'Codex usage endpoint could not be reached: fetch failed'],
  ])('fails plainly (%#)', async (fetchImpl, message) => {
    await expect(probeCodexUsage(auth, fetchImpl)).rejects.toThrow(message)
  })

  it('names a sign-in failure', async () => {
    await expect(probeCodexUsage({ getValidAccessToken: async () => { throw new Error('refresh token revoked') }, getAccountId: () => undefined }, json(200, '{}')))
      .rejects.toThrow('ChatGPT sign-in could not be used: refresh token revoked')
  })
})

describe('Grok credits (Grok Build billing endpoint)', () => {
  const end = '2027-01-15T08:00:00Z'

  it('maps the weekly pool, its end as the reset, and purchased credits in dollars', () => {
    const r = fromGrokCredits({ config: { creditUsagePercent: 37.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2027-01-08T08:00:00Z', end }, prepaidBalance: { val: 1250 } } }, NOW)
    expect(r).toEqual({
      windows: [{ key: 'pool', label: 'Weekly', usedPercent: 37.5, limited: false, resetsAt: Date.parse(end), observedAt: NOW }],
      credits: { balance: 12.5 },
    })
  })

  it('falls back to the older used / monthlyLimit cents and billingPeriodEnd', () => {
    const r = fromGrokCredits({ config: { monthlyLimit: { val: 2000 }, used: { val: 2000 }, billingPeriodEnd: end } }, NOW)
    expect(r?.windows).toEqual([{ key: 'pool', label: 'Usage', usedPercent: 100, limited: true, resetsAt: Date.parse(end), observedAt: NOW }])
    expect(r?.credits).toBeUndefined()
  })

  it('reads an omitted percent as 0 within a period (proto3 drops zeros), hides a zero balance', () => {
    const r = fromGrokCredits({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end }, prepaidBalance: {} } }, NOW)
    expect(r).toEqual({ windows: [{ key: 'pool', label: 'Weekly', usedPercent: 0, limited: false, resetsAt: Date.parse(end), observedAt: NOW }] })
  })

  it('returns null when nothing usable is left', () => {
    expect(fromGrokCredits({ config: {} }, NOW)).toBeNull()
    expect(fromGrokCredits({ config: { creditUsagePercent: 'x', currentPeriod: { end: 'soon' } } }, NOW)).toBeNull()
    expect(fromGrokCredits({ renamed: {} }, NOW)).toBeNull()
    expect(fromGrokCredits(null, NOW)).toBeNull()
  })
})

describe('Grok usage probe', () => {
  it('sends the Grok Build auth headers and parses the body', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits')
      const h = init.headers as Record<string, string>
      expect(h.Authorization).toBe('Bearer tok')
      expect(h['X-XAI-Token-Auth']).toBe('xai-grok-cli')
      expect(h['x-userid']).toBe('user-1')
      return new Response(JSON.stringify({ config: { creditUsagePercent: 12 } }), { status: 200 })
    })
    const r = await probeGrokUsage({ getValidAccessToken: async () => 'tok', getAccountId: () => 'user-1' }, fetchImpl as unknown as typeof fetch, () => NOW)
    expect(r.windows[0].usedPercent).toBe(12)
  })

  it('names the endpoint and the sign-in when they fail', async () => {
    const auth = { getValidAccessToken: async () => 'tok', getAccountId: () => undefined }
    await expect(probeGrokUsage(auth, (async () => new Response('', { status: 401 })) as unknown as typeof fetch)).rejects.toThrow('Grok usage endpoint returned HTTP 401')
    await expect(probeGrokUsage({ ...auth, getValidAccessToken: async () => { throw new Error('expired') } }, fetch)).rejects.toThrow('Grok sign-in could not be used: expired')
  })
})

describe('SubscriptionUsageService', () => {
  let dir: string
  let now: number
  let signedIn: Record<SubscriptionProviderId, boolean | undefined>
  let accountReads: number
  let freshReads: number

  const make = (extra: Partial<SubscriptionUsageDeps> = {}) => new SubscriptionUsageService({
    filePath: join(dir, 'subscription-usage.json'),
    now: () => now,
    account: async (p, fresh) => { accountReads++; if (fresh) freshReads++; return { signedIn: signedIn[p] } },
    ...extra,
  })
  const snap = async (s: SubscriptionUsageService, p: SubscriptionProviderId): Promise<SubscriptionUsageSnapshot> =>
    (await s.getState()).snapshots.find((x) => x.provider === p)!
  const win = (key: string, usedPercent: number, resetsAt?: number): UsageReport => ({
    windows: [{ key, label: key, usedPercent, observedAt: now, ...(resetsAt ? { resetsAt } : {}) }],
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-sub-usage-'))
    now = NOW
    accountReads = 0
    freshReads = 0
    signedIn = { 'claude-subscription': true, 'chatgpt-subscription': true, 'grok-subscription': true }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports every provider, unavailable until a report arrives, signed_out from auth', async () => {
    signedIn['grok-subscription'] = false
    const s = make()
    const state = await s.getState()
    expect(state.snapshots.map((x) => [x.provider, x.status])).toEqual([
      ['claude-subscription', 'unavailable'], ['chatgpt-subscription', 'unavailable'], ['grok-subscription', 'signed_out'],
    ])
  })

  it('drops windows a newer usage check left out, in this process and from the file', async () => {
    const daemon = make()
    daemon.record('grok-subscription', win('requests', 0))
    daemon.flush()
    now += 1
    const studio = make({ probes: { 'grok-subscription': async () => win('pool', 30, now + 60_000) } })
    expect((await snap(studio, 'grok-subscription')).windows.map((w) => w.key)).toEqual(['requests'])
    await studio.refresh()
    expect((await snap(studio, 'grok-subscription')).windows.map((w) => w.key)).toEqual(['pool'])
    studio.flush()
    // The daemon still holds the old window in memory; merging on save must not bring it back.
    daemon.record('claude-subscription', win('five_hour', 1))
    daemon.flush()
    expect((await snap(make(), 'grok-subscription')).windows.map((w) => w.key)).toEqual(['pool'])
  })

  it('keeps windows reported in separate events when no usage check left them out', async () => {
    const s = make()
    s.record('claude-subscription', win('five_hour', 10))
    now += 1
    s.record('claude-subscription', win('seven_day', 20))
    expect((await snap(s, 'claude-subscription')).windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
  })

  it('keeps reset-less windows reported together, stale but shown, when nothing newer arrives', async () => {
    const s = make()
    s.record('chatgpt-subscription', { windows: [{ key: 'primary', label: 'p', usedPercent: 5, observedAt: now }, { key: 'secondary', label: 's', usedPercent: 0, observedAt: now }] })
    now += FRESH_MS + 1
    const c = await snap(s, 'chatgpt-subscription')
    expect([c.status, c.windows.length]).toEqual(['stale', 2])
  })

  it('merges windows by key across events', async () => {
    const s = make()
    s.record('claude-subscription', win('five_hour', 10))
    s.record('claude-subscription', win('seven_day', 50))
    s.record('claude-subscription', win('five_hour', 12))
    const c = await snap(s, 'claude-subscription')
    expect(c.status).toBe('ok')
    expect(c.windows.map((w) => [w.key, w.usedPercent])).toEqual([['five_hour', 12], ['seven_day', 50]])
  })

  it('leaves out windows past their reset; status follows the freshest live window', async () => {
    const s = make()
    s.record('claude-subscription', win('seven_day_sonnet', 90, NOW + 60_000))
    now += 30 * 60_000
    s.record('claude-subscription', win('five_hour', 20, NOW + 5 * 60 * 60_000))
    const c = await snap(s, 'claude-subscription')
    expect(c.status).toBe('ok')
    expect(c.windows.map((w) => w.key)).toEqual(['five_hour'])

    // Every window expired: no figures shown, and the old ones read as stale.
    now = NOW + 6 * 60 * 60_000
    const d = await snap(s, 'claude-subscription')
    expect(d.windows).toEqual([])
    expect(d.status).toBe('stale')

    // Old figures, reset not passed: stale on age.
    s.record('grok-subscription', win('requests', 5))
    now += FRESH_MS + 1
    expect((await snap(s, 'grok-subscription')).status).toBe('stale')
  })

  it('keeps fresh figures ok when a later check fails; the error is a note', async () => {
    const s = make()
    s.record('chatgpt-subscription', win('primary', 10))
    s.markError('chatgpt-subscription', 'Codex usage endpoint returned HTTP 500')
    const c = await snap(s, 'chatgpt-subscription')
    expect(c).toMatchObject({ status: 'ok', error: 'Codex usage endpoint returned HTTP 500' })
    expect(c.windows[0].usedPercent).toBe(10)
    // Past the freshness horizon the same snapshot is stale, the error still attached.
    now += FRESH_MS + 1
    expect(await snap(s, 'chatgpt-subscription')).toMatchObject({ status: 'stale', error: 'Codex usage endpoint returned HTTP 500' })
    // A good report clears the error.
    s.record('chatgpt-subscription', win('primary', 11))
    expect(await snap(s, 'chatgpt-subscription')).not.toHaveProperty('error')
    // No figures ever: error.
    s.markError('claude-subscription', 'no figures yet')
    expect((await snap(s, 'claude-subscription')).status).toBe('error')
  })

  it('never throws from record/markError, ignores null reports', async () => {
    const s = make()
    expect(() => s.record('claude-subscription', null)).not.toThrow()
    expect(() => s.record('claude-subscription', { windows: null } as unknown as UsageReport)).not.toThrow()
    expect((await snap(s, 'claude-subscription')).status).toBe('unavailable')
  })

  it('throttles probes to one per 10 s, backs off after three failures', async () => {
    let calls = 0
    let fail = true
    const s = make({ probes: { 'chatgpt-subscription': async () => { calls++; if (fail) throw new Error('Codex usage endpoint returned HTTP 500'); return win('primary', 1) } } })

    await Promise.all([s.refresh(), s.refresh()]) // concurrent: one probe
    expect(calls).toBe(1)
    expect(await snap(s, 'chatgpt-subscription')).toMatchObject({ status: 'error', error: 'Codex usage endpoint returned HTTP 500' })
    now += 5_000
    await s.refresh()
    expect(calls).toBe(1)
    now += 5_000
    await s.refresh()
    now += 10_000
    await s.refresh()
    expect(calls).toBe(3)
    // Three consecutive failures: back off.
    now += 60_000
    await s.refresh()
    expect(calls).toBe(3)
    now += PROBE_BACKOFF_MS
    fail = false
    await s.refresh()
    expect(calls).toBe(4)
    expect((await snap(s, 'chatgpt-subscription')).status).toBe('ok')
  })

  it('skips probes when signed out and providers without a probe', async () => {
    const probe = vi.fn(async () => win('primary', 1))
    signedIn['chatgpt-subscription'] = false
    const s = make({ probes: { 'chatgpt-subscription': probe } })
    const state = await s.refresh()
    expect(probe).not.toHaveBeenCalled()
    expect(state.snapshots.find((x) => x.provider === 'chatgpt-subscription')?.status).toBe('signed_out')
  })

  it('reads sign-ins on every state; refresh asks for fresh ones, even without probing', async () => {
    const s = make()
    await s.getState()
    expect([accountReads, freshReads]).toEqual([3, 0])
    await s.refresh({ probe: false })
    expect([accountReads, freshReads]).toEqual([6, 3])
  })

  it('a sign-in shows on the next read, not after a cache expires', async () => {
    signedIn['chatgpt-subscription'] = false
    const s = make()
    expect((await snap(s, 'chatgpt-subscription')).status).toBe('signed_out')
    signedIn['chatgpt-subscription'] = true
    expect((await snap(s, 'chatgpt-subscription')).status).toBe('unavailable')
  })

  it('drops a signed-out account\'s figures and history, and takes a new report after sign-in', async () => {
    const s = make()
    s.record('chatgpt-subscription', { ...win('primary', 40), plan: 'plus' })
    s.flush()
    signedIn['chatgpt-subscription'] = false
    await s.refresh()
    expect(await snap(s, 'chatgpt-subscription')).toEqual({ provider: 'chatgpt-subscription', status: 'signed_out', windows: [] })
    expect(s.getHistory()).toHaveLength(0)
    // The file still has the old figures: a save must not bring them back.
    s.flush()
    expect(JSON.parse(readFileSync(join(dir, 'subscription-usage.json'), 'utf8')).snapshots['chatgpt-subscription']).toBeUndefined()

    signedIn['chatgpt-subscription'] = true
    now += 10 * 60_000
    s.record('chatgpt-subscription', win('primary', 3))
    const c = await snap(s, 'chatgpt-subscription')
    expect(c.status).toBe('ok')
    expect(c.plan).toBeUndefined()
    expect(c.windows.map((w) => w.usedPercent)).toEqual([3])
    // Saved inside the debounce after the sign-out, the old account's figures still stay out.
    s.flush()
    expect((await snap(s, 'chatgpt-subscription')).windows.map((w) => w.usedPercent)).toEqual([3])
    expect(s.getHistory().map((x) => x.usedPercent)).toEqual([3])
  })

  it('another process that has not seen the sign-out cannot write the old account back', async () => {
    const other = make()
    other.record('chatgpt-subscription', { ...win('primary', 40), plan: 'pro' })
    other.flush()
    const s = make()
    signedIn['chatgpt-subscription'] = false
    await s.getState()
    s.flush()
    // The other process still thinks it is signed in and saves its old snapshot.
    other.record('grok-subscription', win('tokens', 1))
    other.flush()
    signedIn['chatgpt-subscription'] = true
    now += 60_000
    s.record('chatgpt-subscription', { ...win('primary', 2), plan: 'plus' })
    s.flush()
    const c = await snap(s, 'chatgpt-subscription')
    expect([c.plan, c.windows.map((w) => w.usedPercent)]).toEqual(['plus', [2]])
    expect(s.getHistory().filter((x) => x.provider === 'chatgpt-subscription').map((x) => x.usedPercent)).toEqual([2])
  })

  it('keeps at most one history sample per window per 5 min, however far the figure moves; filters by since', () => {
    const s = make()
    s.record('grok-subscription', win('tokens', 10))
    now += 60_000
    s.record('grok-subscription', win('tokens', 60)) // dropped: inside the interval
    s.record('grok-subscription', win('requests', 5)) // another window
    now += SAMPLE_INTERVAL_MS
    s.record('grok-subscription', win('tokens', 61))
    expect(s.getHistory().map((x) => [x.window, x.usedPercent])).toEqual([['tokens', 10], ['requests', 5], ['tokens', 61]])
    expect(s.getHistory({ since: NOW + 1 }).length).toBe(2)
  })

  it('persists snapshots and history across restarts', async () => {
    const a = make()
    a.record('chatgpt-subscription', { ...win('primary', 33), plan: 'plus', credits: { balance: 2 } })
    a.markError('grok-subscription', 'nothing yet')
    a.flush()
    const b = make()
    const c = await snap(b, 'chatgpt-subscription')
    expect(c).toMatchObject({ status: 'ok', plan: 'plus', credits: { balance: 2 } })
    expect(c.windows[0]).toMatchObject({ key: 'primary', usedPercent: 33 })
    expect((await snap(b, 'grok-subscription'))).toMatchObject({ status: 'error', error: 'nothing yet' })
    expect(b.getHistory()).toHaveLength(1)
  })

  it('merges with the file on save instead of overwriting another process\'s data', async () => {
    const studio = make()
    const daemon = make()
    studio.record('claude-subscription', win('five_hour', 10))
    daemon.record('chatgpt-subscription', win('primary', 20))
    now += SAMPLE_INTERVAL_MS
    daemon.record('claude-subscription', win('seven_day', 30))
    studio.flush()
    daemon.flush()
    now += 60_000
    studio.record('claude-subscription', win('five_hour', 11))
    studio.flush()

    const fresh = make()
    const claude = await snap(fresh, 'claude-subscription')
    expect(claude.windows.map((w) => [w.key, w.usedPercent])).toEqual([['five_hour', 11], ['seven_day', 30]])
    expect((await snap(fresh, 'chatgpt-subscription')).windows[0].usedPercent).toBe(20)
    // Union of both histories, each sample once, oldest first.
    expect(fresh.getHistory().map((x) => [x.provider, x.window, x.usedPercent])).toEqual([
      ['claude-subscription', 'five_hour', 10], ['chatgpt-subscription', 'primary', 20],
      ['claude-subscription', 'seven_day', 30], ['claude-subscription', 'five_hour', 11],
    ])
  })

  it('keeps all history on save, however old', () => {
    const file = join(dir, 'subscription-usage.json')
    writeFileSync(file, JSON.stringify({ samples: [
      { t: NOW - 91 * 24 * 60 * 60_000, provider: 'claude-subscription', window: 'five_hour', usedPercent: 1 },
      { t: NOW - 1, provider: 'claude-subscription', window: 'five_hour', usedPercent: 2 },
    ] }))
    const s = make()
    s.record('grok-subscription', win('requests', 3))
    s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).samples.map((x: { usedPercent: number }) => x.usedPercent)).toEqual([1, 2, 3])
  })

  it('starts empty from a corrupt file (moved aside) or a wrong-shaped one', async () => {
    const file = join(dir, 'subscription-usage.json')
    writeFileSync(file, '{not json')
    const s = make()
    expect((await snap(s, 'claude-subscription')).status).toBe('unavailable')
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true)

    writeFileSync(file, JSON.stringify({ snapshots: { 'claude-subscription': { windows: { five_hour: { usedPercent: 'x' } } }, bogus: {} }, samples: [{ t: 'x' }, 5] }))
    const t = make()
    expect((await snap(t, 'claude-subscription')).windows).toEqual([])
    expect(t.getHistory()).toEqual([])
    t.record('claude-subscription', win('five_hour', 1))
    t.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).snapshots['claude-subscription'].windows.five_hour.usedPercent).toBe(1)
  })

  it('pushes the full state to listeners after changes (coalesced)', async () => {
    vi.useFakeTimers()
    try {
      const s = make()
      const seen: number[] = []
      s.onChange((state) => seen.push(state.snapshots.length))
      s.record('claude-subscription', win('five_hour', 1))
      s.record('claude-subscription', win('seven_day', 1))
      await vi.advanceTimersByTimeAsync(300)
      expect(seen).toEqual([3])
    } finally {
      vi.useRealTimers()
    }
  })
})
