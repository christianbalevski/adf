import { useEffect, useRef, useState } from 'react'

/**
 * Categorical palette (dataviz reference instance, light/dark steps selected
 * per surface). Slot order is the CVD-safety mechanism — never reorder or
 * cycle. Slot 8 is reserved for the "Other" fold.
 */
export const SERIES_COLORS: { fill: string; bg: string }[] = [
  { fill: 'fill-[#2a78d6] dark:fill-[#3987e5]', bg: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  { fill: 'fill-[#eb6834] dark:fill-[#d95926]', bg: 'bg-[#eb6834] dark:bg-[#d95926]' },
  { fill: 'fill-[#1baf7a] dark:fill-[#199e70]', bg: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  { fill: 'fill-[#eda100] dark:fill-[#c98500]', bg: 'bg-[#eda100] dark:bg-[#c98500]' },
  { fill: 'fill-[#e87ba4] dark:fill-[#d55181]', bg: 'bg-[#e87ba4] dark:bg-[#d55181]' },
  { fill: 'fill-[#008300] dark:fill-[#008300]', bg: 'bg-[#008300] dark:bg-[#008300]' },
  { fill: 'fill-[#4a3aa7] dark:fill-[#9085e9]', bg: 'bg-[#4a3aa7] dark:bg-[#9085e9]' },
  { fill: 'fill-[#8b8b93] dark:fill-[#83838c]', bg: 'bg-[#8b8b93] dark:bg-[#83838c]' },
]
/** Named series beyond this count fold into "Other" (slot 8). */
export const MAX_NAMED_SERIES = SERIES_COLORS.length - 1

export interface ChartSeries {
  key: string
  label: string
  /** Index into SERIES_COLORS — fixed per entity, independent of window/metric. */
  color: number
}

export type UsageMetric = 'tokens' | 'cost'

export interface UsageChartProps {
  /** YYYY-MM-DD keys, oldest → newest, continuous. */
  days: string[]
  series: ChartSeries[]
  /** values[dayIndex][seriesIndex] in the current metric. */
  values: number[][]
  metric: UsageMetric
  /** Draw a date tick every N slots. */
  tickEvery: number
  height?: number
}

/** Abbreviated axis tick: 950 → "950", 12300 → "12.3k", 1_200_000 → "1.2M". */
export function formatTokensAxis(n: number): string {
  const abbr = (v: number, suffix: string) => `${v.toFixed(1).replace(/\.0$/, '')}${suffix}`
  if (n >= 1e9) return abbr(n / 1e9, 'B')
  if (n >= 1e6) return abbr(n / 1e6, 'M')
  if (n >= 1e3) return abbr(n / 1e3, 'k')
  return String(Math.round(n))
}

/** `$0.42` on the axis; sub-cent values keep two significant digits. */
export function formatUsdAxis(n: number): string {
  if (n === 0) return '$0'
  return `$${n >= 1 ? n.toFixed(2) : Number(n.toPrecision(2)).toString()}`
}

/** Round `raw` up to a 1 / 2 / 2.5 / 5 × 10^k step so gridlines land on clean values. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const frac = raw / base
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10
  return nice * base
}

function formatDateTick(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDateLong(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

const MARGIN = { top: 8, right: 8, bottom: 20, left: 44 }
const GRID_STEPS = 3
const BAR_MAX_WIDTH = 24
const SEGMENT_GAP = 2
const BAR_GAP = 2

export function UsageChart({ days, series, values, metric, tickEvery, height = 180 }: UsageChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fmt = metric === 'cost' ? formatUsdAxis : formatTokensAxis
  const fmtValue = metric === 'cost'
    ? (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)
    : (v: number) => v.toLocaleString()

  const dayTotals = values.map((row) => row.reduce((a, b) => a + b, 0))
  const maxTotal = dayTotals.reduce((a, b) => Math.max(a, b), 0)
  const step = niceStep(maxTotal / GRID_STEPS)
  const yMax = step * GRID_STEPS

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotH = height - MARGIN.top - MARGIN.bottom
  const baseline = MARGIN.top + plotH
  const n = days.length
  const slotW = n > 0 ? plotW / n : 0
  const barW = Math.max(1, Math.min(BAR_MAX_WIDTH, slotW - BAR_GAP))
  const yOf = (v: number) => baseline - (yMax > 0 ? (v / yMax) * plotH : 0)

  const hovered = hover != null ? { day: days[hover], row: values[hover], total: dayTotals[hover] } : null
  const tooltipLeft = hover != null ? MARGIN.left + (hover + 0.5) * slotW : 0
  const tooltipFlip = tooltipLeft > width / 2

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={`Daily ${metric === 'cost' ? 'cost' : 'token usage'} by model`}>
          {/* Gridlines + tick labels (recessive, hairline, solid) */}
          {Array.from({ length: GRID_STEPS }, (_, i) => {
            const v = step * (i + 1)
            const y = yOf(v)
            return (
              <g key={i}>
                <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y} y2={y} className="stroke-[var(--adf-ui-separator)]" strokeWidth={1} shapeRendering="crispEdges" />
                {maxTotal > 0 && (
                  <text x={MARGIN.left - 6} y={y} textAnchor="end" dominantBaseline="middle" className="fill-[var(--adf-ui-text-subtle)] text-[10px] tabular-nums">
                    {fmt(v)}
                  </text>
                )}
              </g>
            )
          })}
          <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={baseline} y2={baseline} className="stroke-[var(--adf-ui-separator)]" strokeWidth={1} shapeRendering="crispEdges" />

          {/* Bars, stacked by series; 2px surface gap between segments; top segment rounded */}
          {days.map((day, di) => {
            const cx = MARGIN.left + (di + 0.5) * slotW
            const x = cx - barW / 2
            const row = values[di]
            let cum = 0
            const segs: { si: number; y0: number; y1: number }[] = []
            row.forEach((v, si) => {
              if (v <= 0) return
              const y0 = yOf(cum)
              const y1 = yOf(cum + v)
              cum += v
              segs.push({ si, y0, y1 })
            })
            const isHover = hover === di
            return (
              <g key={day}>
                {isHover && (
                  <rect x={MARGIN.left + di * slotW} y={MARGIN.top} width={slotW} height={plotH} className="fill-[var(--adf-ui-surface-hover)]" />
                )}
                {segs.map((seg, k) => {
                  const isTop = k === segs.length - 1
                  const bottom = seg.y0 - (k > 0 ? SEGMENT_GAP : 0)
                  const h = bottom - seg.y1
                  if (h < 1) return null
                  const cls = SERIES_COLORS[series[seg.si].color].fill
                  if (!isTop) {
                    return <rect key={seg.si} x={x} y={seg.y1} width={barW} height={h} className={cls} />
                  }
                  const r = Math.min(4, barW / 2, h)
                  const d = `M${x},${seg.y1 + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${bottom} H${x} Z`
                  return <path key={seg.si} d={d} className={cls} />
                })}
                {/* Hit target spans the whole slot, full plot height */}
                <rect
                  x={MARGIN.left + di * slotW}
                  y={MARGIN.top}
                  width={Math.max(slotW, 1)}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(di)}
                  onMouseLeave={() => setHover((h) => (h === di ? null : h))}
                />
                {di % tickEvery === 0 && (
                  <text
                    x={cx}
                    y={height - 6}
                    textAnchor={di === 0 && slotW < 40 ? 'start' : 'middle'}
                    className="fill-[var(--adf-ui-text-subtle)] text-[10px]"
                  >
                    {formatDateTick(day)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-2 text-[11px] shadow-md ring-1 ring-inset ring-[var(--adf-ui-separator)]"
          style={{ left: tooltipLeft, transform: tooltipFlip ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          <div className="mb-1 font-medium text-[var(--adf-ui-text)]">{formatDateLong(hovered.day)}</div>
          {hovered.total === 0 ? (
            <div className="text-[var(--adf-ui-text-subtle)]">No usage</div>
          ) : (
            <>
              {series.map((s, si) => {
                const v = hovered.row[si]
                if (v <= 0) return null
                return (
                  <div key={s.key} className="flex items-center gap-2 whitespace-nowrap">
                    <span className={`h-0.5 w-3 shrink-0 rounded-full ${SERIES_COLORS[s.color].bg}`} />
                    <span className="min-w-0 flex-1 truncate text-[var(--adf-ui-text-muted)]">{s.label}</span>
                    <span className="tabular-nums text-[var(--adf-ui-text)]">{fmtValue(v)}</span>
                  </div>
                )
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-[var(--adf-ui-separator)] pt-1 text-[var(--adf-ui-text-muted)]">
                <span>Total</span>
                <span className="tabular-nums font-medium text-[var(--adf-ui-text)]">{fmtValue(hovered.total)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
