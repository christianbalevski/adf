import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { AdfApi } from '../../preload/api'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { SubscriptionProviderId, SubscriptionUsageState } from '../../shared/types/subscription-usage.types'
import { cachesOf } from '../utils/config-caches'
import { subscriptionProviderIds } from '../utils/subscription-usage'

/**
 * Subscription usage per runtime (each runtime holds its own sign-ins). One
 * entry per runtime key, loaded while any component uses it: on first use,
 * on every change event, every POLL_MS while the window is visible, and when
 * it becomes visible again. A failed call keeps the last state; nothing here
 * throws into render.
 */

const POLL_MS = 60_000

export interface SubscriptionUsageEntry {
  /** Null until the first answer. */
  state: SubscriptionUsageState | null
  /** Epoch ms of the last successful load. */
  loadedAt: number | null
  refreshing: boolean
}

const EMPTY: SubscriptionUsageEntry = { state: null, loadedAt: null, refreshing: false }

interface SubscriptionUsageStoreState {
  entries: Record<string, SubscriptionUsageEntry>
}

export const useSubscriptionUsageStore = create<SubscriptionUsageStoreState>(() => ({ entries: {} }))

function patch(key: string, next: Partial<SubscriptionUsageEntry>): void {
  useSubscriptionUsageStore.setState((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY), ...next } } }))
}

async function load(key: string, api: AdfApi | undefined): Promise<void> {
  if (!api?.getSubscriptionUsage) return
  try {
    const state = await api.getSubscriptionUsage()
    if (state) patch(key, { state, loadedAt: Date.now() })
  } catch { /* keep the last state */ }
}

interface Subscription { count: number; stop: () => void }
const subscriptions = new Map<string, Subscription>()

function acquire(key: string, api: AdfApi | undefined): () => void {
  const existing = subscriptions.get(key)
  if (existing) {
    existing.count++
  } else {
    void load(key, api)
    const off = api?.onSubscriptionUsageChanged?.((state) => patch(key, { state, loadedAt: Date.now() }))
    const timer = setInterval(() => { if (!document.hidden) void load(key, api) }, POLL_MS)
    const onVisible = () => { if (!document.hidden) void load(key, api) }
    document.addEventListener('visibilitychange', onVisible)
    subscriptions.set(key, {
      count: 1,
      stop: () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
        off?.()
      },
    })
  }
  return () => {
    const sub = subscriptions.get(key)
    if (!sub) return
    if (--sub.count <= 0) {
      sub.stop()
      subscriptions.delete(key)
    }
  }
}

/**
 * The subscription usage of the runtime `api` reaches, kept current while
 * the calling component is mounted. `key` names that runtime.
 * `refresh({ auto: true })` is one the user did not click for: the runtime's
 * providerChecksEnabled opt-out applies.
 */
export function useSubscriptionUsage(key: string, api: AdfApi | undefined) {
  useEffect(() => acquire(key, api), [key, api])
  const entry = useSubscriptionUsageStore((s) => s.entries[key] ?? EMPTY)
  const refresh = useCallback(async (opts?: { auto?: boolean }) => {
    if (!api?.refreshSubscriptionUsage) return
    patch(key, { refreshing: true })
    try {
      const state = await api.refreshSubscriptionUsage(opts)
      if (state) patch(key, { state, loadedAt: Date.now() })
    } catch {
      // Unreachable: keep what is shown; the snapshot's own error says why.
      await load(key, api)
    } finally {
      patch(key, { refreshing: false })
    }
  }, [key, api])
  return { ...entry, refresh }
}

/**
 * Configured provider id → the subscription it draws on, from the runtime's
 * provider list in the config caches (config-caches.ts; a Settings save
 * busts it). Read once per runtime, and again when `refetchOn` changes after
 * the cache was busted.
 */
export function useSubscriptionProviderIds(runtimeId: string, api: AdfApi | undefined, refetchOn?: unknown): Record<string, SubscriptionProviderId> {
  const [providers, setProviders] = useState<ProviderConfig[] | null>(() => cachesOf(runtimeId).providers)
  useEffect(() => {
    const caches = cachesOf(runtimeId)
    if (caches.providers) { setProviders(caches.providers); return }
    let live = true
    api?.getSettings?.().then((settings) => {
      caches.providers = (settings?.providers as ProviderConfig[] | undefined) ?? []
      if (live) setProviders(caches.providers)
    }).catch(() => { /* catalog ids still resolve */ })
    return () => { live = false }
  }, [runtimeId, api, refetchOn])
  return useMemo(() => subscriptionProviderIds(providers ?? undefined), [providers])
}
