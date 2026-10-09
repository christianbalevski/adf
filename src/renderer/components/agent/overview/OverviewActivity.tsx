/**
 * The overview's lower sections, under the stats: Coming up, Recent
 * activity, the 14-day Activity sparkline and Contents. Each hides when
 * it has nothing to show.
 *
 * Timers, recent events, per-day turns and contents come from
 * `adf:agent:activity` (AgentVitalsService.getAgentActivity), refetched with
 * the same triggers as vitals. Approvals, asks and the unread count are read
 * live from the renderer stores, and while a turn runs the store's log is
 * merged into the recent list so it moves before the next read.
 */

import { useMemo } from 'react'
import { MAIN_LOOP, useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useInboxStore } from '../../../stores/inbox.store'
import { Tooltip } from '../../common/Tooltip'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentState } from '../../../../shared/types/ipc.types'
import type { ActivityDay, AgentActivity, AgentContents } from '../../../../shared/types/agent-vitals.types'
import { useOverviewRead, type OverviewReader } from './useOverviewRead'
import {
  activityEventText,
  approxTokens,
  compactCount,
  contentsView,
  dayTooltip,
  formatAgo,
  formatUntil,
  mergeLiveActivity,
  sparkHeights,
  sparkSummary,
  waitingItems,
  type ContentsKey
} from './agent-overview-model'

const readActivity: OverviewReader<AgentActivity> = (filePath, force) => window.adfApi?.getAgentActivity?.(filePath, { force })

const SPARK_HEIGHT = 40

const ROW = 'w-full flex items-baseline gap-2 -mx-1.5 px-1.5 py-[3px] rounded text-left text-[13px] hover:bg-[var(--paper-sunken)]'
const WHEN = 'shrink-0 text-[11.5px] text-[var(--ink-faint)] tabular-nums'
const MONO = 'font-mono text-[12px]'

function openLoops(): void {
  useAppStore.getState().expandRightPanelToTab('loop')
}

export function OverviewActivity({ filePath, state, config, now }: {
  filePath: string | null
  state: AgentState
  config: AgentConfig | null
  now: number
}) {
  const activity = useOverviewRead(filePath, state, config, readActivity)
  if (!activity) return null
  return (
    <>
      <ComingUp activity={activity} now={now} />
      <RecentActivity activity={activity} now={now} />
      <ActivitySpark daily={activity.daily} partial={activity.dailyPartial} />
      <Contents contents={activity.contents} />
    </>
  )
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--rule)] pt-3 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

// =============================================================================
// Coming up
// =============================================================================

