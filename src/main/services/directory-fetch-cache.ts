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
 * Errors (network failure, non-2xx, timeout) resolve to `null` — callers can
 * tell "peer unreachable" apart from "peer reachable but no visible agents"
 * (a genuinely empty `[]`), which the UI renders very differently. Failures
 * are never cached; the in-flight promise is cleared either way so the next
 * call retries.
 */
export class DirectoryFetchCache {
  static readonly TTL_MS = 30_000
  // Generous: resolving an mDNS peer + TLS-less HTTP round trip can exceed 2s
  // on a busy Wi-Fi segment, and a false "unreachable" reads as "0 agents"
  static readonly FETCH_TIMEOUT_MS = 5_000

  private entries = new Map<string, CacheEntry>()
  private inFlight = new Map<string, Promise<DirectoryEntry[] | null>>()

  async fetch(runtimeUrl: string): Promise<DirectoryEntry[] | null> {
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

  private async fetchFresh(runtimeUrl: string): Promise<DirectoryEntry[] | null> {
    const url = runtimeUrl.replace(/\/+$/, '') + '/mesh/directory'
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DirectoryFetchCache.FETCH_TIMEOUT_MS) })
      if (!res.ok) return null
      const body = await res.json()
      const cards = Array.isArray(body) ? (body as DirectoryEntry[]) : []
      this.entries.set(runtimeUrl, { cards, expiresAt: Date.now() + DirectoryFetchCache.TTL_MS })
      return cards
    } catch {
      return null
    }
  }
}
