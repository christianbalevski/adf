import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { ProviderModal } from '../providers/ProviderModal'
import { useProviderManager } from '../providers/useProviderManager'
import { useOwnedProviderList } from '../providers/useOwnedProviderList'

/**
 * Provider at the moment of need. Mounted once in AppShell; opens whenever a
 * start is parked on `providerSetupRequest`. It is the Settings → Providers
 * modal, the same picker and form, driven by the same manager hook, over a
 * copy of the providers list that this dialog persists itself.
 *
 * Done (only enabled once a default model is set) points the blocked agent
 * at the new provider and resolves true, so the start retries. Escape, X,
 * or dismissing the picker resolves false and removes the provider added
 * during this request: nothing half-configured is left in Settings, and
 * nothing pretends to be connected. The key lives in app settings, never in
 * the agent file.
 */
export function ProviderSetupDialog() {
  const request = useAppStore((s) => s.providerSetupRequest)
  const resolveProviderSetup = useAppStore((s) => s.resolveProviderSetup)
  const agentName = useAgentStore((s) => s.config?.name)
  const agentProvider = useAgentStore((s) => s.config?.model?.provider)

  const list = useOwnedProviderList()
  const { providers, setProviders, defaultProviderId, setDefaultProviderId, load, flushSave } = list
  const [error, setError] = useState<string | null>(null)
  const addedIdRef = useRef<string | null>(null)

  const m = useProviderManager({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave })
  const { openPicker, closeModal, pick, remove } = m

  // Fresh sheet for every request: read the current list, then open the picker.
  useEffect(() => {
    if (!request) return
    let cancelled = false
    addedIdRef.current = null
    setError(null)
    load().then(() => { if (!cancelled) openPicker() })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [request, load, openPicker])

  const onPick = useCallback((entry: Parameters<typeof pick>[0]) => {
    void pick(entry).then((id) => { addedIdRef.current = id })
  }, [pick])

  /** Escape, X, backdrop: the request is cancelled and the provider added here is taken back. */
  const cancel = useCallback(async () => {
    const added = addedIdRef.current
    if (added) {
      remove(added, false)
      addedIdRef.current = null
      // `remove` updates state; persist the post-removal list directly so the
      // rollback does not depend on a debounce that unmounting may cancel.
      const rest = providers.filter((p) => p.id !== added)
      const nextDefault = defaultProviderId === added ? rest[0]?.id : defaultProviderId
      try { await window.adfApi.setSettings({ providers: rest, defaultProviderId: nextDefault ?? '' }) } catch { /* the list is re-read next time */ }
    } else {
      closeModal()
    }
    resolveProviderSetup(false)
  }, [closeModal, defaultProviderId, providers, remove, resolveProviderSetup])

  /** Done: the provider is saved; point the blocked agent at it and let the start retry. */
  const done = useCallback(async () => {
    const provider = m.editing
    if (!provider) { await cancel(); return }
    const model = (provider.defaultModel ?? '').trim()
    if (!model) { setError('Set a default model first.'); return }
    setError(null)
    try {
      await flushSave()
      const foreground = useDocumentStore.getState().filePath
      const target = request?.filePath
      if (target && target === foreground) {
        const config = await window.adfApi.getAgentConfig()
        if (config) {
          const updated = { ...config, model: { ...config.model, provider: provider.id, model_id: model } }
          await window.adfApi.setAgentConfig(updated)
          useAgentStore.getState().setConfig(updated)
        }
      } else if (target) {
        const r = await window.adfApi.setAgentModelForFile(target, { provider: provider.id, model_id: model })
        if (!r.success) { setError(r.error ?? 'Could not update the agent'); return }
      }
      addedIdRef.current = null
      closeModal()
      resolveProviderSetup(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cancel, closeModal, flushSave, m.editing, request?.filePath, resolveProviderSetup])

  if (!request) return null

  const who = agentName ?? 'This agent'
  const foreground = useDocumentStore.getState().filePath
  const fresh = request.filePath === foreground && !agentProvider
  const reason = fresh
    ? `${who} needs a model to run.`
    : request.reason === 'provider_unconfigured'
      ? `${who}'s provider has no API key on this computer.`
      : `${who}'s model names a provider that is not configured on this computer.`

  return (
    <ProviderModal
      {...m.modalProps}
      open={m.modalOpen}
      onClose={() => { void cancel() }}
      onPick={onPick}
      onDone={() => { void done() }}
      requireDefaultModel={`Becomes ${who}'s model.`}
      intro={
        <>
          {reason} Credentials are stored in app settings, not in the agent file.
          {error && <span className="block pt-1 text-[var(--adf-ui-danger)]">{error}</span>}
        </>
      }
    />
  )
}