function ComingUp({ activity, now }: { activity: AgentActivity; now: number }) {
  const log = useAgentStore((s) => s.log)
  const structuralVersion = useAgentStore((s) => s.structuralVersion)
  const approvals = useAgentStore((s) => s.pendingApprovals)
  const asks = useAgentStore((s) => s.pendingAsks)
  const sideLoops = useAgentStore((s) => s.sideLoops)
  const unread = useInboxStore((s) => s.unreadCount)

  const waiting = useMemo(
    () => waitingItems([
      { loop: MAIN_LOOP, log, approvals: approvals.keys(), asks: asks.entries() },
      ...Object.entries(sideLoops).map(([loop, slice]) => ({
        loop,
        log: slice.log,
        approvals: slice.pendingApprovals.keys(),
        asks: slice.pendingAsks.entries()
      }))
    ]),
    // structuralVersion: the log array is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, structuralVersion, approvals, asks, sideLoops]
  )

  const timers = activity.upcoming
  if (waiting.length === 0 && unread === 0 && timers.length === 0) return null

  return (
    <Section title="Coming up">
      <ul>
        {waiting.map((w) => (
          <li key={w.key}>
            <button type="button" onClick={openLoops} className={`${ROW} font-medium`}>
              <span className="min-w-0 flex-1 truncate">{w.text}</span>
              <span className={WHEN}>waiting</span>
            </button>
          </li>
        ))}
        {unread > 0 && (
          <li>
            <button type="button" onClick={() => useAppStore.getState().expandRightPanelToTab('inbox')} className={ROW}>
              <span className="min-w-0 flex-1 truncate">
                <span className="tabular-nums">{compactCount(unread)}</span> unread {unread === 1 ? 'message' : 'messages'}
              </span>
            </button>
          </li>
        )}
        {timers.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => useAppStore.getState().expandRightPanelToTab('agent', 'timers')} className={ROW}>
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              <span className={`shrink-0 ${MONO} text-[11px] text-[var(--ink-faint)]`}>{t.scope}</span>
              <span className={WHEN}>{formatUntil(t.at, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// =============================================================================
// Recent activity
// =============================================================================

function RecentActivity({ activity, now }: { activity: AgentActivity; now: number }) {
  const log = useAgentStore((s) => s.log)
  const structuralVersion = useAgentStore((s) => s.structuralVersion)
  const events = useMemo(
    () => mergeLiveActivity(activity.recent, log, activity.computedAt),
    // structuralVersion: the log array is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, log, structuralVersion]
  )
  if (events.length === 0) return null
  return (
    <Section title="Recent activity">
      <ul>
        {events.map((e, i) => {
          const t = activityEventText(e)
          return (
            <li key={`${e.kind}:${e.at}:${e.label}:${i}`}>
              <button type="button" onClick={openLoops} className={ROW}>
                <span className="min-w-0 flex-1 truncate">
                  {t.lead}
                  {t.mono && <span className={MONO}>{t.mono}</span>}
                  {t.tail && <span className="font-mono text-[12px] tabular-nums text-[var(--ink-muted)]">{t.tail}</span>}
                </span>
                <span className={WHEN}>{formatAgo(e.at, now)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

// =============================================================================
// Activity sparkline
// =============================================================================

const PARTIAL_TIP = 'Older loop history was compacted away or is past the scan limit, so earlier days may read low.'

/**
 * One bar per local day, today at the right in full ink, the rest
 * de-emphasised. No axes: the summary line names the total and each bar's
 * tooltip gives the day, turns and cost. A hidden table carries the same
 * numbers for screen readers.
 */
function ActivitySpark({ daily, partial }: { daily: ActivityDay[]; partial: boolean }) {
  const heights = useMemo(() => sparkHeights(daily, SPARK_HEIGHT), [daily])
  const hasAny = daily.some((d) => d.turns > 0 || (d.costUsd ?? 0) > 0)
  if (!hasAny) return null
  const summary = sparkSummary(daily)
  const last = daily.length - 1
  return (
    <Section
      title="Activity"
      aside={
        partial ? (
          <Tooltip tip={PARTIAL_TIP}>
            <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums underline decoration-dotted decoration-[var(--ink-faint)] underline-offset-2">{summary}</span>
          </Tooltip>
        ) : (
          <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums">{summary}</span>
        )
      }
    >
      <div role="img" aria-label={summary} className="flex items-end gap-[2px]" style={{ height: SPARK_HEIGHT }}>
        {daily.map((d, i) => (
          <Tooltip key={d.date} tip={dayTooltip(d, i === last)} delay={0} className="group flex-1 h-full flex items-end">
            {heights[i] > 0 ? (
              <span
                className={`block w-full rounded-t-[2px] ${i === last ? 'bg-[var(--ink)]' : 'bg-[var(--ink-faint)] group-hover:bg-[var(--ink-muted)]'}`}
                style={{ height: heights[i] }}
              />
            ) : (
              <span className="block w-full h-px bg-[var(--rule)] group-hover:bg-[var(--ink-faint)]" />
            )}
          </Tooltip>
        ))}
      </div>
      <table className="sr-only">
        <caption>Finished turns per day</caption>
        <thead><tr><th>Day</th><th>Turns</th><th>Cost</th></tr></thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.turns}</td>
              <td>{typeof d.costUsd === 'number' ? `$${d.costUsd.toFixed(2)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

// =============================================================================
// Contents
// =============================================================================

/**
 * Segment colours, fixed per group (never by rank): ink and blue from the
 * brand tokens, so each mode gets its own selected steps. The pair stays
 * apart under protan/deutan simulation (dataviz validator), and every
 * segment's numbers are also printed in the legend.
 */
const CONTENTS_COLOR: Record<ContentsKey, string> = {
  mind: 'var(--ink)',
  skills: 'var(--blue)'
}

const openFiles = (): void => useAppStore.getState().expandRightPanelToTab('files')
const openContents: Record<ContentsKey, () => void> = {
  mind: openFiles,
  skills: () => useAppStore.getState().expandRightPanelToTab('agent', 'skills')
}

/**
 * One stacked bar of approximate tokens (mind, skills) with a legend line
 * per group, then local tables as plain facts: table data is rarely read
 * into context, so it is not on the token meter. Hidden when the file holds
 * none of them.
 */
function Contents({ contents }: { contents: AgentContents }) {
  const view = useMemo(() => contentsView(contents), [contents])
  if (!view) return null
  const sized = view.groups.filter((g) => g.tokens > 0)
  return (
    <Section
      title="Contents"
      aside={view.groups.length > 0 ? <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums">{approxTokens(view.total)} tokens</span> : undefined}
    >
      {sized.length > 0 && (
        <div role="img" aria-label={view.groups.map((g) => g.text).join('; ')} className="flex h-2 gap-[2px]">
          {sized.map((g) => (
            <Tooltip key={g.key} tip={g.text} delay={0} className="flex min-w-[3px]" style={{ flexGrow: g.tokens, flexBasis: 0 }}>
              <span className="block h-full w-full rounded-[2px]" style={{ background: CONTENTS_COLOR[g.key] }} />
            </Tooltip>
          ))}
        </div>
      )}
      <ul>
        {view.groups.map((g) => (
          <li key={g.key}>
            <button type="button" onClick={openContents[g.key]} className={ROW}>
              <span aria-hidden className="self-center h-2 w-2 shrink-0 rounded-[2px]" style={{ background: CONTENTS_COLOR[g.key] }} />
              <span className="min-w-0 flex-1 truncate tabular-nums">{g.text}</span>
            </button>
          </li>
        ))}
        {view.tables && (
          <li>
            <button type="button" onClick={openFiles} className={ROW}>
              <span className="min-w-0 flex-1 truncate tabular-nums">{view.tables}</span>
            </button>
          </li>
        )}
      </ul>
    </Section>
  )
}
