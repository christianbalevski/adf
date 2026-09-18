import { useMemo } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import type { TrackedDirEntry } from '../../../shared/types/ipc.types'

import { formatTokenCount as formatTokens } from '../../utils/token-estimate'
import type { DashboardData } from './useDashboardData'

function trackedFilePaths(filesByDir: Record<string, TrackedDirEntry[]>): Set<string> {
  const out = new Set<string>()
  const walk = (entries: TrackedDirEntry[]) => {
    for (const e of entries) {
      if (e.isDirectory) walk(e.children ?? [])
      else out.add(e.filePath)
    }
  }
  for (const entries of Object.values(filesByDir)) walk(entries)
  return out
}

/**
 * The dashboard, reduced to one line: how many agents, how many running,
 * tokens today, and anything that needs attention. Everything else the old
 * tile grid showed lives in Settings, one click from the segment that names
 * it. Hidden until the first agent exists; there is nothing to count before.
 */
export function HomeStatusLine({ data }: { data: DashboardData }) {
  const { quick, providerTests, agentStats, loading } = data
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)

  // Same population as the sidebar's Running list: agents the manager
  // holds AND that still exist under a tracked folder (the store keeps
  // entries for files that were deleted or untracked until they stop).
  // Errored agents are held too, but "running" is not what they are doing.
  const { running, failing } = useMemo(() => {
    const tracked = trackedFilePaths(filesByDir)
    let running = 0
    let failing = 0
    for (const a of backgroundAgents) {
      if (!tracked.has(a.filePath)) continue
      if (a.state === 'off' || a.state === 'not_participating') continue
      if (a.state === 'error') failing += 1
      else running += 1
    }
    return { running, failing }
  }, [backgroundAgents, filesByDir])

  const total = agentStats?.total ?? 0
  const todayTokens = quick ? quick.tokens.today.input + quick.tokens.today.output : 0
  const failedProviders = providerTests?.failed ?? 0

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px] text-[var(--adf-ui-text-muted)]">
      <Segment loading={loading.agentStats}>
        <strong className="font-semibold text-[var(--adf-ui-text)]">{total}</strong> {total === 1 ? 'agent' : 'agents'}
      </Segment>
      <Dot />
      <Segment>
        <strong className="font-semibold text-[var(--adf-ui-text)]">{running}</strong> running
      </Segment>
      {failing > 0 && (
        <>
          <Dot />
          <Segment>
            <strong className="font-semibold text-[var(--adf-ui-danger)]">{failing}</strong>{' '}
            <span className="text-[var(--adf-ui-danger)]">{failing === 1 ? 'agent failing' : 'agents failing'}</span>
          </Segment>
        </>
      )}
      <Dot />
      <Segment loading={loading.quick}>
        <strong className="font-semibold text-[var(--adf-ui-text)]">{formatTokens(todayTokens)}</strong> tokens today
      </Segment>
      {failedProviders > 0 && (
        <>
          <Dot />
          <button
            type="button"
            onClick={() => openSettingsAt('providers')}
            className="rounded px-1 text-[var(--adf-ui-danger)] hover:underline"
          >
            {failedProviders} provider{failedProviders === 1 ? '' : 's'} failing
          </button>
        </>
      )}
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => setShowMeshGraph(true)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--adf-ui-text-muted)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="12" cy="18" r="2.5" />
          <path d="M8.3 7 15.6 8.5M7.5 8.2l3.2 7.6M16.6 10.2l-3.2 5.6" />
        </svg>
        Fleet map
      </button>
    </div>
  )
}

function Segment({ children, loading }: { children: React.ReactNode; loading?: boolean }) {
  if (loading) return <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-[var(--adf-ui-surface-raised)] align-middle" aria-busy="true" />
  return <span className="whitespace-nowrap px-1">{children}</span>
}

function Dot() {
  return <span className="text-[var(--adf-ui-text-subtle)]" aria-hidden>·</span>
}
