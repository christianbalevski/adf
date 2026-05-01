/**
 * In-memory LRU cache for API lambda responses.
 * Uses Map insertion order for LRU eviction, lazy TTL expiry.
 */

interface CacheEntry {
  status: number
  headers: Record<string, string> | undefined
  body: unknown
  expiresAt: number
  sizeBytes: number
}

const MAX_ENTRIES = 1000
const MAX_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB

export class ApiResponseCache {
  private entries = new Map<string, CacheEntry>()
  private totalBytes = 0

  /**
   * Build a normalized cache key from method, path, and query params.
   * Query params are sorted alphabetically so ?a=1&b=2 == ?b=2&a=1.
   */
  buildKey(method: string, path: string, query: Record<string, string>): string {
    const keys = Object.keys(query).sort()
    const qs = keys.length > 0
      ? '?' + keys.map(k => `${k}=${query[k]}`).join('&')
      : ''
    return `${method} ${path}${qs}`
  }

  /**
   * Get a cached response. Returns null on miss or expired entry.
   * Re-inserts on hit to refresh LRU position.
   */
  get(key: string): { status: number; headers: Record<string, string> | undefined; body: unknown } | null {
    const entry = this.entries.get(key)
    if (!entry) return null

    // Lazy TTL expiry
    if (Date.now() > entry.expiresAt) {
      this.totalBytes -= entry.sizeBytes
      this.entries.delete(key)
      return null
    }

    // Re-insert to refresh LRU position
    this.entries.delete(key)
    this.entries.set(key, entry)

    return { status: entry.status, headers: entry.headers, body: entry.body }
  }

  /**
   * Store a response in the cache with the given TTL.
   * Evicts LRU entries if over maxEntries or maxTotalBytes.
   */
  set(
    key: string,
    status: number,
    headers: Record<string, string> | undefined,
    body: unknown,
    ttlMs: number
  ): void {
    // Remove existing entry if present
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.sizeBytes
      this.entries.delete(key)
    }

    const sizeBytes = estimateSize(body)
    const entry: CacheEntry = {
      status,
      headers,
      body,
      expiresAt: Date.now() + ttlMs,
      sizeBytes
    }

    this.entries.set(key, entry)
    this.totalBytes += sizeBytes

    // Evict LRU entries (oldest = first in map) until within limits
    while (this.entries.size > MAX_ENTRIES || this.totalBytes > MAX_TOTAL_BYTES) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      const oldEntry = this.entries.get(oldest.value)!
      this.totalBytes -= oldEntry.sizeBytes
      this.entries.delete(oldest.value)
    }
  }

  /**
   * Invalidate all entries whose key's path starts with the given prefix.
   * Returns the number of entries removed.
   */
  invalidate(pathPrefix: string): number {
    let count = 0
    for (const [key, entry] of this.entries) {
      // Key format: "METHOD /path?query" — extract path portion
      const spaceIdx = key.indexOf(' ')
      const pathAndQuery = key.slice(spaceIdx + 1)
      const path = pathAndQuery.split('?')[0]
      if (path.startsWith(pathPrefix)) {
        this.totalBytes -= entry.sizeBytes
        this.entries.delete(key)
        count++
      }
    }
    return count
  }

  /** Wipe all entries. */
  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  get size(): number {
    return this.entries.size
  }
}

function estimateSize(body: unknown): number {
  if (body === null || body === undefined) return 0
  if (typeof body === 'string') return body.length
  try {
    return JSON.stringify(body).length
  } catch {
    return 0
  }
}
