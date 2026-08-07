import { RuntimeService, type RuntimeAgentLoadedEvent } from '../runtime/runtime-service'
import { AgentRuntimeBuilder } from '../runtime/agent-runtime-builder'
import { CodeSandboxService } from '../runtime/code-sandbox'
import { MeshManager } from '../runtime/mesh-manager'
import { createProvider } from '../providers/provider-factory'
import { seedMandatoryReasoningModels, setMandatoryReasoningPersister } from '../providers/ai-sdk-provider'
import { PodmanService, type ComputeEnvSettings } from '../services/podman.service'
import { SandboxPackagesService } from '../services/sandbox-packages.service'
import { SandboxStdlibService } from '../services/sandbox-stdlib.service'
import { MeshServer } from '../services/mesh-server'
import { WsConnectionManager } from '../services/ws-connection-manager'
import { PackageResolver } from '../services/mcp-package-resolver'
import { UvManager } from '../services/uv-manager'
import { UvxPackageResolver } from '../services/uvx-package-resolver'
import { killAllHostExecs } from '../services/host-exec.service'
import { getTokenUsageService } from '../services/token-usage.service'
import { DaemonHost } from './daemon-host'
import { DaemonEventBus } from './event-bus'
import { defaultSettingsPath, FileSettingsStore } from './file-settings-store'
import { withSource } from '../runtime/execution-context'
import { registerDaemonEventBus, emitUmbilicalEvent } from '../runtime/emit-umbilical'
import { ensureWorkspaceUmbilicalBus, destroyUmbilicalBus } from '../runtime/umbilical-bus'
import { TapManager } from '../runtime/tap-manager'
import { getLanAddresses } from '../utils/network'
import { purgeAllScratchDirs, purgeStaleProcessDirs } from '../utils/scratch-dir'
import { killAllTracked } from '../utils/child-registry'
import { withDeadline } from '../utils/concurrency'
import { AdfDatabase } from '../adf/adf-database'
import { DEFAULT_COMPUTE_SETTINGS } from '../../shared/constants/compute-defaults'

// A console.log after the parent's stdout pipe is gone emits EIO/EPIPE; with
// no 'error' listener that becomes an uncaught exception over a harmless
// shutdown write. No-op listeners absorb dead-pipe writes (parity with Studio).
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

// --- Fatal/signal handling — installed BEFORE any construction so an early
// Ctrl+C or crash during boot still exits instead of leaking children. Once
// the host exists, they run its bounded shutdown.
const FATAL_SHUTDOWN_BUDGET_MS = 20_000
let hostForShutdown: { stop(): Promise<void> } | null = null
let shutdownStarted = false

