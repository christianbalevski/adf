/**
 * Agent overview: the right dock's first tab. A centred card face mirroring
 * the agent's ALF card (orbital with its own status line as a speech bubble,
 * name and @handle, description, Public / Verified owner badges) and a state
 * line with the model; then four levelled stats (Experience, Reach, Access,
 * Autonomy) and a facts line (7-day cost, age, next wake).
 *
 * Stats come from `adf:agent:vitals` (main/services/agent-vitals.ts), the
 * sections under them from `adf:agent:activity` (OverviewActivity). There is
 * no push event, so both refetch on open, when a turn ends, when the config
 * changes, and every 10 s while the panel shows (useOverviewRead; main caches
 * both reads, so a poll costs little).
 *
 * Height budget: the whole panel fits without scrolling in a 1366x768 window
 * with the dock at its default 320 px. 768 - title bar 40 - status bar 28 -
 * dock tabs 36 = 664 px for the panel. Worst case (status, 2-line
 * description, both badges, 3 metrics + "+N", 3 Coming up rows + "+N"),
 * 18 px text lines:
 *   padding 16
 *   card face: orbital 72 + 6 + name 20 + 2 + description 2x16 + 4
 *     + badges 16 + 2 + state 18 = 172 (status bubble sits beside the orbital)
 *   gap 8, stats grid 2x44 + borders 3 = 91, facts 6+18, metrics 6+78 -> 199
 *   gap 8, Coming up: rule+pad 7 + title 18 + 4 + 4 rows x 22 = 117
 *   gap 8, Activity: 29 + spark 28 = 57
 *   gap 8, Contents: 29 + meter 8 + 4 + legend 18 = 59
 *   total ~652 px. Anything taller (banners, a smaller window) scrolls.
 * Keep new rows inside this budget: cap lists with OVERVIEW_ROW_LIMIT + "+N".
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OverviewActivity } from './OverviewActivity'
import { useOverviewRead, type OverviewReader } from './useOverviewRead'
import { useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useDocumentStore } from '../../../stores/document.store'
import { getLoopActivity } from '../../../utils/loop-activity'
import { Tooltip } from '../../common/Tooltip'
import { SpeechBubble } from '../../common/SpeechBubble'
import { LiveOrbital, orbitalMotionStateFor, useOpenAgentOrbitalSeed } from '../../orbital'
import type { AgentState } from '../../../../shared/types/ipc.types'
import type { AgentMetric, AgentVitals, ExperienceStat, PowerStat } from '../../../../shared/types/agent-vitals.types'
import {
  HIGH_POWER_LABEL,
  LEVELS_STORAGE_KEY,
  agentStatusLabel,
  compactCount,
  configTargetFor,
  decideLevelUp,
  experienceContributors,
  experienceHeadline,
  experienceTooltip,
  experienceValueText,
  levelBarParts,
  overviewFacts,
  parseStoredLevels,
  powerSections,
  powerTooltip,
  visibleItems,
  OVERVIEW_ROW_LIMIT,
  type LevelBarParts,
  type PowerItem
} from './agent-overview-model'

const ORBITAL_SIZE = 72
const PULSE_MS = 1200

type StatKey = 'experience' | 'reach' | 'access' | 'autonomy'

const STAT_NAMES: Record<StatKey, string> = {
  experience: 'Experience',
  reach: 'Reach',
  access: 'Access',
  autonomy: 'Autonomy'
}

// =============================================================================
// Data
// =============================================================================

const readVitals: OverviewReader<AgentVitals> = (filePath, force) => window.adfApi?.getAgentVitals?.(filePath, { force })

/** What the agent is doing right now, for the state line and orbital motion. */
function useLiveActivity(nextWakeAt: number | undefined, now: number): { state: AgentState; label: string; toolRunning: boolean } {
  const state = useAgentStore((s) => s.state)
  const starting = useAgentStore((s) => s.starting)
  const log = useAgentStore((s) => s.log)
  const structuralVersion = useAgentStore((s) => s.structuralVersion)
  const approvals = useAgentStore((s) => s.pendingApprovals.size + Object.values(s.sideLoops).reduce((n, l) => n + l.pendingApprovals.size, 0))
  const asks = useAgentStore((s) => s.pendingAsks.size + Object.values(s.sideLoops).reduce((n, l) => n + l.pendingAsks.size, 0))
  const suspend = useAgentStore((s) => s.pendingSuspend !== null)

  return useMemo(() => {
    const waiting = approvals > 0 || asks > 0 || suspend
    const activity = getLoopActivity(log, { active: state === 'active', starting, waiting })
    let toolName: string | null = null
    if (activity.entryId) {
      const idx = log.findIndex((e) => e.id === activity.entryId)
      const entry = idx >= 0 ? log[idx] : null
      // Running = the call has no result after it yet.
      if (entry?.type === 'tool_call' && !log.slice(idx + 1).some((e) => e.type === 'tool_result')) {
        const name = entry.metadata?.name
        toolName = typeof name === 'string' && name ? name : null
      }
    }
    return {
      state,
      label: agentStatusLabel(state, { starting, toolName, approvals, asks, suspend, nextWakeAt, now }),
      toolRunning: toolName !== null
    }
    // structuralVersion: the log array is mutated in place for streamed deltas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, structuralVersion, state, starting, approvals, asks, suspend, nextWakeAt, now])
}

/** Pulse once when the level rose past the last one Studio saw for this DID. */
function useLevelUpPulse(did: string | undefined, level: number | undefined): boolean {
  const [pulsing, setPulsing] = useState(false)
  useEffect(() => {
    if (!did || level === undefined) return
    let levels: Record<string, number>
    try {
      levels = parseStoredLevels(localStorage.getItem(LEVELS_STORAGE_KEY))
    } catch {
      return
    }
    const decision = decideLevelUp(levels[did], level)
    if (levels[did] !== decision.store) {
      levels[did] = decision.store
      try {
        localStorage.setItem(LEVELS_STORAGE_KEY, JSON.stringify(levels))
      } catch {
        /* storage unavailable: no pulse bookkeeping */
      }
    }
    if (decision.pulse) setPulsing(true)
  }, [did, level])
  useEffect(() => {
    if (!pulsing) return
    const t = setTimeout(() => setPulsing(false), PULSE_MS)
    return () => clearTimeout(t)
  }, [pulsing])
  return pulsing
}

/** Open the agent config sub-tab (or identity / timers) where a factor is set. */
function openConfigFor(configPath: string): void {
  const target = configTargetFor(configPath)
  const app = useAppStore.getState()
  app.expandRightPanelToTab('agent', target.subTab)
  if (!target.section) return
  const section = target.section
  app.setPendingConfigSection(section)
  // Drop a request no Section picked up (config not loaded, section absent),
  // so it cannot fire later when the user opens Config by hand.
  setTimeout(() => {
    if (useAppStore.getState().pendingConfigSection === section) useAppStore.getState().setPendingConfigSection(null)
  }, 2000)
}

// =============================================================================
// Panel
// =============================================================================

export function AgentOverview() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)
  const statusText = useAgentStore((s) => s.statusText)
  const seed = useOpenAgentOrbitalSeed()
  const state = useAgentStore((s) => s.state)
  const vitals = useOverviewRead(filePath, state, config, readVitals)
  const [now, setNow] = useState(() => Date.now())
  const live = useLiveActivity(vitals?.nextWakeAt, now)
  const pulsing = useLevelUpPulse(vitals?.did, vitals?.stats.experience.level)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (vitals) setNow(Date.now())
  }, [vitals])

  const name = config?.name || vitals?.name || vitals?.handle || ''
  const handle = config?.handle || vitals?.handle || ''
  const model = config?.model?.model_id || vitals?.model
  const motion = orbitalMotionStateFor(live.state, live.toolRunning)
  // Live store first (updates as the agent writes), the file's values otherwise.
  const status = statusText.trim() || vitals?.status || ''
  const description = (config ? config.description?.trim() : vitals?.description) || ''
  const isPublic = config ? !!config.serving?.public?.enabled : !!vitals?.public

  // The state line already says when an idle agent wakes.
  const showsWake = live.label.includes(' · wakes') || live.label.includes(' · wake due')
  const facts = vitals ? overviewFacts(vitals, now).filter((f) => !(showsWake && f.id === 'wake')) : []

  return (
    <div className="px-3 py-2 space-y-2 text-[var(--ink)]">
      <header className="flex flex-col items-center text-center">
        <div className="relative w-full flex justify-center">
          <div
            className={`shrink-0 rounded-full ${pulsing ? 'pulse-ring' : ''}`}
            style={{ width: ORBITAL_SIZE, height: ORBITAL_SIZE }}
          >
            <LiveOrbital seed={seed} size={ORBITAL_SIZE} state={motion} />
          </div>
          {status && <StatusBubble text={status} />}
        </div>
        <h2 className="mt-1.5 max-w-full truncate text-[15px] font-semibold leading-5" title={name}>
          {name}
          {handle && handle !== name && <span className="ml-1.5 font-normal text-[12px] text-[var(--ink-muted)]">@{handle}</span>}
        </h2>
        {description && (
          <Tooltip tip={description} className="mt-0.5 block max-w-full">
            <p className="line-clamp-2 text-[11.5px] leading-4 text-[var(--ink-muted)]">{description}</p>
          </Tooltip>
        )}
        {(isPublic || vitals?.ownerVerified) && (
          <div className="mt-1 flex gap-1.5">
            {isPublic && <Badge>Public</Badge>}
            {vitals?.ownerVerified && <Badge>Verified owner</Badge>}
          </div>
        )}
        <p className="mt-0.5 max-w-full truncate text-[12px] leading-[18px]">
          {live.label}
          {model && <span className="text-[var(--ink-muted)]"> · <span className="font-mono text-[11.5px]">{model}</span></span>}
        </p>
      </header>

      <section className="space-y-1.5">
        {vitals && <StatGrid vitals={vitals} />}

        {facts.length > 0 && (
          <p className="text-[12px] leading-[18px] text-[var(--ink-muted)] tabular-nums">
            {facts.map((f, i) => (
              <span key={f.id}>
                {i > 0 && ' · '}
                {f.id === 'cost' && vitals?.cost7dPartial ? (
                  <Tooltip tip="Some calls had no known price, so the real cost is higher.">
                    <span className="underline decoration-dotted decoration-[var(--ink-faint)] underline-offset-2">{f.text}</span>
                  </Tooltip>
                ) : (
                  f.text
                )}
              </span>
            ))}
          </p>
        )}

        {vitals && vitals.metrics?.length > 0 && <MetricList metrics={vitals.metrics} />}
      </section>

      <OverviewActivity filePath={filePath} state={live.state} config={config} now={now} />
    </div>
  )
}

