import { useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import type {
  DashboardQuickStats,
  DashboardProviderTests,
  DashboardAgentStats,
} from '../../../shared/types/ipc.types'

interface GettingStartedProps {
  quick: DashboardQuickStats | null
  providerTests: DashboardProviderTests | null
  agentStats: DashboardAgentStats | null
}

type StepStatus = 'done' | 'incomplete' | 'loading'

/**
 * 1-2-3 onboarding strip shown above the dashboard.
 *
 * Three states per step — `done`, `incomplete`, `loading` — keep us from
 * misrepresenting a slow slice as a real "not done" signal. Until each
 * step's underlying IPC slice resolves the step shows a pulsing badge
 * (no red, no green) so the user isn't told "do this!" only to watch the
 * step flip green a second later.
 *
 * When all three steps are `done` AND nothing is loading, the whole
 * section collapses to a one-line "all set up" bar with an expand
 * chevron, rather than disappearing entirely.
 *
 * Completion signals (intentionally based on observable state, not flags):
 *   1. Connect a provider     — at least one provider tests OK
 *   2. Create a new .adf      — at least one tracked .adf exists
 *   3. Chat with an agent     — non-zero all-time token usage
 */
export function GettingStarted({ quick, providerTests, agentStats }: GettingStartedProps) {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const filePath = useDocumentStore((s) => s.filePath)
  const { createFile, openFile } = useAdfFile()
  const [forceExpand, setForceExpand] = useState(false)

  const step1Status: StepStatus = !providerTests
    ? 'loading'
    : providerTests.ok > 0 ? 'done' : 'incomplete'

  const step2Status: StepStatus = !agentStats
    ? 'loading'
    : agentStats.total > 0 ? 'done' : 'incomplete'

  const allTimeTokens = quick ? quick.tokens.allTime.input + quick.tokens.allTime.output : 0
  const step3Status: StepStatus = !quick
    ? 'loading'
    : allTimeTokens > 0 ? 'done' : 'incomplete'

  // `allDone` intentionally does NOT depend on the `loading` flag — each
  // per-step status already reports `'loading'` when its slice has never
  // been seen (slice === null), which keeps `allDone` false on initial
  // boot. On manual refresh the previous slice values stay populated, so
  // the steps remain `'done'` and the bar stays collapsed. Including
  // `!loading` here would briefly expand the collapsed bar every time
  // the user hit refresh — a visual glitch.
  const allDone =
    step1Status === 'done' &&
    step2Status === 'done' &&
    step3Status === 'done'

  const handleStep2 = async () => {
    // If a doc is already open, the create button still works (opens a new one).
    // If nothing is tracked yet, the helper will prompt for save location.
    if (filePath) await openFile()
    else await createFile('Untitled')
  }

  // --- Collapsed bar: all done & user hasn't expanded ---
  if (allDone && !forceExpand) {
    return (
      <div className="w-full max-w-3xl px-4">
        <button
          onClick={() => setForceExpand(true)}
          className={[
            'group w-full flex items-center gap-2 px-3 py-2 rounded-lg',
            'border border-green-500/40 bg-green-500/5 dark:bg-green-500/10',
            'text-left transition-colors hover:bg-green-500/10 dark:hover:bg-green-500/15',
            'focus:outline-none focus:ring-2 focus:ring-green-500/40',
          ].join(' ')}
          title="Show getting-started steps"
        >
          <span className="flex shrink-0 items-center justify-center w-5 h-5 rounded-full bg-green-500 text-white text-[10px] font-semibold">
            ✓
          </span>
          <span className="flex-1 text-xs text-neutral-700 dark:text-neutral-200 font-medium">
            All systems go
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
            Show ▾
          </span>
        </button>
      </div>
    )
  }

  // --- Expanded grid: any step incomplete/loading, or user expanded manually ---
  return (
    <div className="w-full max-w-3xl px-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
          Getting started
        </h3>
        {allDone && forceExpand && (
          <button
            onClick={() => setForceExpand(false)}
            className="text-xs text-neutral-400 hover:text-blue-500"
            title="Collapse"
          >
            Hide ▴
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Step
          n={1}
          status={step1Status}
          label="Connect a provider"
          hint={hintForStep(step1Status, 'Checking…', 'Connected', 'Add an API key')}
          onClick={() => openSettingsAt('providers')}
        />
        <Step
          n={2}
          status={step2Status}
          label="Create a new .adf"
          hint={hintForStep(step2Status, 'Checking…', 'You have agents', 'Start with a blank agent')}
          onClick={handleStep2}
        />
        <Step
          n={3}
          status={step3Status}
          label="Run agent"
          hint={
            step3Status === 'done'
              ? `${formatTokensShort(allTimeTokens)} tokens used`
              : hintForStep(step3Status, 'Checking…', '', 'Open an .adf and start it')
          }
          // Step 3 is only actionable once step 2 is done — there has to be
          // something to open.
          onClick={step2Status === 'done' ? () => openFile() : undefined}
        />
      </div>
    </div>
  )
}

function hintForStep(
  status: StepStatus,
  loadingText: string,
  doneText: string,
  incompleteText: string,
): string {
  if (status === 'loading') return loadingText
  if (status === 'done') return doneText
  return incompleteText
}

function Step({
  n,
  status,
  label,
  hint,
  onClick,
}: {
  n: number
  status: StepStatus
  label: string
  hint: string
  onClick?: () => void
}) {
  // No click action while loading — clicking before we know would be
  // misleading (e.g. "Connect a provider" when one is already connected
  // but we're still waiting on the test). Disable interaction.
  const interactive = !!onClick && status !== 'loading'
  const Tag = interactive ? 'button' : 'div'

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onClick : undefined}
      aria-busy={status === 'loading' || undefined}
      className={[
        'flex items-center gap-3 text-left',
        'rounded-lg border px-3 py-2.5 transition-colors',
        status === 'done'
          ? 'border-green-500/40 bg-green-500/5 dark:bg-green-500/10'
          : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800',
        interactive ? 'hover:bg-neutral-50 dark:hover:bg-neutral-700/60 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/50' : '',
      ].join(' ')}
    >
      <StepBadge n={n} status={status} />
      <span className="flex-1 min-w-0">
        <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate">
          {label}
        </div>
        <div
          className={[
            'text-xs truncate',
            status === 'loading'
              ? 'text-neutral-400 dark:text-neutral-500 animate-pulse'
              : 'text-neutral-500 dark:text-neutral-400',
          ].join(' ')}
        >
          {hint}
        </div>
      </span>
    </Tag>
  )
}

function StepBadge({ n, status }: { n: number; status: StepStatus }) {
  if (status === 'done') {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center w-6 h-6 rounded-full text-xs font-semibold bg-green-500 text-white"
      >
        ✓
      </span>
    )
  }
  if (status === 'loading') {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center w-6 h-6 rounded-full text-xs font-semibold bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 border border-neutral-300 dark:border-neutral-600 animate-pulse"
      >
        {n}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center w-6 h-6 rounded-full text-xs font-semibold bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600"
    >
      {n}
    </span>
  )
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
