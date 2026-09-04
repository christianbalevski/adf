import { useState, useEffect, useMemo } from 'react'
import type { TokenUsageData } from '../../../shared/types/ipc.types'
import { Button, SegmentedControl } from '../ui'
import { UsageChart, SERIES_COLORS, MAX_NAMED_SERIES, formatTokensAxis, type ChartSeries, type UsageMetric } from './UsageChart'

/** Compact token count for inline cache annotations: 12345 → "12.3k". */
function formatTokensCompact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** `$0.0042`-style: 4 decimals below $1, 2 above. */
function formatUsdCompact(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

type TokenUsageEntry = TokenUsageData[string][string][string]

/** Sum cost across a set of usage entries; null when none of them carry cost. */
function sumCost(entries: TokenUsageEntry[]): number | null {
  let any = false
  let total = 0
  for (const e of entries) {
    if (e.cost_usd != null) {
      any = true
      total += e.cost_usd
    }
  }
  return any ? total : null
}

type WindowDays = '7' | '30' | '90'
const WINDOW_OPTIONS: { value: WindowDays; label: string }[] = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
]
const TICK_EVERY: Record<WindowDays, number> = { '7': 1, '30': 5, '90': 15 }

const OTHER_KEY = '__other__'

function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Continuous run of N local-date keys ending today (oldest first). */
function lastNDays(n: number): string[] {
  const out: string[] = []
  const today = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    out.push(localDateKey(d))
  }
  return out
}

function tokensOf(e: TokenUsageEntry): number {
  return e.input + e.output
}

interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number | null
}

function totalsOf(entries: TokenUsageEntry[]): Totals {
  const t: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }
  for (const e of entries) {
    t.input += e.input
    t.output += e.output
    t.cacheRead += e.cache_read ?? 0
    t.cacheWrite += e.cache_write ?? 0
  }
  t.cost = sumCost(entries)
  return t
}

function SummaryTotals({ t }: { t: Totals }) {
  return (
    <>
      {t.input.toLocaleString()} input + {t.output.toLocaleString()} output = {(t.input + t.output).toLocaleString()} tokens
      {(t.cacheRead > 0 || t.cacheWrite > 0) && (
        <> · cache {formatTokensCompact(t.cacheRead)} r / {formatTokensCompact(t.cacheWrite)} w</>
      )}
      {t.cost != null && <> · {formatUsdCompact(t.cost)}</>}
    </>
  )
}

