/**
 * Theme and reduced-motion signals for orbitals. The theme is the one App
 * resolves onto <html data-theme> (user setting, or the OS for 'system'), so
 * orbitals switch with the rest of the UI.
 */

import { useSyncExternalStore } from 'react'
import type { OrbitalTheme } from '../../../shared/utils/orbital-cache-key'

function readTheme(): OrbitalTheme {
  const t = document.documentElement.dataset.theme
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function subscribeTheme(cb: () => void): () => void {
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  mq?.addEventListener('change', cb)
  return () => {
    obs.disconnect()
    mq?.removeEventListener('change', cb)
  }
}

export function useOrbitalTheme(): OrbitalTheme {
  return useSyncExternalStore(subscribeTheme, readTheme, () => 'light' as const)
}

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCE_QUERY).matches
}

function subscribeReduce(cb: () => void): () => void {
  const mq = window.matchMedia?.(REDUCE_QUERY)
  mq?.addEventListener('change', cb)
  return () => mq?.removeEventListener('change', cb)
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, prefersReducedMotion, () => false)
}
