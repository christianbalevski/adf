import { resolve } from 'node:path'
import { vi } from 'vitest'
import type { ParityEnv } from './env'
import type { FakeElectron } from './electron-fake'
import { createComputeLog, createFakePodmanServiceClass, type ComputeLog } from './fake-compute'
import type { NormalizationContext } from './normalize'

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
 * Module stubs do not cross a process boundary. A child-process daemon
 * MUST be started with `-r fence.cjs` and a product-level fake compute
 * seam (see README.md); the real PodmanService stops the owner's containers
 * on shutdown.
 */
export interface ParityBackend {
  readonly name: string
  boot(env: ParityEnv, electron: FakeElectron): Promise<BootedBackend>
}

export interface BootedBackend {
  /**
   * Stop agents and release every resource the backend holds, the way the
   * app does on quit. The window is still open: teardown pushes are recorded.
   */
  shutdown(): Promise<void>
  /** Resources still open after shutdown that should not be. Non-empty fails the run. */
  leaks(): string[]
  /** Calls the backend made into the fake compute service (safety evidence; not compared). */
  computeCalls(): readonly string[]
  /** Extra values for the normalizer, e.g. `{ ports: [{ value: '51234', name: 'DAEMON_PORT' }] }`. */
  normalization?(): Partial<Pick<NormalizationContext, 'ports' | 'named' | 'pids'>>
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

  // File watchers are tracked so shutdown can check they were closed (see
  // releaseRunResources).
  vi.doMock('chokidar', async (importOriginal) => {
    const actual = await importOriginal<typeof import('chokidar')>()
    const watch = ((...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args)
      const close = watcher.close.bind(watcher)
      const entry: TrackedWatcher = { paths: ([] as unknown[]).concat(args[0]).map(String), closed: false, close }
      watcher.close = () => { entry.closed = true; return close() }
      resources.watchers.push(entry)
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
  // The second fence (no podman/wsl spawn at all) is fence.cjs, installed by the env.

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

interface TrackedWatcher {
  paths: string[]
  closed: boolean
  close(): Promise<void>
}

/** Resources a backend opens that the harness checks at shutdown. */
export interface RunResources {
  watchers: TrackedWatcher[]
  compute: ComputeLog
}

export function createRunResources(): RunResources {
  return { watchers: [], compute: createComputeLog() }
}

/**
 * After the backend's own shutdown: report every file watcher still open as
 * a leak (the templates-folder watcher included: cleanupAllProcesses stops it
 * since the E3 fix, tests/parity/documents/templates-watcher-shutdown.test.ts).
 */
export async function releaseRunResources(resources: RunResources, _env: ParityEnv): Promise<string[]> {
  const leaks: string[] = []
  for (const w of resources.watchers) {
    if (w.closed) continue
    leaks.push(`file watcher still open after shutdown: ${w.paths.join(', ')}`)
  }
  // Close every open one, so the run root can be deleted; leaks stay reported.
  await Promise.all(resources.watchers.filter((w) => !w.closed).map((w) => { w.closed = true; return w.close().catch(() => {}) }))
  return leaks
}

type IpcModule = typeof import('../../../src/main/ipc/index')
type LeaseModule = typeof import('../../../src/main/runtime/agent-lease')

export const embeddedBackend: ParityBackend = {
  name: 'embedded',
  async boot(env, electron) {
    vi.resetModules()
    const resources = createRunResources()
    installEnvironmentStubs(electron, resources)
    const ipc = (await import(/* @vite-ignore */ srcPath('main/ipc/index.ts'))) as IpcModule
    // This run's instance of the process lease registry (same module graph as ipc).
    const leases = (await import(/* @vite-ignore */ srcPath('main/runtime/agent-lease.ts'))) as LeaseModule
    ipc.registerAllIpcHandlers({
      showMainWindow: () => {
        electron.openWindow()
        return null
      },
      openFile: (filePath) => { electron.localCalls.push({ api: 'hooks.openFile', args: [filePath] }) },
    })
    // The boot envelope sweep (2 s after boot) never runs in a recording: on
    // its timer it ran inside any scenario that outlasted 2 s on a loaded CI
    // runner (CI run 38749217035). The daemon has no such sweep.
    ipc.cancelDeferredEnvelopeSweep()
    // Studio creates the window after registering handlers (main/index.ts).
    electron.openWindow()
    let leaks: string[] = []
    return {
      async shutdown() {
        await ipc.cleanupAllProcesses({ teardownBudgetMs: 10_000 })
        // Process exit: Studio's 'exit' hook releases every lease and the host
        // record (agent-lease.ts). The harness process does not exit, so the
        // run does the same through the registry's close().
        await leases.resetProcessAgentLeases()
        leaks = await releaseRunResources(resources, env)
      },
      leaks: () => leaks,
      computeCalls: () => resources.compute.calls,
    }
  },
}
