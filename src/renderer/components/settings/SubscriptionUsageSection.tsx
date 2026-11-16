import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TokenUsageData } from '../../../shared/types/ipc.types'
import type { SubscriptionProviderId, SubscriptionUsageSample, SubscriptionUsageSnapshot } from '../../../shared/types/subscription-usage.types'
import { Button } from '../ui'
import { MAX_NAMED_SERIES, SERIES_COLORS } from './UsageChart'
import { SubscriptionUsageCard } from '../common/SubscriptionUsageList'
import { useNow } from '../../hooks/useNow'
import { useSubscriptionProviderIds, useSubscriptionUsage } from '../../stores/subscription-usage.store'
import { subscriptionName, subscriptionTitle, subscriptionTokenTotals } from '../../utils/subscription-usage'
import { formatTokenCount } from '../../utils/token-estimate'
import { useSettingsApi, useSettingsRuntimeId } from './settings-runtime'
import { windowRuntime } from '../../utils/window-kind'

const DAY = 24 * 60 * 60 * 1000

/**
 * Settings → Usage, above the token chart: each signed-in subscription's
 * quota windows, their used percent over the selected days, and the tokens
 * agents spent through it. Signed-out subscriptions are listed dimmed, in one
 * line, so their absence is not mistaken for zero usage.
 */
export function SubscriptionUsageSection({ tokenUsage, days, windowDays }: { tokenUsage: TokenUsageData; days: string[]; windowDays: string }) {
  const api = useSettingsApi()
  // Keyed by runtime, so the status bar and Settings share one poll of the same runtime.
  const runtimeKey = useSettingsRuntimeId() ?? windowRuntime
  const usage = useSubscriptionUsage(runtimeKey, api)
  // Opening the section asks providers with an on-demand check (Codex) for fresh figures, unless automatic checks are off.
  const { refresh } = usage
  useEffect(() => { void refresh({ auto: true }) }, [refresh])
  const providerIds = useSubscriptionProviderIds(runtimeKey, api)
  const now = useNow()

  const snapshots = usage.state?.snapshots ?? []
  const shown = snapshots.filter((s) => s.status !== 'signed_out')
  const signedOut = snapshots.filter((s) => s.status === 'signed_out')

  const [history, setHistory] = useState<SubscriptionUsageSample[]>([])
  const since = useMemo(() => Date.now() - Number(windowDays) * DAY, [windowDays, usage.loadedAt])
  useEffect(() => {
    let cancelled = false
    api?.getSubscriptionUsageHistory?.({ since })
      .then((samples: SubscriptionUsageSample[]) => { if (!cancelled && Array.isArray(samples)) setHistory(samples) })
      .catch(() => { /* keep the last history */ })
    return () => { cancelled = true }
  }, [api, since])

  const tokens = useMemo(() => subscriptionTokenTotals(tokenUsage, days, providerIds), [tokenUsage, days, providerIds])

  // Nothing to say until the runtime answers; an older runtime without the feature says nothing at all.
  if (!usage.state) return null

  return (
    <div className="mb-5" data-subscription-usage="">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Subscriptions</label>
        {shown.length > 0 && (
          <Button variant="ghost" size="compact" loading={usage.refreshing} onClick={() => void usage.refresh()}>
            Refresh
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-[var(--adf-ui-text-subtle)]">No subscription is signed in.</p>
      ) : (
        <div className="space-y-3 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
          {shown.map((s, i) => (
            <div key={s.provider} className={i > 0 ? 'border-t border-[var(--adf-ui-separator)] pt-3' : undefined}>
              <SubscriptionUsageCard snapshot={s} now={now} />
              <SubscriptionHistoryChart snapshot={s} samples={history} since={since} now={now} />
              <TokensLine provider={s.provider} totals={tokens[s.provider]} windowDays={windowDays} />
            </div>
          ))}
        </div>
      )}

      {signedOut.length > 0 && (
        <p className="mt-1.5 text-[11px] text-[var(--adf-ui-text-subtle)]">
          Not signed in: {signedOut.map((s) => subscriptionName(s.provider)).join(', ')}
        </p>
      )}
    </div>
  )
}

function TokensLine({ provider, totals, windowDays }: { provider: SubscriptionProviderId; totals?: { input: number; output: number }; windowDays: string }) {
  return (
    <div className="mt-2 text-[11px] text-[var(--adf-ui-text-muted)]" data-subscription-tokens={provider}>
      Agent tokens, last {windowDays} days{' '}
      {totals ? (
        <span className="tabular-nums text-[var(--adf-ui-text)]" title={`${totals.input.toLocaleString()} in + ${totals.output.toLocaleString()} out`}>
          {formatTokenCount(totals.input + totals.output)}
          <span className="text-[var(--adf-ui-text-subtle)]"> ({formatTokenCount(totals.input)} in · {formatTokenCount(totals.output)} out)</span>
        </span>
      ) : (
        <span className="tabular-nums text-[var(--adf-ui-text)]">–</span>
      )}
    </div>
  )
}

const MARGIN = { top: 6, right: 8, bottom: 18, left: 32 }
const HEIGHT = 96

/**
 * Used percent over time, one line per window of a subscription, 0–100 on
 * the y axis. Only reported samples are drawn; gaps between them are lines,
 * not invented points. Hover shows the nearest sample of each window.
 */
