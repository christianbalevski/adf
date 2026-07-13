import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useMeshGraphStore, type NodeActivity } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useFleetStore } from '../../stores/fleet.store'
import { ACTIVITY_TYPE_MARKS } from './MeshGraphNode'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

const ROW_H = 46
const MAX_ROWS = 10
const RANK_WINDOW_MS = 5 * 60_000
/** How long a position-change arrow stays lit after an overtake */
const DELTA_FLASH_MS = 6000
/** Burn this many × above the agent's own baseline reads as a deviation */
const DEVIATION_FACTOR = 4
/** …but only once burn is high enough to matter at all (tokens/min) */
const DEVIATION_FLOOR = 2000

const STATE_DOT: Record<string, string> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400',
  hibernate: 'bg-sky-400',
  suspended: 'bg-orange-400'
}

function formatBurn(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M/m`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k/m`
  return `${Math.round(tokens)}/m`
}

interface RankedAgent {
  agent: FleetAgentStatus
  burn: number
  events: number
  lastAt: number
  latest: NodeActivity | null
  /** Burn is far above this agent's own baseline — behavior changed */
  deviant: boolean
}

/**
 * The agent's most recent signal — real work first (tool reason, say-text,
 * llm usage, messages), then the self-written status line; a bare state flip
 * is the signal of last resort.
 */
function radioLine(r: RankedAgent): { mark: string; markColor: string; text: string } {
  const a = r.latest
  if (a && a.type !== 'state') {
    const typeMark = ACTIVITY_TYPE_MARKS[a.type]
    if (a.type === 'tool_start') {
      return {
        mark: '·',
        markColor: a.isError ? 'text-red-400' : 'text-neutral-400',
        text: a.args ? `${a.toolName} — ${a.args}` : a.toolName
      }
    }
    if (a.type === 'message_sent') return { mark: '>', markColor: 'text-purple-400', text: a.args ? `msg_send ${a.args}` : 'msg_send' }
    if (a.type === 'message_recv') return { mark: '<', markColor: 'text-purple-400', text: a.args ? `msg from ${a.args}` : 'msg received' }
    return {
      mark: typeMark?.mark ?? '·',
      markColor: typeMark?.markColor ?? 'text-neutral-400',
      text: a.args ?? a.toolName
    }
  }
  if (r.agent.status) return { mark: '·', markColor: 'text-neutral-400', text: r.agent.status }
  if (a) {
    // State entry args already carry the arrow ('→ active') — no extra mark
    return { mark: '→', markColor: 'text-neutral-400', text: (a.args ?? '').replace(/^→\s*/, '') || r.agent.state }
  }
  return { mark: '·', markColor: 'text-neutral-400', text: r.agent.state }
}

/**
 * Burn panel — where the fleet's attention (and tokens) are going. A resource
 * readout, not a scoreboard: rows rank by tokens/min with recent events as
 * tiebreak, slide on rank changes with a brief ▲/▼ flash, and stay neutral
 * unless an agent's burn jumps far above its own baseline — deviation from
 * self, not rank against others, is what earns the amber. The second line is
 * the agent's latest radio (tool + _reason, spoken text, or status) so the
 * user can judge whether the burn is earning anything. Click flies to the
 * agent.
 */
