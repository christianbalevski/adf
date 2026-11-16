import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../../../shared/types/subscription-usage.types'
import {
  TONE_FILL,
  TONE_TEXT,
  formatPercent,
  subscriptionStatusLine,
  subscriptionTitle,
  usageTone,
} from '../../utils/subscription-usage'
import { absoluteTime, relativeTime, timeUntil } from '../../utils/relative-time'

/** One quota window: label, a bar of the used percent, the figure, the reset time. */
export function SubscriptionWindowBar({ window: w, now, dimmed = false }: { window: SubscriptionUsageWindow; now: number; dimmed?: boolean }) {
  const tone = usageTone(w.usedPercent, w.limited)
  const resetIn = timeUntil(w.resetsAt, now)
  return (
    <div className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-x-2 gap-y-0.5 text-[11px]" data-usage-window={w.key}>
      <span className="truncate text-[var(--adf-ui-text-muted)]">{w.label}</span>
      <span className="relative h-1.5 min-w-16 overflow-hidden rounded-full bg-neutral-300 dark:bg-neutral-600" aria-hidden="true">
        {w.usedPercent != null && (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${dimmed ? 'bg-neutral-400 dark:bg-neutral-500' : TONE_FILL[tone]}`}
            style={{ width: `${Math.max(0, Math.min(w.usedPercent, 100))}%` }}
          />
        )}
      </span>
      <span className={`w-9 text-right tabular-nums ${dimmed ? 'text-[var(--adf-ui-text-subtle)]' : TONE_TEXT[tone] || 'text-[var(--adf-ui-text)]'}`}>
        {formatPercent(w.usedPercent)}
      </span>
      <span />
      <span className="col-span-2 text-[10px] text-[var(--adf-ui-text-subtle)]" title={w.resetsAt != null ? absoluteTime(w.resetsAt) : undefined}>
        {w.limited ? 'Limit reached' : ''}
        {w.limited && resetIn ? ' · ' : ''}
        {resetIn ? `Resets in ${resetIn}` : w.limited ? '' : 'Reset time –'}
      </span>
    </div>
  )
}

/** One subscription: title, its windows, credits, freshness, and a plain status line when not current (a quiet note when only a later check failed). */
export function SubscriptionUsageCard({ snapshot: s, now }: { snapshot: SubscriptionUsageSnapshot; now: number }) {
  const status = subscriptionStatusLine(s, now)
  const dimmed = s.status === 'stale' || s.status === 'signed_out'
  const problem = s.status === 'error' || (s.status === 'stale' && !!s.error)
  return (
    <div className="space-y-1.5" data-subscription={s.provider}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-xs font-medium ${s.status === 'signed_out' ? 'text-[var(--adf-ui-text-subtle)]' : 'text-[var(--adf-ui-text)]'}`}>{subscriptionTitle(s)}</span>
        {s.observedAt != null && (
          <span className="whitespace-nowrap text-[10px] text-[var(--adf-ui-text-subtle)]" title={absoluteTime(s.observedAt)}>
            Updated {relativeTime(s.observedAt, now)}
          </span>
        )}
      </div>
      {s.windows.map((w) => <SubscriptionWindowBar key={w.key} window={w} now={now} dimmed={dimmed} />)}
      {s.credits && (s.credits.balance != null || s.credits.hasCredits != null) && (
        <div className="text-[11px] text-[var(--adf-ui-text-muted)]">
          Credits <span className="tabular-nums text-[var(--adf-ui-text)]">
            {s.credits.balance != null ? s.credits.balance.toLocaleString() : s.credits.hasCredits ? 'Available' : 'None'}
          </span>
        </div>
      )}
      {status && (
        <p className={`text-[11px] ${problem ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>{status}</p>
      )}
    </div>
  )
}
