import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { saveProviderList, type ProviderListSnapshot, type ProviderSaveFailure } from './provider-save'

const SAVE_DEBOUNCE_MS = 250

/**
 * A copy of the providers list that its owner persists itself: read from
 * settings on demand, saved back (debounced) on every change, flushed on
 * request. For surfaces outside the Settings page that drive the provider
 * modal (the home strip, the provider-at-need sheet), where the page's own
 * debounced save is not around. A refused save keeps the edits and shows why
 * (`saveFailure`); it is tried again with the next edit or flush.
 */
export function useOwnedProviderList() {
  const [providers, setProvidersState] = useState<ProviderConfig[]>([])
  const [defaultProviderId, setDefaultProviderIdState] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const loadedRef = useRef(false)
  /** True once the owner edited the list; a load never sets it, so a load is never written back. */
  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What the store last accepted: a refused save marks the rows that differ from it. */
  const savedRef = useRef<ProviderListSnapshot>({ providers: [], defaultProviderId: undefined })
  const [saveFailure, setSaveFailure] = useState<ProviderSaveFailure | null>(null)
  const latest = useRef({ providers, defaultProviderId })
  latest.current = { providers, defaultProviderId }

  const setProviders: React.Dispatch<React.SetStateAction<ProviderConfig[]>> = useCallback((next) => {
    dirtyRef.current = true
    setProvidersState(next)
  }, [])
  const setDefaultProviderId = useCallback((id: string | undefined) => {
    dirtyRef.current = true
    setDefaultProviderIdState(id)
  }, [])

  const load = useCallback(async () => {
    const s = await window.adfApi.getSettings()
    setProvidersState(s.providers ?? [])
    setDefaultProviderIdState(s.defaultProviderId || undefined)
    savedRef.current = { providers: s.providers ?? [], defaultProviderId: s.defaultProviderId || undefined }
    setSaveFailure(null)
    loadedRef.current = true
    dirtyRef.current = false
    setLoaded(true)
  }, [])

  const flushSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!loadedRef.current || !dirtyRef.current) return
    const attempted = latest.current
    dirtyRef.current = false
    const result = await saveProviderList(
      () => window.adfApi.setSettings({ providers: attempted.providers, defaultProviderId: attempted.defaultProviderId ?? '' }),
      savedRef.current, attempted,
    )
    if (result.saved) savedRef.current = attempted
    else dirtyRef.current = true
    setSaveFailure(result.failure)
  }, [])

  // Debounced save of every edit once loaded; the modal's Test / Fetch flush first.
  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void flushSave() }, SAVE_DEBOUNCE_MS)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [providers, defaultProviderId, flushSave])

  return { providers, setProviders, defaultProviderId, setDefaultProviderId, loaded, load, flushSave, saveFailure }
}
