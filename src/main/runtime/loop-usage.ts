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
  totals: RuntimeUsageTotals
  /** Largest total first. */
  byModel: RuntimeAgentUsageByModel[]
}

export function summarizeLoopUsage(entries: ReadonlyArray<{ model?: string | null; tokens?: LoopTokenUsage | null }>): LoopUsageSummary {
  const totals = createUsageTotals()
  const byModel = new Map<string, RuntimeAgentUsageByModel>()
  let usageRows = 0

  for (const entry of entries) {
    if (!entry.tokens) continue
    usageRows++
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
  // `input` is already cache-inclusive (AI SDK v6 reports inputTokens.total),
  // so cache buckets are a breakdown of input, not an addition to it.
  target.total = target.input + target.output
}
