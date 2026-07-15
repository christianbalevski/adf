import { memo, useEffect, useMemo, useState } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useFleetStore } from '../../stores/fleet.store'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

const STATE_DOT: Record<string, string> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400',
  hibernate: 'bg-sky-400',
  suspended: 'bg-orange-400'
}

/** Coarse status age: now → 1m → 4m → 15m → 2h → 3d */
function formatAge(ms: number): string {
  if (ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

interface StewardRow {
  dir: string
  label: string
  agent: FleetAgentStatus
}

/**
 * Stewards panel — the chain of command's status board. One row per appointed
 * steward: which group it speaks for, its full status line (the group
 * summary it maintains), and how stale that line is. This is the most
 * load-bearing info on the map — a steward's status IS the group's status —
 * so it gets its own always-visible list instead of living only in truncated
 * territory labels. Click flies to the steward.
 */
export const FleetStewardsPanel = memo(function FleetStewardsPanel({
  onFocusAgent
}: {
  onFocusAgent: (filePath: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const stewards = useFleetStore((s) => s.stewards)
  const agents = useMeshStore((s) => s.agents)

  // Age chips need to tick even when nothing else re-renders
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo<StewardRow[]>(() => {
    const byDid = new Map(agents.filter((a) => a.did).map((a) => [a.did!, a]))
    const out: StewardRow[] = []
    for (const [dir, did] of Object.entries(stewards)) {
      const agent = byDid.get(did)
      if (!agent) continue // steward's DID no longer on the map — reappoint
      const root = agent.trackedDirRoot
      const rootName = root ? root.split('/').filter(Boolean).pop() ?? root : ''
      const inRoot = !!root && (dir === root || dir.startsWith(root + '/'))
      const label = !inRoot
        ? dir.split('/').pop() ?? dir
        : dir === root ? rootName : `${rootName}/${dir.slice(root!.length + 1)}`
      out.push({ dir, label, agent })
    }
    out.sort((a, b) => a.label.localeCompare(b.label))
    return out
  }, [stewards, agents])

  if (rows.length === 0) return null
  const now = Date.now()

  return (
    <div className="rounded-lg bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm overflow-hidden pointer-events-auto select-none">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 transition-colors"
        title="Appointed stewards — each status line speaks for its whole group"
      >
        <span className="flex items-center gap-1.5">
          <span>♛</span>
          Stewards
        </span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {!collapsed && (
        <div className="overflow-y-auto max-h-[40vh]">
          {rows.map((r) => {
            const isGhost = r.agent.online === false
            const age = r.agent.statusSince ? formatAge(now - r.agent.statusSince) : null
            return (
              <button
                key={r.dir}
                onClick={() => onFocusAgent(r.agent.filePath)}
                className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 border-t border-neutral-100 dark:border-neutral-800/60"
                title={`${r.agent.handle} — steward of ${r.label}${r.agent.status ? `\n${r.agent.status}` : ''}`}
              >
                <span className={`shrink-0 text-base leading-none mt-px ${isGhost ? 'grayscale opacity-60' : ''}`}>
                  {r.agent.icon || pickAgentIcon(r.agent.agentId || r.agent.filePath)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-200">
                      {r.label}
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
                      ♛ {r.agent.handle}
                    </span>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${
                      isGhost ? 'border border-dashed border-neutral-400' : STATE_DOT[r.agent.state] ?? 'bg-neutral-400'
                    }`} />
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className="flex-1 min-w-0 text-[10px] leading-snug text-neutral-500 dark:text-neutral-400"
                      style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}
                    >
                      {r.agent.status || (isGhost ? 'not started' : 'no status reported')}
                    </span>
                    {age && (
                      <span className="shrink-0 text-[9px] tabular-nums text-neutral-400 dark:text-neutral-500">
                        {age}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})
