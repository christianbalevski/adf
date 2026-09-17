/**
 * Agent Registry Service
 *
 * The registry is a folder of `.adf` files plus one `index.json`
 * (`registry/` at the repo root). The files are the agents — nothing is
 * generated from source folders, and nothing is decomposed. This service
 * answers two questions for the home screen gallery:
 *
 *  1. Which agents can the user bring home right now? The copies bundled
 *     with this build, always, plus anything the live index on GitHub lists
 *     that this build does not ship (downloaded on demand).
 *  2. Where is the file for one of them? A bundled path, or a verified
 *     download in <userData>/agent-registry-files.
 *
 * Trust: a registry agent carries lambdas and enabled tools, so it is code.
 * The sha256 in the index only proves a download arrived intact — it does
 * not vouch for the origin. The trust boundary stays where it is for every
 * other .adf: the review dialog the user reads before Claim & Run.
 *
 * Runtime-agnostic: no 'electron' import. The bundled directory, the cache
 * directory, the app version and fetch are injected.
 */

import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  compareAppVersions,
  parseAgentRegistryIndex,
  type AgentRegistryEntry,
  type AgentRegistryIndex,
} from '../../shared/schemas/agent-registry.schema'
import type { AgentRegistryAgentView, AgentRegistryGetResult } from '../../shared/types/ipc.types'
import { guardedFetch, isFetchFailure, type GuardedFetchResult } from '../utils/guarded-fetch'
import { writeJsonAtomic } from '../utils/atomic-json'

export const AGENT_REGISTRY_BASE_URL = 'https://raw.githubusercontent.com/christianbalevski/adf/main/registry/'
export const AGENT_REGISTRY_INDEX_URL = `${AGENT_REGISTRY_BASE_URL}index.json`

/** An index is a few KB; anything approaching this is not an index. */
const MAX_INDEX_BYTES = 512 * 1024
/** Ceiling on a single registry agent, regardless of what the index claims. */
const MAX_AGENT_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/**
 * How long a failed index fetch stands before `getRegistry()` tries again.
 * Without it the first launch of an offline session would latch the app into
 * bundled-only until restart, even once the network comes back.
 */
export const REFRESH_RETRY_MS = 60_000

interface CacheFile {
  fetchedAt: number
  document: unknown
}

