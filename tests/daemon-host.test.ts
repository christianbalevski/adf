import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-host-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-daemon-host-test',
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

import { DaemonHost } from '../src/main/daemon/daemon-host'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'

describe('DaemonHost', () => {
  it('unloads agents and stops all compute containers on shutdown', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'shutdown-agent', provider: new MockLLMProvider() })
    let stopCalled = 0
    let stopAllCalled = 0
    const host = new DaemonHost({
      runtime,
      computeService: {
        getStatus: () => ({ status: 'running', containerName: 'adf-mcp', activeAgents: [ref.id] }),
        listContainers: async () => [{ name: 'adf-mcp', status: 'running', running: true }],
        ensureRunning: async () => {},
        stop: async () => { stopCalled++ },
        stopAll: async () => { stopAllCalled++ },
      },
    })

    await host.stop()

    expect(runtime.getAgent(ref.id)).toBeUndefined()
    expect(stopAllCalled).toBe(2)
    expect(stopCalled).toBe(0)
  })

  it('stops compute even when an agent unload hangs', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'stuck-agent', provider: new MockLLMProvider() })
    runtime.unloadAgent = async () => new Promise<void>(() => {})
    let stopAllCalled = 0
    const host = new DaemonHost({
      runtime,
      shutdownAgentTimeoutMs: 5,
      computeService: {
        getStatus: () => ({ status: 'running', containerName: 'adf-mcp', activeAgents: [ref.id] }),
        listContainers: async () => [{ name: 'adf-mcp', status: 'running', running: true }],
        ensureRunning: async () => {},
        stop: async () => {},
        stopAll: async () => { stopAllCalled++ },
      },
    })

    await host.stop()

    expect(stopAllCalled).toBe(2)
  })
})
