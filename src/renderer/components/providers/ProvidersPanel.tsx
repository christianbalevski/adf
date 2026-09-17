import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { catalogEntryForProvider, isSubscriptionType, nextProviderName, providerTypeHint, type ProviderCatalogEntry } from '../../../shared/constants/provider-catalog'
import { BrandMark } from '../common/BrandMark'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'
import { ProviderModal, type ModelListState, type SubscriptionAuthState } from './ProviderModal'
import { generateProviderId, providerDotClass, providerStatusLabel, type ProviderTestStatus } from './provider-status'

interface ProvidersPanelProps {
  providers: ProviderConfig[]
  setProviders: React.Dispatch<React.SetStateAction<ProviderConfig[]>>
  defaultProviderId: string | undefined
  setDefaultProviderId: (id: string | undefined) => void
  /** Persist pending settings now (the page debounces saves) so Test / Fetch models see fresh values. */
  flushSave: () => void
  onOpenTemplate: () => void
}

/**
 * Settings → Providers: one row per configured provider, a picker modal to
 * add more, and a modal per row for the app default + agent overrides. Edits
 * apply live (the page's debounced save persists them), matching the MCP tab.
 */
export function ProvidersPanel({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave, onOpenTemplate }: ProvidersPanelProps) {
  const providersRef = useRef(providers)
  providersRef.current = providers

  const [status, setStatus] = useState<Record<string, ProviderTestStatus>>({})
  const [models, setModels] = useState<Record<string, ModelListState>>({})
  const [overrideCounts, setOverrideCounts] = useState<Record<string, number>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // --- Connection tests -----------------------------------------------------
  const runTest = useCallback(async (id: string, force: boolean) => {
    setStatus((s) => ({ ...s, [id]: 'testing' }))
    try {
      const r = await window.adfApi?.testProvider(id, force)
      setStatus((s) => ({ ...s, [id]: r?.status ?? 'unknown' }))
    } catch {
      setStatus((s) => ({ ...s, [id]: 'failed' }))
    }
  }, [])

  // Cached (non-forced) test per row on first sight; the modal's Test forces.
  useEffect(() => {
    for (const p of providers) {
      if (status[p.id] === undefined) void runTest(p.id, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  // --- Override counts (row chips) -------------------------------------------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next: Record<string, number> = {}
      for (const p of providers) {
        if (isSubscriptionType(p.type)) continue
        try {
          const r = await window.adfApi?.listProviderCredentialFiles({ providerId: p.id })
          next[p.id] = r?.files.length ?? 0
        } catch {
          next[p.id] = 0
        }
      }
      if (!cancelled) setOverrideCounts(next)
    })()
    return () => { cancelled = true }
    // Re-count when the set of provider ids changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.map((p) => p.id).join('|')])

  // --- Models ------------------------------------------------------------------
  const fetchModels = useCallback((id: string) => {
    if (models[id]?.loading) return
    flushSave()
    setModels((m) => ({ ...m, [id]: { models: [], loading: true } }))
    window.adfApi?.listModels(id).then((result) => {
      setModels((m) => ({ ...m, [id]: { models: [...result.models].sort((a, b) => a.localeCompare(b)), error: result.error } }))
    }).catch((err) => {
      setModels((m) => ({ ...m, [id]: { models: [], error: String(err) } }))
    })
  }, [models, flushSave])

  // --- Subscription auth ---------------------------------------------------------
  const [chatgptAuth, setChatgptAuth] = useState<{ authenticated: boolean; email?: string }>({ authenticated: false })
  const [chatgptLoading, setChatgptLoading] = useState(false)
  const [grokAuth, setGrokAuth] = useState<{ authenticated: boolean; email?: string; flowError?: string }>({ authenticated: false })
  const [grokLoading, setGrokLoading] = useState(false)
  const [grokDevice, setGrokDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)

  const refreshChatgpt = useCallback(() => { window.adfApi?.chatgptAuthStatus().then(setChatgptAuth).catch(() => {}) }, [])
  const refreshGrok = useCallback(() => { window.adfApi?.grokAuthStatus().then(setGrokAuth).catch(() => {}) }, [])

  const chatgpt: SubscriptionAuthState = {
    ...chatgptAuth,
    loading: chatgptLoading,
    signIn: async () => {
      setChatgptLoading(true)
      try {
        const result = await window.adfApi?.chatgptAuthStart()
        if (result && !result.success) console.warn('[ChatGPT Auth]', result.error)
        refreshChatgpt()
      } catch (err) {
        console.warn('[ChatGPT Auth]', err)
      } finally {
        setChatgptLoading(false)
      }
    },
    signOut: async () => { await window.adfApi?.chatgptAuthLogout(); refreshChatgpt() },
  }

  const grok: SubscriptionAuthState = {
    ...grokAuth,
    loading: grokLoading,
    device: grokDevice,
    signIn: async () => {
      setGrokLoading(true)
      try {
        const result = await window.adfApi?.grokAuthStart()
        if (result?.success && result.userCode && result.verificationUri) {
          setGrokDevice({ userCode: result.userCode, verificationUri: result.verificationUri })
        } else if (result && !result.success) {
          setGrokAuth((prev) => ({ ...prev, flowError: result.error }))
        }
      } catch (err) {
        console.warn('[Grok Auth]', err)
      } finally {
        setGrokLoading(false)
      }
    },
    signOut: async () => { await window.adfApi?.grokAuthLogout(); setGrokDevice(null); refreshGrok() },
  }

  // Poll while a Grok device-code flow is pending.
  useEffect(() => {
    if (!grokDevice) return
    const timer = setInterval(() => {
      window.adfApi?.grokAuthStatus().then((s) => {
        setGrokAuth(s)
        if (s.authenticated || s.flowError || s.flowPending === false) setGrokDevice(null)
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [grokDevice])

  // Opening a subscription provider refreshes its auth and lists its models.
  const editing = editingId ? providers.find((p) => p.id === editingId) ?? null : null
  useEffect(() => {
    if (!editing) return
    if (editing.type === 'chatgpt-subscription') { refreshChatgpt(); if (!models[editing.id]?.models?.length) fetchModels(editing.id) }
    if (editing.type === 'grok-subscription') { refreshGrok(); if (!models[editing.id]?.models?.length) fetchModels(editing.id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  // --- Mutations -------------------------------------------------------------------
  const pick = (entry: ProviderCatalogEntry) => {
    const current = providersRef.current
    const created: ProviderConfig = {
      id: generateProviderId(),
      type: entry.type,
      preset: entry.key,
      name: nextProviderName(entry.label, current),
      baseUrl: entry.baseUrl ?? '',
      apiKey: '',
      defaultModel: '',
      params: [],
    }
    setProviders([...current, created])
    if (current.length === 0) setDefaultProviderId(created.id)
    setEditingId(created.id)
  }

  const update = (id: string, patch: Partial<ProviderConfig>) =>
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const remove = (id: string) => {
    const p = providersRef.current.find((x) => x.id === id)
    if (!window.confirm(`Remove ${p?.name || 'this provider'}? Agents that carry their own copy keep working; agents using the app default will need another provider.`)) return
    const next = providersRef.current.filter((x) => x.id !== id)
    setProviders(next)
    if (defaultProviderId === id) setDefaultProviderId(next[0]?.id)
    setModalOpen(false)
    setEditingId(null)
  }

  const openRow = (id: string) => { setEditingId(id); setModalOpen(true) }
  const closeModal = () => { setModalOpen(false); setEditingId(null) }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <label className="block text-[13px] font-medium text-[var(--adf-ui-text)]">Providers</label>
          <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            Model endpoints your agents can use. Each has an app default and optional per-agent overrides.
            New agents start on the default provider; change that under{' '}
            <button type="button" onClick={onOpenTemplate} className="rounded underline underline-offset-2 hover:text-[var(--adf-ui-text)] focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]">Agent template</button>.
          </p>
        </div>
        <Button variant="primary" size="compact" className="shrink-0" onClick={() => { setEditingId(null); setModalOpen(true) }}>+ Add provider</Button>
      </div>

      <ProviderModal
        open={modalOpen}
        onClose={closeModal}
        provider={editing}
        isDefault={!!editing && editing.id === defaultProviderId}
        status={editing ? status[editing.id] : undefined}
        onPick={pick}
        onUpdate={(patch) => editing && update(editing.id, patch)}
        onRemove={() => editing && remove(editing.id)}
        onMakeDefault={() => editing && setDefaultProviderId(editing.id)}
        onTest={() => { if (editing) { flushSave(); void runTest(editing.id, true) } }}
        models={editing ? models[editing.id] : undefined}
        onFetchModels={() => editing && fetchModels(editing.id)}
        chatgpt={chatgpt}
        grok={grok}
        onOverrideCountChange={(count) => editing && setOverrideCounts((c) => ({ ...c, [editing.id]: count }))}
      />

      {providers.length === 0 ? (
        <div className="rounded-[var(--adf-ui-container-radius)] border border-dashed border-[var(--adf-ui-border)] px-4 py-6 text-center">
          <p className="text-[13px] font-medium text-[var(--adf-ui-text)]">No providers yet</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            Sign in with a ChatGPT or Grok subscription, paste an API key, or point at a local server like LM Studio or Ollama.
          </p>
          <Button variant="primary" className="mt-3" onClick={() => { setEditingId(null); setModalOpen(true) }}>Choose a provider</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => {
            const entry = catalogEntryForProvider(p)
            const st = status[p.id]
            const isDefault = p.id === defaultProviderId
            const overrides = overrideCounts[p.id] ?? 0
            const detail = p.type === 'openai-compatible' && p.baseUrl ? p.baseUrl : providerTypeHint(p.type)
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => openRow(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(p.id) } }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] px-3 py-2 transition-colors hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <BrandMark iconKey={entry?.iconKey} label={entry?.label ?? p.name} size={26} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Tooltip tip={providerStatusLabel(st)}>
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${providerDotClass(st)}`} />
                      </Tooltip>
                      <span className="truncate text-[13px] font-medium text-[var(--adf-ui-text)]">{p.name || entry?.label}</span>
                      {isDefault && (
                        <Tooltip tip="New agents start on this provider.">
                          <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--adf-ui-warning)]">Default</span>
                        </Tooltip>
                      )}
                      {overrides > 0 && (
                        <Tooltip tip={`${overrides} agent${overrides === 1 ? '' : 's'} carry their own copy of this provider.`}>
                          <span className="rounded bg-[var(--adf-ui-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--adf-ui-accent)]">
                            {overrides} override{overrides === 1 ? '' : 's'}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    <p className="truncate text-[10.5px] text-[var(--adf-ui-text-subtle)]">
                      {detail}{p.defaultModel ? ` · ${p.defaultModel}` : ''}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">Configure ›</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