export const FleetLeaderboard = memo(function FleetLeaderboard({
  onFocusAgent
}: {
  onFocusAgent: (filePath: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  // Re-rank on a slow tick — positions should swap deliberately, not thrash
  // on every event. Store reads happen inside the memo via getState.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo<RankedAgent[]>(() => {
    void tick
    const now = Date.now()
    const { agentPulse, nodeActivities } = useMeshGraphStore.getState()
    const { burn: burnResult, burnBaseline } = useFleetStore.getState()
    const perAgent = burnResult?.perAgent
    const ranked: RankedAgent[] = []
    for (const agent of useMeshStore.getState().agents) {
      const pulse = agentPulse[agent.filePath]
      const events = pulse ? pulse.filter((t) => now - t < RANK_WINDOW_MS).length : 0
      const burn = perAgent?.[agent.filePath]?.tokensPerMin ?? 0
      if (events === 0 && burn === 0) continue
      const acts = nodeActivities[agent.filePath]
      // Last real work beats a trailing state flip in the radio line
      const latest = acts && acts.length > 0
        ? acts.findLast((x) => x.type !== 'state') ?? acts[acts.length - 1]
        : null
      const baseline = burnBaseline[agent.filePath] ?? 0
      ranked.push({
        agent,
        burn,
        events,
        lastAt: latest?.timestamp ?? 0,
        latest,
        deviant: burn > DEVIATION_FLOOR && baseline > 0 && burn > DEVIATION_FACTOR * baseline
      })
    }
    ranked.sort((a, b) =>
      b.burn - a.burn ||
      b.events - a.events ||
      b.lastAt - a.lastAt ||
      a.agent.filePath.localeCompare(b.agent.filePath)
    )
    return ranked.slice(0, MAX_ROWS)
  }, [tick])

  // Overtake detection — previous rank per agent, flash timestamps per change
  const prevRankRef = useRef<Map<string, number>>(new Map())
  const deltaRef = useRef<Map<string, { delta: number; at: number }>>(new Map())
  useEffect(() => {
    const prev = prevRankRef.current
    const next = new Map<string, number>()
    rows.forEach((r, i) => {
      next.set(r.agent.filePath, i)
      const was = prev.get(r.agent.filePath)
      if (was !== undefined && was !== i) {
        deltaRef.current.set(r.agent.filePath, { delta: was - i, at: Date.now() })
      }
    })
    prevRankRef.current = next
  }, [rows])

  if (rows.length === 0) return null

  return (
    <div className="absolute left-3 top-[4.7rem] z-10 w-[280px] pointer-events-auto select-none">
      <div className="rounded-lg bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm overflow-hidden">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 transition-colors"
          title="Where the fleet's tokens are going — amber means burn far above the agent's own baseline"
        >
          <span className="flex items-center gap-1.5">
            <span>🔥</span>
            Burn
          </span>
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {!collapsed && (
          <div className="relative overflow-y-auto max-h-[55vh]" style={{ height: rows.length * ROW_H }}>
            {rows.map((r, i) => {
              const fp = r.agent.filePath
              const flash = deltaRef.current.get(fp)
              const showDelta = flash && Date.now() - flash.at < DELTA_FLASH_MS ? flash.delta : 0
              const radio = radioLine(r)
              return (
                <button
                  key={fp}
                  onClick={() => onFocusAgent(fp)}
                  className={`absolute left-0 right-0 flex items-center gap-2 px-2.5 text-left transition-[top] duration-700 ease-in-out hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 ${
                    r.deviant ? 'bg-amber-50/70 dark:bg-amber-500/10' : ''
                  }`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                  title={r.latest?.detail ?? (r.deviant
                    ? `${r.agent.handle} — burn is >${DEVIATION_FACTOR}× its usual rate`
                    : `${r.agent.handle} — ${r.events} events / 5 min`)}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                    {i + 1}
                  </span>
                  <span className="w-3 shrink-0 text-[9px] font-mono">
                    {showDelta > 0 && <span className="text-green-500">▲</span>}
                    {showDelta < 0 && <span className="text-red-400">▼</span>}
                  </span>
                  <span className="shrink-0 text-base leading-none">
                    {r.agent.icon || pickAgentIcon(r.agent.agentId || r.agent.filePath)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-200">
                        {r.agent.handle}
                      </span>
                      <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${STATE_DOT[r.agent.state] ?? 'bg-neutral-400'}`} />
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
                      <span className={`shrink-0 font-mono ${radio.markColor}`}>{radio.mark}</span>
                      <span className="truncate">{radio.text}</span>
                    </span>
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[10px] tabular-nums ${
                      r.deviant ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-neutral-400 dark:text-neutral-500'
                    }`}
                    title={r.burn > 0 ? 'Tokens per minute (5-min window)' : 'Events in the last 5 min'}
                  >
                    {r.burn > 0 ? formatBurn(r.burn) : r.events}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})
