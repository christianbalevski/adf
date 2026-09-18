import { createContext, useContext, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/app.store'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { ProviderModal } from '../providers/ProviderModal'
import { useProviderManager } from '../providers/useProviderManager'
import { useOwnedProviderList } from '../providers/useOwnedProviderList'

type Manager = ReturnType<typeof useProviderManager>

export interface HomeProviders {
  providers: ProviderConfig[]
  loaded: boolean
  status: Manager['status']
  /** The provider the next new agent starts on: the session pick, else the default. */
  selectedId: string | null
  selected: ProviderConfig | undefined
  setHomeProviderId: (id: string | null) => void
  /** Opens the Settings catalog picker in place. */
  openPicker: () => void
}

const Ctx = createContext<HomeProviders | null>(null)

/**
 * One provider list and one Settings modal for the whole home screen, so the
 * composer chip and the connect card agree on what exists and neither has to
 * poll the other. Same manager as Settings → Providers, over a copy of the
 * list that this component persists itself.
 */
export function HomeProvidersProvider({ children }: { children: React.ReactNode }) {
  const homeProviderId = useAppStore((s) => s.homeProviderId)
  const setHomeProviderId = useAppStore((s) => s.setHomeProviderId)
  const list = useOwnedProviderList()
  const { providers, setProviders, defaultProviderId, setDefaultProviderId, loaded, load, flushSave } = list
  const m = useProviderManager({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave })
  const { openPicker, closeModal, status, modalOpen } = m

  // Settings may change the list while home is open; refresh on focus, but
  // never underneath an open modal.
  const modalOpenRef = useRef(modalOpen)
  modalOpenRef.current = modalOpen
  useEffect(() => {
    const reload = () => { if (!modalOpenRef.current) void load().catch(() => {}) }
    reload()
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [load])

  const selectedId = (homeProviderId && providers.some((p) => p.id === homeProviderId) ? homeProviderId : defaultProviderId) ?? null
  const selected = providers.find((p) => p.id === selectedId)
  useEffect(() => {
    if (homeProviderId && loaded && !providers.some((p) => p.id === homeProviderId)) setHomeProviderId(null)
  }, [homeProviderId, loaded, providers, setHomeProviderId])

  return (
    <Ctx.Provider value={{ providers, loaded, status, selectedId, selected, setHomeProviderId, openPicker }}>
      {children}
      <ProviderModal {...m.modalProps} open={modalOpen} onClose={() => { void flushSave(); closeModal() }} />
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
 * of the home screen until a provider exists, then disappears; the composer
 * chip below stays as the everyday way in.
 */
export function ConnectProviderCard() {
  const { loaded, providers, openPicker } = useHomeProviders()
  if (!loaded || providers.length > 0) return null
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        onClick={openPicker}
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
          <span className="block text-[14px] font-semibold text-[var(--adf-ui-text)]">Connect a provider</span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-[var(--adf-ui-text-muted)]">
            Agents need a model to run. Add a cloud key or a local server; it takes a minute.
          </span>
        </span>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-[var(--adf-ui-accent)] px-3 text-[12px] font-medium text-white dark:text-neutral-950">
          Connect
        </span>
      </button>
    </div>
  )
}
