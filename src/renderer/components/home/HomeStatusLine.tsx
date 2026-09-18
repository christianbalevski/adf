import { useMemo, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useAgentStore } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { collectRunningAgents, type RunningAgentRow } from '../../utils/running-agents'
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

type Detail = 'running' | 'failing'

/**
 * The dashboard, reduced to one line, with every fact one click from what
 * it counts: agents opens the fleet map, running and failing unfold a list
 * with Stop on each row, tokens opens Settings → General (usage), a failing
 * provider opens Settings → Providers. Hidden until the first agent exists;
 * there is nothing to count before.
 */
export function HomeStatusLine({ data }: { data: DashboardData }) {
  const { quick, providerTests, agentStats, loading } = data
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)
  const directories = useTrackedDirsStore((s) => s.directories)
  const filePath = useDocumentStore((s) => s.filePath)
  const foregroundState = useAgentStore((s) => s.state)
  const [detail, setDetail] = useState<Detail | null>(null)

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

  const rows = useMemo<RunningAgentRow[]>(() => {
    if (!detail) return []
    const byPath = new Map(backgroundAgents.map((a) => [a.filePath, a.state] as const))
    const wanted = (state: string | undefined) =>
      detail === 'failing' ? state === 'error' : !!state && state !== 'off' && state !== 'not_participating' && state !== 'error'
    return collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: filePath,
      foregroundRunning: detail === 'failing' ? foregroundState === 'error' : foregroundState !== 'off' && foregroundState !== 'error',
      isBackgroundRunning: (fp) => wanted(byPath.get(fp)),
    })
  }, [detail, backgroundAgents, directories, filesByDir, filePath, foregroundState])

  const total = agentStats?.total ?? 0
  const todayTokens = quick ? quick.tokens.today.input + quick.tokens.today.output : 0
  const failedProviders = providerTests?.failed ?? 0
  const toggle = (d: Detail) => setDetail((cur) => (cur === d ? null : d))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px] text-[var(--adf-ui-text-muted)]">
        <Segment loading={loading.agentStats}>
          <Link onClick={() => setShowMeshGraph(true)} label="Open the fleet map">
            <strong className="font-semibold text-[var(--adf-ui-text)]">{total}</strong> {total === 1 ? 'agent' : 'agents'}
          </Link>
        </Segment>
        <Dot />
        <Segment>
          {running === 0
            ? <><strong className="font-semibold text-[var(--adf-ui-text)]">0</strong> running</>
            : (
              <Link onClick={() => toggle('running')} pressed={detail === 'running'} label="Show the running agents">
                <strong className="font-semibold text-[var(--adf-ui-text)]">{running}</strong> running
              </Link>
            )}
        </Segment>
        {failing > 0 && (
          <>
            <Dot />
            <Segment>
              <Link onClick={() => toggle('failing')} pressed={detail === 'failing'} label="Show the failing agents">
                <strong className="font-semibold text-[var(--adf-ui-danger)]">{failing}</strong>{' '}
                <span className="text-[var(--adf-ui-danger)]">{failing === 1 ? 'agent failing' : 'agents failing'}</span>
              </Link>
            </Segment>
          </>
        )}
        <Dot />
        <Segment loading={loading.quick}>
          <Link onClick={() => openSettingsAt('general')} label="Open usage in Settings">
            <strong className="font-semibold text-[var(--adf-ui-text)]">{formatTokens(todayTokens)}</strong> tokens today
          </Link>
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
      {detail && <AgentList rows={rows} kind={detail} currentFilePath={filePath} />}
    </div>
  )
}

/**
 * The unfolded list under the line: one row per agent, its name opening
 * the agent, Stop on the right. Empty rows mean the count and the tree
 * disagree for a moment (an agent stopping, a folder just untracked).
 */
function AgentList({ rows, kind, currentFilePath }: { rows: RunningAgentRow[]; kind: Detail; currentFilePath: string | null }) {
  const { openFile } = useAdfFile()
  const [stopping, setStopping] = useState<Set<string>>(new Set())

  const stop = async (fp: string) => {
    setStopping((s) => new Set(s).add(fp))
    try {
      if (fp === currentFilePath) {
        await window.adfApi.stopAgent()
        useAgentStore.getState().setState('off')
      } else {
        await window.adfApi.stopBackgroundAgent(fp)
      }
    } finally {
      setStopping((s) => { const n = new Set(s); n.delete(fp); return n })
    }
  }

  return (
    <ul className="mt-2 divide-y divide-[var(--adf-ui-separator)] rounded-lg border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] text-[12.5px]">
      {rows.length === 0 && (
        <li className="px-3 py-2 text-[var(--adf-ui-text-subtle)]">Nothing {kind === 'failing' ? 'failing' : 'running'} right now.</li>
      )}
      {rows.map(({ file, folderHint }) => {
        const name = file.agentName ?? file.fileName.replace(/\.adf$/i, '')
        const busy = stopping.has(file.filePath)
        return (
          <li key={file.filePath} className="flex items-center gap-2 px-3 py-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kind === 'failing' ? 'bg-[var(--adf-ui-danger)]' : 'bg-emerald-500'}`} aria-hidden />
            <button
              type="button"
              onClick={() => { void openFile(file.filePath) }}
              className="min-w-0 truncate text-left text-[var(--adf-ui-text)] hover:underline"
            >
              {name}
            </button>
            {folderHint && <span className="truncate text-[11px] text-[var(--adf-ui-text-subtle)]">{folderHint}</span>}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => { void stop(file.filePath) }}
              disabled={busy}
              className="rounded-md border border-[var(--adf-ui-border)] px-2 py-0.5 text-[11.5px] text-[var(--adf-ui-text-muted)] transition-colors hover:border-[var(--adf-ui-danger)] hover:text-[var(--adf-ui-danger)] disabled:opacity-50"
            >
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Link({ onClick, label, pressed, children }: { onClick: () => void; label: string; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={`rounded px-1 transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] ${pressed ? 'bg-[var(--adf-ui-surface-hover)]' : ''}`}
    >
      {children}
    </button>
  )
}

function Segment({ children, loading }: { children: React.ReactNode; loading?: boolean }) {
  if (loading) return <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-[var(--adf-ui-surface-raised)] align-middle" aria-busy="true" />
  return <span className="whitespace-nowrap">{children}</span>
}

function Dot() {
  return <span className="text-[var(--adf-ui-text-subtle)]" aria-hidden>·</span>
}
