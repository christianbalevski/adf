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
