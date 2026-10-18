/**
 * Remote access: the fixed API contract of docs/design/remote-access.md §11.1.
 * Shared by the daemon (routes), the CLI and Studio. Shapes only; no logic.
 */

export type RemoteAccessState = 'off' | 'on' | 'no_address' | 'env_bind' | 'error'

export interface RemoteAddress {
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'lan' | 'tailnet'
  iface: string
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
  code: string
  openedAt: string
  expiresAt: string
  attemptsLeft: number
  claim: PairingClaimView | null
}

export interface RemoteAccessStatus {
  enabled: boolean
  state: RemoteAccessState
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
}

export type PairClaimResult =
  | { state: 'pending' }
  | { state: 'denied' }
  | { state: 'approved'; token: string; device: { id: string; label: string }; daemon: { name: string; fingerprint: string; urls: RemoteUrl[] } }
