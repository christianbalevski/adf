import { useAgentStore, type AgentState } from '../../stores/agent.store'

const stateConfig: Record<AgentState, { label: string; color: string; ring?: boolean; pulse?: boolean }> = {
  active: { label: 'Active', color: 'bg-yellow-400', pulse: true },
  idle: { label: 'Idle', color: 'bg-green-400' },
  hibernate: { label: 'Hibernate', color: 'bg-purple-500' },
  suspended: { label: 'Suspended', color: 'border-red-400', ring: true },
  error: { label: 'Error', color: 'bg-red-400' },
  off: { label: 'Off', color: 'bg-neutral-400' }
}

export function AgentStatus() {
  const state = useAgentStore((s) => s.state)
  const { label, color, ring, pulse } = stateConfig[state] ?? stateConfig.off

  return (
    <div className="flex items-center gap-2">
      {ring ? (
        <div className={`w-2 h-2 rounded-full border-[1.5px] ${color}`} />
      ) : pulse ? (
        <div className="relative w-2 h-2">
          <div className={`absolute inset-0 rounded-full ${color} animate-ping opacity-75`} />
          <div className={`relative w-2 h-2 rounded-full ${color}`} />
        </div>
      ) : (
        <div className={`w-2 h-2 rounded-full ${color}`} />
      )}
      <span className="text-xs text-neutral-500 dark:text-neutral-400">{label}</span>
    </div>
  )
}