function SubscriptionHistoryChart({ snapshot, samples, since, now }: { snapshot: SubscriptionUsageSnapshot; samples: SubscriptionUsageSample[]; since: number; now: number }) {
  const [width, setWidth] = useState(0)
  const [hoverT, setHoverT] = useState<number | null>(null)
  // A callback ref: the wrapper mounts only once samples arrive, which can be after this component does.
  const wrapRef = useCallback((el: HTMLDivElement) => {
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const series = useMemo(() => {
    const byWindow = new Map<string, SubscriptionUsageSample[]>()
    for (const sample of samples) {
      if (sample.provider !== snapshot.provider || sample.t < since) continue
      const list = byWindow.get(sample.window) ?? []
      list.push(sample)
      byWindow.set(sample.window, list)
    }
    // Colour by the window's place in the snapshot, so a window keeps its colour across redraws;
    // past the named slots it wraps, never taking the slot reserved for "Other".
    const order = snapshot.windows.map((w) => w.key)
    for (const key of byWindow.keys()) if (!order.includes(key)) order.push(key)
    return order
      .filter((key) => byWindow.has(key))
      .map((key) => ({
        key,
        label: snapshot.windows.find((w) => w.key === key)?.label ?? key,
        color: order.indexOf(key) % MAX_NAMED_SERIES,
        points: byWindow.get(key)!.sort((a, b) => a.t - b.t),
      }))
  }, [samples, snapshot, since])

  if (series.length === 0) return null

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
  // The axis starts at the first sample, not the token chart's whole range: quota windows are hours to a week long.
  const start = Math.max(since, Math.min(...series.map((s) => s.points[0].t)))
  const span = Math.max(1, now - start)
  const xOf = (t: number) => MARGIN.left + ((t - start) / span) * plotW
  const yOf = (v: number) => MARGIN.top + plotH - (Math.max(0, Math.min(v, 100)) / 100) * plotH
  const nearest = (pts: SubscriptionUsageSample[], t: number) =>
    pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), pts[0])

  const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="mt-2" data-subscription-history={snapshot.provider}>
      <div ref={wrapRef} className="relative w-full select-none">
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            className="block overflow-visible"
            role="img"
            aria-label={`${subscriptionTitle(snapshot)}: used percent over time`}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              if (x < MARGIN.left || x > MARGIN.left + plotW) { setHoverT(null); return }
              setHoverT(start + ((x - MARGIN.left) / Math.max(1, plotW)) * span)
            }}
            onMouseLeave={() => setHoverT(null)}
          >
            {[50, 100].map((v) => (
              <g key={v}>
                <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={yOf(v)} y2={yOf(v)} className="stroke-[var(--adf-ui-separator)]" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={MARGIN.left - 6} y={yOf(v)} textAnchor="end" dominantBaseline="middle" className="fill-[var(--adf-ui-text-subtle)] text-[10px] tabular-nums">{v}%</text>
              </g>
            ))}
            <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={yOf(0)} y2={yOf(0)} className="stroke-[var(--adf-ui-separator)]" strokeWidth={1} shapeRendering="crispEdges" />
            <text x={MARGIN.left} y={HEIGHT - 4} className="fill-[var(--adf-ui-text-subtle)] text-[10px]">{fmtDate(start)}</text>
            <text x={MARGIN.left + plotW} y={HEIGHT - 4} textAnchor="end" className="fill-[var(--adf-ui-text-subtle)] text-[10px]">Now</text>
            {series.map((s) => {
              return s.points.length === 1
                ? <circle key={s.key} cx={xOf(s.points[0].t)} cy={yOf(s.points[0].usedPercent)} r={2} className={SERIES_COLORS[s.color].fill} />
                : <polyline key={s.key} fill="none" strokeWidth={1.5} strokeLinejoin="round" className={SERIES_COLORS[s.color].stroke} points={s.points.map((p) => `${xOf(p.t)},${yOf(p.usedPercent)}`).join(' ')} />
            })}
            {hoverT != null && (
              <line x1={xOf(hoverT)} x2={xOf(hoverT)} y1={MARGIN.top} y2={MARGIN.top + plotH} className="stroke-[var(--adf-ui-text-subtle)]" strokeWidth={1} shapeRendering="crispEdges" />
            )}
          </svg>
        )}
        {hoverT != null && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-2 text-[11px] shadow-md ring-1 ring-inset ring-[var(--adf-ui-separator)]"
            style={{ left: xOf(hoverT), transform: xOf(hoverT) > width / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
          >
            {series.map((s) => {
              const p = nearest(s.points, hoverT)
              return (
                <div key={s.key} className="flex items-center gap-2 whitespace-nowrap">
                  <span className={`h-0.5 w-3 shrink-0 rounded-full ${SERIES_COLORS[s.color].bg}`} />
                  <span className="min-w-0 flex-1 truncate text-[var(--adf-ui-text-muted)]">{s.label}</span>
                  <span className="tabular-nums text-[var(--adf-ui-text)]">{Math.round(p.usedPercent)}%</span>
                  <span className="text-[var(--adf-ui-text-subtle)]">{new Date(p.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${SERIES_COLORS[s.color].bg}`} />
              <span className="text-[var(--adf-ui-text-muted)]">{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
