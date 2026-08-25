/**
 * MCP Registry Fetch Service
 *
 * Serves the curated MCP server registry, preferring the live document on
 * GitHub raw over the copy bundled at build time so new/updated entries reach
 * users without an app release. Three-tier fallback:
 *
 *  1. remote  — fetched from MCP_REGISTRY_URL and validated via
 *               parseMcpRegistryDocument. Persisted (with its ETag) to
 *               <userData>/mcp-registry-cache.json so the next launch starts
 *               from the freshest known copy.
 *  2. cache   — the last successfully fetched document, used when the network
 *               or the remote document fails.
 *  3. bundled — the /mcp-registry.json copy compiled into the app. Always
 *               valid (a broken bundled registry is a build error).
 *
 * Runtime-agnostic: no 'electron' import — the storage directory is injected
 * (the IPC layer passes app.getPath('userData')), and fetch is injectable for
 * tests.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  MCP_REGISTRY,
  BUNDLED_REGISTRY_UPDATED_AT,
  type McpRegistryEntry
} from '../../shared/constants/mcp-registry'
import { parseMcpRegistryDocument, type ParsedMcpRegistryDocument } from '../../shared/schemas/mcp-registry.schema'
import type { McpRegistryGetResult } from '../../shared/types/ipc.types'
import { writeJsonAtomic } from '../utils/atomic-json'

export const MCP_REGISTRY_URL = 'https://raw.githubusercontent.com/christianbalevski/adf/main/mcp-registry.json'

/** Shape persisted to <userData>/mcp-registry-cache.json. */
interface RegistryCacheFile {
  etag?: string
  fetchedAt: number
  /** The raw remote document — re-validated on every read, never trusted blindly. */
  document: unknown
}

export interface McpRegistryFetchOptions {
  /** Directory the cache file lives in (Electron passes app.getPath('userData')). */
  userDataDir: string
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
}

export class McpRegistryFetchService {
  static readonly CACHE_FILE_NAME = 'mcp-registry-cache.json'
  static readonly FETCH_TIMEOUT_MS = 10_000
  static readonly REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

