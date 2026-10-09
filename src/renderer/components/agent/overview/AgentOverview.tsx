/**
 * Agent overview: the right dock's first tab. The agent's live orbital, name,
 * DID, what it is doing, context use, four stats (Experience, Reach, Access,
 * Autonomy) and a facts line (7-day cost, age, next wake).
 *
 * Stats come from `adf:agent:vitals` (main/services/agent-vitals.ts). There is
 * no push event, so the panel refetches on open, when a turn ends, when the
 * config changes, and every 10 s while it is showing (the slow part is cached
 * in main, so a poll costs little).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MAIN_LOOP, useAgentStore } from '../../../stores/agent.store'
import { useAppStore } from '../../../stores/app.store'
import { useDocumentStore } from '../../../stores/document.store'
import { getLoopActivity } from '../../../utils/loop-activity'
import { Tooltip } from '../../common/Tooltip'
import { LiveOrbital, orbitalMotionStateFor, useOpenAgentOrbitalSeed } from '../../orbital'
import { resolveLoopThreshold } from '../../../../shared/utils/context-breakdown'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentState } from '../../../../shared/types/ipc.types'
import type { AgentVitals, ExperienceStat, PowerStat } from '../../../../shared/types/agent-vitals.types'
import {
  LEVELS_STORAGE_KEY,
  agentStatusLabel,
  compactCount,
  configTargetFor,
  decideLevelUp,
  experienceTooltip,
  formatPoints,
  overviewFacts,
  parseStoredLevels,
  powerSegments,
  powerTooltip,
  shortDid,
  type SegmentKind
} from './agent-overview-model'

const POLL_MS = 10_000
const ORBITAL_SIZE = 112
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

function useAgentVitals(filePath: string | null, state: AgentState, config: AgentConfig | null): AgentVitals | null {
  const [entry, setEntry] = useState<{ path: string; vitals: AgentVitals } | null>(null)
  const seq = useRef(0)

  const fetchVitals = useCallback((force: boolean) => {
    const api = window.adfApi
    if (!filePath || !api?.getAgentVitals) return
    const id = ++seq.current
    api.getAgentVitals(filePath, { force }).then(
      (vitals) => {
        if (id === seq.current && vitals) setEntry({ path: filePath, vitals })
      },
      () => {}
    )
  }, [filePath])

  // Panel open, agent switch, and any config change (Studio edits and the
  // runtime's own both land in the store). Debounced so a burst of saves is
  // one read.
  useEffect(() => {
    const t = setTimeout(() => fetchVitals(true), 250)
    return () => clearTimeout(t)
  }, [fetchVitals, config])

  // A turn just ended: loop rows, files and cost moved.
  const prevState = useRef(state)
  useEffect(() => {
    const was = prevState.current
    prevState.current = state
    if (was === 'active' && state !== 'active') fetchVitals(true)
  }, [state, fetchVitals])

  // Light poll while the panel is mounted (it only is while its tab shows).
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) fetchVitals(false)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [fetchVitals])

  return entry && entry.path === filePath ? entry.vitals : null
}

/** What the main loop is doing right now, for the status line and orbital motion. */
function useLiveActivity(): { state: AgentState; label: string; toolRunning: boolean } {
  const state = useAgentStore((s) => s.state)
  const starting = useAgentStore((s) => s.starting)
  const log = useAgentStore((s) => s.log)
  const structuralVersion = useAgentStore((s) => s.structuralVersion)
  const waiting = useAgentStore((s) => s.pendingApprovals.size > 0 || s.pendingAsks.size > 0 || s.pendingSuspend !== null)

  return useMemo(() => {
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
      label: agentStatusLabel(state, { starting, waiting, toolName }),
      toolRunning: toolName !== null
    }
    // structuralVersion: the log array is mutated in place for streamed deltas.
  }, [log, structuralVersion, state, starting, waiting])
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
  const tokenUsage = useAgentStore((s) => s.tokenUsage)
  const tokenEstimate = useAgentStore((s) => s.tokenEstimate)
  const seed = useOpenAgentOrbitalSeed()
  const live = useLiveActivity()
  const vitals = useAgentVitals(filePath, live.state, config)
  const pulsing = useLevelUpPulse(vitals?.did, vitals?.stats.experience.level)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (vitals) setNow(Date.now())
  }, [vitals])

  const name = config?.name || vitals?.name || vitals?.handle || ''
  const model = config?.model?.model_id || vitals?.model
  const motion = orbitalMotionStateFor(live.state, live.toolRunning)

  // Context: the live store first (same numbers as the status bar gauge), the
  // executor's last report from vitals when the store has none yet.
  const storeUsed = tokenEstimate ?? tokenUsage.input + tokenUsage.output
  const context = storeUsed > 0
    ? { used: storeUsed, threshold: resolveLoopThreshold(config, MAIN_LOOP) }
    : vitals?.contextTokens && vitals.contextThreshold
      ? { used: vitals.contextTokens, threshold: vitals.contextThreshold }
      : null

  const facts = vitals ? overviewFacts(vitals, now) : []

  return (
    <div className="p-3 space-y-3 text-[var(--ink)]">
      <header className="flex items-start gap-3">
        <div
          className={`shrink-0 rounded-full ${pulsing ? 'pulse-ring' : ''}`}
          style={{ width: ORBITAL_SIZE, height: ORBITAL_SIZE }}
        >
          <LiveOrbital seed={seed} size={ORBITAL_SIZE} state={motion} />
        </div>
        <div className="min-w-0 flex-1 pt-2 space-y-1">
          <h2 className="text-[15px] font-semibold leading-tight truncate" title={name}>{name}</h2>
          {vitals?.did && <DidRow did={vitals.did} />}
          <p className="text-[12px] text-[var(--ink-muted)] truncate">
            {live.label}
            {model && <> · <span className="font-mono text-[11.5px]">{model}</span></>}
          </p>
          {context && <ContextBar used={context.used} threshold={context.threshold} />}
        </div>
      </header>

      {vitals && <StatGrid vitals={vitals} />}

      {facts.length > 0 && (
        <p className="text-[12px] text-[var(--ink-muted)] tabular-nums">
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
    </div>
  )
}

function DidRow({ did }: { did: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => {
    navigator.clipboard?.writeText(did).then(() => setCopied(true), () => {})
  }
  return (
    <div className="flex items-center gap-1 min-w-0">
      <Tooltip tip={did} className="min-w-0 truncate">
        <span className="font-mono text-[11.5px] text-[var(--ink-muted)]">{shortDid(did)}</span>
      </Tooltip>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'DID copied' : 'Copy DID'}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-sunken)]"
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}

