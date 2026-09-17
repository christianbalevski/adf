import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { SHARE_MARKED_EVENT } from '../../hooks/useShareDrag'
import { formatTokenCount } from '../../utils/token-estimate'
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

/** Same localStorage idiom as the sidebar's Running section: best-effort, non-fatal. */
const HIDDEN_KEY = 'adf-getting-started-hidden'

function loadHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function saveHidden(hidden: boolean): void {
  try {
    localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0')
  } catch { /* storage full/unavailable — the pref just won't stick */ }
}

/**
 * The four beats of the first session, as a strip above the dashboard.
 * Shown only once at least one agent exists (before that the onboarding
 * canvas owns the home screen), so step 1 is always done when it appears.
 *
 * Three states per step — `done`, `incomplete`, `loading` — keep us from
 * misrepresenting a slow slice as a real "not done" signal. Until each
 * step's underlying slice resolves the step shows a pulsing badge, so the
 * user isn't told "do this!" only to watch the step flip green a second
 * later.
 *
 * Hiding the strip is the user's call and it sticks (localStorage, same
 * idiom as the sidebar's Running section). Collapsing it off "all four done"
 * instead would re-open the strip for every existing user the moment a new
 * step is added, which is how step 4 arrived.
 *
 * Completion signals (observable state, not flags):
 *   1. Add an agent       — at least one tracked .adf exists
 *   2. Connect a provider — at least one provider tests OK
 *   3. Run an agent       — non-zero all-time token usage
 *   4. Share an agent     — the first drag-out has happened (settings.onboardingSharedAt)
 */
export function GettingStarted({ quick, providerTests, agentStats }: GettingStartedProps) {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const openShareDialog = useAppStore((s) => s.openShareDialog)
  const [hidden, setHidden] = useState(loadHidden)
  const [sharedAt, setSharedAt] = useState<number | null | undefined>(undefined)

  const setHiddenPref = (next: boolean) => {
    setHidden(next)
    saveHidden(next)
  }

  // The share step is the one signal not in a dashboard slice.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      window.adfApi?.getSettings()
        .then((s) => { if (!cancelled) setSharedAt(s.onboardingSharedAt ?? null) })
        .catch(() => { if (!cancelled) setSharedAt(null) })
    }
    load()
    window.addEventListener(SHARE_MARKED_EVENT, load)
    return () => {
      cancelled = true
      window.removeEventListener(SHARE_MARKED_EVENT, load)
    }
  }, [])

  const step1Status: StepStatus = !agentStats
    ? 'loading'
    : agentStats.total > 0 ? 'done' : 'incomplete'

  const step2Status: StepStatus = !providerTests
    ? 'loading'
    : providerTests.ok > 0 ? 'done' : 'incomplete'

  const allTimeTokens = quick ? quick.tokens.allTime.input + quick.tokens.allTime.output : 0
  const step3Status: StepStatus = !quick
    ? 'loading'
    : allTimeTokens > 0 ? 'done' : 'incomplete'

  const step4Status: StepStatus = sharedAt === undefined
    ? 'loading'
    : sharedAt ? 'done' : 'incomplete'

  const statuses = [step1Status, step2Status, step3Status, step4Status]
  const doneCount = statuses.filter((s) => s === 'done').length
  const allDone = doneCount === statuses.length

  if (hidden) {
    return (
      <div className="w-full max-w-3xl px-4">
        <button
          onClick={() => setHiddenPref(false)}
          className={[
            'group w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors',
            'focus:outline-none focus:ring-2',
            allDone
              ? 'border border-green-500/40 bg-green-500/5 dark:bg-green-500/10 hover:bg-green-500/10 dark:hover:bg-green-500/15 focus:ring-green-500/40'
              : 'border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700/60 focus:ring-blue-500/50',
          ].join(' ')}
        >
          {allDone && (
            <span className="flex shrink-0 items-center justify-center w-5 h-5 rounded-full bg-green-500 text-white text-[10px] font-semibold">
              ✓
            </span>
          )}
          <span className="flex-1 text-xs text-neutral-700 dark:text-neutral-200 font-medium">
            Getting started
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {doneCount} of {statuses.length} done
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
            Show ▾
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-3xl px-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
          Getting started
        </h3>
        <button
          onClick={() => setHiddenPref(true)}
          className="text-xs text-neutral-400 hover:text-blue-500"
        >
          Hide ▴
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
        <Step
          n={1}
          status={step1Status}
          label="Add an agent"
          // The strip only renders once an agent exists, so the incomplete
          // branch is unreachable — no copy pretends otherwise.
          hint={hintForStep(step1Status, 'Checking…', `${agentStats?.total ?? 0} agent${agentStats?.total === 1 ? '' : 's'}`, '')}
        />
        <Step
          n={2}
          status={step2Status}
          label="Connect a provider"
          hint={hintForStep(step2Status, 'Checking…', 'Connected', 'Sign in or add an API key')}
          onClick={() => openSettingsAt('providers')}
        />
        <Step
          n={3}
          status={step3Status}
          label="Run an agent"
          hint={
            step3Status === 'done'
              ? `${formatTokenCount(allTimeTokens)} tokens used`
              : hintForStep(step3Status, 'Checking…', '', 'Open an agent and send a message')
          }
        />
        <Step
          n={4}
          status={step4Status}
          label="Share an agent"
          hint={hintForStep(step4Status, 'Checking…', 'Dragged out once', 'Drag one out of the sidebar')}
          onClick={() => openShareDialog()}
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
  // misleading. Disable interaction.
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
        className="flex shrink-0 items-center justify-center w-6 h-6 rounded-full text-xs font-semibold bg-neutral-200 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 animate-pulse"
      >
        {n}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center w-6 h-6 rounded-full text-xs font-semibold bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
    >
      {n}
    </span>
  )
}
