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
  // Re-probe containers while the home screen is mounted so the tile fills
  // in once podman is up. Polls every 4s for the first few ticks (podman
  // usually settles quickly), then backs off to 15s; once main repeatedly
  // reports podman is not installed (`unavailable`), drops to a 60s slow
  // poll instead of stopping — a user installing podman mid-session should
  // see the tile recover without remounting the home screen.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticks = 0
    let unavailableStreak = 0

    const tick = () => {
      window.adfApi?.getDashboardContainers()
        .then((result) => {
          if (cancelled) return
          setContainers(result)
          const unavailable = result.unavailable === true
          unavailableStreak = unavailable ? unavailableStreak + 1 : 0
          schedule()
        })
        .catch(() => { if (!cancelled) schedule() /* keep last value */ })
    }

    const schedule = () => {
      if (cancelled) return
      ticks += 1
      // Podman looks uninstalled — slow poll so an install mid-session
      // is still picked up without hammering the probe.
      const delay = unavailableStreak >= 3 ? 60000 : ticks < 5 ? 4000 : 15000
      timer = setTimeout(tick, delay)
    }

    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
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
