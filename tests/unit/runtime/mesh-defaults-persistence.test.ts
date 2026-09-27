import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-mesh-defaults-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-mesh-defaults-test', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { MeshManager } from '../../../src/main/runtime/mesh-manager'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function makeConfig(messaging?: AgentConfig['messaging']): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'agent-1-id',
    name: 'agent-1',
    handle: 'agent-1',
    ...(messaging ? { messaging } : {}),
    tools: [{ name: 'msg_read', enabled: true, visible: true }],
  } as unknown as AgentConfig
}

/** A workspace whose file config is a separate object, as on disk. */
function fakeWorkspace(onDisk: AgentConfig) {
  let disk = structuredClone(onDisk)
  const writes: AgentConfig[] = []
  return {
    _cardBuilder: undefined,
    getAgentConfig: () => structuredClone(disk),
    setAgentConfig: (c: AgentConfig) => { disk = structuredClone(c); writes.push(disk) },
    get disk() { return disk },
    writes,
  }
}

function register(mesh: MeshManager, filePath: string, config: AgentConfig, workspace: unknown): void {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  mesh.registerAgent(filePath, config, registry, workspace as never, {} as never, {} as never, true, null, null, null, null)
}

describe('mesh defaults persistence', () => {
  it("never overwrites the owner's receive:false on disk, while the running config receives", () => {
    const filePath = join(tmpdir(), 'adf-mesh-defaults', 'agent-1.adf')
    const config = makeConfig({ receive: false, mode: 'proactive' })
    const ws = fakeWorkspace(config)
    const persisted: AgentConfig[] = []
    const mesh = new MeshManager([])
    mesh.enableMesh()
    mesh.setConfigPersistedListener((_fp, c) => persisted.push(c))

    register(mesh, filePath, config, ws)

    expect(config.messaging.receive).toBe(true)          // runtime policy on the mesh
    expect(ws.disk.messaging.receive).toBe(false)        // owner's choice kept
    // Missing communication tool declarations ARE persisted, and the host is told.
    expect(ws.disk.tools.map(t => t.name)).toEqual(expect.arrayContaining(['msg_send', 'agent_discover']))
    expect(persisted).toHaveLength(1)

    // Idempotent: nothing left to add, nothing written again.
    mesh.unregisterAgent(filePath)
    register(mesh, filePath, makeConfig({ receive: false, mode: 'proactive' }), ws)
    expect(ws.writes).toHaveLength(1)
  })

  it('persists a messaging section only when the file has none', () => {
    const filePath = join(tmpdir(), 'adf-mesh-defaults', 'agent-2.adf')
    const config = makeConfig()
    const ws = fakeWorkspace(config)
    const mesh = new MeshManager([])
    mesh.enableMesh()
    register(mesh, filePath, config, ws)
    expect(ws.disk.messaging).toEqual({ receive: true, mode: 'proactive' })
  })
})
