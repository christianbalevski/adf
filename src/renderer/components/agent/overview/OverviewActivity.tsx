/**
 * The overview's lower sections, under the stats: Coming up, the 14-day
 * Activity sparkline and Contents. Each hides when it has nothing to show.
 * Sized to the height budget in AgentOverview.tsx.
 *
 * Timers, per-day turns and contents come from `adf:agent:activity`
 * (AgentVitalsService.getAgentActivity), refetched with the same triggers as
 * vitals. Approvals, asks and the unread count are read live from the
 * renderer stores.
 */

import { useMemo, useState } from 'react'
import { MAIN_LOOP, useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useInboxStore } from '../../../stores/inbox.store'
import { Tooltip } from '../../common/Tooltip'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentState } from '../../../../shared/types/ipc.types'
import type { ActivityDay, AgentActivity, AgentContents, UpcomingWake } from '../../../../shared/types/agent-vitals.types'
import { useOverviewRead, type OverviewReader } from './useOverviewRead'
import {
  OVERVIEW_ROW_LIMIT,
  approxTokens,
  compactCount,
  contentsView,
  dayTooltip,
  formatUntil,
  sparkHeights,
  sparkSummary,
  timerRowText,
  visibleItems,
  waitingItems,
  type ContentsKey,
  type WaitingItem
} from './agent-overview-model'

const readActivity: OverviewReader<AgentActivity> = (filePath, force) => window.adfApi?.getAgentActivity?.(filePath, { force })

const SPARK_HEIGHT = 32

const ROW = 'w-full flex items-baseline gap-2 -mx-1.5 px-1.5 py-0.5 rounded text-left text-[13px] leading-[18px] hover:bg-[var(--paper-sunken)]'
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
      <ActivitySpark daily={activity.daily} partial={activity.dailyPartial} />
      <Contents contents={activity.contents} />
    </>
  )
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--rule)] pt-2 space-y-1">
      <div className="flex items-baseline justify-between gap-2 leading-[18px]">
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

  const [expanded, setExpanded] = useState(false)

  const rows: ComingRow[] = [
    ...waiting.map((w): ComingRow => ({ kind: 'waiting', key: w.key, w })),
    ...(unread > 0 ? [{ kind: 'unread', key: 'unread', n: unread } as const] : []),
    ...activity.upcoming.map((t): ComingRow => ({ kind: 'timer', key: `timer:${t.id}`, t }))
  ]
  if (rows.length === 0) return null
  const { shown, hidden } = visibleItems(rows, expanded, OVERVIEW_ROW_LIMIT)

  return (
    <Section title="Coming up">
      <ul>
        {shown.map((r) => (
          <li key={r.key}>
            {r.kind === 'waiting' ? (
              <button type="button" onClick={openLoops} className={`${ROW} font-medium`}>
                <span className="min-w-0 flex-1 truncate">{r.w.text}</span>
                <span className={WHEN}>waiting</span>
              </button>
            ) : r.kind === 'unread' ? (
              <button type="button" onClick={() => useAppStore.getState().expandRightPanelToTab('inbox')} className={ROW}>
                <span className="min-w-0 flex-1 truncate">
                  <span className="tabular-nums">{compactCount(r.n)}</span> unread {r.n === 1 ? 'message' : 'messages'}
                </span>
              </button>
            ) : (
              <TimerRow t={r.t} now={now} />
            )}
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button type="button" onClick={() => setExpanded(true)} className={`${ROW} text-[12px] text-[var(--ink-muted)] hover:text-[var(--ink)]`}>
              +{hidden} more
            </button>
          </li>
        )}
      </ul>
    </Section>
  )
}

type ComingRow =
  | { kind: 'waiting'; key: string; w: WaitingItem }
  | { kind: 'unread'; key: string; n: number }
  | { kind: 'timer'; key: string; t: UpcomingWake }

const openTimers = (): void => useAppStore.getState().expandRightPanelToTab('agent', 'timers')

/**
 * system: `lambda` then its input, both mono. agent: the loop as a tag, then
 * the start of the prompt. Shortened text shows in full in the tooltip.
 */
function TimerRow({ t, now }: { t: UpcomingWake; now: number }) {
  const v = timerRowText(t)
  const tip = v.full ? (v.kind === 'lambda' && v.head ? `${v.head} ${v.full}` : v.full) : ''
  return (
    <Tooltip tip={tip} disabled={!tip} className="block">
      <button type="button" onClick={openTimers} className={ROW}>
        {v.kind === 'loop' && (
          <span className={`shrink-0 self-center rounded px-1 ${MONO} text-[11px] leading-4 bg-[var(--paper-sunken)] text-[var(--ink-muted)]`}>{v.head}</span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {v.kind === 'lambda' && <span className={MONO}>{v.head}</span>}
          {v.kind === 'lambda' && v.text && ' '}
          {v.text && <span className={v.mono ? `${MONO} text-[var(--ink-muted)]` : ''}>{v.text}</span>}
        </span>
        <span className={WHEN}>{formatUntil(t.at, now)}</span>
      </button>
    </Tooltip>
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
 * One stacked bar of approximate tokens (mind, skills) and one legend line:
 * each group's tokens (file and skill counts in the tooltip), then local
 * tables as a plain fact: table data is rarely read
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
      <div className="flex items-baseline gap-3 min-w-0 text-[12px] leading-[18px] tabular-nums">
        {view.groups.map((g) => (
          <Tooltip key={g.key} tip={g.text} className="shrink-0">
            <button type="button" onClick={openContents[g.key]} aria-label={g.text} className="inline-flex items-baseline gap-1.5 hover:underline underline-offset-2">
              <span aria-hidden className="self-center h-2 w-2 shrink-0 rounded-[2px]" style={{ background: CONTENTS_COLOR[g.key] }} />
              {g.short}
            </button>
          </Tooltip>
        ))}
        {view.tables && (
          <button type="button" onClick={openFiles} className="min-w-0 truncate text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline underline-offset-2">
            {view.tables}
          </button>
        )}
      </div>
    </Section>
  )
}
