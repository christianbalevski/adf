import { memo, useEffect, useMemo, useState } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

const MAX_ROWS = 8

function formatEta(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`
  return `${(ms / 86_400_000).toFixed(1).replace(/\.0$/, '')}d`
}

/** Compact schedule descriptor: once / every 5m / cron expr */
function scheduleText(a: FleetAgentStatus): string {
  const s = a.nextWakeSchedule
  if (!s) return ''
  switch (s.mode) {
    case 'once': return 'once'
    case 'interval': return `every ${formatDuration(s.every_ms)}`
    case 'cron': return s.cron
  }
}

/**
 * Next-up panel — the fleet's timer horizon. When the map is quiet this
 * answers "what fires next, and for whom": one row per agent with a pending
 * timer, soonest first. Countdown + schedule kind + payload excerpt is
 * enough to judge whether the next wake needs a human; the tooltip carries
 * the absolute time and scope. Click flies to the agent.
 */
export const FleetNextUpPanel = memo(function FleetNextUpPanel({
  onFocusAgent
}: {
  onFocusAgent: (filePath: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const agents = useMeshStore((s) => s.agents)

  // Countdowns tick every second — the whole point of the panel is "how long"
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const now = Date.now()
  const rows = useMemo(() => {
    return agents
      .filter((a) => a.nextWakeAt && a.nextWakeAt > Date.now())
      .sort((a, b) => a.nextWakeAt! - b.nextWakeAt!)
      .slice(0, MAX_ROWS)
    // now dependency keeps overdue rows dropping out between polls
  }, [agents, now])

  if (rows.length === 0) return null

  return (
    <div className="rounded-lg bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm overflow-hidden pointer-events-auto select-none">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 transition-colors"
        title="Upcoming timers across the fleet — the next thing that will trigger on its own"
      >
        <span className="flex items-center gap-1.5">
          <span>⏰</span>
          Next up
        </span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {!collapsed && (
        <div className="overflow-y-auto max-h-[30vh]">
          {rows.map((a, i) => {
            const sched = scheduleText(a)
            const scope = a.nextWakeScope === 'system' ? 'lambda' : 'wakes agent'
            return (
              <button
                key={a.filePath}
                onClick={() => onFocusAgent(a.filePath)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60 border-t border-neutral-100 dark:border-neutral-800/60"
                title={`${a.handle} — ${new Date(a.nextWakeAt!).toLocaleString()}\n${scope}${sched ? ` · ${sched}` : ''}${a.nextWakeLabel ? `\n${a.nextWakeLabel}` : ''}`}
              >
                <span className="shrink-0 text-base leading-none">
                  {a.icon || pickAgentIcon(a.agentId || a.filePath)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] font-medium text-neutral-700 dark:text-neutral-200">
                      {a.handle}
                    </span>
                    {sched && (
                      <span className={`shrink-0 text-[9px] px-1 py-px rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500 ${
                        a.nextWakeSchedule?.mode === 'cron' ? 'font-mono' : ''
                      }`}>
                        {sched}
                      </span>
                    )}
                    {a.nextWakeScope === 'system' && (
                      <span className="shrink-0 text-[9px] text-neutral-400 dark:text-neutral-500" title="Runs a system lambda, not the agent loop">
                        λ
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-neutral-500 dark:text-neutral-400">
                    {a.nextWakeLabel || (a.nextWakeScope === 'system' ? 'system lambda' : 'wake agent loop')}
                  </span>
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] tabular-nums ${
                    i === 0 ? 'text-sky-600 dark:text-sky-400 font-semibold' : 'text-neutral-400 dark:text-neutral-500'
                  }`}
                >
                  {formatEta(a.nextWakeAt! - now)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})
