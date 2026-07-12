import { memo, useMemo } from 'react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'

/**
 * Fleet alert layer — the "needs me" queue plus fleet state counts.
 * Sits under the top bar; entries jump the viewport to the agent.
 * Hotkeys: `.` cycles agents awaiting input, `,` cycles idle agents.
 */
export const FleetAlertBar = memo(function FleetAlertBar({
  onFocusAgent
}: {
  onFocusAgent: (filePath: string) => void
}) {
  const agents = useMeshStore((s) => s.agents)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)

  const counts = useMemo(() => {
    let active = 0
    let idle = 0
    let error = 0
    for (const a of agents) {
      if (a.state === 'active') active++
      else if (a.state === 'idle') idle++
      else if (a.state === 'error') error++
    }
    return { active, idle, error }
  }, [agents])

  const queue = useMemo(() => {
    const handleByPath = new Map(agents.map((a) => [a.filePath, a.handle]))
    return Object.entries(pendingInteractions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, pending]) => ({
        filePath,
        pending,
        handle: handleByPath.get(filePath) ?? filePath.split('/').pop()?.replace('.adf', '') ?? filePath
      }))
  }, [agents, pendingInteractions])

  return (
    <div className="absolute top-10 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 pointer-events-none">
      {/* Fleet state counts */}
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm pointer-events-auto select-none">
        <span className="flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300" title="Active agents">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
          {counts.active}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300" title="Idle agents (press , to cycle)">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
          {counts.idle}
        </span>
        {counts.error > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-red-500" title="Agents in error state">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            {counts.error}
          </span>
        )}
      </div>

      {/* Needs-me queue */}
      {queue.length > 0 && (
        <div className="flex items-center gap-1.5 min-w-0 pointer-events-auto">
          <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 shrink-0 select-none">
            Needs you ({queue.length})
          </span>
          <div className="flex items-center gap-1 overflow-x-auto min-w-0">
            {queue.map(({ filePath, handle, pending }) => (
              <button
                key={filePath}
                onClick={() => onFocusAgent(filePath)}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 whitespace-nowrap shrink-0"
                title={pending.type === 'ask' ? pending.question : `Approve ${pending.toolName}?`}
              >
                <span className="font-medium">{handle}</span>
                <span className="text-amber-500 dark:text-amber-400">
                  {pending.type === 'ask' ? 'asks' : `wants ${pending.toolName}`}
                </span>
              </button>
            ))}
          </div>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0 select-none hidden sm:inline">
            press <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">.</kbd> to cycle
          </span>
        </div>
      )}
    </div>
  )
})
