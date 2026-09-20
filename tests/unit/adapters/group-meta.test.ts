/**
 * GroupMetaCache — TTL behavior plus the opportunistic sweep that keeps a
 * long-lived adapter from accumulating one entry per chat it ever saw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GroupMetaCache, buildGroupMeta } from '../../../src/main/adapters/group-meta'

function meta(chatId: string) {
  return buildGroupMeta({ platform: 'telegram', chatId, title: `chat ${chatId}` })
}

/** Size of the internal map — the thing the sweep is supposed to bound. */
function size(cache: GroupMetaCache): number {
  return (cache as unknown as { entries: Map<string, unknown> }).entries.size
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GroupMetaCache', () => {
  it('serves fresh entries and drops expired ones on lookup', () => {
    vi.useFakeTimers()
    const cache = new GroupMetaCache(1000, 100)
    cache.set('a', meta('a'))
    expect(cache.get('a')?.chat_id).toBe('a')
    vi.advanceTimersByTime(1001)
    expect(cache.get('a')).toBeNull()
  })

  it('negative-caches a failed fetch on the shorter failure TTL', async () => {
    vi.useFakeTimers()
    const cache = new GroupMetaCache(10_000, 100)
    const fetch = vi.fn(async () => { throw new Error('no scope') })

    expect(await cache.getOrFetch('a', fetch)).toBeNull()
    expect(await cache.getOrFetch('a', fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1) // second call served from the negative cache

    vi.advanceTimersByTime(101)
    expect(await cache.getOrFetch('a', fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sweeps expired entries once a new key pushes it past the threshold', () => {
    vi.useFakeTimers()
    const cache = new GroupMetaCache(1000, 100)
    for (let i = 0; i < 70; i++) cache.set(`old-${i}`, meta(`old-${i}`))
    expect(size(cache)).toBe(70)

    vi.advanceTimersByTime(1001)
    // Nothing is looked up again — only an insert of a NEW key triggers the sweep.
    cache.set('fresh', meta('fresh'))
    expect(size(cache)).toBe(1)
    expect(cache.get('fresh')?.chat_id).toBe('fresh')
  })

  it('refreshing an existing key never sweeps, and fresh entries survive one', () => {
    vi.useFakeTimers()
    const cache = new GroupMetaCache(1000, 100)
    for (let i = 0; i < 70; i++) cache.set(`k-${i}`, meta(`k-${i}`))
    cache.set('k-0', meta('k-0')) // same key — no sweep, no eviction
    expect(size(cache)).toBe(70)

    cache.set('new', meta('new')) // new key, but nothing has expired yet
    expect(size(cache)).toBe(71)
  })
})
