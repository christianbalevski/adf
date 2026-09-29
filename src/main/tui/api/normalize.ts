// Defensive readers for daemon responses that may be partial or from an
// older daemon version: fill what the views read so they render "none"
// instead of crashing.

import type { RuntimeOverview } from './types'

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : [])
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Fill the parts of GET /runtime the fleet reads, so a partial or older
 * daemon response (missing sections, `providers: {}`) renders as "none"
 * instead of crashing the view.
 */
export function normalizeRuntime(raw: unknown): RuntimeOverview {
  const r = obj(raw)
  const daemon = obj(r.daemon)
  const providers = obj(r.providers)
  const network = obj(r.network)
  const mesh = obj(network.mesh)
  const websocket = obj(network.websocket)
  return {
    ...r,
    daemon: { ...daemon, pid: num(daemon.pid), uptime: num(daemon.uptime) },
    settings: obj(r.settings),
    providers: { ...providers, providers: arr(providers.providers) },
    auth: obj(r.auth),
    mcp: obj(r.mcp),
    adapters: obj(r.adapters),
    network: { ...network, mesh: { ...mesh, status: mesh.status ?? null }, agents: arr(network.agents), websocket: { ...websocket, activeConnections: num(websocket.activeConnections) } },
    compute: r.compute && typeof r.compute === 'object' ? r.compute as Record<string, unknown> : null,
    agents: arr(r.agents),
  } as unknown as RuntimeOverview
}
