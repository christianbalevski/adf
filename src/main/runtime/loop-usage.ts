import type { LoopTokenUsage } from '../../shared/types/adf-v02.types'

/**
 * Token usage summed from the `tokens` column of loop rows — the one place
 * the daemon's /agents/:id/usage and the shell's `status` count it, so they
 * always agree. Rows only: compaction and clear delete rows (a compaction
 * leaves one summary row carrying its own call), and model_invoke or other
 * provider calls that don't write loop rows aren't counted.
 */

export interface RuntimeUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface RuntimeAgentUsageByModel extends RuntimeUsageTotals {
  model: string
  rows: number
}

export interface LoopUsageSummary {
  loopRows: number
  usageRows: number
  /** Rows whose figures are a char estimate, not provider-reported (see hasReportedUsage). */
  estimatedRows: number
  totals: RuntimeUsageTotals
  /** Largest total first. */
  byModel: RuntimeAgentUsageByModel[]
}

export function summarizeLoopUsage(entries: ReadonlyArray<{ model?: string | null; tokens?: LoopTokenUsage | null }>): LoopUsageSummary {
  const totals = createUsageTotals()
  const byModel = new Map<string, RuntimeAgentUsageByModel>()
  let usageRows = 0
  let estimatedRows = 0

  for (const entry of entries) {
    if (!entry.tokens) continue
    usageRows++
    if (!hasReportedUsage(entry.tokens)) estimatedRows++
    addUsage(totals, entry.tokens)
    const model = entry.model ?? 'unknown'
    let bucket = byModel.get(model)
    if (!bucket) {
      bucket = { model, rows: 0, ...createUsageTotals() }
      byModel.set(model, bucket)
    }
    bucket.rows++
    addUsage(bucket, entry.tokens)
  }

  return {
    loopRows: entries.length,
    usageRows,
    estimatedRows,
    totals,
    byModel: Array.from(byModel.values()).sort((a, b) => b.total - a.total),
  }
}

function createUsageTotals(): RuntimeUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addUsage(target: RuntimeUsageTotals, usage: LoopTokenUsage): void {
  target.input += usage.input ?? 0
  target.output += usage.output ?? 0
  target.cacheRead += usage.cache_read ?? 0
  target.cacheWrite += usage.cache_write ?? 0
  // `input` is the call's full prompt on every provider path, cache reads and
  // writes included (the figure the context breakdown calibrates to), so the
  // cache buckets are a breakdown of input, not an addition to it.
  target.total = target.input + target.output
}

/**
 * Whether a row's usage came from the provider. Every path that reports
 * usage records at least `cache_read` (0 when nothing was cached); a row
 * holding only input/output predates the `estimated` flag and was a char
 * estimate from a provider that reported nothing.
 */
export function hasReportedUsage(t: LoopTokenUsage): boolean {
  if (t.estimated) return false
  return t.cache_read !== undefined || t.cache_write !== undefined ||
    t.reasoning !== undefined || t.cost_usd !== undefined
}
