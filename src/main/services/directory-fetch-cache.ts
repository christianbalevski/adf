import type { DirectoryEntry } from '../tools/built-in/agent-discover.tool'

interface CacheEntry {
  cards: DirectoryEntry[]
  expiresAt: number
}

/**
 * In-memory cache for `GET /mesh/directory` responses from remote runtimes.
 *
 * Two jobs:
 *  1. TTL-based caching (30s) so repeated `agent_discover(scope: "all")` calls
 *     don't spam every discovered peer with HTTP requests.
 *  2. Concurrent-fetch deduplication — if two callers ask for the same URL at
 *     once, they share one HTTP request via an in-flight promise map.
 *
 * Errors (network failure, non-2xx, timeout) resolve to `[]` silently per the
 * mDNS spec: an unreachable peer simply disappears from results rather than
 * raising. The in-flight promise is cleared either way so the next call retries.
 */
export class DirectoryFetchCache {
  static readonly TTL_MS = 30_000
  static readonly FETCH_TIMEOUT_MS = 2_000

  private entries = new Map<string, CacheEntry>()
  private inFlight = new Map<string, Promise<DirectoryEntry[]>>()

  async fetch(runtimeUrl: string): Promise<DirectoryEntry[]> {
    const now = Date.now()
    const cached = this.entries.get(runtimeUrl)
    if (cached && cached.expiresAt > now) return cached.cards

    const pending = this.inFlight.get(runtimeUrl)
    if (pending) return pending

    const promise = this.fetchFresh(runtimeUrl).finally(() => {
      this.inFlight.delete(runtimeUrl)
    })
    this.inFlight.set(runtimeUrl, promise)
    return promise
  }

  /** Drop cached entries. Pass a url to invalidate a single peer; omit to clear all. */
  invalidate(runtimeUrl?: string): void {
    if (runtimeUrl) {
      this.entries.delete(runtimeUrl)
    } else {
      this.entries.clear()
    }
  }

  private async fetchFresh(runtimeUrl: string): Promise<DirectoryEntry[]> {
    const url = runtimeUrl.replace(/\/+$/, '') + '/mesh/directory'
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DirectoryFetchCache.FETCH_TIMEOUT_MS) })
      if (!res.ok) return []
      const body = await res.json()
      const cards = Array.isArray(body) ? (body as DirectoryEntry[]) : []
      this.entries.set(runtimeUrl, { cards, expiresAt: Date.now() + DirectoryFetchCache.TTL_MS })
      return cards
    } catch {
      return []
    }
  }
}
