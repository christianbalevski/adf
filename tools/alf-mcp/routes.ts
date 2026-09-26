/**
 * Mesh route layout shared by the alf-mcp client (discovery) and its inbox
 * server. Mirrors mesh-server.ts: the directory is the `/agents` collection and
 * each agent lives under `/agents/:handle/`.
 *
 * The legacy layout (`/mesh/directory`, `/:handle/mesh/*`) predates the
 * runtime's route changes in 4e0a645 and b1d7c02. The inbox server still
 * answers it so contacts saved by older alf-mcp versions keep working, and
 * discovery falls back to it for runtimes that haven't moved yet.
 */
import type { AlfAgentCard } from '../../src/shared/types/adf-v02.types'

export const DIRECTORY_PATH = '/agents'
export const LEGACY_DIRECTORY_PATH = '/mesh/directory'

export type AgentLeaf = 'inbox' | 'card' | 'health'

export function agentPath(handle: string, leaf: AgentLeaf): string {
  return `/agents/${handle}/${leaf}`
}

export function legacyAgentPath(handle: string, leaf: AgentLeaf): string {
  return `/${handle}/mesh/${leaf}`
}

export interface DiscoveredAgent extends AlfAgentCard {
  runtime_url: string
}

type CardsResult =
  | { kind: 'ok'; cards: AlfAgentCard[] }
  /** Reachable, but no directory at this path (HTTP error or non-array body). */
  | { kind: 'missing' }
  /** Transport failure: refused, timed out, DNS. */
  | { kind: 'unreachable' }

async function fetchCards(url: string, timeoutMs: number): Promise<CardsResult> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { kind: 'unreachable' }
  }
  if (!res.ok) return { kind: 'missing' }
  try {
    const body = (await res.json()) as unknown
    return Array.isArray(body) ? { kind: 'ok', cards: body as AlfAgentCard[] } : { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
}

export const DEFAULT_DIRECTORY_TIMEOUT_MS = 2500

/**
 * Fetch a runtime's agent directory: `/agents` first, then the legacy path.
 * The legacy attempt is only made when the runtime answered without a
 * directory — an unreachable runtime costs one timeout, not two.
 */
export async function fetchDirectory(
  runtimeUrl: string,
  timeoutMs = DEFAULT_DIRECTORY_TIMEOUT_MS,
): Promise<DiscoveredAgent[]> {
  const base = runtimeUrl.replace(/\/$/, '')
  let result = await fetchCards(`${base}${DIRECTORY_PATH}`, timeoutMs)
  if (result.kind === 'missing') result = await fetchCards(`${base}${LEGACY_DIRECTORY_PATH}`, timeoutMs)
  const cards = result.kind === 'ok' ? result.cards : []
  return cards.map((c) => ({ ...c, runtime_url: runtimeUrl }))
}

export interface DiscoverAgentsOptions {
  runtimeUrls: Iterable<string>
  /** This agent's own card, excluded from the results. */
  self?: { handle: string; did: string }
  timeoutMs?: number
}

/** Query every runtime directory in parallel and merge the results. */
export async function discoverAgents(opts: DiscoverAgentsOptions): Promise<DiscoveredAgent[]> {
  const urls = [...new Set(opts.runtimeUrls)]
  // Explicit arrow: passing fetchDirectory straight to map() would feed the
  // array index in as timeoutMs.
  const results = await Promise.all(urls.map((url) => fetchDirectory(url, opts.timeoutMs)))
  const self = opts.self
  return results.flat().filter((a) => !self || a.handle !== self.handle || a.did !== self.did)
}