/**
 * The agent's own status line (adf_meta `status`) beside the orbital, in the
 * home page's bubble. Static (persistent state, not a quip); two lines at
 * most, the full text in the tooltip. Fills the space right of the orbital.
 */
function StatusBubble({ text }: { text: string }) {
  return (
    <Tooltip
      tip={text}
      className="absolute top-1 w-fit"
      style={{ left: `calc(50% + ${ORBITAL_SIZE / 2 + 10}px)`, right: 0 }}
    >
      <SpeechBubble className="relative px-2 py-1 text-[11.5px] leading-4">
        <span className="line-clamp-2 break-words">{text}</span>
      </SpeechBubble>
    </Tooltip>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--rule)] px-1.5 text-[11px] leading-4 text-[var(--ink-muted)]">{children}</span>
  )
}

/** adf_meta `metric:*` rows, as written; the first OVERVIEW_ROW_LIMIT, then "+N more". */
function MetricList({ metrics }: { metrics: AgentMetric[] }) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = visibleItems(metrics, expanded, OVERVIEW_ROW_LIMIT)
  return (
    <div className="text-[12px] leading-[18px] space-y-0.5">
      <dl className="space-y-0.5" aria-label="Metrics">
        {shown.map((m) => (
          <div key={m.name} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-[var(--ink-muted)]" title={m.name}>{m.name}</dt>
            <dd className="min-w-0 truncate font-mono text-[11.5px] tabular-nums" title={m.value}>{m.value}</dd>
          </div>
        ))}
      </dl>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="text-[var(--ink-muted)] hover:text-[var(--ink)]">
          +{hidden} more
        </button>
      )}
    </div>
  )
}

