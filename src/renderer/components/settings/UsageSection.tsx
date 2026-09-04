import { useState, useEffect } from 'react'
import type { TokenUsageData } from '../../../shared/types/ipc.types'
import { Button } from '../ui'

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

export function TokenUsageSection() {
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData>({})
  const [expanded, setExpanded] = useState(false)

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

  const dates = Object.keys(tokenUsage).sort().reverse()
  const allEntries = dates.flatMap((date) =>
    Object.values(tokenUsage[date]).flatMap((models) => Object.values(models))
  )
  const totalInput = allEntries.reduce((sum, usage) => sum + usage.input, 0)
  const totalOutput = allEntries.reduce((sum, usage) => sum + usage.output, 0)
  const totalCost = sumCost(allEntries)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Token Usage
        </label>
        <div className="flex gap-2">
          {dates.length > 0 && (
            <Button
              onClick={handleClear}
              variant="danger"
              size="compact"
            >
              Clear
            </Button>
          )}
          {dates.length > 0 && (
            <Button
              onClick={() => setExpanded(!expanded)}
              variant="ghost"
              size="compact"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </div>
      </div>

      {dates.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No token usage recorded yet.
        </p>
      ) : (
        <div className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
          <div className="mb-2 text-xs text-[var(--adf-ui-text-muted)]">
            <strong>Total:</strong> {totalInput.toLocaleString()} input + {totalOutput.toLocaleString()} output = {(totalInput + totalOutput).toLocaleString()} tokens
            {totalCost != null && <> · {formatUsdCompact(totalCost)}</>}
          </div>

          {expanded && (
            <div className="space-y-3 mt-3">
              {dates.map((date) => {
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
          )}
        </div>
      )}
    </div>
  )
}
