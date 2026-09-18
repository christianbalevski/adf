import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { isSubscriptionType, nextProviderName, type ProviderCatalogEntry } from '../../../shared/constants/provider-catalog'
import type { ModelListState, SubscriptionAuthState } from './ProviderModal'
import { generateProviderId, type ProviderTestStatus } from './provider-status'
import { countOverrides } from './override-utils'

export interface ProviderManagerInput {
  providers: ProviderConfig[]
  setProviders: React.Dispatch<React.SetStateAction<ProviderConfig[]>>
  defaultProviderId: string | undefined
  setDefaultProviderId: (id: string | undefined) => void
  /**
   * Persist pending settings now (callers debounce saves) so Test / Fetch
   * models see fresh values. Resolves once the write has landed.
   */
  flushSave: () => Promise<void> | void
}

/**
 * Everything behind the provider modal that is not layout: connection
 * tests, model lists, subscription sign-ins, carrier counts, and the
 * add/update/remove mutations. Settings → Providers and the at-need sheet
 * both drive the same ProviderModal with this, so a provider connected
 * from either place is the same provider.
 */
export function useProviderManager({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave }: ProviderManagerInput) {
  const providersRef = useRef(providers)
  providersRef.current = providers

  const [status, setStatus] = useState<Record<string, ProviderTestStatus>>({})
  const [models, setModels] = useState<Record<string, ModelListState>>({})
  /** Agents whose .adf carries a copy of this provider (with or without its own key). */
  const [carrierCounts, setCarrierCounts] = useState<Record<string, number>>({})
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

  // --- Carrier counts (row chips) ---------------------------------------------
  // The scan returns every agent whose .adf carries this provider in its config,
  // keyed or not — and Studio copies the default provider into every agent it
  // creates. So this is a "carries a copy" count, not an "overrides" count.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next: Record<string, number> = {}
      for (const p of providers) {
        if (isSubscriptionType(p.type)) continue
        try {
          const r = await window.adfApi?.listProviderCredentialFiles({ providerId: p.id })
          next[p.id] = countOverrides(r?.files ?? [], p)
        } catch {
          next[p.id] = 0
        }
      }
      if (!cancelled) setCarrierCounts(next)
    })()
    return () => { cancelled = true }
    // Re-count when the set of provider ids changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.map((p) => p.id).join('|')])

  // --- Models ------------------------------------------------------------------
  const fetchModels = useCallback(async (id: string) => {
    if (models[id]?.loading) return
    setModels((m) => ({ ...m, [id]: { models: [], loading: true } }))
    try {
      // main reads the provider back from settings, so the write has to land first.
      await flushSave()
      const result = await window.adfApi?.listModels(id)
      setModels((m) => ({ ...m, [id]: { models: [...(result?.models ?? [])].sort((a, b) => a.localeCompare(b)), error: result?.error } }))
    } catch (err) {
      setModels((m) => ({ ...m, [id]: { models: [], error: String(err) } }))
    }
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
    if (editing.type === 'chatgpt-subscription') { refreshChatgpt(); if (!models[editing.id]?.models?.length) void fetchModels(editing.id) }
    if (editing.type === 'grok-subscription') { refreshGrok(); if (!models[editing.id]?.models?.length) void fetchModels(editing.id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  // --- Mutations -------------------------------------------------------------------
  /** Add a provider from the catalog, persist it, and open its form. Returns the new id. */
  const pick = useCallback(async (entry: ProviderCatalogEntry): Promise<string> => {
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
    const next = [...current, created]
    const nextDefault = current.length === 0 ? created.id : defaultProviderId
    // Claim the row's status before the list re-renders: the first-sight test
    // effect skips ids it already has a status for, so it can't race the save
    // below and pin a bogus result on a provider main hasn't seen yet. A fresh
    // provider has no key and no session — "Not configured" is the truth.
    setStatus((s) => ({ ...s, [created.id]: 'unconfigured' }))
    setProviders(next)
    if (current.length === 0) setDefaultProviderId(created.id)
    // Persist before opening the form. A debounced save can't be relied on
    // here: the form's open effect immediately asks main for models, and
    // main reads providers from settings on disk, not from renderer state.
    try {
      await window.adfApi?.setSettings({ providers: next, defaultProviderId: nextDefault })
    } catch {
      // The caller's debounced save still lands a moment later.
    }
    setEditingId(created.id)
    // Now that main can see it, get its real status (subscription tiles report
    // an existing session as connected).
    void runTest(created.id, false)
    return created.id
  }, [defaultProviderId, runTest, setDefaultProviderId, setProviders])

  const update = useCallback((id: string, patch: Partial<ProviderConfig>) =>
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p))), [setProviders])

  const remove = useCallback((id: string, confirm = true) => {
    const p = providersRef.current.find((x) => x.id === id)
    if (confirm && !window.confirm(`Remove ${p?.name || 'this provider'}? Agents that carry their own copy keep working; agents using the app default will need another provider.`)) return false
    const next = providersRef.current.filter((x) => x.id !== id)
    setProviders(next)
    if (defaultProviderId === id) setDefaultProviderId(next[0]?.id)
    setModalOpen(false)
    setEditingId(null)
    return true
  }, [defaultProviderId, setDefaultProviderId, setProviders])

  const openRow = useCallback((id: string) => { setEditingId(id); setModalOpen(true) }, [])
  const openPicker = useCallback(() => { setEditingId(null); setModalOpen(true) }, [])
  const closeModal = useCallback(() => { setModalOpen(false); setEditingId(null) }, [])
  const setCarrierCount = useCallback((id: string, count: number) => setCarrierCounts((c) => ({ ...c, [id]: count })), [])

  /** Props for `<ProviderModal>`; the caller may override `onClose` and add `onDone`, `intro`, `requireDefaultModel`. */
  const modalProps = {
    open: modalOpen,
    onClose: closeModal,
    provider: editing,
    isDefault: !!editing && editing.id === defaultProviderId,
    status: editing ? status[editing.id] : undefined,
    onPick: (entry: ProviderCatalogEntry) => { void pick(entry) },
    onUpdate: (patch: Partial<ProviderConfig>) => { if (editing) update(editing.id, patch) },
    onRemove: () => { if (editing) remove(editing.id) },
    onMakeDefault: () => { if (editing) setDefaultProviderId(editing.id) },
    onTest: () => { if (editing) void (async () => { await flushSave(); await runTest(editing.id, true) })() },
    models: editing ? models[editing.id] : undefined,
    onFetchModels: () => { if (editing) void fetchModels(editing.id) },
    chatgpt,
    grok,
    onCarrierCountChange: (count: number) => { if (editing) setCarrierCount(editing.id, count) },
  }

  return {
    status,
    models,
    carrierCounts,
    modalOpen,
    editingId,
    editing,
    runTest,
    fetchModels,
    chatgpt,
    grok,
    pick,
    update,
    remove,
    openRow,
    openPicker,
    closeModal,
    setCarrierCount,
    modalProps,
  }
}
