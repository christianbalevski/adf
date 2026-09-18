import { useCallback, useEffect, useState } from 'react'
import type {
  DashboardQuickStats,
  DashboardProviderTests,
  DashboardAgentStats,
} from '../../../shared/types/ipc.types'

/**
 * Progressive dashboard data hook.
 *
 * Fires three IPC slices in parallel on mount and exposes each slice
 * independently with its own loading flag, so the status line can fill in
 * as each resolves rather than blocking on the slowest one (typically the
 * .adf peek scan or provider tests at first launch).
 *
 * `refresh()` re-fires all three.
 */
export type DashboardData = ReturnType<typeof useDashboardData>

export function useDashboardData() {
  const [quick, setQuick] = useState<DashboardQuickStats | null>(null)
  const [providerTests, setProviderTests] = useState<DashboardProviderTests | null>(null)
  const [agentStats, setAgentStats] = useState<DashboardAgentStats | null>(null)

  const [loadingQuick, setLoadingQuick] = useState(true)
  const [loadingProviderTests, setLoadingProviderTests] = useState(true)
  const [loadingAgentStats, setLoadingAgentStats] = useState(true)

  const refresh = useCallback(() => {
    setLoadingQuick(true)
    setLoadingProviderTests(true)
    setLoadingAgentStats(true)

    // Fire all three in parallel; each updates its slice when it resolves.
    // On failure we keep the last known value rather than clearing to null
    // — clearing during a refresh would briefly flip downstream UI (like
    // the status line's count) into its "no data yet" state, which
    // reads as a visual glitch even if the data was previously known good.
    // Initial-load failures stay null anyway because that's the seed value.
    window.adfApi?.getDashboardQuickStats()
      .then(setQuick)
      .catch(() => { /* preserve previous slice */ })
      .finally(() => setLoadingQuick(false))

    window.adfApi?.getDashboardProviderTests()
      .then(setProviderTests)
      .catch(() => { /* preserve previous slice */ })
      .finally(() => setLoadingProviderTests(false))

    window.adfApi?.getDashboardAgentStats()
      .then(setAgentStats)
      .catch(() => { /* preserve previous slice */ })
      .finally(() => setLoadingAgentStats(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const anyLoading = loadingQuick || loadingProviderTests || loadingAgentStats

  return {
    quick,
    providerTests,
    agentStats,
    loading: {
      quick: loadingQuick,
      providerTests: loadingProviderTests,
      agentStats: loadingAgentStats,
      any: anyLoading,
    },
    refresh,
  }
}
