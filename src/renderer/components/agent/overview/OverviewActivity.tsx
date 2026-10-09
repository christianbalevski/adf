/**
 * The overview's lower sections, under the stats: Coming up, Recent
 * activity, the 14-day Activity sparkline and What it knows. Each hides when
 * it has nothing to show.
 *
 * Timers, recent events, per-day turns and knowledge come from
 * `adf:agent:activity` (AgentVitalsService.getAgentActivity), refetched with
 * the same triggers as vitals. Approvals, asks and the unread count are read
 * live from the renderer stores, and while a turn runs the store's log is
 * merged into the recent list so it moves before the next read.
 */

import { useMemo, useState } from 'react'
import { MAIN_LOOP, useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useEditorTabsStore } from '../../../stores/editor-tabs.store'
import { useInboxStore } from '../../../stores/inbox.store'
import { Tooltip } from '../../common/Tooltip'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentState } from '../../../../shared/types/ipc.types'
import type { ActivityDay, AgentActivity, KnowledgeFile, KnowledgeTable } from '../../../../shared/types/agent-vitals.types'
import { useOverviewRead, type OverviewReader } from './useOverviewRead'
import {
  activityEventText,
  compactCount,
  dayTooltip,
  formatAgo,
  formatUntil,
  mergeLiveActivity,
  rowsLabel,
  sparkHeights,
  sparkSummary,
  visibleItems,
  waitingItems
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
      <WhatItKnows knowledge={activity.knowledge} now={now} />
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
// What it knows
// =============================================================================

function openSkills(): void {
  useAppStore.getState().expandRightPanelToTab('agent', 'skills')
}

function openTable(name: string): void {
  const app = useAppStore.getState()
  app.expandRightPanelToTab('files')
  app.setPendingFilesTable(name)
  // Drop a request the Files tab never picked up, so it cannot fire later.
  setTimeout(() => {
    if (useAppStore.getState().pendingFilesTable === name) useAppStore.getState().setPendingFilesTable(null)
  }, 2000)
}

async function openFile(path: string): Promise<void> {
  const result = await window.adfApi?.readInternalFile?.(path)
  if (result?.content != null) {
    useEditorTabsStore.getState().openTab(path, result.binary ? '' : result.content, result.binary, result.mimeType)
  } else {
    useAppStore.getState().expandRightPanelToTab('files')
  }
}

function WhatItKnows({ knowledge, now }: { knowledge: AgentActivity['knowledge']; now: number }) {
  const { skills, tables, files, filesTotal } = knowledge
  if (skills.length + tables.length + files.length === 0) return null
  return (
    <Section title="What it knows">
      <KnowGroup title="Skills" items={skills} total={skills.length} itemKey={(s) => s}>
        {(s) => (
          <button type="button" onClick={openSkills} className={ROW}>
            <span className={`min-w-0 flex-1 truncate ${MONO}`}>{s}</span>
          </button>
        )}
      </KnowGroup>
      <KnowGroup title="Tables" items={tables} total={tables.length} itemKey={(t: KnowledgeTable) => t.name}>
        {(t) => (
          <button type="button" onClick={() => openTable(t.name)} className={ROW}>
            <span className={`min-w-0 flex-1 truncate ${MONO}`}>{t.name}</span>
            <span className={WHEN}>{rowsLabel(t.rows)}</span>
          </button>
        )}
      </KnowGroup>
      <KnowGroup title="Files" items={files} total={filesTotal} itemKey={(f: KnowledgeFile) => f.path}>
        {(f) => (
          <button type="button" onClick={() => void openFile(f.path)} className={ROW}>
            <span className={`min-w-0 flex-1 truncate ${MONO}`}>{f.path}</span>
            <span className={WHEN}>{formatAgo(Date.parse(f.updatedAt), now)}</span>
          </button>
        )}
      </KnowGroup>
    </Section>
  )
}

/**
 * One group with "N more". `total` can exceed `items` (files are capped in
 * main); past the loaded items the expander opens the Files tab.
 */
function KnowGroup<T>({ title, items, total, itemKey, children }: {
  title: string
  items: T[]
  total: number
  itemKey: (item: T) => string
  children: (item: T) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const { shown, hidden } = visibleItems(items, expanded)
  const beyond = Math.max(0, total - items.length)
  const more = expanded ? beyond : hidden + beyond
  return (
    <div>
      <h4 className="text-[11px] font-medium text-[var(--ink-muted)]">{title}</h4>
      <ul>
        {shown.map((item) => <li key={itemKey(item)}>{children(item)}</li>)}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() => (hidden > 0 && !expanded ? setExpanded(true) : useAppStore.getState().expandRightPanelToTab('files'))}
          className="mt-0.5 text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink)] underline-offset-2 hover:underline tabular-nums"
        >
          {compactCount(more)} more
        </button>
      )}
    </div>
  )
}