async function boundedShutdown(exitCode: number): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  try {
    if (hostForShutdown) {
      await withDeadline(hostForShutdown.stop(), FATAL_SHUTDOWN_BUDGET_MS, () => {
        console.error(`[ADF Daemon] Shutdown exceeded ${FATAL_SHUTDOWN_BUDGET_MS}ms budget — forcing exit`)
      })
    }
  } catch (err) {
    console.error('[ADF Daemon] Shutdown error:', err)
  } finally {
    process.exit(exitCode)
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as NodeJS.Signals[]) {
  process.on(sig, () => {
    console.log(`[ADF Daemon] Received ${sig} — shutting down...`)
    void boundedShutdown(0)
  })
}
process.on('uncaughtException', (err) => {
  console.error('[ADF Daemon] Uncaught exception:', err?.stack ?? err)
  void boundedShutdown(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[ADF Daemon] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  void boundedShutdown(1)
})

const port = Number(process.env.ADF_DAEMON_PORT ?? 7385)
const host = process.env.ADF_DAEMON_HOST ?? '127.0.0.1'
const pidFile = process.env.ADF_DAEMON_PIDFILE
const settingsPath = process.env.ADF_DAEMON_SETTINGS ?? defaultSettingsPath()

const settings = new FileSettingsStore(settingsPath)
const eventBus = new DaemonEventBus(1000)
registerDaemonEventBus(eventBus)
// Seed + persist the set of OpenRouter models that mandate reasoning (they 400
// on an explicit disable). Persisting means a model fails at most once, ever.
// (Parity with Studio registerAllIpcHandlers.)
seedMandatoryReasoningModels((settings.get('openrouterMandatoryReasoningModels') as string[] | undefined) ?? [])
setMandatoryReasoningPersister((modelId) => {
  const cur = (settings.get('openrouterMandatoryReasoningModels') as string[] | undefined) ?? []
  if (!cur.includes(modelId)) settings.set('openrouterMandatoryReasoningModels', [...cur, modelId])
})
const basePrompt = (settings.get('globalSystemPrompt') as string | undefined) ?? ''
const toolPrompts = (settings.get('toolPrompts') as Record<string, string> | undefined) ?? {}
const compactionPrompt = (settings.get('compactionPrompt') as string | undefined) ?? undefined
const trackedDirs = (settings.get('trackedDirectories') as string[] | undefined) ?? []
const codeSandboxService = new CodeSandboxService()
const sandboxPackagesService = new SandboxPackagesService()
const sandboxStdlibService = new SandboxStdlibService()
const podmanService = new PodmanService()
podmanService.setSettingsAccessor(() => readComputeSettings(settings.get('compute')))
const uvManager = new UvManager()
const mcpPackageResolver = new PackageResolver('mcp-servers')
const adapterPackageResolver = new PackageResolver('channel-adapters')
const uvxPackageResolver = new UvxPackageResolver(uvManager)
const meshManager = new MeshManager(trackedDirs)
const wsConnectionManager = new WsConnectionManager(meshManager.createWsDelegate())
meshManager.setWsConnectionManager(wsConnectionManager)
const meshServer = new MeshServer(codeSandboxService, settings)
meshServer.setMeshManager(meshManager)
meshServer.setWsConnectionManager(wsConnectionManager)
if (settings.get('meshEnabled') !== false) {
  meshManager.enableMesh()
}
const agentRuntimeBuilder = new AgentRuntimeBuilder({
  settings,
  codeSandboxService,
  podmanService,
  wsConnectionManager,
  mcpPackageResolver,
  adapterPackageResolver,
  uvManager,
  uvxPackageResolver,
  basePrompt,
  toolPrompts,
  compactionPrompt,
})
const runtime = new RuntimeService({
  settings,
  providerFactory: config => createProvider(config, settings),
  basePrompt,
  toolPrompts,
  compactionPrompt,
  agentRuntimeBuilder,
})
const loadedAgentEvents = new Map<string, RuntimeAgentLoadedEvent>()
const daemon = new DaemonHost({
  runtime,
  host,
  port,
  pidFile,
  computeService: podmanService,
  settingsStore: settings,
  eventBus,
  wsService: wsConnectionManager,
  networkService: {
    getStatus: () => ({
      meshEnabled: meshManager.isEnabled(),
      meshServerRunning: meshServer.isRunning(),
      meshServer: {
        running: meshServer.isRunning(),
        port: meshServer.getPort(),
        host: meshServer.getHost(),
      },
      agents: meshManager.getAgentStatuses(),
      debug: meshManager.getDebugInfo(),
    }),
    enableMesh: () => {
      if (!meshManager.isEnabled()) meshManager.enableMesh()
      for (const event of loadedAgentEvents.values()) registerAgentWithMesh(event)
      return { success: true, meshEnabled: meshManager.isEnabled(), agents: meshManager.getAgentStatuses() }
    },
    disableMesh: () => {
      meshManager.disableMesh()
      return { success: true, meshEnabled: meshManager.isEnabled(), agents: meshManager.getAgentStatuses() }
    },
    getRecentTools: (limit) => meshManager.getRecentTools(limit),
    getServerStatus: () => ({
      running: meshServer.isRunning(),
      port: meshServer.getPort(),
      host: meshServer.getHost(),
    }),
    startServer: async () => {
      await meshServer.start()
      return { success: meshServer.isRunning(), running: meshServer.isRunning(), port: meshServer.getPort(), host: meshServer.getHost() }
    },
    stopServer: async () => {
      await meshServer.stop()
      return { success: true, running: meshServer.isRunning(), port: meshServer.getPort(), host: meshServer.getHost() }
    },
    restartServer: async () => {
      await meshServer.stop()
      await meshServer.start()
      return { success: meshServer.isRunning(), running: meshServer.isRunning(), port: meshServer.getPort(), host: meshServer.getHost() }
    },
    getLanAddresses,
    getDiscoveredRuntimes: () => [],
  },
  mcpPackageService: mcpPackageResolver,
  mcpPythonPackageService: uvxPackageResolver,
  adapterPackageService: adapterPackageResolver,
  sandboxPackageService: sandboxPackagesService,
  // Runs inside DaemonHost.stop() after agents and compute are down — keeps
  // daemon shutdown at parity with Studio's cleanupAllProcesses. Each hook is
  // independently try-caught by the host.
  onShutdown: [
    () => wsConnectionManager.stopAll(),
    () => meshServer.stop(),
    () => meshManager.disableMesh(),
    () => codeSandboxService.destroyAll(),
    () => getTokenUsageService().flush(),
    () => killAllTracked(),
    () => killAllHostExecs(),
    () => sweepTrackedDirWalFiles(),
    () => purgeAllScratchDirs(),
  ],
})
hostForShutdown = daemon

/**
 * Checkpoint + remove WAL sidecars across tracked directories, skipping any
 * .adf still loaded by the runtime (their DBs are open and SQLite owns the
 * sidecars).
 */
function sweepTrackedDirWalFiles(): void {
  const loadedPaths = new Set<string>()
  for (const event of loadedAgentEvents.values()) {
    if (event.filePath) loadedPaths.add(event.filePath)
  }
  const dirs = (settings.get('trackedDirectories') as string[] | undefined) ?? []
  for (const dir of dirs) {
    try { AdfDatabase.cleanupOrphanedWalFiles(dir, loadedPaths) }
    catch (err) { console.error(`[ADF Daemon] WAL sweep failed in ${dir}:`, err) }
  }
}

runtime.on('agent-event', ({ agentId, filePath, event }) => {
  // Envelope event (raw forwarded executor event) stays here.
  // tool.* / turn.* / agent.state.changed / agent.error are emitted
  // inside AgentExecutor.emitEvent so they fire in both daemon and Studio.
  emitUmbilicalEvent({
    event_type: 'agent.event',
    agentId,
    timestamp: event.timestamp,
    payload: { filePath, event },
  })
})
const tapManagers = new Map<string, TapManager>()

runtime.on('agent-loaded', async (event) => {
  loadedAgentEvents.set(event.agentId, event)
  if (event.agent.codeSandboxService && event.agent.adfCallHandler && event.agent.workspace) {
    const bus = ensureWorkspaceUmbilicalBus(event.agentId, event.agent.workspace)
    const taps = event.ref.config.umbilical_taps ?? []
    if (taps.length > 0) {
      const tm = new TapManager(
        event.agentId,
        event.agent.workspace,
        bus,
        event.agent.codeSandboxService,
        event.agent.adfCallHandler,
      )
      try {
        await tm.register(taps)
        tapManagers.set(event.agentId, tm)
      } catch (err) {
        console.error(`[ADF Daemon] Tap registration failed for ${event.agentId}:`, err)
      }
    }
  } else if (event.agent.workspace) {
    ensureWorkspaceUmbilicalBus(event.agentId, event.agent.workspace)
  }
  withSource('system:lifecycle', event.agentId, () => {
    emitUmbilicalEvent({
      event_type: 'agent.loaded',
      agentId: event.agentId,
      payload: {
        filePath: event.filePath,
        name: event.ref.config.name,
        handle: event.ref.config.handle,
        autostart: event.ref.config.autostart ?? false,
      },
    })
  })
  registerAgentWithMesh(event)
  if (event.agent.adapterManager) {
    event.agent.adapterManager.on('status-changed', (type, status, error) => {
      withSource('system:adapter', event.agentId, () => {
        emitUmbilicalEvent({
          event_type: 'adapter.status.changed',
          agentId: event.agentId,
          payload: { filePath: event.filePath, type, status, error },
        })
      })
    })
    event.agent.adapterManager.on('log', (type, entry) => {
      withSource('system:adapter', event.agentId, () => {
        emitUmbilicalEvent({
          event_type: 'adapter.log',
          agentId: event.agentId,
          timestamp: entry.timestamp,
          payload: { filePath: event.filePath, type, entry },
        })
      })
    })
  }
  if (event.agent.mcpManager) {
    event.agent.mcpManager.on('status-changed', (name, status, error) => {
      withSource('system:mcp', event.agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.status.changed',
          agentId: event.agentId,
          payload: { filePath: event.filePath, name, status, error },
        })
      })
    })
    event.agent.mcpManager.on('tools-discovered', (name, tools) => {
      withSource('system:mcp', event.agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.tools.discovered',
          agentId: event.agentId,
          payload: { filePath: event.filePath, name, toolCount: tools.length },
        })
      })
    })
    event.agent.mcpManager.on('log', (name, entry) => {
      withSource('system:mcp', event.agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.log',
          agentId: event.agentId,
          timestamp: entry.timestamp,
          payload: { filePath: event.filePath, name, entry },
        })
      })
    })
  }
})
runtime.on('agent-unloaded', ({ agentId, filePath }) => {
  loadedAgentEvents.delete(agentId)
  const tm = tapManagers.get(agentId)
  if (tm) {
    tm.dispose()
    tapManagers.delete(agentId)
  }
  withSource('system:lifecycle', agentId, () => {
    emitUmbilicalEvent({
      event_type: 'agent.unloaded',
      agentId,
      payload: { filePath },
    })
  })
  destroyUmbilicalBus(agentId)
  if (filePath) meshManager.unregisterAgent(filePath)
})

