import { useAppStore } from '../../stores/app.store'
import { useRuntimes } from '../../stores/runtimes.store'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'

/**
 * The runtime the next new agent is created on: the one picked on home while
 * it is in the set and connected, else This computer. The folder, template,
 * provider and identity chips all read from it.
 */
export function useHomeRuntime(): RuntimeId {
  const picked = useAppStore((s) => s.homeRuntime)
  const runtimes = useRuntimes()
  return runtimes.some((r) => r.id === picked && r.state === 'connected') ? picked : LOCAL_RUNTIME
}