export function TokenUsageSection() {
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData>({})
  const [windowDays, setWindowDays] = useState<WindowDays>('30')
  const [metric, setMetric] = useState<UsageMetric>('tokens')
  const [showBreakdown, setShowBreakdown] = useState(false)

  useEffect(() => {
    window.adfApi?.getTokenUsage().then((data) => {
      setTokenUsage(data)
    })
  }, [])

  const handleClear = async () => {
    if (!window.confirm('Are you sure you want to clear all token usage data? This cannot be undone.')) {
      return
    }
    await window.adfApi?.clearTokenUsage()
    setTokenUsage({})
  }

  const handleDownload = async () => {
    await window.adfApi?.saveTokenUsageExport?.(JSON.stringify(tokenUsage, null, 2))
  }

  const allDates = useMemo(() => Object.keys(tokenUsage).sort(), [tokenUsage])
  const allEntries = useMemo(
    () => allDates.flatMap((date) => Object.values(tokenUsage[date]).flatMap((models) => Object.values(models))),
    [allDates, tokenUsage],
  )
  const allTime = useMemo(() => totalsOf(allEntries), [allEntries])
  const hasCost = allTime.cost != null

  // Colour follows the entity: rank series by all-time tokens once, so toggling
  // window/metric never repaints the survivors. Rank > MAX_NAMED_SERIES folds to "Other".
  const seriesIndex = useMemo(() => {
    const totals = new Map<string, number>()
    const modelProviders = new Map<string, Set<string>>()
    for (const date of allDates) {
      for (const [provider, models] of Object.entries(tokenUsage[date])) {
        for (const [model, e] of Object.entries(models)) {
          const key = `${provider}/${model}`
          totals.set(key, (totals.get(key) ?? 0) + tokensOf(e))
          if (!modelProviders.has(model)) modelProviders.set(model, new Set())
          modelProviders.get(model)!.add(provider)
        }
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const named: ChartSeries[] = ranked.slice(0, MAX_NAMED_SERIES).map((key, i) => {
      const slash = key.indexOf('/')
      const provider = key.slice(0, slash)
      const model = key.slice(slash + 1)
      const unique = (modelProviders.get(model)?.size ?? 1) === 1
      return { key, label: unique ? model : `${provider}/${model}`, color: i }
    })
    const folded = ranked.slice(MAX_NAMED_SERIES)
    const keyToIdx = new Map<string, number>()
    named.forEach((s, i) => keyToIdx.set(s.key, i))
    if (folded.length > 0) {
      named.push({ key: OTHER_KEY, label: `Other (${folded.length})`, color: MAX_NAMED_SERIES })
      folded.forEach((k) => keyToIdx.set(k, named.length - 1))
    }
    return { series: named, keyToIdx }
  }, [allDates, tokenUsage])

  const days = useMemo(() => lastNDays(Number(windowDays)), [windowDays])
  const windowDateSet = useMemo(() => new Set(days), [days])

  const windowEntries = useMemo(
    () => days.filter((d) => tokenUsage[d]).flatMap((d) => Object.values(tokenUsage[d]).flatMap((models) => Object.values(models))),
    [days, tokenUsage],
  )
  const windowTotals = useMemo(() => totalsOf(windowEntries), [windowEntries])

  // values[day][series] in the active metric; series with zero across the window are dropped from the legend.
  const { series, values, seriesTotals } = useMemo(() => {
    const all = seriesIndex.series
    const full = days.map(() => all.map(() => 0))
    days.forEach((date, di) => {
      const providers = tokenUsage[date]
      if (!providers) return
      for (const [provider, models] of Object.entries(providers)) {
        for (const [model, e] of Object.entries(models)) {
          const si = seriesIndex.keyToIdx.get(`${provider}/${model}`)
          if (si == null) continue
          full[di][si] += metric === 'cost' ? (e.cost_usd ?? 0) : tokensOf(e)
        }
      }
    })
    const totals = all.map((_, si) => full.reduce((sum, row) => sum + row[si], 0))
    const keep = all.map((_, si) => totals[si] > 0)
    return {
      series: all.filter((_, si) => keep[si]),
      values: full.map((row) => row.filter((_, si) => keep[si])),
      seriesTotals: totals.filter((_, si) => keep[si]),
    }
  }, [days, tokenUsage, seriesIndex, metric])

  const fmtLegend = metric === 'cost' ? formatUsdCompact : formatTokensAxis
  const breakdownDates = useMemo(() => allDates.filter((d) => windowDateSet.has(d)).reverse(), [allDates, windowDateSet])

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Token Usage
        </label>
        {allDates.length > 0 && (
          <div className="flex items-center gap-2">
            {hasCost && (
              <SegmentedControl<UsageMetric>
                value={metric}
                onChange={setMetric}
                ariaLabel="Chart metric"
                options={[
                  { value: 'tokens', label: 'Tokens' },
                  { value: 'cost', label: 'Cost' },
                ]}
              />
            )}
            <SegmentedControl<WindowDays>
              value={windowDays}
              onChange={setWindowDays}
              ariaLabel="Time window"
              options={WINDOW_OPTIONS}
            />
          </div>
        )}
      </div>

      {allDates.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No token usage recorded yet.
        </p>
      ) : (
        <div className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
          <div className="mb-2 text-xs text-[var(--adf-ui-text-muted)]">
            <strong>Last {windowDays} days:</strong> <SummaryTotals t={windowTotals} />
            <span className="ml-2 text-[var(--adf-ui-text-subtle)]">
              All time {formatTokensAxis(allTime.input + allTime.output)} tokens
              {allTime.cost != null && <> · {formatUsdCompact(allTime.cost)}</>}
            </span>
          </div>

          <UsageChart
            days={days}
            series={series}
            values={values}
            metric={metric}
            tickEvery={TICK_EVERY[windowDays]}
          />

          {series.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {series.map((s, si) => (
                <span key={s.key} className="inline-flex items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${SERIES_COLORS[s.color].bg}`} />
                  <span className="text-[var(--adf-ui-text-muted)]">{s.label}</span>
                  <span className="tabular-nums text-[var(--adf-ui-text-subtle)]">{fmtLegend(seriesTotals[si])}</span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--adf-ui-separator)] pt-2">
            <Button variant="ghost" size="compact" onClick={() => setShowBreakdown(!showBreakdown)} aria-expanded={showBreakdown}>
              {showBreakdown ? 'Hide breakdown' : 'Show breakdown'}
            </Button>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="compact" onClick={handleDownload}>
                Download JSON
              </Button>
              <Button
                variant="ghost"
                size="compact"
                onClick={handleClear}
                className="text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-danger)]"
              >
                Clear history…
              </Button>
            </div>
          </div>

          {showBreakdown && (
            breakdownDates.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--adf-ui-text-subtle)]">No usage in the last {windowDays} days.</p>
            ) : (
              <div className="mt-2 space-y-3">
                {breakdownDates.map((date) => {
                  const dateCost = sumCost(Object.values(tokenUsage[date]).flatMap((models) => Object.values(models)))
                  return (
                    <div key={date} className="border-t border-[var(--adf-ui-separator)] pt-2">
                      <div className="mb-1 text-xs font-semibold text-[var(--adf-ui-text)]">
                        {date}
                        {dateCost != null && <span className="ml-2 font-normal text-[var(--adf-ui-text-muted)]">{formatUsdCompact(dateCost)}</span>}
                      </div>
                      {Object.entries(tokenUsage[date]).map(([provider, models]) => {
                        const providerCost = sumCost(Object.values(models))
                        return (
                          <div key={provider} className="ml-3 space-y-1">
                            <div className="text-xs font-medium text-[var(--adf-ui-text-muted)]">
                              {provider}
                              {providerCost != null && <span className="ml-2 font-normal text-[var(--adf-ui-text-subtle)]">{formatUsdCompact(providerCost)}</span>}
                            </div>
                            {Object.entries(models).map(([model, usage]) => (
                              <div key={model} className="ml-3 font-mono text-xs text-[var(--adf-ui-text-subtle)]">
                                {model}: {usage.input.toLocaleString()} in + {usage.output.toLocaleString()} out
                                {/* Inline extras keep the table compact — no columns that sit empty for most providers */}
                                {(usage.cache_read || usage.cache_write) ? (
                                  <> · cache {formatTokensCompact(usage.cache_read ?? 0)} r / {formatTokensCompact(usage.cache_write ?? 0)} w</>
                                ) : null}
                                {usage.cost_usd != null && <> · {formatUsdCompact(usage.cost_usd)}</>}
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
