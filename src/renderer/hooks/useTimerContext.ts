import { useMemo } from 'react'
import { useAgentStore } from '../stores/agent.store'
import { timerContext } from '../components/agent/overview/agent-overview-model'
import type { GateFacts, TimerContext } from '../../shared/utils/trigger-gate'

/** Main's gate facts from the store: the state and, in error, `recovery_at`. */
export function useGateFacts(): GateFacts {
  const state = useAgentStore((s) => s.gate)
  const recoveryAt = useAgentStore((s) => s.recoveryAt)
  return useMemo(() => ({ state, recoveryAt }), [state, recoveryAt])
}

/** The timer prediction's context from the store: config and each inner loop's published facts. */
export function useTimerContext(): TimerContext | undefined {
  const config = useAgentStore((s) => s.config)
  const loopFacts = useAgentStore((s) => s.loopGateFacts)
  return useMemo(() => timerContext(config, loopFacts), [config, loopFacts])
}
