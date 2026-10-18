/**
 * Remote access: other computers reach this computer's ADF daemon
 * (docs/design/remote-access.md §11). The contract between the daemon's
 * `/remote-access`, `/remote/hello` and `/pair/*` routes and their clients
 * (Studio, the adf CLI). Tokens and pairing codes appear only where a field
 * says so.
 */

export type RemoteAccessState = 'off' | 'on' | 'no_address' | 'env_bind' | 'error'

export interface RemoteAddress {
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'lan' | 'tailnet'
  /** The interface name `os.networkInterfaces()` reports. */
  iface: string
  /** `public`: the OS (Windows) or the owner's list (macOS, Linux) does not mark the network private; no listener (§3.3.1). */
  network: 'private' | 'public' | 'tailnet'
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
  firewall: { state: 'ok' | 'blocked' | 'public_network' | 'unknown'; message: string; commands: string[] }
  devices: RemoteDevice[]
  pairing: PairingWindowView | null
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
  /** macOS and Linux: mark (true) or unmark (false) the current networks private. Windows: 409 `network_category_os`. */
  trustNetwork?: boolean
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
  deviceId?: string
  label?: string
  /** `pairing_closed`: 'wrong_codes' | 'expired' | 'cancelled' | 'paired' | 'denied' | 'disabled'. */
  reason?: string
}
