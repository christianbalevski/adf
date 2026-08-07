import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { DaemonHost } from '../src/main/daemon/daemon-host'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'

const scratchDir = join(tmpdir(), `adf-daemon-host-pid-${process.pid}`)

function pidFilePath(name: string): string {
  mkdirSync(scratchDir, { recursive: true })
  return join(scratchDir, name)
}

describe('DaemonHost', () => {
  beforeEach(async () => {
    // stopOnce latches the process-wide RuntimeGate via beginTeardown();
    // clear it so each test can register agents again.
    const { RuntimeGate } = await import('../src/main/runtime/runtime-gate')
    ;(RuntimeGate as unknown as { _resetForTests?: () => void })._resetForTests?.()
  })

  it('unloads agents and stops all compute containers on shutdown', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'shutdown-agent', provider: new MockLLMProvider() })
    let stopCalled = 0
    let stopAllCalled = 0
    let pendingStartsCalled = 0
    const host = new DaemonHost({
      runtime,
      computeService: {
        getStatus: () => ({ status: 'running', containerName: 'adf-mcp', activeAgents: [ref.id] }),
        listContainers: async () => [{ name: 'adf-mcp', status: 'running', running: true }],
        ensureRunning: async () => {},
        stop: async () => { stopCalled++ },
        stopAll: async () => { stopAllCalled++ },
        pendingStarts: async () => { pendingStartsCalled++ },
      },
    })

    await host.stop()

    expect(runtime.getAgent(ref.id)).toBeUndefined()
    // pendingStarts drains in-flight container starts, so a single stopAll suffices.
    expect(pendingStartsCalled).toBe(1)
    expect(stopAllCalled).toBe(1)
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
        pendingStarts: async () => {},
      },
    })

    await host.stop()

    expect(stopAllCalled).toBe(1)
  })

  it('runs onShutdownStart hooks before agent unload and onShutdown hooks after', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    runtime.createAgent({ name: 'order-agent', provider: new MockLLMProvider() })
    const events: string[] = []
    const origUnload = runtime.unloadAgent.bind(runtime)
    runtime.unloadAgent = async (id, opts) => { events.push('unload'); return origUnload(id, opts) }
    const host = new DaemonHost({
      runtime,
      onShutdownStart: [() => { events.push('start-hook') }],
      onShutdown: [() => { events.push('shutdown-hook') }],
    })

    await host.stop()

    expect(events).toEqual(['start-hook', 'unload', 'shutdown-hook'])
  })

  it('does not re-run shutdown hooks when stop() is called again after completion', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    let startHooks = 0
    let hooks = 0
    const host = new DaemonHost({
      runtime,
      onShutdownStart: [() => { startHooks++ }],
      onShutdown: [() => { hooks++ }],
    })

    await host.stop()
    await host.stop()

    expect(startHooks).toBe(1)
    expect(hooks).toBe(1)
  })

  it('writes a JSON identity pid file and removes it on stop', async () => {
    const pidFile = pidFilePath('identity.pid')
    rmSync(pidFile, { force: true })
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const host = new DaemonHost({ runtime, host: '127.0.0.1', port: 0, pidFile })

    await host.start()
    try {
      const record = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid: number; startedAt: number; image: string }
      expect(record.pid).toBe(process.pid)
      expect(record.image).toBe('adf-daemon')
      expect(typeof record.startedAt).toBe('number')
      expect(record.startedAt).toBeLessThanOrEqual(Date.now())
    } finally {
      await host.stop()
    }
    expect(existsSync(pidFile)).toBe(false)
  })

  it('treats a pre-reboot pid file as stale even when the pid is alive', async () => {
    const pidFile = pidFilePath('stale-reboot.pid')
    // process.ppid (the test runner) is definitely alive; a startedAt from
    // before the current OS boot must still be treated as stale.
    const preBoot = Date.now() - osUptime() * 1000 - 60_000
    writeFileSync(pidFile, `${JSON.stringify({ pid: process.ppid, startedAt: preBoot, image: 'adf-daemon' })}\n`, 'utf-8')
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const host = new DaemonHost({ runtime, host: '127.0.0.1', port: 0, pidFile })

    await host.start()
    try {
      const record = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid: number }
      expect(record.pid).toBe(process.pid)
    } finally {
      await host.stop()
    }
  })

  it('refuses to start when the pid file names a live post-boot process', async () => {
    const pidFile = pidFilePath('live.pid')
    writeFileSync(pidFile, `${JSON.stringify({ pid: process.ppid, startedAt: Date.now(), image: 'adf-daemon' })}\n`, 'utf-8')
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const host = new DaemonHost({ runtime, host: '127.0.0.1', port: 0, pidFile })

    await expect(host.start()).rejects.toThrow(/already running as PID/)
    rmSync(pidFile, { force: true })
  })
})
