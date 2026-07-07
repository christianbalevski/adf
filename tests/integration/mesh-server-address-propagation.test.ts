import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-mesh-addr-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-mesh-addr-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { MeshManager } from '../../src/main/runtime/mesh-manager'
import { MeshServer } from '../../src/main/services/mesh-server'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'

// The default meshPort is 7295. When 7295 is taken, the port is overridden
// (e.g. 38922 here) and the server binds that instead. If the manager is
// attached AFTER the server started, it must still learn the real port —
// otherwise reply_to / card URLs derive from the stale 7295 default.
const OVERRIDE_PORT = 38922

describe('MeshServer → MeshManager address propagation', () => {
  it('propagates the bound port to a manager attached after start()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-mesh-addr-'))
    const filePath = join(dir, 'riff.adf')
    const agent = createHeadlessAgent({
      filePath, name: 'riff', provider: new MockLLMProvider(),
      createOptions: { handle: 'riff', messaging: { mode: 'respond_only', visibility: 'localhost', receive: true } as never }
    })
    const mesh = new MeshManager([dir])
    mesh.enableMesh()
    mesh.registerServableAgent(filePath, agent.workspace.getAgentConfig(), agent.registry, agent.workspace, agent.session, agent.executor)

    const settingsStub = { get: (k: string) => (k === 'meshPort' ? OVERRIDE_PORT : undefined) }
    const server = new MeshServer(new CodeSandboxService(), settingsStub)

    try {
      // Bug-reproducing order: start the server BEFORE attaching the manager.
      await server.start()
      expect(server.isRunning()).toBe(true)
      expect(server.getPort()).toBe(OVERRIDE_PORT)

      // Manager still on its default until it is attached.
      expect(mesh.getMeshServerAddress().port).toBe(7295)

      server.setMeshManager(mesh)

      // Attaching to an already-running server must backfill the real port.
      expect(mesh.getMeshServerAddress().port).toBe(OVERRIDE_PORT)
    } finally {
      try { await server.stop() } catch { /* best-effort */ }
      try { mesh.unregisterAgent(filePath) } catch { /* best-effort */ }
      agent.dispose()
    }
  })
})
