/**
 * The overview's lower sections, under the stats: Coming up, the 14-day
 * Activity sparkline and Contents. Each hides when it has nothing to show.
 * Sized to the height budget in AgentOverview.tsx, which folds the
 * sparkline into its facts line, then the Contents rows into one line, when
 * the panel would scroll.
 *
 * Timers, per-day turns and contents come from `adf:agent:activity`
 * (AgentVitalsService.getAgentActivity, read by AgentOverview with the same
 * triggers as vitals). Approvals, asks and the unread count are read live
 * from the renderer stores.
 */

import { useMemo, useState } from 'react'
import { MAIN_LOOP, useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useInboxStore } from '../../../stores/inbox.store'
import { Tooltip } from '../../common/Tooltip'
import type { ActivityDay, AgentActivity, AgentContents, MemoryStratum, UpcomingWake } from '../../../../shared/types/agent-vitals.types'
import type { OverviewReader } from './useOverviewRead'
import {
  COMING_UP_ROW_LIMIT,
  compactCount,
  contentsFoldedLine,
  contentsRows,
  dayTooltip,
  formatUntil,
  hasActivity,
  sparkHeights,
  sparkSummary,
  strataSegments,
  strataSummary,
  timerRowText,
  visibleItems,
  waitingItems,
  type ContentsKey,
  type WaitingItem
} from './agent-overview-model'

export const readActivity: OverviewReader<AgentActivity> = (filePath, force) => window.adfApi?.getAgentActivity?.(filePath, { force })

const SPARK_HEIGHT = 24

const ROW = 'w-full flex items-baseline gap-2 -mx-1.5 px-1.5 py-0.5 rounded text-left text-[13px] leading-[18px] hover:bg-[var(--paper-sunken)]'
const WHEN = 'shrink-0 text-[11.5px] text-[var(--ink-faint)] tabular-nums'
const MONO = 'font-mono text-[12px]'

function openLoops(): void {
  useAppStore.getState().expandRightPanelToTab('loop')
}

export function OverviewActivity({ activity, now, chartFolded, contentsFolded }: {
  activity: AgentActivity | null
  now: number
  /** The sparkline is a fact in the stats' facts line instead. */
  chartFolded: boolean
  /** Contents shows as one line in its title row, without rows or strip. */
  contentsFolded: boolean
}) {
  if (!activity) return null
  return (
    <>
      <ComingUp activity={activity} now={now} />
      {!chartFolded && <ActivitySpark daily={activity.daily} partial={activity.dailyPartial} />}
      <Contents contents={activity.contents} folded={contentsFolded} />
    </>
  )
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--rule)] pt-1.5 space-y-1">
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
  const { shown, hidden } = visibleItems(rows, expanded, COMING_UP_ROW_LIMIT)

  return (
    <Section
      title="Coming up"
      aside={hidden > 0 ? (
        <button type="button" onClick={() => setExpanded(true)} className="text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink)] tabular-nums">
          +{hidden} more
        </button>
      ) : undefined}
    >
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
  if (!hasActivity(daily)) return null
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
      {/* A table ignores height: 1px, so sr-only goes on a wrapper; on the
          table itself its full height extended the dock's scroll area. */}
      <div className="sr-only">
      <table>
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
      </div>
    </Section>
  )
}

// =============================================================================
// Contents
// =============================================================================

const openFiles = (): void => useAppStore.getState().expandRightPanelToTab('files')
const openContents: Record<ContentsKey, () => void> = {
  mind: openFiles,
  skills: () => useAppStore.getState().expandRightPanelToTab('agent', 'skills'),
  tables: openFiles
}

/** Coming up's row without its vertical padding: one 18 px line, as the old meter line was. */
const CONTENTS_ROW = ROW.replace('py-0.5', 'py-0')

/**
 * Memory (`mind/`, what the agent recorded since creation), Skills (loaded
 * capability) and Tables, one row each, no shared meter or total: memory and
 * skills are different things. Rows with nothing in them are left out; the
 * section hides when all are. Under Memory, the strata strip. Folded: one
 * line ("Memory ~20k · 5 skills · 3 tables") in the title row.
 */
function Contents({ contents, folded }: { contents: AgentContents; folded: boolean }) {
  const rows = useMemo(() => contentsRows(contents), [contents])
  if (rows.length === 0) return null
  if (folded) {
    const line = contentsFoldedLine(contents)
    return (
      <Section
        title="Contents"
        aside={
          <Tooltip tip={line} className="min-w-0">
            <button type="button" onClick={openFiles} className="block max-w-full truncate text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink)] tabular-nums">{line}</button>
          </Tooltip>
        }
      />
    )
  }
  return (
    <Section title="Contents">
      <ul>
        {rows.map((r) => (
          <li key={r.key}>
            <button type="button" onClick={openContents[r.key]} className={CONTENTS_ROW}>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{r.label}</span>{' '}
                <span className="text-[var(--ink-muted)] tabular-nums">{r.text}</span>
              </span>
              {r.aside && <span className={WHEN}>{r.aside}</span>}
            </button>
            {r.key === 'mind' && <MemoryStrata contents={contents} />}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Sequential, one ink family: settled memory darkest (most emphatic in dark), fresh lightest. */
const STRATUM_FILL: Record<MemoryStratum, string> = {
  older: 'var(--ink)',
  quarter: 'var(--ink-muted)',
  month: 'var(--ink-faint)',
  week: 'var(--rule-strong)'
}

/**
 * The memory's tokens by when each file was last updated, oldest left. 4 px
 * plus a 2 px gap under the Memory row; a 2 px surface gap between segments.
 * No legend: each segment's tooltip names its band, the aria-label all of
 * them. Hidden when memory (less the seeded log header) is 0.
 */
function MemoryStrata({ contents }: { contents: AgentContents }) {
  const segments = useMemo(() => strataSegments(contents.mind.strata), [contents])
  if (segments.length === 0) return null
  return (
    <div role="img" aria-label={strataSummary(segments)} className="mt-0.5 flex h-1 gap-[2px]">
      {segments.map((s) => (
        // Hit area 12 px tall, layout height 4.
        <Tooltip key={s.band} tip={s.tip} delay={0} className="block -my-1 py-1 min-w-[3px]" style={{ flex: `${s.tokens} 1 0px` }}>
          <span className="block h-1 rounded-[1px]" style={{ background: STRATUM_FILL[s.band] }} />
        </Tooltip>
      ))}
    </div>
  )
}
