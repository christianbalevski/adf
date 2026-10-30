import { useSyncExternalStore } from 'react'

export interface BrowserSessionControls {
  busy: boolean
  signOut: () => Promise<void>
}

// The browser bootstrap and Studio have separate React roots. Share only the
// session action; credentials and recovery remain owned by the bootstrap.
let controls: BrowserSessionControls | null = null
const listeners = new Set<() => void>()
const snapshot = () => controls
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function installBrowserSessionControls(next: BrowserSessionControls): () => void {
  controls = next
  for (const listener of listeners) listener()
  return () => {
    if (controls !== next) return
    controls = null
    for (const listener of listeners) listener()
  }
}

export function useBrowserSessionControls(): BrowserSessionControls | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