export interface AgentRegistryServiceOptions {
  /** Directory holding the bundled index.json + .adf files. May not exist (dev tree without registry). */
  bundledDir: string
  /** Directory for the index cache and downloaded files (Electron passes app.getPath('userData')). */
  userDataDir: string
  /** This build's version, for min_app_version gating. */
  appVersion: string
  /** Injectable for tests; defaults to guardedFetch. */
  fetchFn?: (url: string, opts: { maxBytes: number; timeoutMs: number }) => Promise<GuardedFetchResult>
  /** Injectable clock for tests. */
  now?: () => number
  /**
   * True when this build is supposed to ship a bundled registry (Electron
   * passes `app.isPackaged`). A packaged build with no `index.json` next to
   * the app is a packaging fault, not a dev tree — it is reported instead of
   * rendering a silently empty gallery. Defaults to false.
   */
  expectBundled?: boolean
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class AgentRegistryService {
  static readonly CACHE_FILE_NAME = 'agent-registry-cache.json'
  static readonly FILES_DIR_NAME = 'agent-registry-files'

  private readonly bundledDir: string
  private readonly cachePath: string
  private readonly filesDir: string
  private readonly appVersion: string
  private readonly fetchFn: NonNullable<AgentRegistryServiceOptions['fetchFn']>
  private readonly now: () => number
  private readonly expectBundled: boolean

  private remote: { index: AgentRegistryIndex; fetchedAt: number; source: 'remote' | 'cache' } | null = null
  private remoteError: string | undefined
  private inFlight: Promise<void> | null = null
  private refreshedOnce = false
  /** Whether the last completed fetch attempt failed, and when it started. */
  private lastAttemptFailed = false
  private lastAttemptAt = 0
  /** Bundled files never change at runtime, so the index is parsed once. */
  private bundledCache: AgentRegistryIndex | null = null
  private bundledError: string | undefined

  constructor(options: AgentRegistryServiceOptions) {
    this.bundledDir = options.bundledDir
    this.cachePath = join(options.userDataDir, AgentRegistryService.CACHE_FILE_NAME)
    this.filesDir = join(options.userDataDir, AgentRegistryService.FILES_DIR_NAME)
    this.appVersion = options.appVersion
    this.fetchFn = options.fetchFn ?? ((url, opts) => guardedFetch(url, opts))
    this.now = options.now ?? (() => Date.now())
    this.expectBundled = options.expectBundled ?? false
  }

  // ---------------------------------------------------------------------------
  // Bundled
  // ---------------------------------------------------------------------------

  /**
   * The index shipped with this build, restricted to entries whose file is
   * actually present. A missing bundled index is an empty registry, not a
   * throw — but it is only *silent* in a dev tree: with `expectBundled` it
   * records a `bundledError` that `compose()` surfaces.
   *
   * Cached: bundled files cannot change while the app runs, so the parse,
   * the per-entry `existsSync` and the warnings happen once.
   */
  readBundled(): AgentRegistryIndex {
    if (this.bundledCache) return this.bundledCache
    this.bundledCache = this.loadBundled()
    return this.bundledCache
  }

  private loadBundled(): AgentRegistryIndex {
    const empty: AgentRegistryIndex = { version: 1, updated_at: '1970-01-01', agents: [] }
    const indexPath = join(this.bundledDir, 'index.json')
    if (!existsSync(indexPath)) {
      if (this.expectBundled) this.bundledError = `Bundled registry missing at ${this.bundledDir}`
      return empty
    }
    let document: unknown
    try {
      document = JSON.parse(readFileSync(indexPath, 'utf-8'))
    } catch (err) {
      console.warn('[AgentRegistry] Bundled index.json is unreadable:', err)
      this.bundledError = `Bundled registry index at ${indexPath} is unreadable`
      return empty
    }
    const parsed = parseAgentRegistryIndex(document)
    if (!parsed) {
      console.warn('[AgentRegistry] Bundled index.json is not a registry index')
      this.bundledError = `Bundled registry index at ${indexPath} is not a registry index`
      return empty
    }
    if (parsed.dropped > 0) console.warn(`[AgentRegistry] Bundled index: ${parsed.dropped} malformed entr${parsed.dropped === 1 ? 'y' : 'ies'} dropped`)
    const agents = parsed.index.agents.filter((entry) => {
      const present = existsSync(join(this.bundledDir, entry.file))
      if (!present) console.warn(`[AgentRegistry] Bundled index lists ${entry.file} but the file is not shipped — hidden`)
      return present
    })
    return { ...parsed.index, agents }
  }

  bundledFilePath(entry: AgentRegistryEntry): string {
    return join(this.bundledDir, entry.file)
  }

  // ---------------------------------------------------------------------------
  // Remote index
  // ---------------------------------------------------------------------------

  /**
   * Gallery view: bundled entries always, live entries layered on top. The
   * first call kicks off one remote fetch; later calls reuse it. Never
   * rejects — the bundled gallery renders even with no network.
   */
  async getRegistry(): Promise<AgentRegistryGetResult> {
    if (this.shouldAutoFetch()) await (this.inFlight ?? this.startRefresh())
    return this.compose()
  }

  /**
   * First call always fetches. After that only a *failed* attempt is retried,
   * and not before the backoff has elapsed — so an offline launch is not
   * latched into bundled-only for the rest of the session, and a healthy
   * session does not re-fetch on every gallery render.
   */
  private shouldAutoFetch(): boolean {
    if (!this.refreshedOnce) return true
    if (!this.lastAttemptFailed) return false
    return this.now() - this.lastAttemptAt >= REFRESH_RETRY_MS
  }

  /**
   * Explicit re-fetch (the gallery's Refresh button): always performs a fetch
   * that starts no earlier than now. A fetch already in flight was started
   * before the user pressed the button, so this chains a fresh one behind it
   * rather than handing back its result.
   */
  refresh(): Promise<void> {
    const pending = this.inFlight
    if (!pending) return this.startRefresh()
    return pending.then(
      () => this.startRefresh(),
      () => this.startRefresh()
    )
  }

  private startRefresh(): Promise<void> {
    const run: Promise<void> = this.refreshRemote().finally(() => {
      this.refreshedOnce = true
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async refreshRemote(): Promise<void> {
    this.lastAttemptAt = this.now()
    this.lastAttemptFailed = true
    let body: GuardedFetchResult
    try {
      body = await this.fetchFn(AGENT_REGISTRY_INDEX_URL, { maxBytes: MAX_INDEX_BYTES, timeoutMs: FETCH_TIMEOUT_MS })
    } catch (err) {
      body = { error: err instanceof Error ? err.message : String(err) }
    }
    if (isFetchFailure(body)) {
      this.remoteError = body.error
      this.loadCache()
      return
    }
    let document: unknown
    try {
      document = JSON.parse(body.bytes.toString('utf-8'))
    } catch {
      this.remoteError = 'Live index is not valid JSON'
      this.loadCache()
      return
    }
    const parsed = parseAgentRegistryIndex(document)
    if (!parsed) {
      this.remoteError = 'Live index is not a registry index'
      this.loadCache()
      return
    }
    if (parsed.dropped > 0) console.warn(`[AgentRegistry] Live index: ${parsed.dropped} malformed entr${parsed.dropped === 1 ? 'y' : 'ies'} dropped`)
    const fetchedAt = this.now()
    this.remote = { index: parsed.index, fetchedAt, source: 'remote' }
    this.remoteError = undefined
    this.lastAttemptFailed = false
    try {
      mkdirSync(this.filesDir, { recursive: true })
      writeJsonAtomic(this.cachePath, { fetchedAt, document } satisfies CacheFile)
    } catch (err) {
      console.warn('[AgentRegistry] Could not write index cache:', err)
    }
  }

  private loadCache(): void {
    if (this.remote) return
    if (!existsSync(this.cachePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as CacheFile
      const parsed = parseAgentRegistryIndex(raw?.document)
      if (parsed && typeof raw.fetchedAt === 'number') {
        this.remote = { index: parsed.index, fetchedAt: raw.fetchedAt, source: 'cache' }
      }
    } catch {
      /* a broken cache is the same as no cache */
    }
  }

  private supported(entry: AgentRegistryEntry): boolean {
    return !entry.min_app_version || compareAppVersions(this.appVersion, entry.min_app_version) >= 0
  }

  /**
   * Bundled wins unless the live index carries a strictly newer `version` of
   * the same id AND this build can open it — a remote entry that needs a
   * newer Studio must never hide the working bundled copy. Ids only in the
   * live index are 'remote' whether or not they are supported: the gallery
   * shows them greyed out with `supported: false`, which is honest.
   */
  private merged(): { entry: AgentRegistryEntry; source: 'bundled' | 'remote' }[] {
    const bundled = this.readBundled()
    const out = new Map<string, { entry: AgentRegistryEntry; source: 'bundled' | 'remote' }>()
    for (const entry of bundled.agents) out.set(entry.id, { entry, source: 'bundled' })
    if (this.remote) {
      for (const entry of this.remote.index.agents) {
        const existing = out.get(entry.id)
        if (!existing) {
          out.set(entry.id, { entry, source: 'remote' })
          continue
        }
        if (entry.version > existing.entry.version && this.supported(entry)) {
          out.set(entry.id, { entry, source: 'remote' })
        }
      }
    }
    return [...out.values()]
  }

  private compose(): AgentRegistryGetResult {
    const bundled = this.readBundled()
    const agents: AgentRegistryAgentView[] = this.merged().map(({ entry, source }) => ({
      ...entry,
      source,
      supported: this.supported(entry),
    }))
    // With no live index at all, a broken/absent bundled registry is the
    // fault worth showing — it is why the gallery is empty. `remoteError` is
    // the only error channel this result has, so it carries the message.
    const error = !this.remote && this.bundledError ? this.bundledError : this.remoteError
    return {
      agents,
      indexSource: this.remote?.source ?? 'bundled',
      updatedAt: this.remote?.index.updated_at ?? bundled.updated_at,
      ...(this.remote ? { fetchedAt: this.remote.fetchedAt } : {}),
      ...(error ? { remoteError: error } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /**
   * Path to a readable copy of the agent's .adf: the bundled file, or a
   * download verified against the index hash. Throws with a plain message on
   * any failure — the caller surfaces it, nothing is inferred.
   */
  async resolveFile(id: string): Promise<{ path: string; entry: AgentRegistryEntry; source: 'bundled' | 'remote' }> {
    const match = this.merged().find((m) => m.entry.id === id)
    if (!match) throw new Error(`Registry has no agent "${id}"`)
    if (!this.supported(match.entry)) {
      throw new Error(`"${match.entry.name}" needs ADF Studio ${match.entry.min_app_version} or newer (this is ${this.appVersion})`)
    }
    if (match.source === 'bundled') {
      return { path: this.bundledFilePath(match.entry), entry: match.entry, source: 'bundled' }
    }
    return { path: await this.download(match.entry), entry: match.entry, source: 'remote' }
  }

  /** Where a verified download of this entry lives (content-addressed, so a re-listed file re-downloads). */
  private downloadPath(entry: AgentRegistryEntry): string {
    return join(this.filesDir, `${entry.id}-${entry.sha256.slice(0, 16)}.adf`)
  }

  private async download(entry: AgentRegistryEntry): Promise<string> {
    const dest = this.downloadPath(entry)
    if (existsSync(dest)) {
      try {
        if (sha256Hex(readFileSync(dest)) === entry.sha256) return dest
      } catch { /* re-download below */ }
      try { unlinkSync(dest) } catch { /* ignore */ }
    }
    if (entry.size > MAX_AGENT_BYTES) throw new Error(`"${entry.name}" is larger than the ${MAX_AGENT_BYTES / (1024 * 1024)} MB download limit`)
    const url = `${AGENT_REGISTRY_BASE_URL}${encodeURIComponent(entry.file)}`
    let body: GuardedFetchResult
    try {
      body = await this.fetchFn(url, { maxBytes: entry.size, timeoutMs: DOWNLOAD_TIMEOUT_MS })
    } catch (err) {
      body = { error: err instanceof Error ? err.message : String(err) }
    }
    if (isFetchFailure(body)) throw new Error(`Download failed: ${body.error}`)
    if (body.bytes.length !== entry.size) {
      throw new Error(`Download of "${entry.name}" is ${body.bytes.length} bytes, the index says ${entry.size}`)
    }
    const actual = sha256Hex(body.bytes)
    if (actual !== entry.sha256) throw new Error(`Download of "${entry.name}" does not match the index hash — not used`)
    mkdirSync(this.filesDir, { recursive: true })
    // Random suffix: two concurrent resolves of the same entry would otherwise
    // write the same `${dest}.partial` and rename each other's half-file.
    const partial = `${dest}.${randomBytes(6).toString('hex')}.partial`
    try {
      writeFileSync(partial, body.bytes)
      renameSync(partial, dest)
    } catch (err) {
      try { unlinkSync(partial) } catch { /* ignore */ }
      throw err
    }
    return dest
  }
}
