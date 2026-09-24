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

async function fetchCards(url: string, timeoutMs: number): Promise<AlfAgentCard[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return Array.isArray(body) ? (body as AlfAgentCard[]) : null
  } catch {
    return null
  }
}

/**
 * Fetch a runtime's agent directory: `/agents` first, then the legacy path.
 * Unreachable runtimes yield an empty list.
 */
export async function fetchDirectory(runtimeUrl: string, timeoutMs = 2500): Promise<DiscoveredAgent[]> {
  const base = runtimeUrl.replace(/\/$/, '')
  const cards =
    (await fetchCards(`${base}${DIRECTORY_PATH}`, timeoutMs)) ??
    (await fetchCards(`${base}${LEGACY_DIRECTORY_PATH}`, timeoutMs)) ??
    []
  return cards.map((c) => ({ ...c, runtime_url: runtimeUrl }))
}
