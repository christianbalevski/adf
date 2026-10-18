/**
 * The mesh server's bind address. Characterized first (5cc5ccd0: "Allow LAN
 * access" bound 0.0.0.0, every interface, also on a Public network); now LAN
 * mode follows remote access's rule (docs/design/remote-access.md §3.3):
 * loopback plus each private-network and Tailscale address, never a public
 * network (lan-reach.ts). getHost() keeps '0.0.0.0' as the LAN-mode marker.
 */
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
  ({ snapshot: async () => ({ addresses: [], listenable: [], tailscale: 'absent', problem: null, ...snapshot }) }) as unknown as LanReach

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

  it('meshLan on, on a Public network: no wildcard bind, loopback only, not LAN-reachable', async () => {
    const port = await freePort()
    const server = meshServer(port, true)
    server.setLanReach(reach({
      addresses: [{ address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', network: 'public', refusal: 'Not reachable on this network (Public).' }],
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
    'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never],
    'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false } as never],
    Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false } as never],
    Ethernet: [{ address: '203.0.113.5', family: 'IPv4', internal: false } as never],
  }
  const tailscale = async () => ({ state: 'running' as const, ips: ['100.101.102.103'], dnsName: 'agent-1-pc.tail1234.ts.net' })

  it('a private network listens; Tailscale always; virtual adapters and public addresses never', async () => {
    const r = new LanReach({ settingsDir: null, interfaces: () => ifaces, tailscale, categories: async () => ({ categories: new Map([['Wi-Fi', 'private' as const]]), current: [], problem: null }) })
    const s = await r.snapshot()
    expect(s.listenable).toEqual(['100.101.102.103', '192.168.1.20'])
    expect(s.tailscale).toBe('running')
  })

  it('a Public network: the LAN address is listed with its refusal and does not listen', async () => {
    const r = new LanReach({ settingsDir: null, interfaces: () => ifaces, tailscale, categories: async () => ({ categories: new Map([['Wi-Fi', 'public' as const]]), current: [], problem: null }) })
    const s = await r.snapshot()
    expect(s.listenable).toEqual(['100.101.102.103'])
    expect(s.addresses.find((a) => a.address === '192.168.1.20')).toMatchObject({ network: 'public', refusal: 'Not reachable on this network (Public).' })
  })
})
