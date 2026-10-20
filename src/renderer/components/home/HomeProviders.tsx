import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { useProviderManager } from '../providers/useProviderManager'
import { useOwnedProviderList } from '../providers/useOwnedProviderList'
import { providerReady } from '../providers/provider-ready'

type Manager = ReturnType<typeof useProviderManager>

export interface HomeProviders {
  providers: ProviderConfig[]
  loaded: boolean
  status: Manager['status']
  /** The provider the next new agent starts on: the session pick, else the default. */
  selectedId: string | null
  selected: ProviderConfig | undefined
  /** Some provider has a credential and a default model. */
  anyReady: boolean
  /** The selected provider has a credential and a default model. */
  selectedReady: boolean
  /** Picks the provider for the next new agent. A different provider drops the model pick with it. */
  setHomeProviderId: (id: string | null) => void
  /** Model lists by provider id, filled on demand by `fetchModels`. */
  models: Manager['models']
  /** Asks main for one provider's model list; the chip calls it once per provider. */
  fetchModels: (id: string) => Promise<void>
  /**
   * Opens the provider sheet (the at-need one). Resolves with the provider
   * connected, now picked for the next new agent, or null when cancelled.
   */
  openPicker: () => Promise<string | null>
}

const Ctx = createContext<HomeProviders | null>(null)

/**
 * One provider list for the whole home screen, so the composer chip and the
 * connect card agree on what exists and neither has to poll the other. A
 * provider is connected through the at-need provider sheet
 * (ProviderSetupDialog): Done needs a key or a sign-in and a model, and
 * cancel takes back what it added.
 */
export function HomeProvidersProvider({ children }: { children: React.ReactNode }) {
  const homeProviderId = useAppStore((s) => s.homeProviderId)
  const setHomeProviderId = useAppStore((s) => s.setHomeProviderId)
  const setHomeModelId = useAppStore((s) => s.setHomeModelId)
  const connectProvider = useAppStore((s) => s.connectProvider)
  const sheetOpen = useAppStore((s) => s.providerSetupRequest !== null)
  const list = useOwnedProviderList()
  const { providers, setProviders, defaultProviderId, setDefaultProviderId, loaded, load, flushSave, saveFailure } = list
  const m = useProviderManager({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave, saveFailure })
  const { status } = m

  // Settings may change the list while home is open; refresh on focus, but
  // never underneath the open sheet.
  const sheetOpenRef = useRef(sheetOpen)
  sheetOpenRef.current = sheetOpen
  useEffect(() => {
    const reload = () => { if (!sheetOpenRef.current) void load().catch(() => {}) }
    reload()
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [load])

  const selectedId = (homeProviderId && providers.some((p) => p.id === homeProviderId) ? homeProviderId : defaultProviderId) ?? null
  const selected = providers.find((p) => p.id === selectedId)
  useEffect(() => {
    if (homeProviderId && loaded && !providers.some((p) => p.id === homeProviderId)) setHomeProviderId(null)
  }, [homeProviderId, loaded, providers, setHomeProviderId])

  // A model id only means anything next to the provider it came from, so any
  // move to a different provider drops it. `undefined` = the list has not
  // settled yet, so the first resolved provider is not treated as a change.
  const modelProviderRef = useRef<string | null | undefined>(undefined)
  const pickProvider = useCallback((id: string | null) => {
    const next = id ?? defaultProviderId ?? null
    if (modelProviderRef.current !== undefined && modelProviderRef.current !== next) setHomeModelId(null)
    modelProviderRef.current = next
    setHomeProviderId(id)
  }, [defaultProviderId, setHomeModelId, setHomeProviderId])
  useEffect(() => {
    if (!loaded) return
    if (modelProviderRef.current === undefined) { modelProviderRef.current = selectedId; return }
    if (modelProviderRef.current === selectedId) return
    modelProviderRef.current = selectedId
    setHomeModelId(null)
  }, [loaded, selectedId, setHomeModelId])

  // The provider just connected, picked for the next agent (the chip shows it)
  // once the re-read list holds it: picked earlier, the stale-pick effect
  // above would drop it again.
  const [connectedId, setConnectedId] = useState<string | null>(null)
  useEffect(() => {
    if (!connectedId || !providers.some((p) => p.id === connectedId)) return
    setConnectedId(null)
    pickProvider(connectedId)
  }, [connectedId, pickProvider, providers])
  const openPicker = useCallback(async (): Promise<string | null> => {
    const id = await connectProvider('no_provider', null)
    // The sheet saved its own copy of the list; read it back.
    await load().catch(() => {})
    if (id) setConnectedId(id)
    return id
  }, [connectProvider, load])

  const anyReady = providers.some((p) => providerReady(p, status[p.id]))
  const selectedReady = !!selected && providerReady(selected, status[selected.id])

  return (
    <Ctx.Provider value={{ providers, loaded, status, selectedId, selected, anyReady, selectedReady, setHomeProviderId: pickProvider, models: m.models, fetchModels: m.fetchModels, openPicker }}>
      {children}
    </Ctx.Provider>
  )
}

export function useHomeProviders(): HomeProviders {
  const v = useContext(Ctx)
  if (!v) throw new Error('useHomeProviders outside HomeProvidersProvider')
  return v
}

/**
 * The first thing to do when nothing can run yet. Sits in the empty middle
 * of the home screen until a provider has a credential and a model (a tile
 * left empty does not count), then disappears; the composer chip below stays
 * as the everyday way in.
 */
export function ConnectProviderCard() {
  const { loaded, anyReady, openPicker } = useHomeProviders()
  if (!loaded || anyReady) return null
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        onClick={() => { void openPicker() }}
        className="group flex w-full max-w-md items-center gap-4 rounded-2xl border border-[var(--adf-ui-accent)]/40 bg-[var(--adf-ui-surface)] px-5 py-4 text-left shadow-sm transition-colors hover:border-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-surface-hover)]"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 2v5M15 2v5" />
            <path d="M6 7h12v3a6 6 0 0 1-12 0V7z" />
            <path d="M12 16v6" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-[var(--adf-ui-text)]">Model provider</span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-[var(--adf-ui-text-muted)]">
            Sign in with a plan, paste an API key, or use a local server.
          </span>
        </span>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-[var(--adf-ui-accent)] px-3 text-[12px] font-medium text-[var(--adf-ui-on-accent)]">
          Connect
        </span>
      </button>
    </div>
  )
}
