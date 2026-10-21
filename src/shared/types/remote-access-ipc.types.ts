/**
 * Studio IPC shapes for remote access
 * (docs/design/remote-access.md §7, §9.1). The daemon's own shapes are in
 * remote-access.types.ts. No token ever crosses IPC towards the renderer,
 * except the one a device-token creation returns once (§4.6).
 */

import type { AllowedNetwork, NetworkView, RemoteAccessStatus, RemoteDevice } from './remote-access.types'

/** Remote access, host side: Settings → Connections → Add → Share, and Devices. */
export interface RemoteAccessView {
  /** Studio runs the ADF daemon on this computer (local mode); otherwise the panel is read-only. */
  available: boolean
  /** Why the panel cannot be used (embedded or remote mode, no daemon yet). */
  unavailableReason: string | null
  /** The daemon's answer to GET /remote-access; null when not read. */
  status: RemoteAccessStatus | null
  /** Why the status could not be read. */
  error: string | null
  /** The daemon stops when Studio quits (Studio started it, keep-running off): other computers lose it then. */
  stopsWithStudio: boolean
}

/** A pushed change (REMOTE_ACCESS_CHANGED): the new view, and a notice when one is due. */
export interface RemoteAccessChange {
  view: RemoteAccessView
  notice: string | null
}

export type RemoteAccessErrorCode =
  /** The user chose Cancel in a confirmation. Nothing changed. */
  | 'cancelled'
  /** Not local mode, or the daemon is not connected. */
  | 'unavailable'
  /** The daemon refused or failed: `error` is its sentence. */
  | 'daemon'

export type RemoteAccessResult =
  | { ok: true; view: RemoteAccessView }
  | { ok: false; code: RemoteAccessErrorCode; error: string }

/**
 * Add → Share (REMOTE_ACCESS_SHARE): main asks once in a native dialog,
 * then turns remote access on and allows the networks it named.
 * `turnedOn`: this call turned remote access on (also after a later step
 * failed), so Share turns it off again when left with no device added.
 */
export type RemoteShareResult =
  | { ok: true; view: RemoteAccessView; turnedOn: boolean }
  | { ok: false; code: RemoteAccessErrorCode; error: string; turnedOn?: boolean }

/** "Add a computer": the token, shown once. */
export type RemoteDeviceAddResult =
  | { ok: true; view: RemoteAccessView; device: RemoteDevice; token: string }
  | { ok: false; code: RemoteAccessErrorCode; error: string }

// --- Settings → Networking: the status card ------------------------------------

/**
 * This computer's network, as the mesh's LAN mode and remote access see it
 * (lan-reach.ts): one line at the top of Settings → Networking.
 */
export interface NetworkStatusView {
  /** False in remote mode: the mesh and remote access are on the remote computer. */
  available: boolean
  /** LAN addresses (no Tailscale), and whether their network is allowed. */
  lan: Array<{ address: string; iface: string; allowed: boolean }>
  /** The networks this computer is on now. */
  networks: NetworkView[]
  /** The networks the user allowed (remote-access.json; remote access and the mesh's LAN mode). */
  allowedNetworks: AllowedNetwork[]
  tailscale: 'absent' | 'stopped' | 'running'
  /** This computer's tailnet IPv4 address, or null. */
  tailnetAddress: string | null
  firewall: { state: 'ok' | 'blocked' | 'unknown'; message: string }
  /**
   * The services that listen beyond loopback once a network is allowed:
   * remote access (on) and the mesh's LAN mode (the Network switch, or an
   * agent with lan or public visibility).
   */
  waiting: { remoteAccess: boolean; mesh: boolean }
}

/**
 * "<Service> paused on <network>." ("Remote access", "Agent sharing", or
 * both) shown in the window, not as a dialog
 * (NETWORK_NOTICES_CHANGED / NETWORK_NOTICES_GET): once per network per
 * session, until Allow, Not now (NETWORK_NOTICE_DISMISS), or the network goes.
 */
export interface NetworkNotice {
  /** The network id, or `unidentified:…` for a network that cannot be identified. */
  key: string
  /** Null: an unidentified network, which cannot be allowed. */
  networkId: string | null
  message: string
  /** On a LAN the OS reports Public or does not report: "Public network. The token is sent unencrypted." (remote access), else the mesh's sentence. */
  warning: string | null
  canAllow: boolean
}

/** NETWORK_ALLOW / NETWORK_FORGET. */
export type NetworkConsentResult = { ok: true } | { ok: false; error: string }

// --- Client side: Settings → Connections ---------------------

/** One ADF computer found on the LAN (mDNS) or the tailnet (hello probe), merged by fingerprint. */
export interface RemoteDiscoveryEntry {
  fingerprint: string
  name: string
  /** The URL Studio pairs with and saves: tailnet before LAN. */
  url: string
  /** The host part of `url`, for display. */
  address: string
  kind: 'lan' | 'tailnet'
  /** The address is a tailnet one (WireGuard) or https. */
  encrypted: boolean
  /** The host has a pairing window open. */
  pairingOpen: boolean
  /** The saved remote computer has this fingerprint. */
  alreadyPaired: boolean
}

export interface RemoteDiscoveryUpdate {
  entries: RemoteDiscoveryEntry[]
  /** LAN browsing works (mDNS could start). */
  browsing: boolean
  /** Why discovery is limited, in one sentence; null when not. */
  problem: string | null
}

export interface RemotePairStartRequest {
  url: string
  /** This computer's name on the host; default the OS host name. */
  deviceName?: string
  /** The user ticked "I trust this network; the token is sent unencrypted." for this URL. */
  allowInsecureHttp?: boolean
  /** The user answered Replace to `already_saved`: pairing replaces that saved connection's address and token. */
  replace?: boolean
}

export type RemotePairStep =
  /** Hello answered: enter the code. */
  | 'need_code'
  /** The code is being sent. */
  | 'claiming'
  /** The code was right; the host must allow this computer. */
  | 'waiting'
  /** The host allowed it; URL and token are saved. */
  | 'paired'
  /** Ended: `code` and `message` say why. */
  | 'failed'
  /** Cancelled here. */
  | 'cancelled'

export type RemotePairErrorCode =
  | 'wrong_code'
  | 'attempts_used'
  | 'window_closed'
  | 'denied'
  | 'unreachable'
  | 'firewall'
  | 'rate_limited'
  | 'busy'
  | 'expired'
  | 'insecure_unconfirmed'
  | 'remote_access_off'
  /** The host's ADF predates remote access (its /remote/hello answers 401) or the authenticated hello (remote-access.md §5.2.1). */
  | 'old_daemon'
  /** The host's fingerprint is not the one pinned for this address, or the approval came with another. */
  | 'fingerprint_mismatch'
  /** The user kept the saved remote computer. */
  | 'kept'
  /** This computer is already a saved connection: the dialog asks Replace, then starts again with `replace`. */
  | 'already_saved'
  | 'encryption_unavailable'
  | 'save_failed'
  | 'bad_request'
  | 'not_started'

export interface RemotePairState {
  step: RemotePairStep
  /** The host, from its hello. */
  host: { name: string; fingerprint: string; url: string; encrypted: boolean } | null
  /** This computer's name on the host. */
  deviceName: string
  /** wrong_code: tries left in this window. */
  attemptsLeft: number | null
  /** One sentence for the dialog; null when the step says it all. */
  message: string | null
  code: RemotePairErrorCode | null
  /** paired: the URL saved for the remote computer. */
  savedUrl: string | null
  /** paired: the saved connection's id on the Connection page (`remote:<name>`), for Connect. */
  savedId?: string | null
}