  private readonly cachePath: string
  private readonly fetchFn: typeof fetch
  private lastResult: McpRegistryGetResult | null = null
  private inFlight: Promise<McpRegistryGetResult> | null = null
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(options: McpRegistryFetchOptions) {
    this.cachePath = join(options.userDataDir, McpRegistryFetchService.CACHE_FILE_NAME)
    // Bind so an injected bare `fetch` keeps its expected receiver.
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args))
  }

  /**
   * Current registry. The first call performs the remote fetch (lazy refresh
   * on app start); later calls serve the memoized result — the 24h interval
   * (startPeriodicRefresh) keeps it from going stale within a session.
   */
  async getRegistry(): Promise<McpRegistryGetResult> {
    if (this.lastResult) return this.lastResult
    return this.refresh()
  }

  /**
   * Fetch the remote document and update the memoized result, falling back
   * per the tier order above. Never rejects. Concurrent callers share one
   * fetch.
   */
  refresh(): Promise<McpRegistryGetResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.refreshFresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Re-fetch every 24h so a long-running app picks up registry updates. */
  startPeriodicRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      void this.refresh()
    }, McpRegistryFetchService.REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private async refreshFresh(): Promise<McpRegistryGetResult> {
    const cache = this.readCacheFile()
    try {
      const headers: Record<string, string> = {}
      if (cache?.etag) headers['If-None-Match'] = cache.etag
      const res = await this.fetchFn(MCP_REGISTRY_URL, {
        headers,
        signal: AbortSignal.timeout(McpRegistryFetchService.FETCH_TIMEOUT_MS)
      })

      if (res.status === 304 && cache) {
        // Not modified: the cached document IS the current remote content, so
        // it serves as source 'remote' — fetchedAt stays the timestamp of the
        // fetch that actually transferred the body.
        const parsed = this.parseWithWarning(cache.document, 'cached')
        if (parsed) {
          this.lastResult = {
            entries: parsed.entries,
            source: 'remote',
            updatedAt: parsed.updatedAt,
            fetchedAt: cache.fetchedAt
          }
          return this.lastResult
        }
        // ETag present but the cached body no longer parses — treat as a miss.
        return this.serveFallback(null)
      }

      if (!res.ok) {
        console.warn(`[McpRegistry] Remote registry fetch returned ${res.status} — falling back`)
        return this.serveFallback(cache)
      }

      const document: unknown = await res.json()
      const parsed = this.parseWithWarning(document, 'remote')
      if (!parsed) {
        console.warn('[McpRegistry] Remote registry document failed validation — falling back')
        return this.serveFallback(cache)
      }

      const fetchedAt = Date.now()
      this.writeCacheFile({ etag: res.headers.get('etag') ?? undefined, fetchedAt, document })
      this.lastResult = {
        entries: parsed.entries,
        source: 'remote',
        updatedAt: parsed.updatedAt,
        fetchedAt
      }
      return this.lastResult
    } catch (err) {
      console.warn('[McpRegistry] Remote registry fetch failed — falling back:', err instanceof Error ? err.message : err)
      return this.serveFallback(cache)
    }
  }

  /** Cached document if present and parseable, else the bundled registry. */
  private serveFallback(cache: RegistryCacheFile | null): McpRegistryGetResult {
    const parsed = cache ? this.parseWithWarning(cache.document, 'cached') : null
    this.lastResult = parsed
      ? { entries: parsed.entries, source: 'cache', updatedAt: parsed.updatedAt, fetchedAt: cache!.fetchedAt }
      : { entries: MCP_REGISTRY as McpRegistryEntry[], source: 'bundled', updatedAt: BUNDLED_REGISTRY_UPDATED_AT }
    return this.lastResult
  }

  /**
   * Validate a document, logging (not failing) when individual entries were
   * dropped — one bad upstream edit must never blank the registry.
   *
   * A structurally valid document with ZERO surviving entries is treated as
   * invalid (returns null): whether every entry failed the schema (a mass-bad
   * upstream edit) or the list was literally empty, the registry is never
   * intentionally empty — so the safer choice is to fall back (cache, then
   * bundled) rather than blank the UI and, on the remote path, overwrite the
   * previously good cache with an empty document.
   */
  private parseWithWarning(document: unknown, origin: 'remote' | 'cached'): ParsedMcpRegistryDocument | null {
    const parsed = parseMcpRegistryDocument(document)
    if (parsed && parsed.dropped > 0) {
      console.warn(`[McpRegistry] ${origin} registry document had ${parsed.dropped} invalid entr${parsed.dropped === 1 ? 'y' : 'ies'} (dropped)`)
    }
    if (parsed && parsed.entries.length === 0) {
      console.warn(`[McpRegistry] ${origin} registry document has no valid entries (${parsed.dropped} dropped) — treating it as invalid and falling back`)
      return null
    }
    return parsed
  }

  private readCacheFile(): RegistryCacheFile | null {
    try {
      if (!existsSync(this.cachePath)) return null
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as Partial<RegistryCacheFile>
      if (typeof raw !== 'object' || raw === null || typeof raw.fetchedAt !== 'number' || !('document' in raw)) return null
      return {
        etag: typeof raw.etag === 'string' ? raw.etag : undefined,
        fetchedAt: raw.fetchedAt,
        document: raw.document
      }
    } catch {
      // A corrupt cache is just a miss — the bundled copy always remains.
      return null
    }
  }

  private writeCacheFile(cache: RegistryCacheFile): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      writeJsonAtomic(this.cachePath, cache)
    } catch (err) {
      console.warn('[McpRegistry] Failed to persist registry cache:', err instanceof Error ? err.message : err)
    }
  }
}
