import { useSyncExternalStore } from 'react'

/** Only narrow touch browsers get the compact shell; Electron keeps its layout. */
export const COMPACT_WEB_QUERY = '(max-width: 1024px) and (pointer: coarse)'

function subscribe(notify: () => void): () => void {
  if (typeof window === 'undefined' || window.adfApi?.platform !== 'web' || !window.matchMedia) return () => {}
  const media = window.matchMedia(COMPACT_WEB_QUERY)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

export function isCompactWebLayout(): boolean {
  return typeof window !== 'undefined' && window.adfApi?.platform === 'web'
    && !!window.matchMedia?.(COMPACT_WEB_QUERY).matches
}

export function useCompactWebLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactWebLayout, () => false)
}