// =============================================================================
// Stats
// =============================================================================

function StatGrid({ vitals }: { vitals: AgentVitals }) {
  const [open, setOpen] = useState<StatKey | null>(null)
  const [popTop, setPopTop] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const cellRefs = useRef<Partial<Record<StatKey, HTMLButtonElement | null>>>({})
  const { stats } = vitals

  const openRef = useRef<StatKey | null>(null)
  openRef.current = open

  const close = useCallback((refocus: boolean) => {
    const cur = openRef.current
    setOpen(null)
    if (refocus && cur) cellRefs.current[cur]?.focus()
  }, [])

  const toggle = (key: StatKey) => setOpen((cur) => (cur === key ? null : key))

  useLayoutEffect(() => {
    if (!open) return
    const cell = cellRefs.current[open]
    if (cell) setPopTop(cell.offsetTop + cell.offsetHeight + 4)
  }, [open])

  const tips: Record<StatKey, string> = {
    experience: experienceTooltip(stats.experience),
    reach: powerTooltip(stats.reach),
    access: powerTooltip(stats.access),
    autonomy: powerTooltip(stats.autonomy)
  }

  const bars: Record<StatKey, LevelBarParts> = {
    experience: levelBarParts(stats.experience),
    reach: levelBarParts(stats.reach),
    access: levelBarParts(stats.access),
    autonomy: levelBarParts(stats.autonomy)
  }

  const cell = (key: StatKey, className: string) => (
    <Tooltip tip={tips[key]} disabled={open === key} className={`block ${className}`}>
      <button
        ref={(el) => { cellRefs.current[key] = el }}
        type="button"
        onClick={() => toggle(key)}
        aria-label={`${STAT_NAMES[key]}: ${tips[key]}`}
        aria-haspopup="dialog"
        aria-expanded={open === key}
        className={`w-full h-full text-left px-3 py-2 transition-colors hover:bg-[var(--paper-sunken)] ${open === key ? 'bg-[var(--paper-sunken)]' : ''}`}
      >
        <StatCell name={STAT_NAMES[key]} level={stats[key].level} bar={bars[key]} />
      </button>
    </Tooltip>
  )

  return (
    <div ref={gridRef} className="relative">
      <div className="grid grid-cols-2 rounded-md border border-[var(--rule)] bg-[var(--paper-raised)] overflow-hidden">
        {cell('experience', 'border-r border-b border-[var(--rule)]')}
        {cell('reach', 'border-b border-[var(--rule)]')}
        {cell('access', 'border-r border-[var(--rule)]')}
        {cell('autonomy', '')}
      </div>
      {open && (
        <StatPopover
          key={open}
          top={popTop}
          anchor={cellRefs.current[open] ?? null}
          title={`${STAT_NAMES[open]} · Lv ${stats[open].level}`}
          onClose={close}
        >
          {open === 'experience'
            ? <ExperienceDetail stat={stats.experience} />
            : <PowerDetail stat={stats[open]} onNavigate={(path) => { close(false); openConfigFor(path) }} />}
        </StatPopover>
      )}
    </div>
  )
}

