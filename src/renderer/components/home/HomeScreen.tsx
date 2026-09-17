import { useEffect } from 'react'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useMesh } from '../../hooks/useMesh'
import { useDashboardData } from './useDashboardData'
import { OnboardingCanvas } from './OnboardingCanvas'
import { FleetMapCallout } from './FleetMapCallout'
import { HomeDashboard } from './HomeDashboard'
import { NetworkingPanel } from './NetworkingPanel'
import { TrackedDirectoriesPanel } from './TrackedDirectoriesPanel'
import { RegistryGallery } from './RegistryGallery'

/**
 * Home, shown when no .adf is open. Two faces on one data source:
 *
 *  - no agent anywhere yet → the onboarding canvas (one idea, one action);
 *  - otherwise → the operator dashboard, with the registry kept one row
 *    away so more agents are always a click from home.
 *
 * The dashboard is the default face: it owns the per-tile skeletons, so it
 * renders while the agent count is still unknown and stays put if that slice
 * never resolves (`useDashboardData` leaves a failed slice null). Only a
 * resolved count of zero swaps in the canvas.
 */
export function HomeScreen() {
  const { loadDirectories } = useTrackedDirs()
  const { enableMesh } = useMesh()
  const data = useDashboardData()

  // Auto-enable mesh on launch if the user had it on last session, and
  // load the tracked directories so the sidebar/dashboard see the list.
  useEffect(() => {
    loadDirectories()
    window.adfApi?.getSettings().then((s) => {
      if (s?.meshEnabled) enableMesh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const firstRun = data.agentStats !== null && data.agentStats.total === 0

  return (
    <div className="relative flex-1 flex flex-col items-center justify-start gap-4 text-neutral-500 dark:text-neutral-400 overflow-y-auto py-6">
      {firstRun ? (
        <>
          {/* Ambient wash across the whole pane behind the hero — the accent
              at a whisper, so the screen has a top and a bottom instead of
              one flat sheet. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-80"
            style={{
              background:
                'radial-gradient(80% 70% at 50% 0%, color-mix(in srgb, var(--adf-ui-accent) 16%, transparent), transparent 100%)'
            }}
          />
          <OnboardingCanvas />
        </>
      ) : (
        <>
          <FleetMapCallout />
          <HomeDashboard data={data} />
          <div className="w-full max-w-3xl px-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
              Agent registry
            </h3>
            <RegistryGallery mode="carousel" />
          </div>
          <NetworkingPanel />
          <TrackedDirectoriesPanel />
        </>
      )}
    </div>
  )
}
