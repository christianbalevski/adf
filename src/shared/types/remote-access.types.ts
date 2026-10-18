/**
 * Remote access: other computers reach this computer's ADF daemon
 * (docs/design/remote-access.md §11). The contract between the daemon's
 * `/remote-access`, `/remote/hello` and `/pair/*` routes and their clients
 * (Studio, the adf CLI). Tokens and pairing codes appear only where a field
 * says so.
 */

/** `paused`: on, but no address listens because this computer's networks are not allowed (owner decision 2026-10-18 b). */
export type RemoteAccessState = 'off' | 'on' | 'paused' | 'no_address' | 'env_bind' | 'error'

/**
 * A network this computer is on now (owner decision 2026-10-18 b: listen only
 * on a network the user allowed). LAN: identified by the default gateway's
 * MAC address and the subnet (and the Wi-Fi name where it is readable
 * without a permission prompt). Tailnet: by the tailnet's name.
 */
export interface NetworkView {
  /** Null: the network cannot be identified yet (no gateway MAC known); it cannot be allowed. */
  id: string | null
  kind: 'lan' | 'tailnet'
  label: string
  allowed: boolean
  /** What the OS says (Windows' category); unknown elsewhere. Only for the warning line: it is never consent. */
  osCategory: 'private' | 'public' | 'unknown'
  ifaces: string[]
  addresses: string[]
}

/** A network the user allowed (remote-access.json `allowedNetworks`; the mesh's LAN mode reads the same list). */
export interface AllowedNetwork {
  id: string
  kind: 'lan' | 'tailnet'
  label: string
  addedAt: string
}

export interface RemoteAddress {
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'lan' | 'tailnet'
  /** The interface name `os.networkInterfaces()` reports. */
  iface: string
  /** The network the address is on (NetworkView.id); null when it cannot be identified. */
  networkId: string | null
  /** The user allowed that network; only then does the address listen. */
  allowed: boolean
  listening: boolean
  problem: string | null
}

export interface RemoteUrl {
  url: string
  kind: 'tailscale-https' | 'tailnet' | 'lan' | 'mdns-name'
  encrypted: boolean
}

export interface RemoteDevice {
  id: string
  label: string
  origin: 'paired' | 'token'
  createdAt: string
  createdBy: 'studio' | 'cli'
  lastSeenAt: string | null
  lastSeenAddress: string | null
  /** An open client session or stream, or a request in the last 60 s. */
  connected: boolean
  connections: number
  sessions: number
}

export interface PairingClaimView {
  claimId: string
  deviceName: string
  clientKind: 'studio' | 'cli'
  address: string
  via: 'lan' | 'tailnet' | 'proxy'
  tailnetLogin: string | null
  at: string
}

export interface PairingWindowView {
  /** The 6-digit code. Only management routes (this machine) return it. */
  code: string
  /** This computer's name and fingerprint, as the other computer sees them (GET /remote/hello). */
  name: string
  fingerprint: string
  openedAt: string
  expiresAt: string
  /** Wrong codes left in this window, all sources together (20 at the start); 0 closes it. */
  attemptsLeft: number
  /** Sources locked out of this window after 5 wrong codes each. */
  lockedSources: number
  claim: PairingClaimView | null
}

export interface RemoteAccessStatus {
  enabled: boolean
  state: RemoteAccessState
  /** One sentence for the status line. */
  message: string
  problem: string | null
  name: string
  fingerprint: string | null
  port: number
  addresses: RemoteAddress[]
  urls: RemoteUrl[]
  hostNames: string[]
  tailscale: { state: 'absent' | 'stopped' | 'running'; serve: 'on' | 'off' | 'unknown'; httpsUrl: string | null; serveCommand: string | null }
  mdns: { announcing: boolean; problem: string | null }
  firewall: { state: 'ok' | 'blocked' | 'unknown'; message: string; commands: string[] }
  devices: RemoteDevice[]
  pairing: PairingWindowView | null
  /** The networks this computer is on now. */
  networks: NetworkView[]
  /** The networks the user allowed. */
  allowedNetworks: AllowedNetwork[]
  /** The daemon's mesh listens on the LAN (same consent): Studio asks about a new network when this or `enabled` is on. */
  meshLan: boolean
}

export interface RemoteHello {
  v: 1
  name: string
  fingerprint: string
  pairingOpen: boolean
  clientApiVersion: number
}

export interface PairClaimRequest {
  code: string
  deviceName: string
  clientKind: 'studio' | 'cli'
}

export interface PairClaimAccepted {
  claimId: string
  expiresAt: string
  /** Send it as X-ADF-Pair-Secret to collect the result (GET /pair/claims/:claimId). Only the claimant has it. */
  collectSecret: string
}

export type PairClaimResult =
  | { state: 'pending' }
  | { state: 'denied' }
  | { state: 'approved'; token: string; device: { id: string; label: string }; daemon: { name: string; fingerprint: string; urls: RemoteUrl[] } }

/** PUT /remote-access body: at least one field. */
export interface RemoteAccessPatch {
  enabled?: boolean
  name?: string
}

/**
 * Client push topic `remote_access`, to this computer's own sessions only
 * (never a device session, never the umbilical bus). Never carries a token,
 * a code or a claim: `claim_pending` means "pending claims changed", read
 * them through GET /remote-access.
 */
export interface RemoteAccessEvent {
  type:
    | 'enabled' | 'disabled' | 'addresses_changed'
    | 'pairing_opened' | 'pairing_closed' | 'claim_pending'
    /** A source was locked out of the pairing window after 5 wrong codes (the window stays open). */
    | 'pairing_lockout'
    | 'device_added' | 'device_revoked' | 'device_connected' | 'device_disconnected'
    | 'networks_changed'
    /** The discovery feed changed (GET /network/peers): the ADF computers found on the LAN and the tailnet. */
    | 'peers_changed'
  deviceId?: string
  label?: string
  /** `pairing_closed`: 'wrong_codes' | 'expired' | 'cancelled' | 'paired' | 'denied' | 'disabled'. */
  reason?: string
}

/**
 * One ADF computer the discovery feed found (docs/design/remote-access.md
 * §5.1): one `_adf-runtime._tcp` announcement, a legacy `_adf-daemon._tcp`
 * one, or the tailnet sweep. Each entry carries both capabilities. The mesh
 * peer list, Studio's Discovered list and `adf pair` read the same feed.
 */
export interface NetworkPeer {
  /** The runtime id, or `fp:<fingerprint>` for a computer known only through remote access. */
  key: string
  name: string
  source: 'mdns' | 'tailnet' | 'manual'
  /** Its mesh, when visible to other computers: base URL (agents under /agents). */
  mesh: { url: string; port: number } | null
  /** Its remote access, when on: the tailnet address wins over the LAN one (encrypted). */
  remote: {
    url: string
    port: number
    fingerprint: string
    pairingOpen: boolean
    kind: 'lan' | 'tailnet'
    /** One fingerprint seen at this many addresses (more than one on the LAN or on the tailnet): each is listed; null when not. */
    clash: number | null
  } | null
}
