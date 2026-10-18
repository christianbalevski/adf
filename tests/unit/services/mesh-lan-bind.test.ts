/**
 * The mesh server's bind address. Characterized first (5cc5ccd0: "Allow LAN
 * access" bound 0.0.0.0, every interface, also on a Public network); now LAN
 * mode follows remote access's rule and list (docs/design/remote-access.md
 * §3.3.1, owner decision 2026-10-18 b): loopback plus each private and
 * Tailscale address on a network the user allowed (lan-reach.ts).
 * getHost() keeps '0.0.0.0' as the LAN-mode marker.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { MeshServer } from '../../../src/main/services/mesh-server'
import { LanReach, type LanReachSnapshot } from '../../../src/main/services/lan-reach'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { allowNetwork, forgetNetwork } from '../../../src/main/daemon/remote-access/config'
import { lanNetworkId, tailnetNetworkId } from '../../../src/main/daemon/remote-access/network-key'
import type { AllowedNetwork } from '../../../src/shared/types/remote-access.types'

const HOME = lanNetworkId('aa:bb:cc:dd:ee:01', '192.168.77.0/24', null)
const allowedHome: AllowedNetwork[] = [{ id: HOME, kind: 'lan', label: 'Wi-Fi (192.168.77.0/24)', addedAt: '2026-10-18T00:00:00Z' }]

async function freePort(): Promise<number> {
  const s = createNetServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function boundAddress(server: MeshServer): string {
  const fastify = (server as unknown as { server: { server: { address(): { address: string } } } }).server
  return fastify.server.address().address
}

function health(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: '/health', timeout: 2_000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.end()
  })
}

const reach = (snapshot: Partial<LanReachSnapshot>): LanReach =>
  ({ snapshot: async () => ({ addresses: [], listenable: [], networks: [], tailscale: 'absent', ...snapshot }) }) as unknown as LanReach

function meshServer(port: number, lan: boolean): MeshServer {
  return new MeshServer(new CodeSandboxService(), { get: (k: string) => (k === 'meshPort' ? port : k === 'meshLan' ? lan : undefined) })
}

describe('mesh server bind', () => {
  it('meshLan off: loopback only', async () => {
    const port = await freePort()
    const server = meshServer(port, false)
    try {
      await server.start()
      expect(server.getHost()).toBe('127.0.0.1')
      expect(server.getBindMode()).toBe('loopback')
      expect(boundAddress(server)).toBe('127.0.0.1')
      expect(server.getLanAddresses()).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('meshLan on, on a network not allowed: no wildcard bind, loopback only, not LAN-reachable', async () => {
    const port = await freePort()
    const server = meshServer(port, true)
    server.setLanReach(reach({
      addresses: [{ address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', networkId: 'lan-0123456789abcdef', refusal: 'Not allowed on this network.' }],
      listenable: [],
    }))
    try {
      await server.start()
      expect(server.getHost()).toBe('0.0.0.0')
      expect(server.getBindMode()).toBe('lan')
      expect(boundAddress(server)).toBe('127.0.0.1')
      expect(server.getLanAddresses()).toEqual([])
      expect(server.isLanReachable()).toBe(false)
      expect(await health('127.0.0.1', port)).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it.skipIf(process.platform === 'darwin')('meshLan on, private network: each listenable address gets a listener on the same port, served by the same routes', async () => {
    const port = await freePort()
    const server = meshServer(port, true)
    // 127.0.0.2 stands in for a private LAN address (Windows and Linux route all of 127/8 to loopback).
    server.setLanReach(reach({ listenable: ['127.0.0.2'] }))
    try {
      await server.start()
      expect(boundAddress(server)).toBe('127.0.0.1')
      expect(server.getLanAddresses()).toEqual(['127.0.0.2'])
      expect(server.isLanReachable()).toBe(true)
      expect(await health('127.0.0.2', port)).toBe(200)
    } finally {
      await server.stop()
    }
    expect(await health('127.0.0.2', port)).toBe(0)
  })
})

describe('LanReach (the rule both the mesh and remote access use)', () => {
  const ifaces = {
    'Wi-Fi': [{ address: '192.168.77.10', family: 'IPv4', internal: false, netmask: '255.255.255.0' } as never],
    'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false, netmask: '255.255.240.0' } as never],
    Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '255.255.255.255' } as never],
    Ethernet: [{ address: '203.0.113.5', family: 'IPv4', internal: false, netmask: '255.255.255.0' } as never],
  }
  const tailscale = async () => ({ state: 'running' as const, ips: ['100.101.102.103'], dnsName: 'agent-1-pc.tail1234.ts.net', tailnet: 'tail1234.ts.net' })
  const gateways = async (names: readonly string[]) => new Map(names.map((i) => [i, '192.168.77.1|aa:bb:cc:dd:ee:01']))
  const quiet = { wifiNames: async () => new Map<string, string>(), osCategories: async () => new Map<string, 'private' | 'public'>() }

  it('nothing allowed: nothing listens, the LAN nor the tailnet (first visit)', async () => {
    const r = new LanReach({ settingsDir: null, interfaces: () => ifaces, tailscale, gateways, ...quiet })
    const s = await r.snapshot()
    expect(s.listenable).toEqual([])
    expect(s.networks.map((n) => [n.kind, n.allowed])).toEqual([['tailnet', false], ['lan', false]])
    expect(s.addresses.find((a) => a.address === '192.168.77.10')).toMatchObject({ networkId: HOME, refusal: 'Not allowed on this network.' })
  })

  it('allowed networks listen; virtual adapters and public addresses never', async () => {
    const allowed: AllowedNetwork[] = [...allowedHome, { id: tailnetNetworkId('tail1234.ts.net'), kind: 'tailnet', label: 'Tailnet tail1234.ts.net', addedAt: '2026-10-18T00:00:00Z' }]
    const r = new LanReach({ settingsDir: null, interfaces: () => ifaces, tailscale, gateways, allowed: async () => allowed, ...quiet })
    const s = await r.snapshot()
    expect(s.listenable).toEqual(['100.101.102.103', '192.168.77.10'])
    expect(s.tailscale).toBe('running')
  })
})

describe('the mesh follows the same consent as remote access (remote-access.json allowedNetworks)', () => {
  it.skipIf(process.platform === 'darwin')('no listener until the network is allowed; allowing opens it, removing closes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-consent-'))
    const port = await freePort()
    const reach = new LanReach({
      settingsDir: dir,
      interfaces: () => ({ 'Wi-Fi': [{ address: '192.168.77.10', family: 'IPv4', internal: false, netmask: '255.255.255.0' } as never] }),
      tailscale: async () => ({ state: 'absent', ips: [], dnsName: null }),
      gateways: async (ifaces) => new Map(ifaces.map((i) => [i, '192.168.77.1|aa:bb:cc:dd:ee:01'])),
      wifiNames: async () => new Map(),
      osCategories: async (ifaces) => new Map(ifaces.map((i) => [i, 'private' as const])),
    })
    const server = meshServer(port, true)
    server.setLanReach(reach, { bindAddress: () => '127.0.0.2' })
    try {
      await server.start()
      // A Windows Private network is not consent.
      expect(server.getLanAddresses()).toEqual([])
      expect(server.isLanMode()).toBe(true)
      expect(await health('127.0.0.2', port)).toBe(0)
      allowNetwork(dir, { id: HOME, kind: 'lan', label: 'Wi-Fi (192.168.77.0/24)' })
      await server.syncLan(true)
      expect(server.getLanAddresses()).toEqual(['192.168.77.10'])
      expect(await health('127.0.0.2', port)).toBe(200)
      forgetNetwork(dir, HOME)
      await server.syncLan(true)
      expect(server.getLanAddresses()).toEqual([])
      expect(await health('127.0.0.2', port)).toBe(0)
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('re-review 2: the mesh closes its LAN listener when the network changes', () => {
  it.skipIf(process.platform === 'darwin')('a switch to a network not allowed (same interface and address, another gateway) closes the listener at once, before the slow OS read ends', async () => {
    const port = await freePort()
    const net = { gateway: '192.168.77.1|aa:bb:cc:dd:ee:01', gate: null as Promise<void> | null, reads: 0 }
    const reach = new LanReach({
      settingsDir: null,
      interfaces: () => ({ 'Wi-Fi': [{ address: '192.168.77.10', family: 'IPv4', internal: false, netmask: '255.255.255.0' } as never] }),
      tailscale: async () => ({ state: 'absent', ips: [], dnsName: null }),
      gateways: async (ifaces) => new Map(ifaces.map((i) => [i, net.gateway])),
      allowed: async () => allowedHome,
      wifiNames: async () => new Map(),
      osCategories: async () => {
        net.reads++
        if (net.gate) await net.gate
        return new Map()
      },
    })
    const server = meshServer(port, true)
    // 192.168.77.10 is bound on 127.0.0.2 (the daemon tests' bindAddress seam).
    server.setLanReach(reach, { bindAddress: () => '127.0.0.2' })
    try {
      await server.start()
      expect(server.getLanAddresses()).toEqual(['192.168.77.10'])
      expect(await health('127.0.0.2', port)).toBe(200)
      // The laptop moves: another router, a network not allowed.
      let release!: () => void
      net.gate = new Promise<void>((r) => { release = r })
      net.gateway = '192.168.77.1|de:ad:be:ef:00:02'
      const reads = net.reads
      const sync = server.syncLan(false)
      for (let i = 0; i < 100 && net.reads === reads; i++) await new Promise((r) => setTimeout(r, 10))
      expect(net.reads).toBe(reads + 1)
      // The slow read is still running: the listener closed before it.
      expect(server.getLanAddresses()).toEqual([])
      expect(await health('127.0.0.2', port)).toBe(0)
      release()
      await sync
      expect(server.getLanAddresses()).toEqual([])
      // Back home it listens again; no MAC after the probe (final check) closes it.
      net.gate = null
      net.gateway = '192.168.77.1|aa:bb:cc:dd:ee:01'
      await server.syncLan(false)
      expect(server.getLanAddresses()).toEqual(['192.168.77.10'])
      net.gateway = '192.168.77.1|'
      await server.syncLan(false)
      expect(server.getLanAddresses()).toEqual([])
    } finally {
      await server.stop()
    }
  })
})
