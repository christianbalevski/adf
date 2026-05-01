import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DirectoryFetchCache } from '../../../src/main/services/directory-fetch-cache'

const PEER_URL = 'http://host-b.local:7295'

function cardFixture(handle: string) {
  return {
    handle,
    description: `${handle} description`,
    endpoints: { inbox: 'x', card: 'x', health: 'x' },
    public: false,
    shared: [],
    attestations: [],
    policies: [],
    visibility: 'localhost',
    in_subdirectory: false,
    source: 'local-runtime'
  }
}

describe('DirectoryFetchCache', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.useRealTimers()
  })

  it('returns cards on a successful 200 response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as never)

    const cache = new DirectoryFetchCache()
    const result = await cache.fetch(PEER_URL)

    expect(result).toHaveLength(1)
    expect(result[0].handle).toBe('sage')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Ensure the URL was constructed correctly
    const arg = (fetchSpy.mock.calls[0] as [string])[0]
    expect(arg).toBe(`${PEER_URL}/mesh/directory`)
  })

  it('returns [] on non-2xx without throwing', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 500 }) as never)
    const cache = new DirectoryFetchCache()
    expect(await cache.fetch(PEER_URL)).toEqual([])
  })

  it('returns [] on network error without throwing', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('network failed'))
    const cache = new DirectoryFetchCache()
    expect(await cache.fetch(PEER_URL)).toEqual([])
  })

  it('caches fresh results for the TTL window', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as never)

    const cache = new DirectoryFetchCache()
    await cache.fetch(PEER_URL)
    await cache.fetch(PEER_URL)
    await cache.fetch(PEER_URL)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent in-flight fetches (one HTTP request for many callers)', async () => {
    let resolveResponse!: (resp: Response) => void
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve
    }) as never)

    const cache = new DirectoryFetchCache()
    const p1 = cache.fetch(PEER_URL)
    const p2 = cache.fetch(PEER_URL)
    const p3 = cache.fetch(PEER_URL)

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveResponse(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    const [a, b, c] = await Promise.all([p1, p2, p3])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a).toHaveLength(1)
  })

  it('resolves to [] when the fetch aborts via AbortSignal.timeout', async () => {
    // Simulate a timeout by rejecting with an AbortError, which is what
    // AbortSignal.timeout() produces when the signal fires. Same code path as
    // an unreachable .local hostname or a silently-dropped SYN on the LAN.
    const abortErr = new DOMException('timeout', 'TimeoutError')
    fetchSpy.mockRejectedValueOnce(abortErr)

    const cache = new DirectoryFetchCache()
    expect(await cache.fetch(PEER_URL)).toEqual([])
  })

  it('invalidate() drops a single cached entry', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as never)

    const cache = new DirectoryFetchCache()
    await cache.fetch(PEER_URL)
    cache.invalidate(PEER_URL)
    await cache.fetch(PEER_URL)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('invalidate() with no args clears all entries', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as never)

    const cache = new DirectoryFetchCache()
    await cache.fetch(PEER_URL)
    await cache.fetch('http://other.local:7295')
    cache.invalidate()
    await cache.fetch(PEER_URL)
    await cache.fetch('http://other.local:7295')

    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('re-fetches after the TTL expires', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([cardFixture('sage')]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as never)

    const cache = new DirectoryFetchCache()
    await cache.fetch(PEER_URL)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Advance past the TTL.
    vi.setSystemTime(Date.now() + DirectoryFetchCache.TTL_MS + 100)
    await cache.fetch(PEER_URL)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