withSource('system:daemon', () => {
  // Clean up scratch dirs left by previous processes that exited uncleanly
  // (parity with Studio boot).
  try { purgeStaleProcessDirs() } catch (err) { console.warn('[ADF Daemon] Stale scratch purge failed:', err) }

  daemon.start()
    .then(address => {
      console.log(`[ADF Daemon] Listening on http://${address.host}:${address.port}`)
      console.log(`[ADF Daemon] Settings: ${settings.filePath ?? '(memory)'}`)
      withSource('system:daemon', () => {
        emitUmbilicalEvent({
          event_type: 'daemon.started',
          payload: { host: address.host, port: address.port, settingsPath: settings.filePath ?? null },
        })
      })

      // Install sandbox standard library packages (first-launch or version
      // update). Background — agents can start immediately, stdlib becomes
      // available when ready (parity with Studio ipc boot).
      sandboxStdlibService.ensureInstalled((msg) => {
        console.log(`[SandboxStdlib] ${msg}`)
      }).then(() => {
        codeSandboxService.setStdlib(
          sandboxStdlibService.getBasePath(),
          sandboxStdlibService.getModuleNames()
        )
        console.log('[SandboxStdlib] Standard library ready')
      }).catch((err) => {
        console.error('[SandboxStdlib] Failed to install standard library:', err)
      })

      // Auto-start the shared MCP container, deferred and fire-and-forget —
      // same gate as Studio (no settings-level compute-enabled flag exists,
      // so it stays unconditional but never competes with boot).
      setTimeout(() => {
        podmanService.ensureRunning().then(() => {
          console.log('[Compute] Shared MCP container ready')
        }).catch((err) => {
          console.warn('[Compute] Shared container failed to start (MCP servers will run on host):', err instanceof Error ? err.message : err)
        })
      }, 5_000).unref?.()

      const maxDepth = (settings.get('maxDirectoryScanDepth') as number | undefined) ?? 5
      meshServer.start().catch(err => console.error('[MeshServer] Failed to start:', err))

      // Sweep closed WAL sidecars in tracked dirs, deferred until after
      // autostart so open agents are skipped (parity with Studio cleanup).
      const scheduleWalSweep = () => {
        setTimeout(() => {
          try { sweepTrackedDirWalFiles() } catch (err) { console.error('[ADF Daemon] WAL sweep failed:', err) }
        }, 2_000).unref?.()
      }

      if (trackedDirs.length > 0) {
        withSource('system:daemon', () => runtime.autostartFromDirectories(trackedDirs, { maxDepth }))
          .then(report => {
            console.log('[ADF Daemon] Autostart report:', JSON.stringify(report))
            withSource('system:daemon', () => {
              emitUmbilicalEvent({ event_type: 'daemon.autostart.report', payload: { report } })
            })
          })
          .catch(err => console.error('[ADF Daemon] Autostart failed:', err))
          .finally(scheduleWalSweep)
      }
    })
    .catch(err => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EADDRINUSE') {
        console.error(
          `[ADF Daemon] Failed to start: port ${port} on ${host} is already in use — ` +
          'an ADF daemon (or another service) is likely running there already. ' +
          (pidFile ? `Check the pid file at ${pidFile}. ` : 'Check ADF_DAEMON_PIDFILE / running processes. ') +
          'Stop the existing daemon, or pick another port via ADF_DAEMON_PORT.'
        )
      } else {
        console.error('[ADF Daemon] Failed to start:', err)
      }
      process.exit(1)
    })
})