function ContextBar({ used, threshold }: { used: number; threshold: number }) {
  const pct = threshold > 0 ? Math.min(100, Math.max(0, (used / threshold) * 100)) : 0
  const label = `Context ${Math.round(pct)}%`
  return (
    <div className="flex items-center gap-2 pt-0.5" role="meter" aria-label="Context" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={label}>
      <span className="text-[11px] text-[var(--ink-faint)]">Context</span>
      <div className="flex-1 h-1 rounded-full bg-[var(--rule)] overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--status-draft)' : 'var(--ink-muted)' }}
        />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-[var(--ink-muted)]">{Math.round(pct)}%</span>
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

  const cell = (key: StatKey, className: string) => (
    <Tooltip tip={tips[key]} disabled={open === key} className={`block ${className}`}>
      <button
        ref={(el) => { cellRefs.current[key] = el }}
        type="button"
        onClick={() => toggle(key)}
        aria-label={`${STAT_NAMES[key]}: ${tips[key]}`}
        aria-haspopup="dialog"
        aria-expanded={open === key}
        className={`w-full h-full text-left px-3 py-2.5 transition-colors hover:bg-[var(--paper-sunken)] ${open === key ? 'bg-[var(--paper-sunken)]' : ''}`}
      >
        {key === 'experience' ? <ExperienceCell stat={stats.experience} /> : <PowerCell name={STAT_NAMES[key]} stat={stats[key]} />}
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
          top={popTop}
          anchor={cellRefs.current[open] ?? null}
          title={STAT_NAMES[open]}
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

function ExperienceCell({ stat }: { stat: ExperienceStat }) {
  const pct = Math.round(Math.min(1, Math.max(0, stat.progress)) * 100)
  return (
    <span className="block space-y-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">Experience</span>
        <span className="font-mono text-[12px] tabular-nums">Lv {stat.level}</span>
      </span>
      <span className="block h-1.5 rounded-full bg-[var(--rule)] overflow-hidden" aria-hidden="true">
        <span className="block h-full rounded-full bg-[var(--ink)]" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function PowerCell({ name, stat }: { name: string; stat: PowerStat }) {
  return (
    <span className="flex items-center justify-between gap-2 min-h-[22px]">
      <span className="text-[13px] font-semibold">{name}</span>
      <Segments kinds={powerSegments(stat)} />
    </span>
  )
}

const SEGMENT_CLASS: Record<SegmentKind, string> = {
  open: 'bg-[var(--ink)]',
  'open-high': 'bg-[var(--status-draft)]',
  gated: 'border-[1.5px] border-[var(--ink-muted)]',
  empty: 'bg-[var(--rule)]'
}

function Segments({ kinds }: { kinds: SegmentKind[] }) {
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      {kinds.map((k, i) => (
        <span key={i} className={`block w-[10px] h-[10px] rounded-[2px] ${SEGMENT_CLASS[k]}`} />
      ))}
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
  const factors = stat.factors.slice().sort((a, b) => b.points - a.points)
  const hasGated = factors.some((f) => f.gated && f.points > 0)
  return (
    <>
      <p className="text-[12px] text-[var(--ink-muted)] tabular-nums">
        {stat.segments} of 5{stat.gated > 0 ? `, ${stat.gated} gated` : ''}
      </p>
      {factors.length === 0 ? (
        <p className="text-[12px] text-[var(--ink-muted)]">No settings add to this yet.</p>
      ) : (
        <ul className="-mx-1.5">
          {factors.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onNavigate(f.configPath)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded text-left text-[12px] hover:bg-[var(--paper-sunken)]"
              >
                <FactorMarker kind={f.points < 0 ? 'mitigation' : f.gated ? 'gated' : 'open'} />
                <span className={`flex-1 min-w-0 ${f.points < 0 ? 'text-[var(--ink-muted)]' : ''}`}>{f.label}</span>
                <span className="font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">{formatPoints(f.points)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ink-faint)]">
        <span className="flex items-center gap-1"><FactorMarker kind="open" />Runs without approval</span>
        {hasGated && <span className="flex items-center gap-1"><FactorMarker kind="gated" />Needs approval</span>}
      </p>
    </>
  )
}

function FactorMarker({ kind }: { kind: 'open' | 'gated' | 'mitigation' }) {
  if (kind === 'mitigation') {
    return <span className="shrink-0 w-[8px] h-[2px] bg-[var(--ink-faint)]" aria-label="Lowers this stat" role="img" />
  }
  return (
    <span
      role="img"
      aria-label={kind === 'gated' ? 'Needs approval' : 'Runs without approval'}
      className={`shrink-0 block w-[8px] h-[8px] rounded-[2px] ${kind === 'gated' ? 'border-[1.5px] border-[var(--ink-muted)]' : 'bg-[var(--ink)]'}`}
    />
  )
}

function ExperienceDetail({ stat }: { stat: ExperienceStat }) {
  const rows = stat.breakdown.filter((b) => b.value > 0 && Math.round(b.xp) > 0)
  return (
    <>
      <p className="text-[12px] text-[var(--ink-muted)] tabular-nums">
        Level {stat.level} · {compactCount(Math.floor(stat.score))} of {compactCount(stat.nextLevelAt)} XP
      </p>
      {rows.length > 0 && (
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="py-0.5">{b.label}</td>
                <td className="py-0.5 pl-2 text-right font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">{compactCount(b.value)}</td>
                <td className="py-0.5 pl-2 text-right font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">+{compactCount(Math.round(b.xp))} XP</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[12px] text-[var(--ink-muted)]">{stat.nextLevel.hint}.</p>
    </>
  )
}
