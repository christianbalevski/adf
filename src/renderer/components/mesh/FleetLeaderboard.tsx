import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useMeshGraphStore, type NodeActivity } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useFleetStore } from '../../stores/fleet.store'
import { ACTIVITY_TYPE_MARKS } from './MeshGraphNode'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

const ROW_H = 46
const MAX_ROWS = 10
const RANK_WINDOW_MS = 5 * 60_000
/** How long a position-change arrow stays lit after an overtake */
const DELTA_FLASH_MS = 6000

const STATE_DOT: Record<string, string> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400',
  hibernate: 'bg-sky-400',
  suspended: 'bg-orange-400'
}

interface RankedAgent {
  agent: FleetAgentStatus
  score: number
  lastAt: number
  latest: NodeActivity | null
}

/** The agent's most recent signal — tool reason, say-text, llm usage, or status */
function radioLine(r: RankedAgent): { mark: string; markColor: string; text: string } {
  const a = r.latest
  if (a) {
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
  return { mark: '·', markColor: 'text-neutral-400', text: r.agent.state }
}

/**
 * F1-style live leaderboard — the 10 most active agents ranked by events in
 * the rolling 5-min window. Rows swap position with an animated slide and a
 * brief ▲/▼ flash on overtakes; the second line carries the agent's latest
 * "radio": tool call + _reason, spoken text, or status. Click flies to the
 * agent.
 */
export const FleetLeaderboard = memo(function FleetLeaderboard({
  onFocusAgent
}: {
  onFocusAgent: (filePath: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  // Re-rank on a slow tick — pole positions should swap deliberately, not
  // thrash on every event. Store reads happen inside the memo via getState.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo<RankedAgent[]>(() => {
    void tick
    const now = Date.now()
    const { agentPulse, nodeActivities } = useMeshGraphStore.getState()
    const burn = useFleetStore.getState().burn?.perAgent
    const ranked: RankedAgent[] = []
    for (const agent of useMeshStore.getState().agents) {
      const pulse = agentPulse[agent.filePath]
      const score = pulse ? pulse.filter((t) => now - t < RANK_WINDOW_MS).length : 0
      if (score === 0) continue
      const acts = nodeActivities[agent.filePath]
      const latest = acts && acts.length > 0 ? acts[acts.length - 1] : null
      ranked.push({ agent, score, lastAt: latest?.timestamp ?? 0, latest })
    }
    ranked.sort((a, b) =>
      b.score - a.score ||
      (burn?.[b.agent.filePath]?.tokensPerMin ?? 0) - (burn?.[a.agent.filePath]?.tokensPerMin ?? 0) ||
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
        >
          <span className="flex items-center gap-1.5">
            <span>🏁</span>
            Leaderboard
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
                    i === 0 ? 'bg-amber-50/60 dark:bg-amber-500/[0.07]' : ''
                  }`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                  title={r.latest?.detail ?? `${r.agent.handle} — ${r.score} events / 5 min`}
                >
                  <span className={`w-5 shrink-0 text-right font-mono text-[11px] tabular-nums ${
                    i === 0 ? 'text-amber-500 font-semibold' : 'text-neutral-400 dark:text-neutral-500'
                  }`}>
                    {i + 1}
                  </span>
                  <span className="w-3 shrink-0 text-[9px] font-mono">
                    {showDelta > 0 && <span className="text-green-500">▲</span>}
                    {showDelta < 0 && <span className="text-red-400">▼</span>}
                  </span>
                  <span className="shrink-0 text-base leading-none">{r.agent.icon ?? '·'}</span>
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
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500" title="Events in the last 5 min">
                    {r.score}
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
