/**
 * The words of consent per network (docs/design/remote-access.md §3.3.1,
 * owner decision 2026-10-18 b), shared by Studio main's in-window notice
 * (network-consent.ts) and Settings → Networking's status card. A notice
 * names the service that waits for the network, never another one.
 */

/** The services that listen beyond loopback once the network is allowed. */
export interface WaitingServices {
  /** Remote access is on (other computers use this runtime). */
  remoteAccess: boolean
  /** The mesh's LAN mode: the Network switch, or an agent with lan or public visibility. */
  mesh: boolean
}

/** Under the notice for remote access on a LAN the OS reports Public, or does not report. */
export const PUBLIC_WARNING = 'Public network. The token is sent unencrypted.'

/** The same, when only the mesh waits (no token goes over the network). */
export const PUBLIC_MESH_WARNING = 'Public network. Anyone on it can reach the agents you share.'

/** "Remote access", "Agent sharing", or both. */
export function waitingServicesText(services: WaitingServices): string {
  if (services.remoteAccess && services.mesh) return 'Remote access and agent sharing'
  return services.mesh ? 'Agent sharing' : 'Remote access'
}

/** "<Service> paused on <network>." */
export function pausedText(services: WaitingServices, networkLabel: string): string {
  return `${waitingServicesText(services)} paused on ${networkLabel}.`
}

/** The warning for a network not reported Private, by the services that wait. */
export function publicNetworkWarning(services: WaitingServices): string {
  return services.remoteAccess ? PUBLIC_WARNING : PUBLIC_MESH_WARNING
}

// --- What remote access listens on (review A2) -------------------------------------

interface ListenNetwork { id: string | null; kind: 'lan' | 'tailnet'; label: string; allowed: boolean; osCategory: 'private' | 'public' | 'unknown' }

/**
 * The networks remote access listens on once turned on (owner decision
 * 2026-10-18 b): every current network allowed, plus with `allow` (Share)
 * the current ones Share allows, then the networks allowed earlier that
 * this computer is not on now (it listens there when it joins them).
 * `exposed`: one of the current ones is a LAN the OS does not report
 * Private (the Public warning), whether allowed now or earlier.
 */
export function listenPlan(
  status: { networks: ListenNetwork[]; allowedNetworks: Array<{ id: string; label: string }> },
  opts: { allow: boolean },
): { allow: ListenNetwork[]; labels: string[]; exposed: boolean } {
  const allow = opts.allow ? status.networks.filter((n) => !n.allowed && !!n.id) : []
  const current = status.networks.filter((n) => !!n.id && (n.allowed || allow.includes(n)))
  const elsewhere = status.allowedNetworks.filter((a) => !status.networks.some((n) => n.id === a.id))
  return {
    allow,
    labels: [...current.map((n) => n.label), ...elsewhere.map((a) => a.label)],
    exposed: current.some((n) => n.kind === 'lan' && n.osCategory !== 'private'),
  }
}

/** "A", "A and B", "A, B and C". */
export function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** No network allowed yet: remote access is on and listens nowhere until one is. */
export const NO_NETWORK_YET = 'It listens on no network until you allow one.'

/** "Listens on <networks>." */
export function listensOnText(labels: string[]): string {
  return labels.length > 0 ? `Listens on ${andList(labels)}.` : NO_NETWORK_YET
}
