import { useCallback, useEffect, useState } from 'react'
import type {
  DashboardQuickStats,
  DashboardProviderTests,
  DashboardContainers,
  DashboardAgentStats,
} from '../../../shared/types/ipc.types'

/**
 * Progressive dashboard data hook.
 *
 * Fires four IPC slices in parallel on mount and exposes each slice
 * independently with its own loading flag, so tiles can render as soon
 * as their slice resolves rather than blocking on the slowest one
 * (typically the .adf peek scan or provider tests at first launch).
 *
 * `refresh()` re-fires all four; call it from a manual refresh button.
 */
export function useDashboardData() {
  const [quick, setQuick] = useState<DashboardQuickStats | null>(null)
  const [providerTests, setProviderTests] = useState<DashboardProviderTests | null>(null)
  const [containers, setContainers] = useState<DashboardContainers | null>(null)
  const [agentStats, setAgentStats] = useState<DashboardAgentStats | null>(null)

  const [loadingQuick, setLoadingQuick] = useState(true)
  const [loadingProviderTests, setLoadingProviderTests] = useState(true)
  const [loadingContainers, setLoadingContainers] = useState(true)
  const [loadingAgentStats, setLoadingAgentStats] = useState(true)

  const refresh = useCallback(() => {
    setLoadingQuick(true)
    setLoadingProviderTests(true)
    setLoadingContainers(true)
    setLoadingAgentStats(true)

    // Fire all four in parallel; each updates its slice when it resolves.
    // On failure we keep the last known value rather than clearing to null
    // — clearing during a refresh would briefly flip downstream UI (like
    // the GettingStarted collapsed bar) into its "no data yet" state, which
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

    window.adfApi?.getDashboardContainers()
      .then(setContainers)
      .catch(() => { /* preserve previous slice */ })
      .finally(() => setLoadingContainers(false))

    window.adfApi?.getDashboardAgentStats()
      .then(setAgentStats)
      .catch(() => { /* preserve previous slice */ })
      .finally(() => setLoadingAgentStats(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Podman often boots after the app — the first probe at home-mount may
  // return 0 even though the shared `adf-mcp` container is about to start.
  // Re-probe containers every 4s while the home screen is mounted so the
  // tile fills in once podman is up. (Cheap call; only refreshes one slice.)
  useEffect(() => {
    const interval = setInterval(() => {
      window.adfApi?.getDashboardContainers()
        .then(setContainers)
        .catch(() => { /* keep last value */ })
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  const anyLoading = loadingQuick || loadingProviderTests || loadingContainers || loadingAgentStats

  return {
    quick,
    providerTests,
    containers,
    agentStats,
    loading: {
      quick: loadingQuick,
      providerTests: loadingProviderTests,
      containers: loadingContainers,
      agentStats: loadingAgentStats,
      any: anyLoading,
    },
    refresh,
  }
}
