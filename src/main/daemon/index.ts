import { RuntimeService, type RuntimeAgentLoadedEvent } from '../runtime/runtime-service'
import { AgentRuntimeBuilder } from '../runtime/agent-runtime-builder'
import { CodeSandboxService } from '../runtime/code-sandbox'
import { MeshManager } from '../runtime/mesh-manager'
import { createProvider } from '../providers/provider-factory'
import { PodmanService, type ComputeEnvSettings } from '../services/podman.service'
import { SandboxPackagesService } from '../services/sandbox-packages.service'
import { MeshServer } from '../services/mesh-server'
import { WsConnectionManager } from '../services/ws-connection-manager'
import { PackageResolver } from '../services/mcp-package-resolver'
import { UvManager } from '../services/uv-manager'
import { UvxPackageResolver } from '../services/uvx-package-resolver'
import { DaemonHost } from './daemon-host'
import { DaemonEventBus } from './event-bus'
import { defaultSettingsPath, FileSettingsStore } from './file-settings-store'
import { withSource } from '../runtime/execution-context'
import { registerDaemonEventBus, emitUmbilicalEvent } from '../runtime/emit-umbilical'
import { ensureWorkspaceUmbilicalBus, destroyUmbilicalBus } from '../runtime/umbilical-bus'
import { TapManager } from '../runtime/tap-manager'
import { getLanAddresses } from '../utils/network'

const port = Number(process.env.ADF_DAEMON_PORT ?? 7385)
const host = process.env.ADF_DAEMON_HOST ?? '127.0.0.1'
const pidFile = process.env.ADF_DAEMON_PIDFILE
const settingsPath = process.env.ADF_DAEMON_SETTINGS ?? defaultSettingsPath()

const settings = new FileSettingsStore(settingsPath)
const eventBus = new DaemonEventBus(1000)
registerDaemonEventBus(eventBus)
const basePrompt = (settings.get('globalSystemPrompt') as string | undefined) ?? ''
const toolPrompts = (settings.get('toolPrompts') as Record<string, string> | undefined) ?? {}
const compactionPrompt = (settings.get('compactionPrompt') as string | undefined) ?? undefined
const trackedDirs = (settings.get('trackedDirectories') as string[] | undefined) ?? []
const codeSandboxService = new CodeSandboxService()
const sandboxPackagesService = new SandboxPackagesService()
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
})

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
      const maxDepth = (settings.get('maxDirectoryScanDepth') as number | undefined) ?? 5
      meshServer.start().catch(err => console.error('[MeshServer] Failed to start:', err))
      if (trackedDirs.length > 0) {
        withSource('system:daemon', () => runtime.autostartFromDirectories(trackedDirs, { maxDepth }))
          .then(report => {
            console.log('[ADF Daemon] Autostart report:', JSON.stringify(report))
            withSource('system:daemon', () => {
              emitUmbilicalEvent({ event_type: 'daemon.autostart.report', payload: { report } })
            })
          })
          .catch(err => console.error('[ADF Daemon] Autostart failed:', err))
      }
    })
    .catch(err => {
      console.error('[ADF Daemon] Failed to start:', err)
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

const DEFAULT_COMPUTE_SETTINGS: ComputeEnvSettings = {
  containerPackages: ['python3-full', 'python3-pip', 'git', 'curl', 'wget', 'jq', 'unzip', 'ca-certificates', 'openssh-client', 'procps', 'chromium', 'chromium-driver', 'fonts-liberation', 'libnss3', 'libatk-bridge2.0-0', 'libdrm2', 'libgbm1', 'libasound2'],
  machineCpus: 2,
  machineMemoryMb: 2048,
  containerImage: 'docker.io/library/node:20-slim',
}

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
