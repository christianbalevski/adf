// Agent websites: every agent can serve web content through the daemon's mesh
// HTTP server at `/agents/<handle>/` — its `public/` files (serving.public),
// shared files (serving.shared patterns) and API / WebSocket lambda routes
// (serving.api). Pure helpers: parse the daemon's answers, derive one agent's
// site (URL, LAN URLs, what it serves). No React, no store.

import type { TuiState, MeshAgentInfo, WebServerStatus } from '../state/types'

export const DEFAULT_WEB_PORT = 7295

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `GET /network/server` (or `/network/mesh`'s `meshServer`) → status; null when it is not one. */
export function parseServer(raw: unknown): WebServerStatus | null {
  if (!isRecord(raw) || typeof raw.running !== 'boolean') return null
  const port = typeof raw.port === 'number' && Number.isFinite(raw.port) ? raw.port : DEFAULT_WEB_PORT
  return { running: raw.running, port, host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1' }
}

/** `GET /network/mesh` agents[] → what each agent serves (+ its adf_meta status line), by agent id. */
export function parseMeshAgents(raw: unknown): Record<string, MeshAgentInfo> {
  const out: Record<string, MeshAgentInfo> = {}
  if (!Array.isArray(raw)) return out
  for (const a of raw) {
    if (!isRecord(a) || typeof a.agentId !== 'string') continue
    out[a.agentId] = {
      handle: typeof a.handle === 'string' ? a.handle : undefined,
      publicEnabled: a.publicEnabled === true,
      apiRoutes: typeof a.apiRouteCount === 'number' ? a.apiRouteCount : 0,
      sharedCount: typeof a.sharedCount === 'number' ? a.sharedCount : 0,
      ...(typeof a.status === 'string' && a.status.trim() ? { status: a.status.trim() } : {}),
    }
  }
  return out
}

/** `GET /network/mesh/lan-addresses` → IPv4 addresses (`{addresses:{addresses:[…]}}` or `{addresses:[…]}`). */
export function parseLan(raw: unknown): string[] {
  const outer = isRecord(raw) ? raw.addresses : undefined
  const list = Array.isArray(outer) ? outer : isRecord(outer) && Array.isArray(outer.addresses) ? outer.addresses : []
  return list
    .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.address === 'string' && a.family !== 'IPv6' && !String(a.address).includes(':'))
    .map(a => String(a.address))
}

/** Bound to every interface: reachable from the LAN as well. */
export function bindsAll(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === ''
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** The host to put in a link: a wildcard bind is reached at the daemon's host (loopback when the daemon is local). */
export function linkHost(serverHost: string, daemonUrl: string): string {
  let host = serverHost
  if (bindsAll(serverHost)) {
    let daemonHost = '127.0.0.1'
    try { daemonHost = new URL(daemonUrl).hostname.replace(/^\[|\]$/g, '') } catch { /* keep loopback */ }
    host = isLoopback(daemonHost) ? '127.0.0.1' : daemonHost
  }
  return host.includes(':') ? `[${host}]` : host
}

export function siteUrl(host: string, port: number, handle: string): string {
  return `http://${host}:${port}/agents/${encodeURIComponent(handle)}/`
}

/** One agent's website, as far as the TUI knows. */
export interface Site {
  agentId: string
  handle: string
  publicEnabled: boolean
  /** The public folder's index file (serving.public.index, default index.html). */
  index: string
  apiRoutes: number
  /** Of apiRoutes, the WebSocket ones (known from the agent's config). */
  wsRoutes: number
  sharedCount: number
  /** null: the daemon did not say (older daemon, or not read yet). */
  server: WebServerStatus | null
  /** The link while the server runs; null when it is stopped or unknown. */
  url: string | null
  /** Links from other machines on the LAN (server bound to 0.0.0.0). */
  lanUrls: string[]
}

/**
 * The agent's site, or null when it serves nothing (no public folder, no
 * shared files, no API routes): then the TUI shows nothing at all.
 */
export function siteOf(state: Pick<TuiState, 'agents' | 'web' | 'daemonUrl'>, agentId: string | null | undefined): Site | null {
  if (!agentId) return null
  const agent = state.agents[agentId]
  if (!agent) return null
  const serving = agent.config?.serving
  const mesh = state.web?.agents[agentId]
  const api = Array.isArray(serving?.api) ? serving.api : []
  const publicEnabled = mesh ? mesh.publicEnabled : serving?.public?.enabled === true
  const apiRoutes = mesh ? mesh.apiRoutes : api.length
  const sharedCount = mesh ? mesh.sharedCount : serving?.shared?.enabled ? serving.shared.patterns?.length ?? 0 : 0
  if (!publicEnabled && apiRoutes === 0 && sharedCount === 0) return null
  const handle = agent.summary.handle || mesh?.handle || agent.config?.handle || agent.summary.name || agentId
  const server = state.web?.server ?? null
  const url = server?.running ? siteUrl(linkHost(server.host, state.daemonUrl), server.port, handle) : null
  const lanUrls = server?.running && bindsAll(server.host) ? (state.web?.lan ?? []).map(ip => siteUrl(ip, server.port, handle)) : []
  return {
    agentId,
    handle,
    publicEnabled,
    index: serving?.public?.index || 'index.html',
    apiRoutes,
    wsRoutes: api.filter(r => r.method === 'WS').length,
    sharedCount,
    server,
    url,
    lanUrls,
  }
}

/** What the site serves, in words: `public/ (index.html) · 3 API routes incl. 1 WS · 2 shared patterns`. */
export function servedText(site: Site): string {
  const parts: string[] = []
  if (site.publicEnabled) parts.push(`public/ (${site.index})`)
  if (site.apiRoutes > 0) parts.push(`${site.apiRoutes} API route${site.apiRoutes === 1 ? '' : 's'}${site.wsRoutes > 0 ? ` incl. ${site.wsRoutes} WS` : ''}`)
  if (site.sharedCount > 0) parts.push(`${site.sharedCount} shared pattern${site.sharedCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** One word for a table cell: `site` (public pages, maybe an API too), `api`, `files` (shared only). */
export function siteKind(site: Site): string {
  return site.publicEnabled ? 'site' : site.apiRoutes > 0 ? 'api' : 'files'
}

/** The link without the scheme, for tight lines: `127.0.0.1:7295/agents/agent-1/`. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

export const SERVER_STOPPED_TEXT = 'web server stopped — start it'

/** Header / status words for the server: `web :7295`, `web off`; null when unknown. */
export function serverBadge(server: WebServerStatus | null | undefined): { text: string; running: boolean } | null {
  if (!server) return null
  return server.running ? { text: `web :${server.port}`, running: true } : { text: 'web off', running: false }
}

/** `running on 127.0.0.1:7295 (this machine)` / `on all interfaces :7295 (LAN too)` / `stopped`. */
export function serverText(server: WebServerStatus | null | undefined): string {
  if (!server) return 'unknown (the daemon does not report it)'
  if (!server.running) return 'stopped'
  return bindsAll(server.host) ? `running on all interfaces, port ${server.port} (LAN too)` : `running on ${server.host}:${server.port}${isLoopback(server.host) ? ' (this machine only)' : ''}`
}
