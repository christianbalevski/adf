import { describe, expect, it } from 'vitest'
import { pollDeviceCodeToken } from '../../../src/main/providers/grok-subscription/auth-manager'
import type { DeviceCodeResponse } from '../../../src/main/providers/grok-subscription/types'

const DEVICE: DeviceCodeResponse = {
  device_code: 'dev-123',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.x.ai/activate',
  expires_in: 600,
  interval: 5,
}

const TOKENS = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** Build a fetch stub that returns the queued responses in order. */
function fetchQueue(responses: Response[]): { fetchFn: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''))
    const next = responses.shift()
    if (!next) throw new Error('fetch queue exhausted')
    return next
  }) as typeof globalThis.fetch
  return { fetchFn, calls }
}

function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    sleeps,
  }
}

describe('pollDeviceCodeToken', () => {
  it('keeps polling through authorization_pending and returns tokens on approval', async () => {
    const clock = fakeClock()
    const { fetchFn, calls } = fetchQueue([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS),
    ])

    const result = await pollDeviceCodeToken(DEVICE, { fetchFn, sleep: clock.sleep, now: clock.now })

    expect(result.access_token).toBe('at')
    expect(calls.length).toBe(3)
    expect(clock.sleeps).toEqual([5000, 5000])
    // grant type and device code are sent on every poll
    expect(calls[0]).toContain('urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')
    expect(calls[0]).toContain('device_code=dev-123')
  })

  it('backs off by 5s on slow_down', async () => {
    const clock = fakeClock()
    const { fetchFn } = fetchQueue([
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS),
    ])

    await pollDeviceCodeToken(DEVICE, { fetchFn, sleep: clock.sleep, now: clock.now })

    expect(clock.sleeps).toEqual([10000, 10000])
  })

  it('throws when the user denies authorization', async () => {
    const clock = fakeClock()
    const { fetchFn } = fetchQueue([jsonResponse(400, { error: 'access_denied' })])

    await expect(
      pollDeviceCodeToken(DEVICE, { fetchFn, sleep: clock.sleep, now: clock.now })
    ).rejects.toThrow('denied')
  })

  it('throws when the device code expires server-side', async () => {
    const clock = fakeClock()
    const { fetchFn } = fetchQueue([jsonResponse(400, { error: 'expired_token' })])

    await expect(
      pollDeviceCodeToken(DEVICE, { fetchFn, sleep: clock.sleep, now: clock.now })
    ).rejects.toThrow('expired')
  })

  it('times out at the expires_in deadline instead of polling forever', async () => {
    const clock = fakeClock()
    const pending = () => jsonResponse(400, { error: 'authorization_pending' })
    // 600s deadline / 5s interval = 120 polls max; queue a couple extra
    const { fetchFn, calls } = fetchQueue(Array.from({ length: 125 }, pending))

    await expect(
      pollDeviceCodeToken(DEVICE, { fetchFn, sleep: clock.sleep, now: clock.now })
    ).rejects.toThrow('timed out')
    expect(calls.length).toBeLessThanOrEqual(121)
  })

  it('defends against garbage interval/expires values', async () => {
    const clock = fakeClock()
    const { fetchFn } = fetchQueue([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS),
    ])
    const device = { ...DEVICE, interval: NaN as unknown as number, expires_in: -5 }

    const result = await pollDeviceCodeToken(device, { fetchFn, sleep: clock.sleep, now: clock.now })

    expect(result.access_token).toBe('at')
    // NaN interval falls back to the 5s default, not a 0ms busy-loop
    expect(clock.sleeps).toEqual([5000])
  })
})
