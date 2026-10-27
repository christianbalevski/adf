import { useCallback, useEffect, useState } from 'react'
import { trackedDirsActions, useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useAppStore } from '../../stores/app.store'
import { useRuntimes } from '../../stores/runtimes.store'
import { CONNECTION_STATE_LABELS } from '../../../shared/types/connection.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'
import { SettingsRuntimeProvider } from '../settings/settings-runtime'
import { useHomeRuntime } from './home-runtime'
import { useMesh } from '../../hooks/useMesh'
import { useDashboardData } from './useDashboardData'
import { HomeComposer } from './HomeComposer'
import { HomeStatusLine } from './HomeStatusLine'
import { ConnectProviderCard, HomeProvidersProvider } from './HomeProviders'
import { HomeExplainer, useRerollQuips } from './HomeExplainer'
import { useHomeCreature, useIdentityDraft } from './NextAgentIdentity'

/**
 * Home, shown when no .adf is open. One face, first run or not: the status
 * line once there is anything to count, a connect-provider card in the
 * middle until one exists, and the composer pinned at the bottom like any
 * chat, carrying its own name, provider and folder chips. A message sent
 * from the composer is a new agent.
 */
export function HomeScreen() {
  const { loadDirectories } = useTrackedDirs()
  const { enableMesh } = useMesh()
  const runtime = useHomeRuntime()

  // Auto-enable mesh on launch if the user had it on last session, and
  // load the tracked directories so the sidebar sees the list.
  useEffect(() => {
    loadDirectories()
    window.adfApi?.getSettings().then((s) => {
      if (s?.meshEnabled) enableMesh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Everything below belongs to one runtime (its identity draft, providers,
  // templates, folders): a new runtime remounts it. Providers read the
  // runtime through the Settings runtime context.
  const body = <HomeBody key={runtime} runtime={runtime} />
  return runtime === LOCAL_RUNTIME ? body : <SettingsRuntimeProvider runtimeId={runtime}>{body}</SettingsRuntimeProvider>
}

function HomeBody({ runtime }: { runtime: RuntimeId }) {
  const data = useDashboardData()
  // The next agent's DID, minted ahead so its orbital shows in the middle
  // while it is being named. The composer's create adopts exactly this one.
  const identity = useIdentityDraft(runtime)
  // One reroll: a new name brings a new identity (so a new orbital), and the
  // orbital comments on the count. Typing a name keeps the identity.
  const quips = useRerollQuips()
  const { renew } = identity
  const { spin, reset: resetQuips } = quips
  const onReroll = useCallback(() => { renew(); spin() }, [renew, spin])
  // The orbital as a creature: a send excites it, and its phase runs fast
  // while the agent is being made.
  const creature = useHomeCreature()
  const onSending = useCallback((on: boolean) => {
    creature.setBusy(on)
    if (!on) return
    const now = performance.now()
    creature.activity(now)
    creature.spin(8)
    creature.hop(now, 0.12, 320)
  }, [creature])
  // The greeting holds the name chip; the composer owns its state and renders it there.
  const [nameSlot, setNameSlot] = useState<HTMLElement | null>(null)

  // A remote's tracked folders, for the folder chip (This computer's load above).
  useEffect(() => {
    if (runtime !== LOCAL_RUNTIME) void trackedDirsActions(runtime).loadDirectories().catch(() => {})
  }, [runtime])

  const hasAgents = (data.agentStats?.total ?? 0) > 0

  return (
    <HomeProvidersProvider>
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="relative flex-1 overflow-y-auto">
        <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pb-6 pt-8">
          {hasAgents && <HomeStatusLine data={data} />}

          {/* The middle: three faint beats on what this screen does, and,
              until a provider exists, the card asking for one. The card goes
              the moment there is one; the chip in the composer takes over. */}
          <div className="flex flex-1 flex-col items-center justify-center gap-10 py-10">
            <HomeExplainer did={identity.draft?.did ?? null} quip={quips.quip} creature={creature} nameSlot={setNameSlot}>
              <RuntimeSelect runtime={runtime} />
            </HomeExplainer>
            <ConnectProviderCard />
          </div>
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
        <HomeComposer runtime={runtime} identity={identity} nameSlot={nameSlot} onReroll={onReroll} onCreated={resetQuips} onSending={onSending} />
      </div>
    </div>
    </HomeProvidersProvider>
  )
}

/**
 * Where the next agent is created, under the greeting. Shown only while more
 * than one runtime is in the set; a runtime that is down cannot be picked.
 */
function RuntimeSelect({ runtime }: { runtime: RuntimeId }) {
  const runtimes = useRuntimes()
  const setHomeRuntime = useAppStore((s) => s.setHomeRuntime)
  if (runtimes.length < 2) return null
  return (
    <label className="mt-1 inline-flex items-center gap-1 text-[12px] text-[var(--adf-ui-text-subtle)]">
      on
      <select
        value={runtime}
        onChange={(e) => setHomeRuntime(e.target.value)}
        aria-label="Runtime the new agent is created on"
        className="cursor-pointer rounded-sm bg-transparent pr-0.5 font-medium text-[var(--adf-ui-text-muted)] outline-none hover:text-[var(--adf-ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
      >
        {runtimes.map((r) => (
          <option key={r.id} value={r.id} disabled={r.state !== 'connected'}>
            {r.state === 'connected' ? r.name : `${r.name} · ${CONNECTION_STATE_LABELS[r.state]}`}
          </option>
        ))}
      </select>
    </label>
  )
}
