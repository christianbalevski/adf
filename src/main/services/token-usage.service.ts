import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import { writeJsonAtomic, writeJsonAtomicAsync, readJsonOrQuarantine } from '../utils/atomic-json'
import { localDateKey } from '../../shared/utils/date-key'

/**
 * Token usage data structure:
 * {
 *   "2026-02-01": {
 *     "anthropic": {
 *       "claude-sonnet-4-5": { "input": 12345, "output": 6789 },
 *       "claude-opus-4": { "input": 8000, "output": 4000 }
 *     },
 *     "openai": {
 *       "gpt-4": { "input": 5000, "output": 3000 }
 *     }
 *   }
 * }
 */

/**
 * Optional per-call extras recorded alongside input/output totals.
 * All additive — files written before these fields existed load fine.
 */
export interface TokenUsageExtras {
  cache_read?: number
  cache_write?: number
  reasoning?: number
  cost_usd?: number
}

export interface TokenUsageData {
  [date: string]: {
    [provider: string]: {
      [model: string]: {
        input: number
        output: number
        cache_read?: number
        cache_write?: number
        reasoning?: number
        cost_usd?: number
      }
    }
  }
}

type UsageEntry = TokenUsageData[string][string][string]

const EXTRA_KEYS = ['cache_read', 'cache_write', 'reasoning', 'cost_usd'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Non-finite (NaN serialises to `null`, Infinity too) → 0 so sums never poison. */
function finiteOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Coerce whatever was on disk into a well-formed ledger. Non-object days,
 * providers, or models are dropped; numbers that are missing or non-finite
 * become 0. Optional extras stay absent when absent — files written before
 * those fields existed keep loading with the same shape.
 */
export function sanitizeUsageData(raw: unknown): TokenUsageData {
  const out: TokenUsageData = {}
  if (!isRecord(raw)) return out
  for (const [date, byProvider] of Object.entries(raw)) {
    if (!isRecord(byProvider)) continue
    const providers: TokenUsageData[string] = {}
    for (const [provider, byModel] of Object.entries(byProvider)) {
      if (!isRecord(byModel)) continue
      const models: TokenUsageData[string][string] = {}
      for (const [model, entry] of Object.entries(byModel)) {
        if (!isRecord(entry)) continue
        const clean: UsageEntry = { input: finiteOrZero(entry.input), output: finiteOrZero(entry.output) }
        for (const key of EXTRA_KEYS) {
          if (key in entry) clean[key] = finiteOrZero(entry[key])
        }
        models[model] = clean
      }
      providers[provider] = models
    }
    out[date] = providers
  }
  return out
}

/** Add one call's counts onto `data[date][provider][model]`, creating the path as needed. */
function addUsage(
  data: TokenUsageData,
  date: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  extras?: TokenUsageExtras
): void {
  const byProvider = (data[date] ??= {})
  const byModel = (byProvider[provider] ??= {})
  const entry = (byModel[model] ??= { input: 0, output: 0 })
  entry.input += inputTokens
  entry.output += outputTokens
  if (extras) {
    for (const key of EXTRA_KEYS) {
      const v = extras[key]
      if (v !== undefined) entry[key] = (entry[key] ?? 0) + v
    }
  }
}

/** Fold every entry of `delta` onto `target` (mutates and returns `target`). */
function mergeUsage(target: TokenUsageData, delta: TokenUsageData): TokenUsageData {
  for (const [date, byProvider] of Object.entries(delta)) {
    for (const [provider, byModel] of Object.entries(byProvider)) {
      for (const [model, e] of Object.entries(byModel)) {
        const { input, output, ...extras } = e
        addUsage(target, date, provider, model, input, output, extras)
      }
    }
  }
  return target
}

/**
 * Persistence model: Studio and the daemon both own `token-usage.json` in the
 * same user-data directory. Each process therefore never writes its in-memory
 * snapshot — that made the last writer win and let one process's flush undo
 * the other's clear. Instead every process keeps a `pending` DELTA of what it
 * recorded since its last flush; a flush re-reads the file fresh, adds the
 * delta onto it, writes the merged result, and adopts that as its own view.
 *
 * Day keys are the user's LOCAL calendar date (see `localDateKey`), matching
 * what the Usage chart and the home tile display. Rows written by versions
 * before this were keyed by the UTC date; they carry no time-of-day, so
 * nothing can re-bucket them — they stay where they are.
 */
export class TokenUsageService {
  private filePath: string
  private data: TokenUsageData = {}
  /** Recorded since the last successful flush; folded onto disk on save. */
  private pending: TokenUsageData = {}
  /** A clearAll that has not yet reached disk — the next save writes empty instead of merging. */
  private pendingClear = false
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** In-flight debounced write, so two timer ticks never overlap. */
  private asyncSave: Promise<boolean> | null = null
  /** Bumped by every synchronous save; an async save that sees a change while
   *  writing leaves the in-memory view to the synchronous one. */
  private saveGeneration = 0
  private static readonly SAVE_DEBOUNCE_MS = 5000

  constructor() {
    const userDataPath = getUserDataPath()
    this.filePath = join(userDataPath, 'token-usage.json')
    this.data = this.readDisk() ?? {}
  }

  /**
   * Fresh read of the ledger on disk, validated. A corrupt file is moved
   * aside by `readJsonOrQuarantine` and reads as empty. Returns null only in
   * the one case where the corrupt bytes could NOT be preserved — the caller
   * must then refuse to overwrite them.
   */
  private readDisk(): TokenUsageData | null {
    const result = readJsonOrQuarantine<unknown>(this.filePath)
    if (result.quarantinedTo) {
      console.error(`[TokenUsage] token-usage.json was unreadable; moved aside to ${result.quarantinedTo}`)
    }
    if (result.corruptUnpreserved) {
      console.error('[TokenUsage] token-usage.json is corrupt and could not be moved aside; leaving it untouched')
      return null
    }
    return sanitizeUsageData(result.data)
  }

  /**
   * Schedule a debounced save. Coalesces rapid writes into one disk I/O.
   */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) {
        this.dirty = false
        // Debounced flushes are never urgent — write off the main thread.
        void this.saveNowAsync().then((ok) => {
          // Keep the data dirty and try again on the next debounce window.
          if (!ok) this.scheduleSave()
        })
      }
    }, TokenUsageService.SAVE_DEBOUNCE_MS)
    // Never keep the process alive just for a pending usage flush
    ;(this.saveTimer as { unref?: () => void }).unref?.()
  }

  /**
   * Read the file fresh and fold the pending delta onto it. The delta is taken
   * out of `pending` here, so anything recorded while the write is still in
   * flight accumulates into a NEW delta instead of being written twice.
   * Returns null when the delta must not be written (corrupt file that could
   * not be preserved, or the read itself failed) — `pending` is then untouched.
   */
  private prepareSave(): { merged: TokenUsageData; delta: TokenUsageData; clearing: boolean } | null {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      let base: TokenUsageData
      if (this.pendingClear) {
        base = {}
      } else {
        const disk = this.readDisk()
        if (disk === null) return null
        base = disk
      }
      const delta = this.pending
      const clearing = this.pendingClear
      this.pending = {}
      this.pendingClear = false
      return { merged: mergeUsage(base, delta), delta, clearing }
    } catch (err) {
      console.error('[TokenUsage] Failed to save token usage data:', err)
      return null
    }
  }

  /** Adopt the written ledger as the live view, keeping anything recorded since. */
  private commitSave(merged: TokenUsageData): void {
    this.data = mergeUsage(merged, this.pending)
  }

  /** Put an unwritten delta back so a later attempt retries it. */
  private restoreDelta(delta: TokenUsageData, clearing: boolean): void {
    this.pending = mergeUsage(delta, this.pending)
    if (clearing) this.pendingClear = true
  }

  /**
   * Merge the pending delta onto a fresh read of the file and write the
   * result synchronously. Returns false on failure so callers can re-mark the
   * data dirty instead of silently dropping it; the delta is only discarded
   * once the merged file is safely on disk.
   *
   * Reserved for shutdown flushes and `clearAll`, where the bytes have to be
   * on disk before the call returns. Debounced saves use `saveNowAsync`.
   */
  private saveNow(): boolean {
    this.saveGeneration++
    const prepared = this.prepareSave()
    if (!prepared) return false
    try {
      writeJsonAtomic(this.filePath, prepared.merged)
    } catch (err) {
      console.error('[TokenUsage] Failed to save token usage data:', err)
      this.restoreDelta(prepared.delta, prepared.clearing)
      return false
    }
    this.commitSave(prepared.merged)
    return true
  }

  /**
   * Same merge, written off the main thread. Concurrent calls coalesce onto the
   * one in flight; `writeJsonAtomicAsync` additionally serializes per path, so
   * two writers can never interleave temp files.
   */
  private saveNowAsync(): Promise<boolean> {
    if (this.asyncSave) return this.asyncSave
    const run = this.runAsyncSave()
    this.asyncSave = run
    void run.then(
      () => { if (this.asyncSave === run) this.asyncSave = null },
      () => { if (this.asyncSave === run) this.asyncSave = null }
    )
    return run
  }

  private async runAsyncSave(): Promise<boolean> {
    const generation = this.saveGeneration
    const prepared = this.prepareSave()
    if (!prepared) return false
    try {
      await writeJsonAtomicAsync(this.filePath, prepared.merged)
    } catch (err) {
      console.error('[TokenUsage] Failed to save token usage data:', err)
      this.restoreDelta(prepared.delta, prepared.clearing)
      return false
    }
    // A synchronous flush/clear ran while this write was in flight: it is
    // authoritative for the in-memory view, so don't overwrite it here.
    if (generation !== this.saveGeneration) return true
    this.commitSave(prepared.merged)
    return true
  }

  /**
   * Flush pending writes immediately, synchronously. Call on app quit.
   *
   * A debounced async write that is already mid-rename when this runs owns the
   * delta it took; it completes on its own (or, if the process exits first,
   * costs at most one debounce window of counts — this ledger is analytics).
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.dirty) {
      this.dirty = false
      if (!this.saveNow()) {
        this.dirty = true
      }
    }
  }

  /**
   * Record token usage for a specific provider, model, and date.
   * `extras` (cache/reasoning tokens, USD cost) accumulate additively —
   * entries only gain the fields once a call actually reports them.
   */
  recordUsage(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    extras?: TokenUsageExtras
  ): void {
    const date = localDateKey()
    // Same increment onto the live view (what getUsageData/getSummary read
    // right now) and onto the delta that the next flush folds into the file.
    addUsage(this.data, date, provider, model, inputTokens, outputTokens, extras)
    addUsage(this.pending, date, provider, model, inputTokens, outputTokens, extras)

    // Debounced save to disk
    this.scheduleSave()
  }

  /**
   * Get all token usage data
   */
  getUsageData(): TokenUsageData {
    return this.data
  }

  /**
   * Get token usage for a specific date
   */
  getUsageByDate(date: string): TokenUsageData[string] | undefined {
    return this.data[date]
  }

  /**
   * Clear all token usage data
   */
  clearAll(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // Drop the unflushed delta too — a clear means "forget everything so far",
    // not "forget everything except the last five seconds".
    this.data = {}
    this.pending = {}
    this.pendingClear = true
    this.dirty = false
    if (!this.saveNow()) {
      this.scheduleSave() // retry the empty write later; pendingClear keeps it empty
    }
  }

  /**
   * Compact summary used by the home dashboard:
   *  - today's input/output totals across all providers/models
   *  - all-time input/output totals
   *  - top model (most cumulative tokens) all-time, with its total
   */
  getSummary(): {
    today: { input: number; output: number }
    allTime: { input: number; output: number }
    topModel: { provider: string; model: string; total: number } | null
  } {
    const today = localDateKey()
    const todayTotals = { input: 0, output: 0 }
    const allTimeTotals = { input: 0, output: 0 }
    // model key → { provider, model, total }
    const perModel = new Map<string, { provider: string; model: string; total: number }>()

    for (const [date, byProvider] of Object.entries(this.data)) {
      for (const [provider, byModel] of Object.entries(byProvider)) {
        for (const [model, { input, output }] of Object.entries(byModel)) {
          allTimeTotals.input += input
          allTimeTotals.output += output
          if (date === today) {
            todayTotals.input += input
            todayTotals.output += output
          }
          const key = `${provider}::${model}`
          const existing = perModel.get(key)
          const total = (existing?.total ?? 0) + input + output
          perModel.set(key, { provider, model, total })
        }
      }
    }

    let topModel: { provider: string; model: string; total: number } | null = null
    for (const entry of perModel.values()) {
      if (!topModel || entry.total > topModel.total) topModel = entry
    }

    return { today: todayTotals, allTime: allTimeTotals, topModel }
  }
}

// Singleton instance
let instance: TokenUsageService | null = null

export function getTokenUsageService(): TokenUsageService {
  if (!instance) {
    instance = new TokenUsageService()
  }
  return instance
}
