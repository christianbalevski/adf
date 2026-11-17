import type { ReactNode } from 'react'
import { DocsLink } from './DocsLink'
import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../../../shared/types/subscription-usage.types'
import {
  SUBSCRIPTION_USAGE_PAGES,
  TONE_FILL,
  TONE_TEXT,
  formatPercent,
  subscriptionName,
  subscriptionStatusLine,
  subscriptionTitle,
  usageTone,
} from '../../utils/subscription-usage'
import { absoluteTime, relativeTime, timeUntil } from '../../utils/relative-time'

/** One quota window on one line: label, a bar of the used percent, the figure, time until reset. */
export function SubscriptionWindowBar({ window: w, now, dimmed = false }: { window: SubscriptionUsageWindow; now: number; dimmed?: boolean }) {
  const tone = usageTone(w.usedPercent, w.limited)
  const resetIn = timeUntil(w.resetsAt, now)
  return (
    <div className="grid grid-cols-[6.5rem_1fr_2.25rem_minmax(4.5rem,auto)] items-center gap-x-2 text-[11px]" data-usage-window={w.key}>
      <span className="truncate text-[var(--adf-ui-text-muted)]" title={w.label}>{w.label}</span>
      <span className="relative h-1.5 min-w-12 overflow-hidden rounded-full bg-neutral-300 dark:bg-neutral-600" aria-hidden="true">
        {w.usedPercent != null && (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${dimmed ? 'bg-neutral-400 dark:bg-neutral-500' : TONE_FILL[tone]}`}
            style={{ width: `${Math.max(0, Math.min(w.usedPercent, 100))}%` }}
          />
        )}
      </span>
      <span className={`text-right tabular-nums ${dimmed ? 'text-[var(--adf-ui-text-subtle)]' : TONE_TEXT[tone] || 'text-[var(--adf-ui-text)]'}`}>
        {formatPercent(w.usedPercent)}
      </span>
      <span
        className={`whitespace-nowrap text-right text-[10px] tabular-nums ${w.limited ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}
        title={w.resetsAt != null ? `Resets ${absoluteTime(w.resetsAt)}` : 'Reset time not reported'}
      >
        {w.limited ? 'Limit reached' : resetIn ? `Resets ${resetIn}` : ''}
      </span>
    </div>
  )
}

/**
 * One subscription: a header line (title and a link to the provider's own
 * usage page; credits, `meta` and freshness on the right), one line per
 * window, and a plain status line when not current (a quiet note when only a
 * later check failed).
 */
export function SubscriptionUsageCard({ snapshot: s, now, meta }: { snapshot: SubscriptionUsageSnapshot; now: number; meta?: ReactNode }) {
  const status = subscriptionStatusLine(s, now)
  const dimmed = s.status === 'stale' || s.status === 'signed_out'
  const problem = s.status === 'error' || (s.status === 'stale' && !!s.error)
  const credits = s.credits && (s.credits.balance != null || s.credits.hasCredits != null)
    ? s.credits.balance != null ? s.credits.balance.toLocaleString() : s.credits.hasCredits ? 'Available' : 'None'
    : null
  const details: { key: string; node: ReactNode; title?: string }[] = []
  if (credits != null) details.push({ key: 'credits', node: <>Credits <span className="tabular-nums text-[var(--adf-ui-text-muted)]">{credits}</span></> })
  if (meta) details.push({ key: 'meta', node: meta })
  if (s.observedAt != null) details.push({ key: 'updated', node: `Updated ${relativeTime(s.observedAt, now)}`, title: absoluteTime(s.observedAt) })
  return (
    <div className="space-y-1" data-subscription={s.provider}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span className={`text-xs font-medium ${s.status === 'signed_out' ? 'text-[var(--adf-ui-text-subtle)]' : 'text-[var(--adf-ui-text)]'}`}>{subscriptionTitle(s)}</span>
          <DocsLink href={SUBSCRIPTION_USAGE_PAGES[s.provider]} label={<span className="sr-only">{subscriptionName(s.provider)} usage page</span>} />
        </span>
        {details.length > 0 && (
          <span className="flex min-w-0 flex-wrap justify-end gap-x-1.5 text-[10px] text-[var(--adf-ui-text-subtle)]">
            {details.map((d, i) => (
              <span key={d.key} className="whitespace-nowrap" title={d.title}>
                {i > 0 && <span aria-hidden="true">· </span>}{d.node}
              </span>
            ))}
          </span>
        )}
      </div>
      {s.windows.map((w) => <SubscriptionWindowBar key={w.key} window={w} now={now} dimmed={dimmed} />)}
      {status && (
        <p className={`text-[11px] ${problem ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>{status}</p>
      )}
    </div>
  )
}
