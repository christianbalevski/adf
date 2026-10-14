import { resolve } from 'node:path'
import { vi } from 'vitest'
import type { ParityEnv } from './env'
import type { FakeElectron } from './electron-fake'
import { createComputeLog, createFakePodmanServiceClass, guardChildProcess, type ComputeLog } from './fake-compute'

/**
 * A backend is whatever registers Studio main's IPC handlers into the fake
 * `ipcMain`. The scenario runner talks only to the fake (`handlers`,
 * `pushes`), so one scenario definition runs against any backend.
 *
 * `embeddedBackend` boots today's in-process backend, `registerAllIpcHandlers`.
 * The daemon-mode backend (W2-C) implements the same interface: it starts a
 * daemon on port 0 against the same `env`, then registers
 * `registerDaemonModeHandlers` into the same fake.
 *
 * The daemon MUST run in this process (after `installEnvironmentStubs`), or
 * a child process MUST get the same fences: module stubs do not cross a
 * process boundary, and the real PodmanService stops the owner's containers
 * on shutdown.
 */
export interface ParityBackend {
  readonly name: string
  boot(env: ParityEnv, electron: FakeElectron): Promise<BootedBackend>
}

export interface BootedBackend {
  /** Stop agents and release every resource the backend holds. Pushes are no longer recorded. */
  shutdown(): Promise<void>
  /** Safety-fence hits during the run (refused podman/wsl spawns). Non-empty fails the run. */
  violations(): string[]
  /** Calls the backend made into the fake compute service (safety evidence; not compared). */
  computeCalls(): readonly string[]
}

const REPO = resolve(__dirname, '../../..')
export const srcPath = (p: string): string => resolve(REPO, 'src', p).replace(/\\/g, '/')

/**
 * Module stubs for environment the parity harness must not reach. Each one
 * replaces a probe of the developer's machine or the network with the answer
 * a clean machine gives; both backends get the same stubs.
 */
export function installEnvironmentStubs(electron: FakeElectron, resources: RunResources): void {
  vi.doMock('electron', () => electron.module)

  // File watchers are tracked so the run can close them: Studio keeps some
  // (the templates folder watcher) for the life of the process, and an open
  // watcher holds the run's directory on Windows after the run is over.
  vi.doMock('chokidar', async (importOriginal) => {
    const actual = await importOriginal<typeof import('chokidar')>()
    const watch = ((...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args)
      resources.watchers.push(watcher)
      return watcher
    }) as typeof actual.watch
    return { ...actual, watch, default: { ...actual, watch } }
  })

  // Never the real PodmanService: its shutdown stops every running adf-*
  // container on the machine, the owner's included. See fake-compute.ts.
  vi.doMock(srcPath('main/services/podman.service.ts'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/services/podman.service')>()
    return { ...actual, PodmanService: createFakePodmanServiceClass(resources.compute) }
  })
  // Second fence: nothing in the run may spawn podman or wsl.
  for (const id of ['child_process', 'node:child_process']) {
    vi.doMock(id, async (importOriginal) => guardChildProcess(await importOriginal<Record<string, unknown>>(), resources.compute))
  }

  // No Podman on the harness machine, for code that probes without the
  // service: the real probe spawns `podman`/`wsl`.
  vi.doMock(srcPath('main/services/podman-bootstrap.ts'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/services/podman-bootstrap')>()
    return {
      ...actual,
      checkPodmanAvailability: async () => ({
        available: false,
        machineRequired: process.platform === 'darwin' || process.platform === 'win32',
        platform: process.platform,
        installMethods: [],
        prerequisites: [],
        error: 'Podman not found on this system.',
      }),
    }
  })

  // The sandbox standard library is "already installed": the real service
  // runs `npm install` against the registry on first boot of a user-data dir.
  vi.doMock(srcPath('main/services/sandbox-stdlib.service.ts'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/services/sandbox-stdlib.service')>()
    class PreinstalledSandboxStdlibService extends actual.SandboxStdlibService {
      override async ensureInstalled(onProgress?: (message: string) => void): Promise<void> {
        onProgress?.('Standard library up to date')
        ;(this as unknown as { ready: boolean }).ready = true
      }
    }
    return { ...actual, SandboxStdlibService: PreinstalledSandboxStdlibService }
  })
}

/** Process-lifetime resources a backend opened that its own shutdown leaves behind. */
export interface RunResources {
  watchers: { close(): Promise<void> }[]
  compute: ComputeLog
}

export function createRunResources(): RunResources {
  return { watchers: [], compute: createComputeLog() }
}

export async function releaseRunResources(resources: RunResources): Promise<void> {
  await Promise.all(resources.watchers.splice(0).map((w) => w.close().catch(() => {})))
}

type IpcModule = typeof import('../../../src/main/ipc/index')

export const embeddedBackend: ParityBackend = {
  name: 'embedded',
  async boot(_env, electron) {
    vi.resetModules()
    const resources = createRunResources()
    installEnvironmentStubs(electron, resources)
    const ipc = (await import(/* @vite-ignore */ srcPath('main/ipc/index.ts'))) as IpcModule
    ipc.registerAllIpcHandlers({
      showMainWindow: () => {
        electron.openWindow()
        return null
      },
      openFile: (filePath) => { electron.localCalls.push({ api: 'hooks.openFile', args: [filePath] }) },
    })
    // Studio creates the window after registering handlers (main/index.ts).
    electron.openWindow()
    return {
      async shutdown() {
        electron.closeWindow()
        await ipc.cleanupAllProcesses({ teardownBudgetMs: 10_000 })
        await releaseRunResources(resources)
      },
      violations: () => resources.compute.refusedSpawns.map((s) => `refused spawn: ${s}`),
      computeCalls: () => resources.compute.calls,
    }
  },
}