function StatCell({ name, level, bar }: { name: string; level: number; bar: LevelBarParts }) {
  return (
    <span className="block space-y-1">
      <span className="flex items-baseline justify-between gap-2 leading-[18px]">
        <span className="text-[13px] font-semibold">{name}</span>
        <span className="font-mono text-[12px] tabular-nums">Lv {level}</span>
      </span>
      <LevelBar parts={bar} />
    </span>
  )
}

/** Diagonal hatch for the gated share: present but held back. */
const GATED_FILL = 'repeating-linear-gradient(135deg, var(--ink-muted) 0 1.5px, transparent 1.5px 3.5px)'

/** Progress to the next level; solid = runs without asking, hatched = asks first. */
function LevelBar({ parts }: { parts: LevelBarParts }) {
  return (
    <span className="flex h-1.5 rounded-full bg-[var(--rule)] overflow-hidden" aria-hidden="true">
      {parts.openPct > 0 && (
        <span
          className="block h-full"
          style={{ width: `${parts.openPct}%`, background: parts.high ? 'var(--status-draft)' : 'var(--ink)' }}
        />
      )}
      {parts.gatedPct > 0 && (
        <span className="block h-full" style={{ width: `${parts.gatedPct}%`, backgroundImage: GATED_FILL }} />
      )}
    </span>
  )
}

