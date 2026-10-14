/**
 * Adapter states across every running agent, for the fleet map's base
 * stations and Settings → Channels (ADAPTER_GET_STATUS, and the adapters
 * slice of MESH_MAP_POLL). Shared by Studio and the daemon's
 * GET /fleet/adapters.
 *
 * Adapters run per agent, so the map's stations must exist regardless of
 * which agent hosts the channel: states are deduped by type, the healthiest
 * instance wins. `perAgent` says which agent hosts which adapter and how
 * that instance is doing; its logs are dropped (the by-type view keeps
 * them) to keep the payload small.
 */

import type { AdapterAgentStatus, AdapterState } from '../../shared/types/channel-adapter.types'

export function mergeAdapterStates(
  sources: Array<{ filePath: string | null; states: AdapterState[] }>,
): { adapters: AdapterState[]; perAgent: AdapterAgentStatus[] } {
  const rank = (status: string): number =>
    status === 'connected' || status === 'running' ? 2 : status === 'error' ? 1 : 0
  const byType = new Map<string, AdapterState>()
  const perAgent: AdapterAgentStatus[] = []
  const fold = (filePath: string | null, states: AdapterState[]): void => {
    for (const s of states) {
      const prev = byType.get(s.type)
      if (!prev || rank(s.status) > rank(prev.status)) byType.set(s.type, s)
    }
    if (filePath && states.length > 0) {
      perAgent.push({
        filePath,
        adapters: states.map((s) => ({ type: s.type, status: s.status, error: s.error, connectedAt: s.connectedAt })),
      })
    }
  }
  for (const source of sources) fold(source.filePath, source.states)
  return { adapters: [...byType.values()], perAgent }
}
