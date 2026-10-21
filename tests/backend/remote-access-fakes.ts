import { helloBody } from '../helpers/hello-proof'
import type { AllowedNetwork, NetworkView, PairingClaimView, PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../src/shared/types/remote-access.types'

/**
 * A fake ADF daemon with remote access (docs/design/remote-access.md §11):
 * the management routes on its loopback origin and the unauthenticated
 * routes on every origin, with the contract's shapes and error codes. One
 * `fetch` serves every origin the test names; requests are recorded.
 *
 * The long poll answers at once while the claim is pending (no wait), so a
 * test drives the flow by deciding the claim.
 */
export interface FakeRemoteDaemon {
  fetch: typeof fetch
  state: {
    enabled: boolean
    name: string
    fingerprint: string
    devices: RemoteDevice[]
    pairing: (PairingWindowView & { claimSecret?: string }) | null
    urls: RemoteUrl[]
    firewall: RemoteAccessStatus['firewall']
    tailscale: RemoteAccessStatus['tailscale']
    /** claimId → decision. */
    claims: Map<string, { state: 'pending' | 'approved' | 'denied' | 'collected'; deviceName: string; token?: string; device?: RemoteDevice; secret: string }>
    /** Wrong codes from the (one) source in the open window. */
    sourceWrong: number
    /** Origins that time out (a firewall dropping packets). */
    unreachable: Set<string>
    /** An ADF from before remote access: no /remote-access routes, a token asked on /remote/hello and /pair/*. */
    old: boolean
    /** The networks this computer is on (GET /remote-access networks). */
    networks: NetworkView[]
    /** The networks the user allowed. */
    allowed: AllowedNetwork[]
    meshLan: boolean
    /** The device tokens it issued (its hello proves each). */
    tokens: string[]
    /** An ADF from before the authenticated hello: its hello has no proof. */
    unsigned: boolean
  }
  requests: Array<{ origin: string; method: string; path: string; body: unknown; headers: Record<string, string> }>
  /** Answer the pending claim as the host's owner would. */
  decide(allow: boolean): void
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const err = (status: number, code: string, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => json(status, { error, code, ...extra }, headers)

/** A device id of the daemon's shape (10 base32 characters) for the n-th device. */
const deviceIdOf = (n: number): string => `dev${'abcdefghijklmnopqrstuvwxyz'[n % 26]}aaaaaa`

export function device(over: Partial<RemoteDevice> = {}): RemoteDevice {
  return {
    id: 'k3j9q2m7xa', label: 'agent-2 laptop', origin: 'paired', createdAt: '2026-10-18T09:12:03Z', createdBy: 'studio',
    lastSeenAt: null, lastSeenAddress: null, connected: false, connections: 0, sessions: 0, ...over,
  }
}

export function createFakeRemoteDaemon(opts: { loopback?: string } = {}): FakeRemoteDaemon {
  const loopback = opts.loopback ?? 'http://127.0.0.1:47385'
  let seq = 0
  const state: FakeRemoteDaemon['state'] = {
    enabled: false,
    name: 'agent-1-pc',
    fingerprint: 'ABCD-EFGH',
    devices: [],
    pairing: null,
    urls: [
      { url: 'http://agent-1-pc.local:7385', kind: 'mdns-name', encrypted: false },
      { url: 'http://192.168.1.20:7385', kind: 'lan', encrypted: false },
      { url: 'http://100.101.102.103:7385', kind: 'tailnet', encrypted: true },
    ],
    firewall: { state: 'ok', message: '', commands: [] },
    tailscale: { state: 'running', serve: 'off', httpsUrl: null, serveCommand: 'tailscale serve --bg 7385' },
    claims: new Map(),
    unreachable: new Set(),
    old: false,
    networks: [{ id: 'lan-0123456789abcdef', kind: 'lan', label: 'Wi-Fi (192.168.1.0/24)', allowed: true, osCategory: 'private', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }],
    allowed: [{ id: 'lan-0123456789abcdef', kind: 'lan', label: 'Wi-Fi (192.168.1.0/24)', addedAt: '2026-10-18T09:00:00Z' }],
    meshLan: false,
    tokens: [],
    unsigned: false,
    sourceWrong: 0,
  }
  const status = (): RemoteAccessStatus => ({
    enabled: state.enabled,
    state: state.enabled ? 'on' : 'off',
    message: state.enabled ? 'Reachable from other computers at 192.168.1.20, 100.101.102.103' : 'Not reachable from other computers',
    problem: null,
    name: state.name,
    fingerprint: state.enabled ? state.fingerprint : null,
    port: 7385,
    addresses: state.enabled ? [
      { address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', networkId: 'lan-0123456789abcdef', allowed: true, listening: true, problem: null },
      { address: '100.101.102.103', family: 'IPv4', kind: 'tailnet', iface: 'Tailscale', networkId: 'tailnet-0123456789abcdef', allowed: true, listening: true, problem: null },
    ] : [],
    urls: state.enabled ? state.urls : [],
    hostNames: [],
    tailscale: state.tailscale,
    mdns: { announcing: state.enabled, problem: null },
    firewall: state.firewall,
    devices: state.devices,
    networks: state.networks.map((n) => ({ ...n, allowed: state.allowed.some((a) => a.id === n.id) })),
    allowedNetworks: state.allowed,
    meshLan: state.meshLan,
    pairing: state.pairing ? { code: state.pairing.code, name: state.name, fingerprint: state.fingerprint, openedAt: state.pairing.openedAt, expiresAt: state.pairing.expiresAt, attemptsLeft: state.pairing.attemptsLeft, lockedSources: state.pairing.lockedSources ?? 0, claim: state.pairing.claim } : null,
  })

  const fake: FakeRemoteDaemon = {
    state,
    requests: [],
    decide(allow) {
      const claim = state.pairing?.claim
      if (!claim) throw new Error('fake daemon: no pending claim')
      const record = state.claims.get(claim.claimId)!
      if (allow) {
        const d = device({ id: deviceIdOf(++seq), label: record.deviceName })
        state.devices.push(d)
        record.state = 'approved'
        record.device = d
        record.token = `adfd_${d.id}_${'s'.repeat(42)}${String.fromCharCode(65 + seq)}`
        state.tokens.push(record.token)
      } else {
        record.state = 'denied'
      }
      state.pairing = null
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      fake.requests.push({ origin: url.origin, method, path: url.pathname, body, headers })
      if (state.unreachable.has(url.origin)) {
        const e = new Error('The operation was aborted due to timeout')
        e.name = 'TimeoutError'
        throw e
      }
      const path = url.pathname
      const management = url.origin === loopback
      if (state.old) {
        if (path === '/remote/hello' || path.startsWith('/pair/')) return err(401, 'unauthorized', 'Missing or invalid token.')
        return err(404, 'not_found', `Route ${method}:${path} not found`)
      }
      if (path === '/remote-access' || path.startsWith('/remote-access/')) {
        if (!management) return err(403, 'loopback_only', 'Only this computer may change remote access.')
        if (method === 'GET' && path === '/remote-access') return json(200, status())
        if (method === 'PUT' && path === '/remote-access') {
          if (typeof body.enabled !== 'boolean') return json(200, status())
          state.enabled = body.enabled
          if (typeof body.name === 'string') state.name = body.name
          if (!state.enabled) state.pairing = null
          return json(200, status())
        }
        if (method === 'POST' && path === '/remote-access/networks') {
          const n = state.networks.find((x) => x.id === body.id)
          if (!n?.id) return err(404, 'network_not_found', 'That network is not one this computer is on now.')
          if (!state.allowed.some((a) => a.id === n.id)) state.allowed.push({ id: n.id, kind: n.kind, label: n.label, addedAt: '2026-10-18T10:00:00Z' })
          return json(200, status())
        }
        if (method === 'DELETE' && path.startsWith('/remote-access/networks/')) {
          const id = decodeURIComponent(path.slice('/remote-access/networks/'.length))
          if (!state.allowed.some((a) => a.id === id)) return err(404, 'network_not_found', 'That network is not allowed.')
          state.allowed = state.allowed.filter((a) => a.id !== id)
          return json(200, status())
        }
        if (method === 'POST' && path === '/remote-access/devices') {
          const d = device({ id: `tok${++seq}`, label: body.label, origin: 'token' })
          state.devices.push(d)
          const token = `adfd_${d.id}_${'t'.repeat(43)}`
          state.tokens.push(token)
          return json(201, { device: d, token })
        }
        const del = /^\/remote-access\/devices\/([^/]+)$/.exec(path)
        if (method === 'DELETE' && del) {
          const d = state.devices.find((x) => x.id === decodeURIComponent(del[1]))
          if (!d) return err(404, 'device_not_found', 'No such computer.')
          state.devices = state.devices.filter((x) => x !== d)
          return json(200, { device: d, closedSessions: 1, closedConnections: 2 })
        }
        if (method === 'POST' && path === '/remote-access/pairing') {
          state.pairing = { code: '123456', name: state.name, fingerprint: state.fingerprint, openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 20, lockedSources: 0, claim: null }
          state.sourceWrong = 0
          return json(201, status().pairing)
        }
        if (method === 'DELETE' && path === '/remote-access/pairing') {
          state.pairing = null
          return new Response(null, { status: 204 })
        }
        const decide = /^\/remote-access\/pairing\/claims\/([^/]+)$/.exec(path)
        if (method === 'POST' && decide) {
          const claim = state.pairing?.claim
          if (!claim || claim.claimId !== decodeURIComponent(decide[1])) return err(409, 'claim_decided', 'Already decided.')
          fake.decide(body.allow === true)
          const record = state.claims.get(claim.claimId)!
          return json(200, record.state === 'approved' ? { state: 'approved', device: record.device } : { state: 'denied' })
        }
        if (method === 'POST' && path === '/remote-access/tailscale-serve') {
          state.tailscale = { ...state.tailscale, serve: body.enabled ? 'on' : 'off', httpsUrl: body.enabled ? 'https://agent-1-pc.tail1234.ts.net' : null }
          return json(200, { tailscale: state.tailscale, output: body.enabled ? 'Available within your tailnet' : 'removed' })
        }
        return err(404, 'not_found', `Route ${method}:${path} not found`)
      }
      // Unauthenticated routes (§11.3).
      if (!state.enabled && (path === '/remote/hello' || path.startsWith('/pair/'))) return err(404, 'remote_access_off', 'Remote access is off.')
      if (method === 'GET' && path === '/remote/hello') {
        // As the daemon answers it, with the proof for the tokens it issued (remote-access.md §5.2.1).
        const hello = helloBody(new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url), { name: state.name, fingerprint: state.fingerprint, tokens: state.tokens, pairingOpen: state.pairing !== null && !state.pairing.claim, old: state.unsigned })
        return json(200, { ...hello, clientApiVersion: 1 })
      }
      if (method === 'POST' && path === '/pair/claim') {
        const p = state.pairing
        if (!p || Date.parse(p.expiresAt) < Date.now()) return err(404, 'pairing_closed', 'No pairing window is open.')
        if (p.claim) return err(409, 'pairing_busy', 'Another computer is waiting for the host.')
        // One source here: 5 wrong codes lock it out of the window (429), 20 in all close it.
        if (state.sourceWrong >= 5) return err(429, 'rate_limited', 'Too many wrong codes from this computer for this pairing window. Ask the host to open a new one.', {}, { 'Retry-After': '100' })
        if (body.code !== p.code) {
          p.attemptsLeft--
          state.sourceWrong++
          if (state.sourceWrong >= 5) p.lockedSources = 1
          const left = Math.max(0, Math.min(5 - state.sourceWrong, p.attemptsLeft))
          if (p.attemptsLeft <= 0) state.pairing = null
          return err(403, 'wrong_code', 'Wrong code.', { attemptsLeft: left })
        }
        const claimId = `claim${++seq}`
        const claim: PairingClaimView = { claimId, deviceName: body.deviceName, clientKind: body.clientKind, address: '192.168.1.31', via: 'lan', tailnetLogin: null, at: new Date().toISOString() }
        p.claim = claim
        const collectSecret = `secret-${claimId}-${'s'.repeat(30)}`
        state.claims.set(claimId, { state: 'pending', deviceName: body.deviceName, secret: collectSecret })
        return json(202, { claimId, expiresAt: p.expiresAt, collectSecret })
      }
      const poll = /^\/pair\/claims\/([^/]+)$/.exec(path)
      if (method === 'GET' && poll) {
        const record = state.claims.get(decodeURIComponent(poll[1]))
        // The claim id alone collects nothing: the collect secret from the 202 must come along.
        const secret = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-adf-pair-secret')?.[1]
        if (!record || record.state === 'collected' || secret !== record.secret) return err(404, 'claim_not_found', 'No such request.')
        if (record.state === 'pending') {
          await new Promise((r) => setTimeout(r, 5))
          return json(200, { state: 'pending' })
        }
        if (record.state === 'denied') return json(200, { state: 'denied' })
        record.state = 'collected'
        return json(200, { state: 'approved', token: record.token, device: { id: record.device!.id, label: record.device!.label }, daemon: { name: state.name, fingerprint: state.fingerprint, urls: state.urls } }, { 'Cache-Control': 'no-store' })
      }
      return err(404, 'not_found', `Route ${method}:${path} not found`)
    }) as typeof fetch,
  }
  return fake
}
