/**
 * The mesh server's bind address (characterization, before the change that
 * makes LAN mode follow remote access's private/Tailscale-only rule,
 * docs/design/remote-access.md §3.3): with "Allow LAN access" (meshLan) the
 * server binds every interface (0.0.0.0); without it, loopback only.
 */
import { createServer as createNetServer } from 'node:net'
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

describe('mesh server bind (characterization)', () => {
  it('meshLan off: loopback only', async () => {
    const port = await freePort()
    const server = new MeshServer(new CodeSandboxService(), { get: (k: string) => (k === 'meshPort' ? port : undefined) })
    try {
      await server.start()
      expect(server.getHost()).toBe('127.0.0.1')
      expect(boundAddress(server)).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

  it('meshLan on: every interface (0.0.0.0)', async () => {
    const port = await freePort()
    const server = new MeshServer(new CodeSandboxService(), { get: (k: string) => (k === 'meshPort' ? port : k === 'meshLan' ? true : undefined) })
    try {
      await server.start()
      expect(server.getHost()).toBe('0.0.0.0')
      expect(boundAddress(server)).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })
})
