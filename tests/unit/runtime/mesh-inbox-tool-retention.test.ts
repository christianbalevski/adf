import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-mesh-inbox-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-mesh-inbox-test',
      getVersion: () => '0.0.0-test',
    },
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

/** Minimal config — registerAgent only reads handle/messaging/tools. */
function makeConfig(): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'agent-1-id',
    name: 'agent-1',
    handle: 'agent-1',
    tools: [
      { name: 'msg_read', enabled: true, visible: true },
      { name: 'msg_list', enabled: true, visible: true },
      { name: 'msg_update', enabled: true, visible: true },
      { name: 'msg_send', enabled: true, visible: true },
    ],
  } as unknown as AgentConfig
}

function register(
  mesh: MeshManager,
  filePath: string,
  config: AgentConfig,
  registry: ToolRegistry,
  isForeground = true,
): void {
  mesh.registerAgent(
    filePath,
    config,
    registry,
    { _cardBuilder: undefined } as never, // workspace: only _cardBuilder is assigned here
    {} as never,                          // session
    {} as never,                          // triggerEvaluator
    isForeground,
    null,
    null,
    null,
    null,
  )
}

describe('mesh unregister keeps non-mesh inbox tools registered', () => {
  const filePath = join(tmpdir(), 'adf-mesh-inbox', 'agent-1.adf')

  it('leaves msg_read/msg_list/msg_update in the registry and drops only mesh-bound tools', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    expect(registry.get('msg_read')).toBeDefined()

    const mesh = new MeshManager([])
    mesh.enableMesh()
    register(mesh, filePath, makeConfig(), registry)

    expect(registry.get('msg_send')).toBeDefined()
    expect(registry.get('agent_discover')).toBeDefined()

    mesh.unregisterAgent(filePath)

    // Regression: these are plain built-ins the mesh never provided. Studio
    // unregisters + re-registers the mesh on every foreground/background
    // transition against the SAME registry, and a tool_use landing in that
    // window used to fail with "Unknown tool: msg_read".
    expect(registry.get('msg_read')).toBeDefined()
    expect(registry.get('msg_list')).toBeDefined()
    expect(registry.get('msg_update')).toBeDefined()

    // Mesh-bound instances are still torn down.
    expect(registry.get('msg_send')).toBeUndefined()
    expect(registry.get('agent_discover')).toBeUndefined()
  })

  it('keeps mesh-bound tools across a handover unregister and rebinds msg_send on re-register', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const mesh = new MeshManager([])
    // An empty stub is enough: the ws_* tools only touch the manager inside
    // their callbacks, and the handover path must not call unregisterAgent.
    const wsUnregister = vi.fn()
    mesh.setWsConnectionManager({ unregisterAgent: wsUnregister, registerAgent: vi.fn() } as never)
    mesh.enableMesh()

    const fp = join(tmpdir(), 'adf-mesh-inbox', 'agent-3.adf')
    register(mesh, fp, makeConfig(), registry, true)

    const sendBefore = registry.get('msg_send')
    const discoverBefore = registry.get('agent_discover')
    const wsBefore = registry.get('ws_connect')
    expect(sendBefore).toBeDefined()
    expect(discoverBefore).toBeDefined()
    expect(wsBefore).toBeDefined()

    // Foreground -> background: the SAME registry comes back moments later, so
    // nothing may disappear from it in between.
    mesh.unregisterAgent(fp, { keepWsConnections: true })
    expect(wsUnregister).not.toHaveBeenCalled()
    expect(registry.get('msg_send')).toBe(sendBefore)
    expect(registry.get('agent_discover')).toBe(discoverBefore)
    expect(registry.get('ws_connect')).toBe(wsBefore)
    expect(registry.get('ws_send')).toBeDefined()

    // Re-registration under the background host.
    register(mesh, fp, makeConfig(), registry, false)

    const names = registry.getAll().map(t => t.name)
    expect(names.filter(n => n === 'msg_send')).toHaveLength(1)
    expect(names.filter(n => n === 'agent_discover')).toHaveLength(1)
    // msg_send closes over the per-registration config + isMessageTriggeredFn
    // and ws_connect over the WsConnectionManager instance, so both must be
    // fresh instances; agent_discover has no such state and is reused.
    expect(registry.get('msg_send')).not.toBe(sendBefore)
    expect(registry.get('ws_connect')).not.toBe(wsBefore)
    expect(names.filter(n => n === 'ws_connect')).toHaveLength(1)
    expect(registry.get('agent_discover')).toBe(discoverBefore)

    // A real teardown still removes them.
    mesh.unregisterAgent(fp)
    expect(wsUnregister).toHaveBeenCalledTimes(1)
    expect(registry.get('msg_send')).toBeUndefined()
    expect(registry.get('agent_discover')).toBeUndefined()
    expect(registry.get('ws_connect')).toBeUndefined()
    expect(registry.get('msg_read')).toBeDefined()
  })

  it('drops orphaned ws_* tools on a handover when there is no WS manager', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const mesh = new MeshManager([])
    mesh.enableMesh()
    const fp = join(tmpdir(), 'adf-mesh-inbox', 'agent-4.adf')
    register(mesh, fp, makeConfig(), registry)

    // No WS manager ⇒ the ws_* tools were never registered and a survivor would
    // never be refreshed, so the handover must not leave one behind.
    expect(registry.get('ws_connect')).toBeUndefined()
    mesh.unregisterAgent(fp, { keepWsConnections: true })
    expect(registry.get('ws_connect')).toBeUndefined()
    expect(registry.get('msg_send')).toBeDefined()
  })

  it('survives a disableMesh() sweep', () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const mesh = new MeshManager([])
    mesh.enableMesh()
    register(mesh, join(tmpdir(), 'adf-mesh-inbox', 'agent-2.adf'), makeConfig(), registry)
    mesh.disableMesh()

    expect(registry.get('msg_read')).toBeDefined()
    expect(registry.get('msg_send')).toBeUndefined()
  })
})
