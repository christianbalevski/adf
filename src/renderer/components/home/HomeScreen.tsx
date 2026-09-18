import { useEffect } from 'react'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useMesh } from '../../hooks/useMesh'
import { useDashboardData } from './useDashboardData'
import { HomeComposer } from './HomeComposer'
import { HomeStatusLine } from './HomeStatusLine'
import { RegistryGallery } from './RegistryGallery'

/**
 * Home, shown when no .adf is open. One face, first run or not: ready-made
 * agents at the top, the status line once there is anything to count, and
 * the composer pinned at the bottom like any chat, carrying its own
 * provider and folder chips. A message sent from the composer is a new
 * agent.
 */
export function HomeScreen() {
  const { loadDirectories } = useTrackedDirs()
  const { enableMesh } = useMesh()
  const data = useDashboardData()

  // Auto-enable mesh on launch if the user had it on last session, and
  // load the tracked directories so the sidebar sees the list.
  useEffect(() => {
    loadDirectories()
    window.adfApi?.getSettings().then((s) => {
      if (s?.meshEnabled) enableMesh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasAgents = (data.agentStats?.total ?? 0) > 0

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="relative flex-1 overflow-y-auto">
        {/* Ambient wash across the whole pane: the accent at a whisper, so the
            screen has a top and a bottom instead of one flat sheet. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-80"
          style={{
            background:
              'radial-gradient(80% 70% at 50% 0%, color-mix(in srgb, var(--adf-ui-accent) 16%, transparent), transparent 100%)'
          }}
        />

        <div className="relative mx-auto w-full max-w-3xl px-4 pb-6 pt-8">
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--adf-ui-text-subtle)]">
                Ready-made agents
              </span>
              <span className="text-[11.5px] text-[var(--adf-ui-text-subtle)]">
                Runs locally. No account, no subscription. Add your own model, cloud or local.
              </span>
            </div>
            <RegistryGallery mode="carousel" compact />
          </section>

          {hasAgents && (
            <div className="mt-8 border-t border-[var(--adf-ui-separator)] pt-4">
              <HomeStatusLine data={data} />
            </div>
          )}
        </div>
      </div>

      {/* The composer, pinned. No divider: the content above fades out
          under the suggestion rows instead. */}
      <div className="relative shrink-0 pb-5 pt-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-10 h-10"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--adf-ui-canvas))' }}
        />
        <HomeComposer />
      </div>
    </div>
  )
}
