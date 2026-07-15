import { memo, useMemo } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore, type NodeActivity } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { ACTIVITY_TYPE_MARKS } from './MeshGraphNode'
import type { AgentState } from '../../../shared/types/ipc.types'

/**
 * Hover preview — a screen-space card that stays readable at any zoom, so
 * you can peek at an agent's vitals and recent activity from orbit without
 * flying in. Pointer-transparent; positioned next to the cursor, flipped
 * away from window edges.
 */

const CARD_W = 300
const CARD_EST_H = 260

const STATE_LABEL: Partial<Record<AgentState, string>> = {
  active: 'active',
  idle: 'idle',
  hibernate: 'hibernating',
  suspended: 'suspended',
  error: 'error',
  off: 'off'
}

const STATE_DOT_CLASS: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  hibernate: 'bg-purple-400',
  suspended: 'bg-red-300',
  error: 'bg-red-400',
  off: 'bg-neutral-400'
}

const TOOL_COLORS: Record<string, string> = {
  fs: 'text-blue-500 dark:text-blue-400',
  db: 'text-green-500 dark:text-green-400',
  msg: 'text-purple-500 dark:text-purple-400',
  sys: 'text-orange-500 dark:text-orange-400',
  loop: 'text-neutral-500 dark:text-neutral-400'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

function formatEta(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const emptyActivities: NodeActivity[] = []

export const FleetHoverCard = memo(function FleetHoverCard({
  filePath,
  x,
  y
}: {
  filePath: string
  x: number
  y: number
}) {
  const agent = useMeshStore((s) => s.agents.find((a) => a.filePath === filePath))
  const activities = useMeshGraphStore((s) => s.nodeActivities[filePath] ?? emptyActivities)
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const burnEntry = useFleetStore((s) => s.burn?.perAgent[filePath])

  const position = useMemo(() => {
    const left = x + 18 + CARD_W > window.innerWidth ? x - CARD_W - 18 : x + 18
    const top = Math.min(y + 14, window.innerHeight - CARD_EST_H)
    return { left: Math.max(8, left), top: Math.max(8, top) }
  }, [x, y])

  if (!agent) return null
  const isGhost = agent.online === false
  const recent = activities.slice(-5)

  return (
    <div
      className="fixed z-50 pointer-events-none rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm shadow-xl overflow-hidden"
      style={{ ...position, width: CARD_W, animation: 'meshFadeIn 150ms ease-out' }}
    >
      {/* Identity */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className={`text-2xl leading-none shrink-0 ${isGhost ? 'grayscale opacity-60' : ''}`}>
          {agent.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
              {agent.handle}
            </span>
            <span className={`w-2 h-2 rounded-full shrink-0 ${isGhost ? 'border border-dashed border-neutral-400' : STATE_DOT_CLASS[agent.state] ?? 'bg-neutral-400'}`} />
            {agent.held && (
              <span className="text-[9px] px-1.5 py-px rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 font-medium shrink-0">
                ⏸ held
              </span>
            )}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400 italic truncate">
            {isGhost ? 'not started' : agent.status || STATE_LABEL[agent.state] || agent.state}
          </div>
        </div>
      </div>

      {/* Vitals */}
      <div className="flex items-center gap-1.5 px-3.5 pb-2 flex-wrap">
        {agent.model && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
            {agent.model}
          </span>
        )}
        {burnEntry && burnEntry.totalTokens > 0 && (
          <span
            className="text-[10px] px-1.5 py-px rounded-full bg-orange-50 dark:bg-orange-900/30 text-orange-500 dark:text-orange-400 tabular-nums"
            title="Σ total · ↑ input / ↓ output tokens per minute"
          >
            Σ {formatTokens(burnEntry.totalTokens)}
            {burnEntry.tokensPerMin > 0 ? ` · ↑${formatTokens(burnEntry.inPerMin ?? 0)} ↓${formatTokens(burnEntry.outPerMin ?? 0)}/m` : ''}
          </span>
        )}
        {pending && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 font-medium">
            needs you
          </span>
        )}
        {agent.nextWakeAt && agent.nextWakeAt > Date.now() && (
          <span
            className="text-[10px] px-1.5 py-px rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 tabular-nums"
            title={agent.nextWakeLabel ? `Next timer: ${agent.nextWakeLabel}` : 'Next timer'}
          >
            ⏰ wakes in {formatEta(agent.nextWakeAt - Date.now())}{agent.nextWakeLabel ? ` — ${agent.nextWakeLabel.slice(0, 24)}` : ''}
          </span>
        )}
      </div>

      {/* Recent activity */}
      {recent.length > 0 && (
        <div className="border-t border-neutral-100 dark:border-neutral-800 px-2 py-1.5 space-y-0.5">
          {recent.map((act) => {
            const typeMark = ACTIVITY_TYPE_MARKS[act.type]
            const prefix = act.toolName.split('_')[0]
            const color = typeMark?.nameColor ?? TOOL_COLORS[prefix] ?? 'text-neutral-500 dark:text-neutral-400'
            const mark = typeMark?.mark ?? (act.type === 'message_sent' ? '>' : act.type === 'message_recv' ? '<' : act.isError === true ? '✗' : act.isError === false ? '✓' : '~')
            const markColor = typeMark?.markColor ?? (act.isError === true ? 'text-red-500' : act.isError === false ? 'text-green-500' : 'text-neutral-400')
            return (
              <div key={act.id} className="flex items-center gap-1 text-[10px] leading-tight px-1.5">
                <span className={`font-mono shrink-0 w-3 text-center ${markColor}`}>{mark}</span>
                <span className={`font-medium shrink-0 ${color}`}>{act.toolName}</span>
                {act.args && <span className="text-neutral-500 dark:text-neutral-400 truncate">{act.args}</span>}
              </div>
            )
          })}
        </div>
      )}

      <div className="px-3.5 py-1.5 text-[9px] text-neutral-400 dark:text-neutral-600 border-t border-neutral-100 dark:border-neutral-800">
        double-click to open
      </div>
    </div>
  )
})
