import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../../../shared/types/ipc.types'

const SAVE_DEBOUNCE_MS = 250

/**
 * A copy of the providers list that its owner persists itself: read from
 * settings on demand, saved back (debounced) on every change, flushed on
 * request. For surfaces outside the Settings page that drive the provider
 * modal (the home strip, the provider-at-need sheet), where the page's own
 * debounced save is not around.
 */
export function useOwnedProviderList() {
  const [providers, setProvidersState] = useState<ProviderConfig[]>([])
  const [defaultProviderId, setDefaultProviderIdState] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const loadedRef = useRef(false)
  /** True once the owner edited the list; a load never sets it, so a load is never written back. */
  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    loadedRef.current = true
    dirtyRef.current = false
    setLoaded(true)
  }, [])

  const flushSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!loadedRef.current || !dirtyRef.current) return
    const { providers: p, defaultProviderId: d } = latest.current
    dirtyRef.current = false
    await window.adfApi.setSettings({ providers: p, defaultProviderId: d ?? '' })
  }, [])

  // Debounced save of every edit once loaded; the modal's Test / Fetch flush first.
  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void flushSave() }, SAVE_DEBOUNCE_MS)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [providers, defaultProviderId, flushSave])

  return { providers, setProviders, defaultProviderId, setDefaultProviderId, loaded, load, flushSave }
}