// =============================================================================
// Popover
// =============================================================================

/**
 * Anchored under its cell, inside the grid's box (so it scrolls with the
 * panel). Not modal: outside press and Esc close it; Esc returns focus to the
 * cell.
 */
function StatPopover({ top, anchor, title, onClose, children }: {
  top: number
  anchor: HTMLElement | null
  title: string
  onClose: (refocus: boolean) => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose(true)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="absolute left-0 right-0 z-20 focus:outline-none rounded-lg border border-[var(--rule-strong)] bg-[var(--paper-raised)] shadow-float p-3 space-y-2"
      style={{ top }}
    >
      <h3 id={titleId} className="text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function PowerDetail({ stat, onNavigate }: { stat: PowerStat; onNavigate: (configPath: string) => void }) {
  const sections = powerSections(stat)
  const empty = sections.open.length + sections.gated.length + sections.limits.length === 0
  return (
    <>
      {stat.high && (
        <p className="text-[12px] text-[var(--status-draft)]">{HIGH_POWER_LABEL}.</p>
      )}
      {empty && <p className="text-[12px] text-[var(--ink-muted)]">No settings add to this yet.</p>}
      <PowerSection title="Runs without asking" marker="open" items={sections.open} onNavigate={onNavigate} />
      <PowerSection title="Asks you first" marker="gated" items={sections.gated} onNavigate={onNavigate} />
      <PowerSection title="Limits" marker="mitigation" items={sections.limits} onNavigate={onNavigate} />
    </>
  )
}

function PowerSection({ title, marker, items, onNavigate }: {
  title: string
  marker: 'open' | 'gated' | 'mitigation'
  items: PowerItem[]
  onNavigate: (configPath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const { shown, hidden } = visibleItems(items, expanded)
  return (
    <section>
      <h4 className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--ink-muted)]">
        <FactorMarker kind={marker} />
        {title}
      </h4>
      <ul className="-mx-1.5 mt-0.5">
        {shown.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onNavigate(item.configPath)}
              className={`w-full px-1.5 py-0.5 rounded text-left text-[12px] hover:bg-[var(--paper-sunken)] ${marker === 'mitigation' ? 'text-[var(--ink-muted)]' : ''}`}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-0.5 text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink)] underline-offset-2 hover:underline"
        >
          {hidden} more
        </button>
      )}
    </section>
  )
}

function FactorMarker({ kind }: { kind: 'open' | 'gated' | 'mitigation' }) {
  if (kind === 'mitigation') {
    return <span className="shrink-0 w-[8px] h-[2px] bg-[var(--ink-faint)]" aria-hidden="true" />
  }
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 block w-[8px] h-[8px] rounded-[2px] ${kind === 'gated' ? 'border-[1.5px] border-[var(--ink-muted)]' : 'bg-[var(--ink)]'}`}
    />
  )
}

function ExperienceDetail({ stat }: { stat: ExperienceStat }) {
  const lines = experienceContributors(stat)
  const rows = stat.breakdown.filter((b) => b.value > 0 && Math.round(b.xp) > 0)
  return (
    <>
      <p className="text-[12px] text-[var(--ink-muted)] tabular-nums">{experienceHeadline(stat)}</p>
      {lines.length > 0 && (
        <ul className="text-[12px] space-y-0.5">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      <details className="text-[12px]">
        <summary className="cursor-pointer text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink)]">How XP adds up</summary>
        <div className="pt-1.5 space-y-1.5">
          <p className="text-[var(--ink-muted)] tabular-nums">
            {compactCount(Math.floor(stat.score))} XP · Lv {stat.level + 1} at {compactCount(Math.ceil(stat.nextLevelAt))} XP
          </p>
          {rows.length > 0 && (
            <table className="w-full">
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="py-0.5">{b.label}</td>
                    <td className="py-0.5 pl-2 text-right font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">{experienceValueText(b)}</td>
                    <td className="py-0.5 pl-2 text-right font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">+{compactCount(Math.round(b.xp))} XP</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[var(--ink-muted)]">{stat.nextLevel.hint}.</p>
        </div>
      </details>
    </>
  )
}
