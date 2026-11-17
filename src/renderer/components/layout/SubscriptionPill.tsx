import { useRef, useState } from 'react'
import type { AdfApi } from '../../../preload/api'
import type { SubscriptionProviderId, SubscriptionUsageSnapshot } from '../../../shared/types/subscription-usage.types'
import { Tooltip } from '../common/Tooltip'
import { ContextMenu } from '../common/ContextMenu'
import { SubscriptionUsageCard } from '../common/SubscriptionUsageList'
import { useNow } from '../../hooks/useNow'
import { useSubscriptionProviderIds, useSubscriptionUsage } from '../../stores/subscription-usage.store'
import { useAppStore } from '../../stores/app.store'
import { requestSettingsRuntime } from '../../stores/settings-runtime.store'
import { timeUntil } from '../../utils/relative-time'
import { TONE_STROKE, formatPercent, subscriptionStatusLine, subscriptionTitle, tightestWindow, usageTone } from '../../utils/subscription-usage'

const RING_R = 5.5
const RING_C = 2 * Math.PI * RING_R

/**
 * Beside the context gauge while the open agent's model runs on a
 * subscription: a ring filled to that subscription's tightest window's used
 * percent, green, amber from 80%, red from 95%. The figures are in the
 * tooltip; a click lists every subscription's windows and links to
 * Settings → Usage. Nothing for an API-key provider, which never polls.
 */
export function SubscriptionPill({ providerId, runtimeId, api }: { providerId: string | undefined; runtimeId: string; api: AdfApi | undefined }) {
  const ids = useSubscriptionProviderIds(runtimeId, api, providerId)
  const subscription = providerId ? ids[providerId] : undefined
  return subscription ? <UsagePill subscription={subscription} runtimeId={runtimeId} api={api} /> : null
}

function UsagePill({ subscription, runtimeId, api }: { subscription: SubscriptionProviderId; runtimeId: string; api: AdfApi | undefined }) {
  const usage = useSubscriptionUsage(runtimeId, api)
  const now = useNow()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)

  // Nothing until the runtime answers; an older runtime without the feature shows nothing at all.
  if (!usage.state) return null

  const snapshot: SubscriptionUsageSnapshot | undefined = usage.state.snapshots.find((s) => s.provider === subscription)
  const title = subscriptionTitle(snapshot ?? { provider: subscription })
  const tight = snapshot && snapshot.status !== 'signed_out' ? tightestWindow(snapshot.windows) : null
  const used = tight?.usedPercent
  const tone = tight ? usageTone(tight.usedPercent, tight.limited) : 'normal'
  const stale = snapshot?.status === 'stale'

  const windows = snapshot && snapshot.status !== 'signed_out' ? snapshot.windows : []
  const tip = [
    title,
    ...windows.map((w) => {
      const resetIn = timeUntil(w.resetsAt, now)
      return `${w.label}: ${formatPercent(w.usedPercent)} used${w.limited ? ', limit reached' : ''}${resetIn ? `, resets in ${resetIn}` : ''}`
    }),
    (snapshot && subscriptionStatusLine(snapshot, now)) ?? (windows.length === 0 ? 'No usage figures reported' : null),
  ].filter(Boolean).join('\n')

  const toggle = () => {
    if (open) { setOpen(null); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    setOpen(rect ? { x: rect.left, y: rect.top - 6 } : { x: 0, y: 0 })
    // Opening asks providers with an on-demand check (Codex) for fresh figures, unless automatic checks are off.
    void usage.refresh({ auto: true })
  }

  const listed = usage.state.snapshots.filter((s) => s.status !== 'signed_out')

  return (
    <>
      <Tooltip tip={tip} className="flex" disabled={open !== null}>
        <button
          ref={buttonRef}
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open !== null}
          aria-label={`${title} usage: ${tight ? `${tight.label} ${formatPercent(tight.usedPercent)}` : 'not reported'}. Show subscriptions`}
          className={`flex shrink-0 items-center rounded-full p-0.5 hover:bg-[var(--adf-ui-surface-hover)] ${stale ? 'opacity-60' : ''}`}
          data-subscription-pill={subscription}
        >
          <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" className="-rotate-90">
            <circle cx={7} cy={7} r={RING_R} fill="none" strokeWidth={2} className="stroke-neutral-400 dark:stroke-neutral-500" />
            {used != null && (
              <circle
                cx={7}
                cy={7}
                r={RING_R}
                fill="none"
                strokeWidth={2}
                strokeLinecap={used > 0 ? 'round' : 'butt'}
                strokeDasharray={`${(Math.max(0, Math.min(used, 100)) / 100) * RING_C} ${RING_C}`}
                className={TONE_STROKE[tone]}
              />
            )}
          </svg>
        </button>
      </Tooltip>
      <ContextMenu position={open} onClose={() => setOpen(null)} placement={{ x: 'start', y: 'above' }} label="Subscriptions" anchor={buttonRef}>
        <div className="w-[min(340px,calc(100vw-24px))] space-y-3 px-3 py-2" data-subscription-popover="">
          {listed.length === 0
            ? <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">No subscription is signed in.</p>
            : listed.map((s, i) => (
              <div key={s.provider} className={i > 0 ? 'border-t border-hairline pt-2' : undefined}>
                <SubscriptionUsageCard snapshot={s} now={now} />
              </div>
            ))}
        </div>
        <div className="my-1 border-t border-hairline" />
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            setOpen(null)
            requestSettingsRuntime(runtimeId)
            useAppStore.getState().openSettingsAt('usage')
          }}
          className="flex w-full items-center px-3 py-1 text-left text-[11px] text-[var(--adf-ui-text-muted)] outline-none hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] focus-visible:bg-[var(--adf-ui-surface-hover)]"
        >
          Usage settings
        </button>
      </ContextMenu>
    </>
  )
}