function registerAgentWithMesh(event: RuntimeAgentLoadedEvent): void {
  if (!event.filePath) return
  meshManager.registerServableAgent(
    event.filePath,
    event.ref.config,
    event.agent.registry,
    event.agent.workspace,
    event.agent.session,
    event.agent.executor,
    event.agent.adfCallHandler ?? null,
    event.agent.codeSandboxService ?? codeSandboxService,
    event.agent.triggerEvaluator,
  )
  if (event.agent.adapterManager) {
    meshManager.setAdapterManager(event.filePath, event.agent.adapterManager)
  }
}

// Compute defaults come from the shared single source of truth — a local copy
// previously drifted and launched containers without the VNC/desktop packages.
function readComputeSettings(raw: unknown): ComputeEnvSettings {
  const compute = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    containerPackages: Array.isArray(compute.containerPackages)
      ? compute.containerPackages.filter((pkg): pkg is string => typeof pkg === 'string')
      : DEFAULT_COMPUTE_SETTINGS.containerPackages,
    machineCpus: typeof compute.machineCpus === 'number'
      ? compute.machineCpus
      : DEFAULT_COMPUTE_SETTINGS.machineCpus,
    machineMemoryMb: typeof compute.machineMemoryMb === 'number'
      ? compute.machineMemoryMb
      : DEFAULT_COMPUTE_SETTINGS.machineMemoryMb,
    containerImage: typeof compute.containerImage === 'string'
      ? compute.containerImage
      : DEFAULT_COMPUTE_SETTINGS.containerImage,
  }
}
