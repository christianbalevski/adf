import { memo, useMemo } from 'react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useFleetStore } from '../../stores/fleet.store'
import { pathBasename } from './fleet-layout'

function formatBurn(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens)}`
}

/**
 * Fleet alert layer — the "needs me" queue plus the resource bar
 * (state counts + token burn). Sits under the top bar; queue entries
 * jump the viewport to the agent.
 * Hotkeys: `.` cycles agents awaiting input, `,` cycles idle agents.
 */
export const FleetAlertBar = memo(function FleetAlertBar({
  onFocusAgent,
  onSelectGroup
}: {
  onFocusAgent: (filePath: string) => void
  /** Recall a named group — select its members and fly to them */
  onSelectGroup: (filePaths: string[]) => void
}) {
  const namedGroups = useFleetStore((s) => s.namedGroups)
  const setNamedGroups = useFleetStore((s) => s.setNamedGroups)
  const lens = useFleetStore((s) => s.lens)
  const cycleLens = useFleetStore((s) => s.cycleLens)
  const voicesOverride = useFleetStore((s) => s.voicesOverride)
  const setVoicesOverride = useFleetStore((s) => s.setVoicesOverride)
  const voicesOn = voicesOverride ?? lens === 'terrain'

  const deleteGroup = async (name: string) => {
    const rest = { ...namedGroups }
    delete rest[name]
    setNamedGroups(rest)
    try {
      await window.adfApi.setSettings({ fleetGroups: rest })
    } catch { /* store already updated; settings retry on next save */ }
  }
  const agents = useMeshStore((s) => s.agents)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const fleetBurn = useFleetStore((s) => s.burn?.fleet)
  const perAgentBurn = useFleetStore((s) => s.burn?.perAgent)
  const activityPulse = useMeshGraphStore((s) => s.activityPulse)
  const messagePulse = useMeshGraphStore((s) => s.messagePulse)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)

  // Fleet rates over the rolling 5-min window
  const rates = useMemo(() => {
    const now = Date.now()
    const inWindow = (ts: number[]) => ts.filter((t) => now - t < 5 * 60_000).length
    return {
      toolsPerMin: inWindow(activityPulse) / 5,
      msgsPerMin: inWindow(messagePulse) / 5
    }
  }, [activityPulse, messagePulse])

  // MVP chip: hottest agent by burn; falls back to most recent tool activity
  const mvp = useMemo(() => {
    let best: { filePath: string; label: string } | null = null
    let bestBurn = 0
    if (perAgentBurn) {
      for (const [filePath, entry] of Object.entries(perAgentBurn)) {
        if (entry.tokensPerMin > bestBurn) {
          bestBurn = entry.tokensPerMin
          best = { filePath, label: `${formatBurn(entry.tokensPerMin)}/m` }
        }
      }
    }
    if (!best) {
      let latest = 0
      for (const [filePath, acts] of Object.entries(nodeActivities)) {
        const last = acts.length > 0 ? acts[acts.length - 1].timestamp : 0
        if (last > latest) {
          latest = last
          best = { filePath, label: 'active' }
        }
      }
    }
    if (!best) return null
    const agent = agents.find((a) => a.filePath === best!.filePath)
    if (!agent) return null
    return { ...best, handle: agent.handle, icon: agent.icon }
  }, [perAgentBurn, nodeActivities, agents])

  const counts = useMemo(() => {
    let active = 0
    let idle = 0
    let error = 0
    let offline = 0
    for (const a of agents) {
      if (!a.online) offline++
      else if (a.state === 'active') active++
      else if (a.state === 'idle') idle++
      else if (a.state === 'error') error++
    }
    return { active, idle, error, offline }
  }, [agents])

  const queue = useMemo(() => {
    const handleByPath = new Map(agents.map((a) => [a.filePath, a.handle]))
    return Object.entries(pendingInteractions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, pending]) => ({
        filePath,
        pending,
        handle: handleByPath.get(filePath) ?? pathBasename(filePath).replace('.adf', '')
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
        {counts.offline > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500" title="Offline agents (not started)">
            <span className="w-1.5 h-1.5 rounded-full border border-dashed border-neutral-400" />
            {counts.offline}
          </span>
        )}
        {fleetBurn && fleetBurn.totalTokens > 0 && (
          <>
            <span className="w-px h-3 bg-neutral-200 dark:bg-neutral-700" />
            <span
              className="flex items-center gap-1 text-[11px] text-orange-500 dark:text-orange-400 tabular-nums"
              title={`Fleet tokens this session: ${fleetBurn.totalTokens.toLocaleString()} · ↑ ${Math.round(fleetBurn.inPerMin ?? 0)} in / ↓ ${Math.round(fleetBurn.outPerMin ?? 0)} out tokens/min (5-min window)`}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
              </svg>
              Σ {formatBurn(fleetBurn.totalTokens)}
              {fleetBurn.tokensPerMin > 0 && (
                <>
                  <span className="text-neutral-400 dark:text-neutral-500">↑{formatBurn(fleetBurn.inPerMin ?? 0)}</span>
                  <span className="text-orange-400/90 dark:text-orange-500/90">↓{formatBurn(fleetBurn.outPerMin ?? 0)}/m</span>
                </>
              )}
            </span>
          </>
        )}
        {(rates.toolsPerMin > 0 || rates.msgsPerMin > 0) && (
          <>
            <span className="w-px h-3 bg-neutral-200 dark:bg-neutral-700" />
            {rates.toolsPerMin > 0 && (
              <span
                className="flex items-center gap-1 text-[11px] text-blue-500 dark:text-blue-400 tabular-nums"
                title={`Fleet tool calls per minute (5-min window)`}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                {rates.toolsPerMin < 10 ? rates.toolsPerMin.toFixed(1) : Math.round(rates.toolsPerMin)}/m
              </span>
            )}
            {rates.msgsPerMin > 0 && (
              <span
                className="flex items-center gap-1 text-[11px] text-violet-500 dark:text-violet-400 tabular-nums"
                title={`Agent-to-agent messages per minute (5-min window)`}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                {rates.msgsPerMin < 10 ? rates.msgsPerMin.toFixed(1) : Math.round(rates.msgsPerMin)}/m
              </span>
            )}
          </>
        )}
      </div>

      {/* Named groups — click to recall, × to forget */}
      {Object.keys(namedGroups).length > 0 && (
        <div className="flex items-center gap-1 pointer-events-auto">
          {Object.entries(namedGroups).map(([name, members]) => (
            <span
              key={name}
              className="group flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm select-none"
            >
              <button
                onClick={() => onSelectGroup(members)}
                className="flex items-center gap-1 text-[11px] font-medium text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white"
                title={`Select ${members.length} agent${members.length !== 1 ? 's' : ''}`}
              >
                {name}
                <span className="text-[10px] text-neutral-400">{members.length}</span>
              </button>
              <button
                onClick={() => deleteGroup(name)}
                className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-neutral-300 dark:text-neutral-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 opacity-0 group-hover:opacity-100"
                title="Forget group"
              >
                <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Lens — same map, different question; L cycles */}
      <button
        onClick={cycleLens}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-sm border shadow-sm pointer-events-auto select-none text-[11px] font-medium transition-colors ${
          lens === 'terrain'
            ? 'bg-white/85 dark:bg-neutral-900/85 border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            : 'bg-indigo-50/90 dark:bg-indigo-950/70 border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-300'
        }`}
        title="Map lens — recolor the hexes to answer one question: terrain (state), burn (token heat), model (which LLM), health (where the problems are). Press L to cycle."
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
        </svg>
        {lens}
      </button>

      {/* Voice-chip layer — group statuses floating over the plots. Auto:
          on for terrain, yields to diagnostic lenses; V (or click) forces */}
      <button
        onClick={() => setVoicesOverride(!voicesOn)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-sm border shadow-sm pointer-events-auto select-none text-[11px] font-medium transition-colors ${
          voicesOn
            ? 'bg-white/85 dark:bg-neutral-900/85 border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            : 'bg-white/60 dark:bg-neutral-900/60 border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-400 dark:text-neutral-600 hover:text-neutral-600 dark:hover:text-neutral-300'
        }`}
        title="Voices — group status chips over the plots. On by default for terrain, hidden on diagnostic lenses. Press V to toggle."
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-5.6a8.38 8.38 0 0 1-.8-3.9 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z" />
        </svg>
        voices{voicesOn ? '' : ' off'}
      </button>

      {/* Hottest burner right now — a gauge, not a trophy; click to fly there */}
      {mvp && (
        <button
          onClick={() => onFocusAgent(mvp.filePath)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm pointer-events-auto select-none hover:border-orange-300 dark:hover:border-orange-700"
          title="Highest token burn right now — click to fly there"
        >
          <span className="text-[11px]">🔥</span>
          {mvp.icon && <span className="text-[12px] leading-none">{mvp.icon}</span>}
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-200">{mvp.handle}</span>
          <span className="text-[10px] text-orange-500 dark:text-orange-400 tabular-nums">{mvp.label}</span>
        </button>
      )}

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
