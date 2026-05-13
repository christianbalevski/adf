import { z } from 'zod'
import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync, renameSync, copyFileSync, writeFileSync } from 'fs'
import { join, dirname, basename, resolve, relative } from 'path'

/**
 * Delete an ADF file and its associated SQLite WAL files (-shm, -wal).
 */
function deleteAdfFile(filePath: string): void {
  // Delete main file
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
  // Delete WAL files
  const shmPath = `${filePath}-shm`
  const walPath = `${filePath}-wal`
  if (existsSync(shmPath)) {
    unlinkSync(shmPath)
  }
  if (existsSync(walPath)) {
    unlinkSync(walPath)
  }
}
import chokidar from 'chokidar'
import { IPC } from '../../shared/constants/ipc-channels'
import { AdfWorkspace } from '../adf/adf-workspace'
import { AdfDatabase } from '../adf/adf-database'
import { AgentExecutor } from '../runtime/agent-executor'
import { AgentSession } from '../runtime/agent-session'
import { TriggerEvaluator } from '../runtime/trigger-evaluator'
import { RuntimeGate } from '../runtime/runtime-gate'
import { MeshManager } from '../runtime/mesh-manager'
import { BackgroundAgentManager } from '../runtime/background-agent-manager'
import { createProvider } from '../providers/provider-factory'
import { ToolRegistry } from '../tools/tool-registry'
import { SendMessageTool, AgentDiscoverTool, SysCodeTool, SysLambdaTool, SysGetConfigTool, SysUpdateConfigTool, SysFetchTool, ShellTool, CreateAdfTool, NpmInstallTool, NpmUninstallTool, FsTransferTool, ComputeExecTool, McpInstallTool, McpUninstallTool, McpRestartTool, WsConnectTool, WsDisconnectTool, WsConnectionsTool, WsSendTool, StreamBindTool, StreamUnbindTool, StreamBindingsTool, buildToolDiscovery } from '../tools/built-in'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import { StreamBindingManager } from '../runtime/stream-binding-manager'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import { AdfCallHandler } from '../runtime/adf-call-handler'
import { ensureWorkspaceUmbilicalBus, destroyUmbilicalBus } from '../runtime/umbilical-bus'
import { TapManager } from '../runtime/tap-manager'
import { SystemScopeHandler } from '../runtime/system-scope-handler'
import { CodeSandboxService } from '../runtime/code-sandbox'
import { SettingsService } from '../services/settings.service'
import { MeshServer } from '../services/mesh-server'
import { MdnsService, type DiscoveredRuntime } from '../services/mdns-service'
import { DirectoryFetchCache } from '../services/directory-fetch-cache'
import { getOrCreateRuntimeId } from '../utils/runtime-id'
import { McpClientManager } from '../services/mcp-client-manager'
import { createScratchDir, removeScratchDir, purgeAllScratchDirs } from '../utils/scratch-dir'
import { getLanAddresses } from '../utils/network'
import { McpPackageResolver, PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpSpawnConfig, resolveMcpEnvVars } from '../services/mcp-spawn-utils'
import { SandboxStdlibService } from '../services/sandbox-stdlib.service'
import { SandboxPackagesService } from '../services/sandbox-packages.service'
import { McpTool } from '../tools/mcp-tool'
import { PodmanService, isolatedContainerName, containerWorkspacePath } from '../services/podman.service'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { shouldContainerize, shouldIsolate, isServerForceShared, type ComputeSettings } from '../services/container-routing'
import { resolveContainerCommand } from '../services/container-command-resolver'
import { syncDiscoveredMcpTools } from '../services/mcp-tool-sync'
import { buildMcpServerConfigFromRegistration } from '../../shared/utils/mcp-config'
import { ChannelAdapterManager } from '../services/channel-adapter-manager'
import { WsConnectionManager } from '../services/ws-connection-manager'
import { getTokenUsageService } from '../services/token-usage.service'
import { getTokenCounterService } from '../services/token-counter.service'
import { buildConfigSummary, autoLockFields, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { createEvent, createDispatch, type AdfEventDispatch, type AdfBatchDispatch } from '../../shared/types/adf-event.types'
import type { MeshEvent, BackgroundAgentEvent, AgentExecutionEvent, McpServerRegistration, AdapterRegistration } from '../../shared/types/ipc.types'
import type { AgentConfig, MetaProtectionLevel } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'

import { encrypt } from '../crypto/identity-crypto'

/**
 * Read recent tool calls from an agent's workspace loop table.
 * Extracts tool_use/tool_result pairs from the last ~30 loop entries.
 */
function readRecentToolsFromWorkspace(
  workspace: AdfWorkspace,
  limit: number
): { name: string; args?: string; isError?: boolean; timestamp: number }[] {
  try {
    const totalCount = workspace.getLoopCount()
    const offset = Math.max(0, totalCount - 30)
    const entries = offset > 0
      ? workspace.getLoopPaginated(30, offset)
      : workspace.getLoop()

    const toolUseMap = new Map<string, { name: string; args?: string; timestamp: number }>()
    const tools: { name: string; args?: string; isError?: boolean; timestamp: number }[] = []

    for (const entry of entries) {
      for (const block of entry.content_json) {
        if (block.type === 'tool_use' && block.name && block.id) {
          let args: string | undefined
          if (block.input) {
            try {
              const input = block.input as Record<string, unknown>
              if (typeof input._reason === 'string' && input._reason) {
                args = input._reason
              } else {
                const str = typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                args = str.length > 40 ? str.slice(0, 40) + '...' : str
              }
            } catch { /* ignore */ }
          }
          toolUseMap.set(block.id, { name: block.name, args, timestamp: entry.created_at })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const matched = toolUseMap.get(block.tool_use_id)
          if (matched) {
            tools.push({ ...matched, isError: !!block.is_error })
            toolUseMap.delete(block.tool_use_id)
          }
        }
      }
    }

    // Unmatched tool_use (still in progress)
    for (const pending of toolUseMap.values()) {
      tools.push(pending)
    }

    return tools.slice(-limit)
  } catch {
    return []
  }
}

// Application state
let currentWorkspace: AdfWorkspace | null = null
let currentFilePath: string | null = null
const openedAdfDirs = new Set<string>()
let currentDerivedKey: Buffer | null = null
// Cache derived keys by file path so we don't re-prompt within the same app session
const derivedKeyCache = new Map<string, Buffer>()
let agentExecutor: AgentExecutor | null = null
let triggerEvaluator: TriggerEvaluator | null = null
let currentTapManager: TapManager | null = null
let currentStreamBindingManager: StreamBindingManager | null = null
let currentUmbilicalAgentId: string | null = null
let currentSession: AgentSession | null = null
let toolRegistry: ToolRegistry
let settings: SettingsService
let meshManager: MeshManager | null = null
let backgroundAgentManager: BackgroundAgentManager | null = null
let codeSandboxService: CodeSandboxService = new CodeSandboxService()
const sandboxStdlibService = new SandboxStdlibService()
const sandboxPackagesService = new SandboxPackagesService()
let meshServer: MeshServer | null = null
let mdnsService: MdnsService | null = null
let directoryFetchCache: DirectoryFetchCache | null = null
let wsConnectionManager: WsConnectionManager | null = null
let currentAgentToolRegistry: ToolRegistry | null = null
let currentMcpManager: McpClientManager | null = null
let currentScratchDir: string | null = null
let currentAdapterManager: ChannelAdapterManager | null = null
let currentAdfCallHandler: AdfCallHandler | null = null

/**
 * Start mDNS announce/browse if the runtime is eligible: mesh server running,
 * bound to `0.0.0.0`, and (for announcement) at least one LAN-tier agent.
 * Browsing happens whenever the server is LAN-bound — a runtime without
 * LAN-tier agents can still *discover* peers without being announced itself.
 *
 * Idempotent: bails if mDNS is already running, or conditions aren't met.
 * Per spec, re-announcement on tier changes is out of scope — restart required.
 */
async function startMdnsIfEligible(): Promise<void> {
  if (!meshServer || !meshServer.isRunning()) return
  const host = meshServer.getHost()
  if (host !== '0.0.0.0') return  // only announce/browse when LAN-bound

  const hasLanAgent = meshManager?.hasAgentOfTier('lan') ?? false

  // Re-wire meshManager every call: boot runs this before MESH_ENABLE has
  // created meshManager, so the original wire-up in the setup block below was
  // a no-op. When MESH_ENABLE later re-invokes us, the early returns below
  // would skip the wire-up too. Without this, agent_discover(scope: 'all')
  // sees null mdnsService/directoryFetchCache even though both exist.
  if (meshManager) {
    if (directoryFetchCache) meshManager.setDirectoryFetchCache(directoryFetchCache)
    if (mdnsService) meshManager.setMdnsService(mdnsService)
  }

  // If a service is already running, only restart it when we need to flip the
  // announce gate from off→on. (Boot runs this before MESH_ENABLE has created
  // the meshManager, so the first call lands a browse-only service; when
  // MESH_ENABLE later registers a LAN-tier agent, we must upgrade to announcing.)
  if (mdnsService) {
    if (!hasLanAgent) return              // still nothing to announce
    if (mdnsService.isAnnouncing()) return // already announcing — nothing to do
    await stopMdnsAndCleanup()
  }

  const runtimeId = getOrCreateRuntimeId(settings)
  const runtimeDid = settings.get('runtimeDid') as string | undefined

  if (!directoryFetchCache) directoryFetchCache = new DirectoryFetchCache()
  meshManager?.setDirectoryFetchCache(directoryFetchCache)

  const service = new MdnsService()
  service.on('discovered', (peer: DiscoveredRuntime) => {
    meshManager?.emitRuntimeDiscovered(peer)
    // Eager directory prefetch so the UI and agent_discover see agent counts
    // immediately on discovery, not lazily on first read.
    void directoryFetchCache?.fetch(peer.url)
  })
  service.on('expired', (peer: DiscoveredRuntime) => {
    meshManager?.emitRuntimeExpired(peer)
    directoryFetchCache?.invalidate(peer.url)
  })
  service.on('unavailable', ({ reason }: { reason: string }) => {
    console.log(`[mdns] unavailable: ${reason}`)
  })

  await service.start({
    announce: hasLanAgent,
    browse: true,
    port: meshServer.getPort(),
    runtimeId,
    runtimeDid
  })

  mdnsService = service
  meshManager?.setMdnsService(service)
}

/**
 * Stop mDNS cleanly (sends goodbye packets). Must be called before mesh server
 * shutdown so peers evict our entry before the socket goes away.
 */
async function stopMdnsAndCleanup(): Promise<void> {
  const svc = mdnsService
  mdnsService = null
  meshManager?.setMdnsService(null)
  directoryFetchCache?.invalidate()
  if (svc) {
    try { await svc.stop() } catch (err) { console.error('[mdns] stop failed:', err) }
  }
}
const podmanService = new PodmanService()
// Mount host MCP install directories into the container so MCP servers can run
// No host mounts — MCP packages are installed directly inside the container
// via npx/uvx on first connection. This provides true isolation.
// Lazy settings accessor — settings may not be initialized yet at import time
podmanService.setSettingsAccessor(() => {
  const raw = settings?.get('compute') as Record<string, unknown> | undefined
  return {
    containerPackages: (raw?.containerPackages as string[]) ?? ['python3', 'py3-pip', 'git', 'curl'],
    machineCpus: (raw?.machineCpus as number) ?? 2,
    machineMemoryMb: (raw?.machineMemoryMb as number) ?? 2048,
    containerImage: (raw?.containerImage as string) ?? 'docker.io/library/node:20-alpine',
  }
})
const mcpPackageResolver = new McpPackageResolver()
const adapterPackageResolver = new PackageResolver('channel-adapters')
import { UvManager } from '../services/uv-manager'
import { UvxPackageResolver } from '../services/uvx-package-resolver'
const uvManager = new UvManager()
const uvxPackageResolver = new UvxPackageResolver(uvManager)
/** Persisted MCP server logs — survives agent stop so the settings Logs viewer works */
const MCP_LOG_CACHE_MAX_SERVERS = 50
const mcpLogCache = new Map<string, import('../shared/types/adf-v02.types').McpServerLogEntry[]>()
function mcpLogCacheSet(name: string, logs: import('../shared/types/adf-v02.types').McpServerLogEntry[]): void {
  mcpLogCache.set(name, logs)
  // Evict oldest entries (Map insertion order) when over limit
  while (mcpLogCache.size > MCP_LOG_CACHE_MAX_SERVERS) {
    const oldest = mcpLogCache.keys().next().value
    if (oldest !== undefined) mcpLogCache.delete(oldest)
    else break
  }
}
let extractedDisplayState: string | null = null
// Set of filePaths with in-flight AGENT_START so cleanupCurrentFile doesn't close their workspaces
const startingFilePaths = new Set<string>()

function rememberAdfDirectory(filePath: string): void {
  openedAdfDirs.add(resolve(dirname(filePath)))
}

function rememberTrackedDirectory(dirPath: string): void {
  openedAdfDirs.add(resolve(dirPath))
}

function cleanupWalFilesRecursive(directory: string, maxDepth: number, currentDepth = 0): void {
  AdfDatabase.cleanupOrphanedWalFiles(directory)
  if (currentDepth >= maxDepth) return

  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    cleanupWalFilesRecursive(join(directory, entry.name), maxDepth, currentDepth + 1)
  }
}

/**
 * Resolve a ProviderConfig from ADF-stored providers + identity (API key).
 * Returns undefined if the agent's selected provider isn't stored in the ADF.
 */
function resolveProviderConfig(
  config: AgentConfig,
  workspace: AdfWorkspace,
  derivedKey: Buffer | null
): import('../../shared/types/ipc.types').ProviderConfig | undefined {
  const adfProvider = config.providers?.find(p => p.id === config.model.provider)
  if (!adfProvider) return undefined
  const apiKey = workspace.getIdentityDecrypted(
    `provider:${adfProvider.id}:apiKey`, derivedKey
  ) ?? ''
  return { ...adfProvider, apiKey }
}

/** Sync a derived key to the mesh manager for pipeline signing access. */
function syncDerivedKeyToMesh(filePath: string, key: Buffer | null): void {
  if (!meshManager?.isEnabled()) return
  if (key) {
    meshManager.setDerivedKey(filePath, key)
  } else {
    meshManager.clearDerivedKey(filePath)
  }
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

/**
 * Map executor internal states to display states for trigger evaluation.
 * Executor uses: idle, thinking, tool_use, awaiting_approval, awaiting_ask, suspended, error, stopped
 * Display uses: active, idle, hibernate, suspended, off
 */
function executorToDisplayState(executorState: string): string {
  switch (executorState) {
    case 'thinking':
    case 'tool_use':
      return 'active'
    case 'idle':
      return 'idle'
    case 'awaiting_approval':
    case 'awaiting_ask':
    case 'suspended':
      return 'suspended'
    case 'error':
    case 'stopped':
      return 'off'
    // Already a display state (from sys_set_state or start_in_state)
    case 'active':
    case 'hibernate':
    case 'off':
      return executorState
    default:
      return executorState
  }
}

// --- Tracked directory watcher ---
let dirWatcher: chokidar.FSWatcher | null = null

/**
 * Auto-track the parent directory of a newly created ADF file (if not already tracked)
 * and notify the renderer to refresh its sidebar listing.
 * If the directory is already a subdirectory of an existing tracked directory, just
 * refresh the parent tracked dir instead of adding a duplicate entry.
 */
function notifyAdfFileCreated(newFilePath: string): void {
  rememberAdfDirectory(newFilePath)
  const win = getMainWindow()
  if (!win) return
  const dirPath = resolve(dirname(newFilePath))
  const existing = (settings.get('trackedDirectories') as string[]) ?? []

  // Check if this directory is already covered by a tracked parent (normalize paths for comparison)
  const trackedParent = existing.find(d => {
    const nd = resolve(d)
    return dirPath === nd || dirPath.startsWith(nd + '/')
  })
  if (trackedParent) {
    win.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: trackedParent })
    return
  }

  // New directory not covered by any tracked dir — auto-track it
  const updated = [...existing, dirPath]
  settings.set('trackedDirectories', updated)
  startDirWatcher(updated)
  if (meshManager) meshManager.setTrackedDirectories(updated)
  win.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath })
}

function startDirWatcher(directories: string[]): void {
  stopDirWatcher()
  if (directories.length === 0) return

  dirWatcher = chokidar.watch(
    directories.map((d) => join(d, '*.adf')),
    { ignoreInitial: true }
  )

  dirWatcher.on('add', (filePath: string) => {
    const win = getMainWindow()
    if (win) {
      win.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: dirname(filePath) })
    }
  })

  dirWatcher.on('unlink', (filePath: string) => {
    const win = getMainWindow()
    if (win) {
      win.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: dirname(filePath) })
    }
  })
}

function stopDirWatcher(): void {
  if (dirWatcher) {
    dirWatcher.close()
    dirWatcher = null
  }
}

/**
 * Clean up the currently open file, agent, and session.
 */
async function cleanupCurrentFile(): Promise<void> {
  const t0 = performance.now()
  const filePath = currentFilePath
  const workspace = currentWorkspace
  const session = currentSession
  const executor = agentExecutor
  const triggers = triggerEvaluator
  const agentToolReg = currentAgentToolRegistry

  // Dispose the foreground TapManager before handing off.
  // - If transitioning to background, BackgroundAgentManager will create a new
  //   TapManager for the background path against the same bus.
  // - If the agent is fully stopping, stopAgent in BackgroundAgentManager will
  //   destroyUmbilicalBus; we don't need to touch the bus here.
  if (currentTapManager) {
    try { currentTapManager.dispose() } catch { /* best-effort */ }
    currentTapManager = null
  }
  currentUmbilicalAgentId = null

  // Clear module-level refs immediately
  agentExecutor = null
  triggerEvaluator = null
  currentAgentToolRegistry = null
  const adfHandler = currentAdfCallHandler
  currentAdfCallHandler = null
  // Cache the derived key so re-opening the same file doesn't re-prompt
  if (currentDerivedKey && filePath) {
    derivedKeyCache.set(filePath, currentDerivedKey)
  }
  currentDerivedKey = null

  // Transition to background if running
  const willTransitionToBackground = !!(executor && backgroundAgentManager && filePath && workspace && session)

  // Unregister from mesh (keep WS connections alive if transitioning to background)
  if (meshManager?.isEnabled() && filePath) {
    meshManager.unregisterAgent(filePath, { keepWsConnections: willTransitionToBackground })
  }

  if (willTransitionToBackground) {
    const config = workspace.getAgentConfig()

    // Transfer MCP manager + scratch dir ownership to background — don't disconnect
    const mcpMgr = currentMcpManager
    currentMcpManager = null
    const scratchDir = currentScratchDir
    currentScratchDir = null

    // Transfer adapter manager ownership to background — don't stop
    const adapterMgr = currentAdapterManager
    currentAdapterManager = null
    const streamBindingMgr = currentStreamBindingManager
    currentStreamBindingManager = null

    const t1 = performance.now()
    await backgroundAgentManager.transitionToBackground(
      filePath, config, session, workspace, executor, triggers ?? undefined, agentToolReg ?? undefined, mcpMgr, adapterMgr, adfHandler, scratchDir, streamBindingMgr
    )
    console.log(`[PERF] cleanupCurrentFile.transitionToBackground: ${(performance.now() - t1).toFixed(1)}ms`)

    if (meshManager?.isEnabled() && backgroundAgentManager.hasAgent(filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(filePath)
      if (agentRefs) {
        meshManager.registerAgent(
          filePath, agentRefs.config, agentRefs.toolRegistry,
          agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
          () => backgroundAgentManager!.getIsMessageTriggered(filePath),
          agentRefs.executor,
          agentRefs.adfCallHandler,
          agentRefs.codeSandboxService
        )
        syncDerivedKeyToMesh(filePath, derivedKeyCache.get(filePath) ?? null)

        // Re-wire adapter manager to mesh
        if (adapterMgr) {
          meshManager.setAdapterManager(filePath, adapterMgr)
        }
      }
    }

    currentWorkspace = null
    currentSession = null
    currentFilePath = null
    console.log(`[PERF] cleanupCurrentFile (with transition): ${(performance.now() - t0).toFixed(1)}ms`)
    return
  }

  // No transition — abort and clean up
  if (executor) executor.abort()
  if (triggers) triggers.dispose()
  if (currentAdapterManager) {
    await currentAdapterManager.stopAll()
    currentAdapterManager = null
  }
  if (currentStreamBindingManager) {
    currentStreamBindingManager.stopAll('agent_stopped')
    currentStreamBindingManager = null
  }
  currentSession = null

  // Don't close the workspace if AGENT_START is in-flight for this file —
  // it still needs the database connection. AGENT_START will handle cleanup.
  if (workspace && !(filePath && startingFilePaths.has(filePath))) {
    workspace.close()
  }

  currentWorkspace = null
  currentFilePath = null
  console.log(`[PERF] cleanupCurrentFile (no transition): ${(performance.now() - t0).toFixed(1)}ms`)
}

/**
 * Re-entrancy guard for handleAgentOff — prevents the cleanup from re-firing when
 * the very abort/disconnect calls inside it cause downstream events.
 */
const offInProgress = new Set<string>()

/**
 * Centralized "hard off" teardown. Single entry point invoked whenever an agent
 * transitions to the 'off' display state, regardless of source (LLM tool call,
 * lambda, HIL approval, fresh start vs. reuse, foreground vs. background).
 *
 * Tears down everything that makes the agent reachable or active:
 * mesh registration, executor, trigger evaluator, MCP servers, channel adapters,
 * code sandbox. Workspace stays open (file may still be visible in foreground).
 */
async function handleAgentOff(filePath: string): Promise<void> {
  if (offInProgress.has(filePath)) return
  offInProgress.add(filePath)
  try {
    console.log(`[AgentOff] Hard shutdown: ${filePath}`)

    // Mesh: unregister first so no new messages can arrive during teardown.
    if (meshManager?.isEnabled()) {
      meshManager.unregisterAgent(filePath)
    }

    if (filePath === currentFilePath) {
      // Foreground teardown — clear module-level globals.
      if (agentExecutor) {
        try { agentExecutor.abort() } catch { /* ignore */ }
        agentExecutor = null
      }
      if (triggerEvaluator) {
        try { triggerEvaluator.dispose() } catch { /* ignore */ }
        triggerEvaluator = null
      }
      if (currentMcpManager) {
        const mgr = currentMcpManager
        currentMcpManager = null
        try { mgr.removeAllListeners(); await mgr.disconnectAll() } catch { /* ignore */ }
      }
      if (currentAdapterManager) {
        const adapter = currentAdapterManager
        currentAdapterManager = null
        try {
          adapter.removeAllListeners()
          if (meshManager) meshManager.removeAdapterManager(filePath)
          await adapter.stopAll()
        } catch { /* ignore */ }
      }
      if (currentStreamBindingManager) {
        try { currentStreamBindingManager.stopAll('agent_stopped') } catch { /* ignore */ }
        currentStreamBindingManager = null
      }
      try { codeSandboxService?.destroy(filePath) } catch { /* ignore */ }
      // Stop isolated container if one was running for this agent
      try {
        if (currentWorkspace) {
          const cfg = currentWorkspace.getAgentConfig()
          if (cfg.compute?.enabled) {
            podmanService.stopIsolated(cfg.name, cfg.id).catch(() => {})
          }
        }
      } catch { /* ignore */ }
      currentSession = null
      currentAgentToolRegistry = null
      currentAdfCallHandler = null
    } else if (backgroundAgentManager?.hasAgent(filePath)) {
      // Background teardown — stopAgent handles executor abort, MCP, adapters, sandbox.
      try { await backgroundAgentManager.stopAgent(filePath) } catch (err) {
        console.error(`[AgentOff] Background stopAgent failed for ${filePath}:`, err)
      }
    }
  } finally {
    offInProgress.delete(filePath)
  }
}

export function registerAllIpcHandlers(): void {
  settings = new SettingsService()
  // Generate owner + runtime DIDs on first launch
  const { ownerDid, runtimeDid } = settings.ensureRuntimeIdentity()
  console.log(`[Runtime] Owner DID: ${ownerDid}`)
  console.log(`[Runtime] Runtime DID: ${runtimeDid}`)

  toolRegistry = new ToolRegistry()
  registerBuiltInTools(toolRegistry)

  // Install sandbox standard library packages (first-launch or version update)
  // Runs in background — agents can start immediately, stdlib becomes available when ready
  sandboxStdlibService.ensureInstalled((msg) => {
    console.log(`[SandboxStdlib] ${msg}`)
    const win = getMainWindow()
    if (win) win.webContents.send('stdlib-install-progress', msg)
  }).then(() => {
    codeSandboxService.setStdlib(
      sandboxStdlibService.getBasePath(),
      sandboxStdlibService.getModuleNames()
    )
    console.log('[SandboxStdlib] Standard library ready')
  }).catch((err) => {
    console.error('[SandboxStdlib] Failed to install standard library:', err)
  })

  // Start MeshServer (always runs, independent of mesh enable/disable)
  meshServer = new MeshServer(codeSandboxService, settings)
  meshServer.start()
    .then(() => { void startMdnsIfEligible() })
    .catch(err => console.error('[MeshServer] Failed to start:', err))

  const basePrompt = (settings.get('globalSystemPrompt') as string) ?? ''
  const toolPrompts = (settings.get('toolPrompts') as Record<string, string>) ?? {}
  const bgCompactionPrompt = (settings.get('compactionPrompt') as string | undefined) ?? undefined
  backgroundAgentManager = new BackgroundAgentManager(settings, basePrompt, toolPrompts, bgCompactionPrompt)
  backgroundAgentManager.setCodeSandboxService(codeSandboxService)
  backgroundAgentManager.setPodmanService(podmanService)
  backgroundAgentManager.setWsConnectionManager(wsConnectionManager)
  backgroundAgentManager.setUvxPackageResolver(uvxPackageResolver)
  backgroundAgentManager.setUvManager(uvManager)
  backgroundAgentManager.onAgentOff = handleAgentOff

  // Auto-start the shared MCP container in the background.
  // All MCP servers run here by default. Non-blocking — agents that start
  // before the container is ready will connect MCP servers on host.
  podmanService.ensureRunning().then(() => {
    console.log('[Compute] Shared MCP container ready')
  }).catch((err) => {
    console.warn('[Compute] Shared container failed to start (MCP servers will run on host):', err instanceof Error ? err.message : err)
  })

  backgroundAgentManager.on('background_agent_event', (event: BackgroundAgentEvent) => {
    const win = getMainWindow()
    if (win) {
      win.webContents.send(IPC.BACKGROUND_AGENT_EVENT, event)

      // Refresh tracked directories when a background agent creates a new ADF file
      if (event.type === 'adf_file_created') {
        const payload = event.payload as { filePath?: string }
        if (payload?.filePath) {
          notifyAdfFileCreated(payload.filePath)
        }
      }
    }
  })

  // Forward background adapter inbox updates to renderer
  backgroundAgentManager.on('inbox_updated', (data: { filePath: string; inbox: unknown }) => {
    const win = getMainWindow()
    if (win && data.filePath === currentFilePath) {
      win.webContents.send(IPC.INBOX_UPDATED, { inbox: data.inbox })
    }
  })

  // Forward background adapter status changes to renderer
  backgroundAgentManager.on('adapter_status_changed', (data: { filePath: string; type: string; status: string; error?: string }) => {
    const win = getMainWindow()
    if (win && data.filePath === currentFilePath) {
      win.webContents.send(IPC.ADAPTER_STATUS_CHANGED, { type: data.type, status: data.status, error: data.error })
    }
  })

  // Autostart agents from tracked directories (fire-and-forget)
  const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
  for (const d of trackedDirs) rememberTrackedDirectory(d)
  if (trackedDirs.length > 0) {
    backgroundAgentManager.autostartFromDirectories(trackedDirs).catch(err =>
      console.error('[autostart] Boot scan failed:', err)
    )
  }

  // --- File operations ---

  ipcMain.handle(IPC.FILE_OPEN, async (_event, args: { filePath?: string }) => {
    const t0 = performance.now()
    try {
      console.log('[IPC] FILE_OPEN called with:', args)
      let filePath = args?.filePath
      if (!filePath) {
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
          properties: ['openFile']
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'Cancelled' }
        }
        filePath = result.filePaths[0]
      }
      rememberAdfDirectory(filePath)

      let t1 = performance.now()
      await cleanupCurrentFile()
      console.log(`[PERF] FILE_OPEN.cleanup: ${(performance.now() - t1).toFixed(1)}ms`)

      // Check for running background agent
      let agentWasRunning = false
      if (backgroundAgentManager?.hasAgent(filePath)) {
        // If the background agent is password-protected, verify we have the key before extracting
        const bgAgent = backgroundAgentManager.getAgent(filePath)
        if (bgAgent?.workspace.isPasswordProtected()) {
          const cachedKey = derivedKeyCache.get(filePath)
          if (!cachedKey) {
            // Cannot extract — stop the background agent and prompt for password
            console.log(`[PERF] FILE_OPEN: background agent is password-protected, stopping and prompting`)
            if (meshManager?.isEnabled()) {
              meshManager.unregisterAgent(filePath)
            }
            await backgroundAgentManager.stopAgent(filePath)
            currentWorkspace = AdfWorkspace.open(filePath)
            currentFilePath = filePath
            return { success: true, filePath, needsPassword: true }
          }
          currentDerivedKey = cachedKey
        }

        t1 = performance.now()
        if (meshManager?.isEnabled()) {
          meshManager.unregisterAgent(filePath, { keepWsConnections: true })
        }
        const extracted = backgroundAgentManager.extractBackgroundAgent(filePath)
        console.log(`[PERF] FILE_OPEN.extractBackground: ${(performance.now() - t1).toFixed(1)}ms`)
        if (extracted) {
          currentWorkspace = extracted.workspace
          currentSession = extracted.session
          agentExecutor = extracted.executor
          currentAgentToolRegistry = extracted.toolRegistry
          currentMcpManager = extracted.mcpManager
          currentScratchDir = extracted.scratchDir
          currentAdapterManager = extracted.adapterManager
          currentAdfCallHandler = extracted.adfCallHandler
          currentStreamBindingManager = extracted.streamBindingManager
          extractedDisplayState = extracted.displayState
          currentFilePath = filePath
          agentWasRunning = true
          console.log(`[PERF] FILE_OPEN total (from background): ${(performance.now() - t0).toFixed(1)}ms`)
          return { success: true, filePath, agentWasRunning }
        }
      }

      // Open the ADF file
      t1 = performance.now()
      currentWorkspace = AdfWorkspace.open(filePath)
      console.log(`[PERF] FILE_OPEN.workspaceOpen: ${(performance.now() - t1).toFixed(1)}ms`)
      currentFilePath = filePath

      // Check if password-protected
      if (currentWorkspace.isPasswordProtected()) {
        const cachedKey = derivedKeyCache.get(filePath)
        if (cachedKey) {
          // Verify the cached key still works by test-decrypting
          const testVal = currentWorkspace.getIdentityDecrypted('crypto:signing:private_key', cachedKey)
          if (testVal !== null) {
            currentDerivedKey = cachedKey
            console.log(`[PERF] FILE_OPEN: using cached derived key`)
          } else {
            // Cached key is stale, remove it and prompt
            derivedKeyCache.delete(filePath)
            console.log(`[PERF] FILE_OPEN total (needs password, stale cache): ${(performance.now() - t0).toFixed(1)}ms`)
            return { success: true, filePath, needsPassword: true }
          }
        } else {
          console.log(`[PERF] FILE_OPEN total (needs password): ${(performance.now() - t0).toFixed(1)}ms`)
          return { success: true, filePath, needsPassword: true }
        }
      }

      // Identity/ownership checks skipped for local ADFs.
      // Files open without DID stamping or owner mismatch dialogs.

      // Agent name is derived from filename
      t1 = performance.now()
      const agentName = basename(filePath, '.adf')
      const config = currentWorkspace.getAgentConfig()
      console.log(`[PERF] FILE_OPEN.getConfig: ${(performance.now() - t1).toFixed(1)}ms`)
      if (config.name !== agentName) {
        config.name = agentName
        currentWorkspace.setAgentConfig(config)
      }

      // Auto-surface ADF providers in app settings (MCP mirror pattern)
      if (config.providers?.length) {
        const appProviders = (settings.get('providers') as import('../../shared/types/ipc.types').ProviderConfig[]) ?? []
        const appIds = new Set(appProviders.map(p => p.id))
        let added = false
        for (const adfProv of config.providers) {
          if (!appIds.has(adfProv.id)) {
            appProviders.push({
              ...adfProv,
              apiKey: '',
              credentialStorage: 'agent'
            })
            added = true
          }
        }
        if (added) {
          settings.set('providers', appProviders)
        }
      }

      // Clean up orphaned WAL/SHM files left by past crashes (deferred to avoid blocking)
      const openDir = dirname(filePath)
      openedAdfDirs.add(openDir)
      setTimeout(() => {
        try { AdfDatabase.cleanupOrphanedWalFiles(openDir, new Set([filePath])) }
        catch { /* ignore */ }
      }, 0)

      console.log(`[PERF] FILE_OPEN total: ${(performance.now() - t0).toFixed(1)}ms`)
      return { success: true, filePath, agentWasRunning }
    } catch (error) {
      console.error('[IPC] FILE_OPEN error:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle(IPC.FILE_SAVE, async () => {
    try {
      if (!currentFilePath || !currentWorkspace) {
        return { success: false, error: 'No file open' }
      }
      // SQLite auto-persists, but checkpoint WAL for safety
      currentWorkspace.checkpoint()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FILE_CREATE, async (_event, args: { name: string }) => {
    try {
      console.log('[IPC] FILE_CREATE called with name:', args.name)
      const result = await dialog.showSaveDialog({
        defaultPath: `${args.name}.adf`,
        filters: [{ name: 'Agent Document Format', extensions: ['adf'] }]
      })
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' }
      }

      console.log('[IPC] FILE_CREATE: Creating file at:', result.filePath)
      rememberAdfDirectory(result.filePath)
      await cleanupCurrentFile()

      const agentName = basename(result.filePath, '.adf')
      console.log('[IPC] FILE_CREATE: Creating workspace for agent:', agentName)
      currentWorkspace = AdfWorkspace.create(result.filePath, { name: agentName })
      currentFilePath = result.filePath

      // Identity DIDs not stamped for local ADFs — files are identity-free by default.
      // Auto-track the parent directory (or refresh existing parent) + notify renderer
      notifyAdfFileCreated(result.filePath)

      // Auto-register as reviewed (user created it)
      const newConfig = currentWorkspace.getAgentConfig()
      settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), newConfig))

      console.log('[IPC] FILE_CREATE: Success')

      return { success: true, filePath: result.filePath }
    } catch (error) {
      console.error('[IPC] FILE_CREATE error:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FILE_CLOSE, async () => {
    await cleanupCurrentFile()
    return { success: true }
  })

  ipcMain.handle(IPC.FILE_DELETE, async (_event, args: { filePath: string }) => {
    try {
      const { filePath } = args

      if (backgroundAgentManager?.hasAgent(filePath)) {
        if (meshManager?.isEnabled()) {
          meshManager.unregisterAgent(filePath)
        }
        await backgroundAgentManager.stopAgent(filePath)
      }

      if (filePath === currentFilePath) {
        await cleanupCurrentFile()
      }

      // Delete the ADF file and its WAL files
      deleteAdfFile(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FILE_LIST_TABLES, async (_event, args: { filePath: string }) => {
    try {
      const { filePath } = args
      const workspace = AdfWorkspace.open(filePath)
      try {
        // Collect virtual table names so we can exclude their shadow tables
        const virtualTables = workspace.querySQL(
          "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
        ) as Array<{ name: string }>
        const shadowPrefixes = virtualTables.map((v) => `${v.name}_`)

        const rows = workspace.querySQL(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ) as Array<{ name: string }>
        const tables = rows
          .filter((r) => !shadowPrefixes.some((prefix) => r.name.startsWith(prefix)))
          .map((r) => {
            const countRow = workspace.querySQL(`SELECT COUNT(*) as count FROM "${r.name}"`) as Array<{ count: number }>
            return { name: r.name, row_count: countRow[0]?.count ?? 0 }
          })
        return { tables }
      } finally {
        workspace.close()
      }
    } catch (error) {
      return { tables: [], error: String(error) }
    }
  })

  ipcMain.handle(IPC.FILE_CLONE, async (_event, args: { filePath: string; selectedTables: string[] }) => {
    try {
      const { filePath, selectedTables } = args

      // Compute deduplicated clone path
      const dir = dirname(filePath)
      const originalName = basename(filePath, '.adf')
      let newName = `${originalName}_clone`
      let newPath = join(dir, `${newName}.adf`)
      let counter = 2
      while (existsSync(newPath)) {
        newName = `${originalName}_clone_${counter}`
        newPath = join(dir, `${newName}.adf`)
        counter++
      }

      // Copy the full SQLite file, then clear unselected tables
      copyFileSync(filePath, newPath)

      const newWorkspace = AdfWorkspace.open(newPath)
      try {
        // Collect virtual table names so we can skip their shadow tables
        const virtualRows = newWorkspace.querySQL(
          "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
        ) as Array<{ name: string }>
        const shadowPrefixes = virtualRows.map((v) => `${v.name}_`)

        // Get all tables in the clone
        const allRows = newWorkspace.querySQL(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ) as Array<{ name: string }>

        // Remove or clear unselected tables:
        // - adf_ tables: DELETE data but keep schema (valid ADF structure)
        // - Virtual tables: DROP (also removes their shadow tables automatically)
        // - Other tables (local_, etc.): DROP entirely
        // Skip virtual table shadow tables — managed by their parent
        const selectedSet = new Set(selectedTables)
        const virtualSet = new Set(virtualRows.map((v) => v.name))
        for (const row of allRows) {
          if (shadowPrefixes.some((prefix) => row.name.startsWith(prefix))) continue
          if (selectedSet.has(row.name)) continue

          if (virtualSet.has(row.name)) {
            newWorkspace.executeSQL(`DROP TABLE "${row.name}"`)
          } else if (row.name.startsWith('adf_')) {
            newWorkspace.executeSQL(`DELETE FROM "${row.name}"`)
          } else {
            newWorkspace.executeSQL(`DROP TABLE "${row.name}"`)
          }
        }

        // Update the agent name in config
        const config = newWorkspace.getAgentConfig()
        config.name = newName
        newWorkspace.setAgentConfig(config)

        // Identity handling: if identity table was not selected, generate fresh plaintext keys.
        // If it was selected, preserve it exactly (including password protection).
        if (!selectedSet.has('adf_identity')) {
          newWorkspace.generateIdentityKeys(null)
          const cloneIdentity = settings.ensureRuntimeIdentity()
          newWorkspace.getDatabase().setMeta('adf_owner_did', cloneIdentity.ownerDid)
          newWorkspace.getDatabase().setMeta('adf_runtime_did', cloneIdentity.runtimeDid)
        }

        // VACUUM to reclaim space from dropped tables
        newWorkspace.getDatabase().checkpoint()
      } finally {
        newWorkspace.close()
      }

      return { success: true, filePath: newPath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FILE_RENAME, async (_event, args: { filePath: string; newName: string }) => {
    try {
      const { filePath, newName } = args
      const dir = dirname(filePath)
      const newPath = join(dir, `${newName}.adf`)
      rememberAdfDirectory(filePath)
      rememberAdfDirectory(newPath)

      if (newPath !== filePath && existsSync(newPath)) {
        return { success: false, error: `A file named "${newName}.adf" already exists.` }
      }

      if (backgroundAgentManager?.hasAgent(filePath)) {
        if (meshManager?.isEnabled()) {
          meshManager.unregisterAgent(filePath)
        }
        await backgroundAgentManager.stopAgent(filePath)
      }

      // Close current workspace if it's the file being renamed
      if (filePath === currentFilePath && currentWorkspace) {
        currentWorkspace.checkpoint()
        currentWorkspace.close()
        currentWorkspace = null
      }

      if (newPath !== filePath) {
        // Rename main database file
        renameSync(filePath, newPath)

        // Rename WAL files if they exist
        const walPath = `${filePath}-wal`
        const newWalPath = `${newPath}-wal`
        if (existsSync(walPath)) {
          renameSync(walPath, newWalPath)
        }

        const shmPath = `${filePath}-shm`
        const newShmPath = `${newPath}-shm`
        if (existsSync(shmPath)) {
          renameSync(shmPath, newShmPath)
        }
      }

      // Update agent name inside
      const workspace = AdfWorkspace.open(newPath)
      const config = workspace.getAgentConfig()
      config.name = newName
      workspace.setAgentConfig(config)
      workspace.close()

      // Reopen if it was the current file
      if (filePath === currentFilePath) {
        currentWorkspace = AdfWorkspace.open(newPath)
        currentFilePath = newPath
      }

      return { success: true, filePath: newPath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- Agent review (file open flow) ---

  ipcMain.handle(IPC.FILE_CHECK_REVIEW, async () => {
    if (!currentWorkspace || !currentFilePath) {
      return { needsReview: false }
    }
    try {
      const config = currentWorkspace.getAgentConfig()
      if (isConfigReviewed(settings.get('reviewedAgents'), config)) {
        return { needsReview: false }
      }
      const ownerDid = currentWorkspace.getDid()
      const configSummary = buildConfigSummary(config, ownerDid)
      return { needsReview: true, configSummary }
    } catch (err) {
      console.warn('[IPC] FILE_CHECK_REVIEW error:', err)
      return { needsReview: false }
    }
  })

  ipcMain.handle(IPC.FILE_REVIEW_ACCEPT, async () => {
    if (!currentWorkspace || !currentFilePath) {
      return { success: false, error: 'No workspace open' }
    }
    try {
      // Auto-lock security-sensitive fields
      const config = currentWorkspace.getAgentConfig()
      const fieldsToLock = autoLockFields(config)
      const existing = new Set(config.locked_fields ?? [])
      for (const f of fieldsToLock) {
        existing.add(f)
      }
      config.locked_fields = [...existing]
      currentWorkspace.setAgentConfig(config)

      // Mark agent ID as reviewed
      settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), config))

      return { success: true }
    } catch (err) {
      console.warn('[IPC] FILE_REVIEW_ACCEPT error:', err)
      return { success: false, error: String(err) }
    }
  })

  // --- Document content ---

  ipcMain.handle(IPC.DOC_GET_DOCUMENT, async () => {
    if (!currentWorkspace) return { content: '' }
    return { content: currentWorkspace.readDocument() }
  })

  ipcMain.handle(IPC.DOC_SET_DOCUMENT, async (_event, args: { content: string }) => {
    if (!currentWorkspace) {
      console.error('[IPC] DOC_SET_DOCUMENT: No workspace open')
      return { success: false }
    }

    // Read current content before writing so triggers can compute a diff
    const previousContent = currentWorkspace.readDocument()
    currentWorkspace.writeDocument(args.content)

    if (triggerEvaluator) {
      triggerEvaluator.onDocumentEdit(args.content, previousContent)
    }

    return { success: true }
  })

  ipcMain.handle(IPC.DOC_GET_MIND, async () => {
    if (!currentWorkspace) return { content: '' }
    return { content: currentWorkspace.readMind() }
  })

  ipcMain.handle(IPC.DOC_SET_MIND, async (_event, args: { content: string }) => {
    if (!currentWorkspace) return { success: false }
    currentWorkspace.writeMind(args.content)
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_GET_AGENT_CONFIG, async () => {
    if (!currentWorkspace) return null
    return currentWorkspace.getAgentConfig()
  })

  ipcMain.handle(IPC.DOC_SET_AGENT_CONFIG, async (_event, config: AgentConfig) => {
    if (!currentWorkspace) return { success: false }
    const previousConfig = currentWorkspace.getAgentConfig()
    currentWorkspace.setAgentConfig(config)

    if (agentExecutor) {
      agentExecutor.updateConfig(config)

      const modelChanged =
        previousConfig.model.provider !== config.model.provider ||
        previousConfig.model.model_id !== config.model.model_id
      const paramsChanged =
        JSON.stringify(previousConfig.model.params) !== JSON.stringify(config.model.params)
      if (modelChanged || paramsChanged) {
        try {
          const resolved = resolveProviderConfig(config, currentWorkspace, currentDerivedKey)
          const provider = createProvider(config, settings, resolved)
          agentExecutor.updateProvider(provider)
        } catch {
          // Provider creation may fail — keep existing
        }
      }
    }
    if (triggerEvaluator) {
      triggerEvaluator.updateConfig(config)
    }
    currentAdfCallHandler?.updateConfig(config)
    if (meshManager && currentFilePath) {
      meshManager.updateAgentConfig(currentFilePath, config)
    }

    return { success: true }
  })

  // --- Chat/Loop history ---

  ipcMain.handle(IPC.DOC_GET_CHAT, async () => {
    try {
      if (!currentWorkspace) return { chatHistory: null }
      const totalCount = currentWorkspace.getLoopCount()
      const offset = Math.max(0, totalCount - LOOP_DISPLAY_LIMIT)
      const loopEntries = offset > 0
        ? currentWorkspace.getLoopPaginated(LOOP_DISPLAY_LIMIT, offset)
        : currentWorkspace.getLoop()
      const displayEntries = parseLoopToDisplay(loopEntries)
      return {
        chatHistory: {
          version: 1,
          uiLog: displayEntries,
          llmMessages: []
        }
      }
    } catch (error) {
      console.error('[IPC] DOC_GET_CHAT error:', error)
      return { chatHistory: null }
    }
  })

  ipcMain.handle(IPC.DOC_SET_CHAT, async () => {
    // In v0.1, chat is stored in loop table and managed by the runtime
    // UI doesn't directly set chat history
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_CLEAR_CHAT, async () => {
    if (!currentWorkspace) return { success: false }

    currentWorkspace.clearLoop()

    if (currentSession) {
      currentSession.reset()
    }

    if (meshManager?.isEnabled() && currentFilePath) {
      meshManager.resetAgentSession(currentFilePath)
    }

    return { success: true }
  })

  // --- Inbox ---

  ipcMain.handle(IPC.DOC_GET_INBOX, async () => {
    const t0 = performance.now()
    if (!currentWorkspace) return { inbox: null }
    // Only return unread + read messages; archived messages are considered "cleared"
    const unread = currentWorkspace.getInbox('unread')
    const read = currentWorkspace.getInbox('read')
    const messages = [...unread, ...read]
    console.log(`[PERF] DOC_GET_INBOX: ${(performance.now() - t0).toFixed(1)}ms (messages=${messages.length})`)

    const result = {
      inbox: {
        version: 1,
        messages
      }
    }

    return result
  })

  ipcMain.handle(IPC.DOC_CLEAR_INBOX, async () => {
    if (!currentWorkspace) return { success: false }
    // Actually delete all inbox messages (audit-before-delete if audit enabled)
    currentWorkspace.deleteInboxByFilter({})
    const win = getMainWindow()
    if (win) {
      win.webContents.send(IPC.INBOX_UPDATED, { inbox: { version: 1, messages: [] } })
    }
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_GET_OUTBOX, async () => {
    if (!currentWorkspace) return { outbox: null }
    const messages = currentWorkspace.getOutbox()
    return {
      outbox: {
        messages: messages.map(({ original_message, address, network, attachments, meta, ...rest }) => rest)
      }
    }
  })

  // --- Timers ---

  ipcMain.handle(IPC.DOC_GET_TIMERS, async () => {
    if (!currentWorkspace) return { timers: [] }
    return { timers: currentWorkspace.getTimers() }
  })

  ipcMain.handle(IPC.DOC_ADD_TIMER, async (_event, args: {
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number
    delay_ms?: number
    every_ms?: number
    start_at?: number
    end_at?: number
    max_runs?: number
    cron?: string
    scope: string[]
    lambda?: string
    warm?: boolean
    payload?: string
    locked?: boolean
  }) => {
    if (!currentWorkspace) return { success: false, error: 'No workspace open' }
    try {
      const { CronExpressionParser } = await import('cron-parser')
      const now = Date.now()
      let schedule: import('../../shared/types/adf-v02.types').TimerSchedule
      let nextWakeAt: number

      switch (args.mode) {
        case 'once_at':
          if (!args.at || args.at <= now) return { success: false, error: 'Timestamp must be in the future' }
          schedule = { mode: 'once', at: args.at }
          nextWakeAt = args.at
          break
        case 'once_delay':
          if (!args.delay_ms || args.delay_ms <= 0) return { success: false, error: 'Delay must be positive' }
          schedule = { mode: 'once', at: now + args.delay_ms }
          nextWakeAt = now + args.delay_ms
          break
        case 'interval':
          if (!args.every_ms || args.every_ms <= 0) return { success: false, error: 'Interval must be positive' }
          nextWakeAt = args.start_at ?? (now + args.every_ms)
          if (nextWakeAt <= now) return { success: false, error: 'start_at must be in the future' }
          schedule = {
            mode: 'interval',
            every_ms: args.every_ms,
            ...(args.start_at ? { start_at: args.start_at } : {}),
            ...(args.end_at ? { end_at: args.end_at } : {}),
            ...(args.max_runs ? { max_runs: args.max_runs } : {})
          }
          break
        case 'cron':
          if (!args.cron) return { success: false, error: 'Cron expression required' }
          try {
            const interval = CronExpressionParser.parse(args.cron, { currentDate: new Date(now) })
            nextWakeAt = interval.next().getTime()
          } catch (err) {
            return { success: false, error: `Invalid cron: ${String(err)}` }
          }
          schedule = {
            mode: 'cron',
            cron: args.cron,
            ...(args.end_at ? { end_at: args.end_at } : {}),
            ...(args.max_runs ? { max_runs: args.max_runs } : {})
          }
          break
        default:
          return { success: false, error: 'Invalid mode' }
      }

      const id = currentWorkspace.addTimer(schedule, nextWakeAt, args.payload, args.scope, args.lambda, args.warm, args.locked)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DOC_UPDATE_TIMER, async (_event, args: {
    id: number
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number
    delay_ms?: number
    every_ms?: number
    start_at?: number
    end_at?: number
    max_runs?: number
    cron?: string
    scope: string[]
    lambda?: string
    warm?: boolean
    payload?: string
    locked?: boolean
  }) => {
    if (!currentWorkspace) return { success: false, error: 'No workspace open' }
    try {
      const { CronExpressionParser } = await import('cron-parser')
      const now = Date.now()
      let schedule: import('../../shared/types/adf-v02.types').TimerSchedule
      let nextWakeAt: number

      switch (args.mode) {
        case 'once_at':
          if (!args.at || args.at <= now) return { success: false, error: 'Timestamp must be in the future' }
          schedule = { mode: 'once', at: args.at }
          nextWakeAt = args.at
          break
        case 'once_delay':
          if (!args.delay_ms || args.delay_ms <= 0) return { success: false, error: 'Delay must be positive' }
          schedule = { mode: 'once', at: now + args.delay_ms }
          nextWakeAt = now + args.delay_ms
          break
        case 'interval':
          if (!args.every_ms || args.every_ms <= 0) return { success: false, error: 'Interval must be positive' }
          nextWakeAt = args.start_at ?? (now + args.every_ms)
          if (nextWakeAt <= now) return { success: false, error: 'start_at must be in the future' }
          schedule = {
            mode: 'interval',
            every_ms: args.every_ms,
            ...(args.start_at ? { start_at: args.start_at } : {}),
            ...(args.end_at ? { end_at: args.end_at } : {}),
            ...(args.max_runs ? { max_runs: args.max_runs } : {})
          }
          break
        case 'cron':
          if (!args.cron) return { success: false, error: 'Cron expression required' }
          try {
            const interval = CronExpressionParser.parse(args.cron, { currentDate: new Date(now) })
            nextWakeAt = interval.next().getTime()
          } catch (err) {
            return { success: false, error: `Invalid cron: ${String(err)}` }
          }
          schedule = {
            mode: 'cron',
            cron: args.cron,
            ...(args.end_at ? { end_at: args.end_at } : {}),
            ...(args.max_runs ? { max_runs: args.max_runs } : {})
          }
          break
        default:
          return { success: false, error: 'Invalid mode' }
      }

      const updated = currentWorkspace.updateTimer(args.id, schedule, nextWakeAt, args.payload, args.scope, args.lambda, args.warm, args.locked)
      return { success: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DOC_DELETE_TIMER, async (_event, { id }: { id: number }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.deleteTimer(id) }
  })

  // --- Logs ---

  ipcMain.handle(IPC.DOC_GET_LOGS, async (_event, { limit }: { limit?: number } = {}) => {
    if (!currentWorkspace) return { logs: [], count: 0 }
    const logs = currentWorkspace.getLogs(limit)
    return { logs, count: logs.length }
  })

  ipcMain.handle(IPC.DOC_GET_LOGS_AFTER, async (_event, { afterId }: { afterId: number }) => {
    if (!currentWorkspace) return { logs: [] }
    const logs = currentWorkspace.getLogsAfterId(afterId)
    return { logs }
  })

  ipcMain.handle(IPC.DOC_CLEAR_LOGS, async () => {
    if (!currentWorkspace) return { success: false }
    currentWorkspace.clearLogs()
    return { success: true }
  })

  // --- Tasks ---

  ipcMain.handle(IPC.DOC_GET_TASKS, async (_event, { limit }: { limit?: number } = {}) => {
    if (!currentWorkspace) return { tasks: [] }
    const tasks = currentWorkspace.getAllTasks(limit)
    return { tasks }
  })

  // --- Internal Files ---

  ipcMain.handle(IPC.DOC_GET_FILES, async () => {
    if (!currentWorkspace) return { files: [] }
    return { files: currentWorkspace.listFiles() }
  })

  ipcMain.handle(IPC.DOC_UPLOAD_FILE, async (_event, { path, data, mimeType }: { path: string; data: number[]; mimeType?: string }) => {
    if (!currentWorkspace) return { success: false }
    const buffer = Buffer.from(new Uint8Array(data))
    currentWorkspace.writeFileBuffer(path, buffer, mimeType ?? 'application/octet-stream')
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_IMPORT_PATHS, async (_event, { paths }: { paths: string[] }) => {
    if (!currentWorkspace) return { success: false, count: 0 }
    let count = 0
    const importEntry = (hostPath: string, vfsPrefix: string) => {
      const stat = statSync(hostPath)
      if (stat.isFile()) {
        const data = readFileSync(hostPath)
        const name = basename(hostPath)
        const vfsPath = vfsPrefix ? `${vfsPrefix}/${name}` : name
        currentWorkspace!.writeFileBuffer(vfsPath, data, currentWorkspace!.getMimeType(vfsPath))
        count++
      } else if (stat.isDirectory()) {
        const dirName = basename(hostPath)
        const newPrefix = vfsPrefix ? `${vfsPrefix}/${dirName}` : dirName
        for (const entry of readdirSync(hostPath, { withFileTypes: true })) {
          importEntry(join(hostPath, entry.name), newPrefix)
        }
      }
    }
    try {
      for (const p of paths) importEntry(p, '')
      return { success: true, count }
    } catch (err) {
      console.error('[IPC] DOC_IMPORT_PATHS error:', err)
      return { success: false, count }
    }
  })

  ipcMain.handle(IPC.DOC_PICK_AND_IMPORT, async () => {
    if (!currentWorkspace) return { success: false, count: 0 }
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog({
      ...(win ? { window: win } : {}),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    } as Electron.OpenDialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { success: false, count: 0 }

    let count = 0
    const importEntry = (hostPath: string, vfsPrefix: string) => {
      const stat = statSync(hostPath)
      if (stat.isFile()) {
        const data = readFileSync(hostPath)
        const name = basename(hostPath)
        const vfsPath = vfsPrefix ? `${vfsPrefix}/${name}` : name
        currentWorkspace!.writeFileBuffer(vfsPath, data, currentWorkspace!.getMimeType(vfsPath))
        count++
      } else if (stat.isDirectory()) {
        const dirName = basename(hostPath)
        const newPrefix = vfsPrefix ? `${vfsPrefix}/${dirName}` : dirName
        for (const entry of readdirSync(hostPath, { withFileTypes: true })) {
          importEntry(join(hostPath, entry.name), newPrefix)
        }
      }
    }
    try {
      for (const p of result.filePaths) importEntry(p, '')
      return { success: true, count }
    } catch (err) {
      console.error('[IPC] DOC_PICK_AND_IMPORT error:', err)
      return { success: false, count }
    }
  })

  ipcMain.handle(IPC.DOC_DELETE_INTERNAL_FILE, async (_event, { path }: { path: string }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.deleteFile(path) }
  })

  ipcMain.handle(IPC.DOC_RENAME_INTERNAL_FILE, async (_event, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
    if (!currentWorkspace) return { success: false }
    try {
      return { success: currentWorkspace.renameInternalFile(oldPath, newPath) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DOC_RENAME_FOLDER, async (_event, { oldPrefix, newPrefix }: { oldPrefix: string; newPrefix: string }) => {
    if (!currentWorkspace) return { success: false, count: 0 }
    try {
      const count = currentWorkspace.renameFolder(oldPrefix, newPrefix)
      return { success: true, count }
    } catch (err) {
      return { success: false, count: 0, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DOC_SET_FILE_PROTECTION, async (_event, { path, protection }: { path: string; protection: 'read_only' | 'no_delete' | 'none' }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.setFileProtection(path, protection) }
  })

  ipcMain.handle(IPC.DOC_SET_FILE_AUTHORIZED, async (_event, { path, authorized }: { path: string; authorized: boolean }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.setFileAuthorized(path, authorized) }
  })

  // ---- Meta (human/UI — no protection enforcement) ----

  ipcMain.handle(IPC.DOC_GET_ALL_META, async () => {
    if (!currentWorkspace) return { entries: [] }
    return { entries: currentWorkspace.getAllMeta() }
  })

  ipcMain.handle(IPC.DOC_SET_META, async (_event, { key, value, protection }: { key: string; value: string; protection?: MetaProtectionLevel }) => {
    if (!currentWorkspace) return { success: false }
    currentWorkspace.setMeta(key, value, protection)
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_DELETE_META, async (_event, { key }: { key: string }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.deleteMeta(key) }
  })

  ipcMain.handle(IPC.DOC_SET_META_PROTECTION, async (_event, { key, protection }: { key: string; protection: MetaProtectionLevel }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.setMetaProtection(key, protection) }
  })

  ipcMain.handle(IPC.DOC_READ_INTERNAL_FILE, async (_event, { path: filePath }: { path: string }) => {
    if (!currentWorkspace) return { content: null, binary: false }
    const buf = currentWorkspace.readFileBuffer(filePath)
    if (!buf) return { content: null, binary: false }
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const textExts = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])
    const isText = textExts.has(ext)
    if (isText) {
      return { content: buf.toString('utf-8'), binary: false }
    }
    return { content: buf.toString('base64'), binary: true }
  })

  ipcMain.handle(IPC.DOC_WRITE_INTERNAL_FILE, async (_event, { path, content }: { path: string; content: string }) => {
    if (!currentWorkspace) return { success: false }
    const previousContent = currentWorkspace.readFile(path) ?? undefined
    currentWorkspace.writeFile(path, content)
    if (triggerEvaluator) {
      triggerEvaluator.onFileChange(path, 'modified', content, previousContent)
    }
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_DOWNLOAD_INTERNAL_FILE, async (_event, { path: filePath }: { path: string }) => {
    if (!currentWorkspace) return { success: false }
    const buf = currentWorkspace.readFileBuffer(filePath)
    if (!buf) return { success: false, error: 'File not found' }
    const fileName = filePath.includes('/') ? filePath.split('/').pop()! : filePath
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showSaveDialog({
      ...(win ? { window: win } : {}),
      defaultPath: fileName,
    } as Electron.SaveDialogOptions)
    if (result.canceled || !result.filePath) return { success: false }
    writeFileSync(result.filePath, buf)
    return { success: true }
  })

  // --- Local Tables ---

  ipcMain.handle(IPC.DOC_LIST_LOCAL_TABLES, async () => {
    if (!currentWorkspace) return { tables: [] }
    return { tables: currentWorkspace.listLocalTables() }
  })

  ipcMain.handle(IPC.DOC_QUERY_LOCAL_TABLE, async (_event, { table, limit, offset }: { table: string; limit?: number; offset?: number }) => {
    if (!currentWorkspace) return { columns: [], rows: [] }
    // Validate table name to prevent injection
    if ((!table.startsWith('local_') && table !== 'adf_audit') || /[^a-zA-Z0-9_]/.test(table)) {
      return { columns: [], rows: [], error: 'Invalid table name' }
    }
    try {
      const lim = limit ?? 100
      const off = offset ?? 0
      const rows = currentWorkspace.querySQL(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, [lim, off]) as Record<string, unknown>[]
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      return { columns, rows }
    } catch (error) {
      return { columns: [], rows: [], error: String(error) }
    }
  })

  ipcMain.handle(IPC.DOC_DROP_LOCAL_TABLE, async (_event, { table }: { table: string }) => {
    if (!currentWorkspace) return { success: false }
    if (!table.startsWith('local_') || /[^a-zA-Z0-9_]/.test(table)) {
      return { success: false, error: 'Invalid table name' }
    }
    return { success: currentWorkspace.dropLocalTable(table) }
  })

  // Batch fetch — paginated loop loading for fast file switches
  const LOOP_DISPLAY_LIMIT = 200
  ipcMain.handle(IPC.DOC_GET_BATCH, async () => {
    const t0 = performance.now()
    if (!currentWorkspace) {
      return { document: '', mind: '', agentConfig: null, chat: null }
    }
    // Only load last N loop entries for display (not the full 25k+ history)
    let t1 = performance.now()
    const totalCount = currentWorkspace.getLoopCount()
    console.log(`[PERF] DOC_GET_BATCH.getLoopCount: ${(performance.now() - t1).toFixed(1)}ms (count=${totalCount})`)

    t1 = performance.now()
    const offset = Math.max(0, totalCount - LOOP_DISPLAY_LIMIT)
    const loopEntries = offset > 0
      ? currentWorkspace.getLoopPaginated(LOOP_DISPLAY_LIMIT, offset)
      : currentWorkspace.getLoop()
    console.log(`[PERF] DOC_GET_BATCH.getLoop: ${(performance.now() - t1).toFixed(1)}ms (entries=${loopEntries.length}, offset=${offset})`)

    t1 = performance.now()
    const displayEntries = parseLoopToDisplay(loopEntries)
    console.log(`[PERF] DOC_GET_BATCH.parseLoop: ${(performance.now() - t1).toFixed(1)}ms (display=${displayEntries.length})`)

    t1 = performance.now()
    const document = currentWorkspace.readDocument()
    const mind = currentWorkspace.readMind()
    const agentConfig = currentWorkspace.getAgentConfig()
    const lastTokens = currentWorkspace.getLastAssistantTokens()
    const statusText = currentWorkspace.getMeta('status') ?? ''
    console.log(`[PERF] DOC_GET_BATCH.readDocMindConfig: ${(performance.now() - t1).toFixed(1)}ms`)

    const result = {
      document,
      mind,
      agentConfig,
      lastTokens,
      statusText,
      chat: {
        version: 1,
        uiLog: displayEntries,
        llmMessages: []
      }
    }

    console.log(`[PERF] DOC_GET_BATCH total: ${(performance.now() - t0).toFixed(1)}ms`)
    return result
  })

  // --- Agent runtime ---

  ipcMain.handle(IPC.AGENT_START, async (_event, args?: { filePath?: string; hasUserMessage?: boolean }) => {
    const t0 = performance.now()
    if (!currentWorkspace || !currentFilePath) {
      return { success: false, error: 'No file open' }
    }
    RuntimeGate.resume()
    // Guard: if the caller captured a filePath, ensure it still matches the current file
    if (args?.filePath && args.filePath !== currentFilePath) {
      return { success: false, error: 'Agent file changed since start was requested' }
    }

    const config = currentWorkspace.getAgentConfig()

    // Review gate: refuse to start an unreviewed agent
    if (!isConfigReviewed(settings.get('reviewedAgents'), config)) {
      return { success: false, error: 'Agent must be reviewed before starting. Please accept the agent review first.' }
    }

    // Reuse extracted executor if running (but not if it's in error state —
    // error state requires a fresh executor, same as stopped)
    if (agentExecutor && agentExecutor.getState() !== 'stopped' && agentExecutor.getState() !== 'error') {
      agentExecutor.removeAllListeners('event')

      const capturedWorkspace = currentWorkspace
      const capturedSession = currentSession!
      const capturedFilePath = currentFilePath

      agentExecutor.on('event', async (event) => {
        if (currentFilePath === capturedFilePath) {
          const win = getMainWindow()
          if (win) {
            win.webContents.send(IPC.AGENT_EVENT, event)
          }
        }

        // Propagate display state changes to trigger evaluator (map executor → display states)
        if (event.type === 'state_changed' && triggerEvaluator) {
          const payload = event.payload as { state: string }
          triggerEvaluator.setDisplayState(executorToDisplayState(payload.state))
        }

        // Hard off: any path that lands on display state 'off' triggers full teardown.
        if (event.type === 'state_changed') {
          const payload = event.payload as { state: string }
          if (payload.state === 'off' && capturedFilePath) {
            await handleAgentOff(capturedFilePath)
          }
        }

        // Refresh tracked directories when a new ADF file is created by the agent
        if (event.type === 'adf_file_created') {
          const payload = event.payload as { filePath?: string }
          if (payload?.filePath) {
            notifyAdfFileCreated(payload.filePath)
          }
        }

        // NOTE: Agent-originated file/document changes (file_updated, document_updated)
        // are NOT routed to the trigger evaluator here — doing so would cause
        // on_file_change triggers to self-fire when the agent writes files via fs_write.
        // User-originated edits already trigger on_file_change through their own IPC
        // handlers (DOC_SET_DOCUMENT → onDocumentEdit, DOC_WRITE_INTERNAL_FILE → onFileChange).
      })

      if (triggerEvaluator) {
        triggerEvaluator.dispose()
      }
      triggerEvaluator = new TriggerEvaluator(config)
      // Use the preserved display state from background extraction, not the config default —
      // preserves hibernate/suspended when switching to foreground
      triggerEvaluator.setDisplayState(extractedDisplayState ?? executorToDisplayState(agentExecutor.getState()))
      extractedDisplayState = null
      triggerEvaluator.on('trigger', async (dispatch: AdfEventDispatch | AdfBatchDispatch) => {
        if (agentExecutor) {
          try {
            await agentExecutor.executeTurn(dispatch)
          } catch (error) {
            const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
            try { currentWorkspace?.insertLog('error', 'runtime', 'trigger_error', eventType, String(error).slice(0, 200)) } catch { /* non-fatal */ }
            const win = getMainWindow()
            if (win) {
              win.webContents.send(IPC.AGENT_EVENT, {
                type: 'error',
                payload: { error: String(error) },
                timestamp: Date.now()
              })
            }
          }
        }
      })
      triggerEvaluator.on('event', (event: AgentExecutionEvent) => {
        const win = getMainWindow()
        if (win) win.webContents.send(IPC.AGENT_EVENT, event)
      })
      triggerEvaluator.startTimerPolling(currentWorkspace)
      triggerEvaluator.setWorkspace(currentWorkspace)

      // Wire on_logs trigger: workspace log entries → trigger evaluator
      {
        const capturedEval = triggerEvaluator
        currentWorkspace.setOnLogCallback((level, origin, event, target, message) => {
          capturedEval.onLog(level, origin, event, target, message)
        })
      }

      // Wire task lifecycle callbacks to the new trigger evaluator
      if (agentExecutor) {
        const capturedTriggerEval = triggerEvaluator
        const capturedExecutor = agentExecutor
        agentExecutor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
          capturedTriggerEval.onToolCall(tool, args, taskId, origin, systemScopeHandled)
        }
        agentExecutor.onTaskCreated = (task) => {
          capturedTriggerEval.onTaskCreate(task)
        }
        agentExecutor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
          capturedTriggerEval.onTaskComplete(taskId, tool, status, result, error)
          if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
            try {
              const parsed = JSON.parse(result)
              if (parsed.target_state) capturedExecutor.applyDeferredStateTransition(parsed.target_state)
            } catch { /* ignore parse errors */ }
          }
        }

        // Re-wire adfCallHandler so lambda-initiated state transitions reach the
        // current executor. Previous wiring may close over disposed objects after
        // background extraction.
        if (currentAdfCallHandler) {
          currentAdfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
            capturedTriggerEval.onTaskComplete(taskId, tool, status, result, error)
            if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
              try {
                const parsed = JSON.parse(result)
                if (parsed.target_state) capturedExecutor.applyDeferredStateTransition(parsed.target_state)
              } catch { /* ignore parse errors */ }
            }
          }
          currentAdfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
            if (tool !== 'sys_set_state') return
            try {
              const parsed = JSON.parse(resultContent)
              if (parsed.target_state) capturedExecutor.applyDeferredStateTransition(parsed.target_state)
            } catch { /* ignore parse errors */ }
          }
          currentAdfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
            capturedExecutor.resolveHilTask(taskId, approved, modifiedArgs)
          }
        }
      }

      // Wire sys_update_config propagation callback
      if (currentAgentToolRegistry) {
        const sysUpdateTool = currentAgentToolRegistry.get('sys_update_config') as SysUpdateConfigTool | undefined
        if (sysUpdateTool) {
          sysUpdateTool.onConfigChanged = (updatedConfig) => {
            if (agentExecutor) agentExecutor.updateConfig(updatedConfig)
            if (triggerEvaluator) triggerEvaluator.updateConfig(updatedConfig)
            currentAdfCallHandler?.updateConfig(updatedConfig)
            if (meshManager && capturedFilePath) meshManager.updateAgentConfig(capturedFilePath, updatedConfig)
          }
        }

        const createAdfTool = currentAgentToolRegistry.get('sys_create_adf') as CreateAdfTool | undefined
        if (createAdfTool) {
          createAdfTool.onAutostartChild = async (childPath) => backgroundAgentManager?.startAgent(childPath) ?? false
          createAdfTool.onChildCreated = (_childPath, childConfig) => {
            settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), childConfig))
          }
        }
      }

      // Re-wire adapter inbound events to the new trigger evaluator.
      // Background extraction disposes the old evaluator, leaving the adapter's
      // 'inbound' listener calling into a dead evaluator.
      if (currentAdapterManager) {
        currentAdapterManager.removeAllListeners('inbound')
        currentAdapterManager.on('inbound', (type: string, msg: any, meta: { inboxId: string; parentId?: string }) => {
          const unread = capturedWorkspace.getInbox('unread')
          const read = capturedWorkspace.getInbox('read')
          const allMessages = [...unread, ...read]
          const win = getMainWindow()
          if (win) {
            win.webContents.send(IPC.INBOX_UPDATED, {
              inbox: {
                version: 1,
                messages: allMessages
              }
            })
          }
          if (triggerEvaluator) {
            const sender = `${type}:${msg.sender}`
            triggerEvaluator.onInbox(sender, msg.payload, {
              source: type,
              messageId: meta.inboxId,
              parentId: meta.parentId,
              sourceMeta: msg.sourceMeta
            })
          }
        })
      }

      if (meshManager?.isEnabled() && currentFilePath && currentAgentToolRegistry) {
        const capturedExecutor = agentExecutor
        meshManager.registerAgent(
          currentFilePath, config, currentAgentToolRegistry,
          currentWorkspace, capturedSession, triggerEvaluator, true,
          () => capturedExecutor?.isMessageTriggered ?? false,
          agentExecutor,
          currentAdfCallHandler, codeSandboxService
        )
        agentExecutor.updateConfig(config)
        currentAdfCallHandler?.updateConfig(config)
        syncDerivedKeyToMesh(currentFilePath, currentDerivedKey)

        // Wire adapter manager to mesh for outbound routing
        if (currentAdapterManager) {
          meshManager.setAdapterManager(currentFilePath, currentAdapterManager)
        }
      }

      const displayState = triggerEvaluator.getDisplayState()
      console.log(`[PERF] AGENT_START (reuse executor): ${(performance.now() - t0).toFixed(1)}ms`)
      return {
        success: true,
        sessionId: capturedSession.getSessionId(),
        agentState: displayState,
        pendingApprovals: agentExecutor.getPendingApprovals(),
        pendingAsks: agentExecutor.getPendingAsks()
      }
    }

    // Capture all context BEFORE any async operations so concurrent FILE_OPEN
    // cannot swap the globals out from under us during awaits.
    const capturedFilePath = currentFilePath
    const capturedWorkspace = currentWorkspace
    const capturedSession = currentSession
    const capturedDerivedKey = currentDerivedKey

    // Signal that a start is in-flight — prevents cleanupCurrentFile from
    // closing the workspace database while we're still using it.
    startingFilePaths.add(capturedFilePath)

    // Helper: check if the foreground file has changed during an await
    const fileChanged = () => currentFilePath !== capturedFilePath

    // Clean up previous
    if (agentExecutor) {
      agentExecutor.abort()
      agentExecutor = null
    }
    if (triggerEvaluator) {
      triggerEvaluator.dispose()
      triggerEvaluator = null
    }
    if (currentTapManager) {
      try { currentTapManager.dispose() } catch { /* best-effort */ }
      currentTapManager = null
    }
    currentUmbilicalAgentId = null
    if (currentStreamBindingManager) {
      currentStreamBindingManager.stopAll('agent_restarted')
      currentStreamBindingManager = null
    }
    if (currentAdapterManager) {
      await currentAdapterManager.stopAll()
      currentAdapterManager = null
    }

    // Set up provider
    const resolved = resolveProviderConfig(config, capturedWorkspace, capturedDerivedKey)
    const provider = createProvider(config, settings, resolved)
    const validation = await provider.validateConfig()
    if (!validation.valid) {
      startingFilePaths.delete(capturedFilePath)
      return { success: false, error: validation.error || 'Provider not configured' }
    }

    // Create or reuse session
    const basePrompt = (settings.get('globalSystemPrompt') as string) ?? ''
    const toolPrompts = (settings.get('toolPrompts') as Record<string, string>) ?? {}
    const compactionPrompt = (settings.get('compactionPrompt') as string | undefined) ?? undefined
    const session = capturedSession ?? new AgentSession(capturedWorkspace)
    if (!capturedSession) {
      // Restore from loop
      const tLoop = performance.now()
      const loopEntries = capturedWorkspace.getLoop()
      console.log(`[PERF] AGENT_START.getLoop: ${(performance.now() - tLoop).toFixed(1)}ms (entries=${loopEntries.length})`)
      if (loopEntries.length > 0) {
        session.restoreMessages(loopEntries.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at })))
      }
    }

    // Ensure inbox tools are in config
    const toolNames = config.tools.map((t) => t.name)
    for (const toolName of ['msg_list', 'msg_read', 'msg_update']) {
      if (!toolNames.includes(toolName)) {
        config.tools.push({ name: toolName, enabled: true, visible: true })
      }
    }
    for (const toolName of ['stream_bind', 'stream_unbind', 'stream_bindings']) {
      if (!toolNames.includes(toolName)) {
        config.tools.push({ name: toolName, enabled: false })
      }
    }

    // Create tool registry
    const agentToolRegistry = new ToolRegistry()
    registerBuiltInTools(agentToolRegistry)

    // Create AdfCallHandler if code execution, sys_lambda, system scope lambdas, serving API routes, or middleware are declared
    const hasSystemLambda = Object.values(config.triggers ?? {}).some(
      (tc: any) => tc?.enabled && tc?.targets?.some((t: any) => t.scope === 'system' && t.lambda)
    )
    const hasApiRoutes = (config.serving?.api?.length ?? 0) > 0
    const hasMiddleware = !!(
      config.security?.middleware?.inbox?.length ||
      config.security?.middleware?.outbox?.length ||
      config.security?.fetch_middleware?.length ||
      config.serving?.api?.some(r => r.middleware?.length)
    )
    const needsAdfHandler = hasSystemLambda || hasApiRoutes || hasMiddleware || config.tools.some(t =>
      t.name === 'sys_code' || t.name === 'sys_lambda'
    )
    let adfCallHandler: AdfCallHandler | null = null
    if (needsAdfHandler) {
      adfCallHandler = new AdfCallHandler({
        toolRegistry: agentToolRegistry,
        workspace: capturedWorkspace,
        config,
        provider,
        createProviderForModel: (modelId: string) => {
          const overrideConfig = { ...config, model: { ...config.model, model_id: modelId } }
          const resolved = resolveProviderConfig(overrideConfig, capturedWorkspace, capturedDerivedKey)
          return createProvider(overrideConfig, settings, resolved)
        },
        resolveIdentity: (purpose: string) => {
          // ONLY reads from adf_identity — never falls back to app-level settings.
          const row = capturedWorkspace.getIdentityRow(purpose)
          if (!row) return null
          if (!row.code_access) return null
          return capturedWorkspace.getIdentityDecrypted(purpose, capturedDerivedKey)
        }
      })
      adfCallHandler.onEvent = (event) => {
        if (currentFilePath === capturedFilePath) {
          const win = getMainWindow()
          if (win) win.webContents.send(IPC.AGENT_EVENT, event)
        }
      }
      adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
        agentExecutor?.resolveHilTask(taskId, approved, modifiedArgs)
      }
    }
    currentAdfCallHandler = adfCallHandler

    // Register sys_code with adf handler
    if (config.tools.some((t) => t.name === 'sys_code')) {
      agentToolRegistry.register(new SysCodeTool(codeSandboxService, capturedFilePath, adfCallHandler ?? undefined, config.limits?.execution_timeout_ms))
    }

    // Register sys_lambda with adf handler
    if (adfCallHandler && config.tools.some((t) => t.name === 'sys_lambda')) {
      agentToolRegistry.register(new SysLambdaTool(codeSandboxService, adfCallHandler, capturedFilePath, config.limits?.execution_timeout_ms))
    }

    // Register npm_install / npm_uninstall with sandbox packages service
    {
      // Compute visible packages: agent config + runtime-level (from settings)
      const agentPkgs = config.code_execution?.packages ?? []
      const runtimePkgs = (settings.get('sandboxPackages') as Array<{ name: string; version: string }>) ?? []
      const allVisibleNames = [
        ...new Set([...runtimePkgs.map((p) => p.name), ...agentPkgs.map((p) => p.name)])
      ]

      if (allVisibleNames.length > 0) {
        codeSandboxService.setUserPackages(sandboxPackagesService.getBasePath(), allVisibleNames)
      }

      const refreshUserPackages = () => {
        const freshConfig = capturedWorkspace.getAgentConfig()
        const freshAgentPkgs = freshConfig.code_execution?.packages ?? []
        const freshRuntimePkgs = (settings.get('sandboxPackages') as Array<{ name: string; version: string }>) ?? []
        const names = [
          ...new Set([...freshRuntimePkgs.map((p) => p.name), ...freshAgentPkgs.map((p) => p.name)])
        ]
        codeSandboxService.setUserPackages(sandboxPackagesService.getBasePath(), names)
      }

      if (config.tools.some((t) => t.name === 'npm_install')) {
        agentToolRegistry.register(new NpmInstallTool(sandboxPackagesService, () => refreshUserPackages()))
      }
      if (config.tools.some((t) => t.name === 'npm_uninstall')) {
        agentToolRegistry.register(new NpmUninstallTool(() => refreshUserPackages()))
      }
    }

    const connectConfiguredMcpServer = async (
      freshConfig: AgentConfig,
      serverName: string,
      reason: string
    ): Promise<{ toolsDiscovered: number }> => {
      const serverCfg = freshConfig.mcp?.servers?.find((server) => server.name === serverName)
      if (!serverCfg) throw new Error(`Server "${serverName}" not found.`)
      if (!currentMcpManager) throw new Error('No MCP manager active.')

      const connCfg = { ...serverCfg }
      const mcpRegistrations = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
      const reg = mcpRegistrations.find((registration) => registration.name === connCfg.name)

      if (reg?.toolCallTimeout) {
        connCfg.tool_call_timeout_ms = reg.toolCallTimeout * 1000
      }
      if (reg?.url && connCfg.transport === 'http') connCfg.url = reg.url
      if (reg?.headers?.length) {
        const appHeaders: Record<string, string> = {}
        for (const { key, value } of reg.headers) {
          if (key && value) appHeaders[key] = value
        }
        if (Object.keys(appHeaders).length) connCfg.headers = { ...connCfg.headers, ...appHeaders }
      }
      if (reg?.headerEnv?.length) {
        connCfg.header_env = [
          ...(connCfg.header_env ?? []),
          ...reg.headerEnv
            .filter((entry) => entry.key && entry.value)
            .map((entry) => ({ header: entry.key, env: entry.value, required: true }))
        ]
      }
      if (reg?.bearerTokenEnvVar) {
        connCfg.bearer_token_env_var = reg.bearerTokenEnvVar
      }

      const appEnvKeys: string[] = []
      if (reg?.env?.length) {
        const appEnv: Record<string, string> = {}
        for (const { key, value } of reg.env) {
          if (key && value) {
            appEnv[key] = value
            appEnvKeys.push(key)
          }
        }
        if (Object.keys(appEnv).length) {
          connCfg.env = { ...connCfg.env, ...appEnv }
        }
      }

      const resolvedEnv = resolveMcpEnvVars(connCfg, (key) => capturedWorkspace.getIdentityDecrypted(key, capturedDerivedKey))
      const agentEnvKeys = Object.keys(resolvedEnv)
      if (agentEnvKeys.length) {
        connCfg.env = { ...connCfg.env, ...resolvedEnv }
      }

      let uvBinPath: string | undefined
      if (connCfg.transport !== 'http' && (serverCfg.pypi_package || serverCfg.command === 'uvx')) {
        try { uvBinPath = await uvManager.ensureUv() } catch { /* uv not available */ }
      }

      const computeSettings = (settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
      let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
      if (connCfg.transport === 'http') {
        console.log(`[MCP] ${reason}: connecting "${serverName}" over HTTP: ${connCfg.url}`)
      } else {
        const willContainer = shouldContainerize(connCfg.name, serverCfg, freshConfig, computeSettings)
        console.log(`[MCP] ${reason} routing: containerize=${willContainer}, isolated=${shouldIsolate(freshConfig)}, run_location=${serverCfg.run_location ?? 'default'}`)
        if (willContainer) {
          const containerCmd = resolveContainerCommand(serverCfg)
          const isolated = shouldIsolate(freshConfig) && !isServerForceShared(serverCfg)

          try {
            await Promise.race([
              isolated
                ? podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id)
                : podmanService.ensureRunning(),
              new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60_000))
            ])
          } catch (containerErr) {
            console.warn(`[MCP] ${reason} skipped "${serverName}" — container not ready: ${containerErr instanceof Error ? containerErr.message : containerErr}`)
            return { toolsDiscovered: 0 }
          }
          const { isolatedContainerName } = await import('../services/podman.service')
          const podmanBin = await podmanService.findPodman()
          const containerName = isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp'
          try { await podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, freshConfig.id)) } catch { /* ignore */ }
          if (podmanBin) {
            console.log(`[MCP] ${reason}: connecting "${serverName}" in container ${containerName}: ${containerCmd.command} ${containerCmd.args.join(' ')}`)
            connectOptions = {
              externalTransport: new PodmanStdioTransport({
                podmanBin,
                containerName,
                command: containerCmd.command,
                args: containerCmd.args,
                env: connCfg.env,
                cwd: containerWorkspacePath(isolated, freshConfig.id),
              })
            }
          }
        } else {
          const spawn = resolveMcpSpawnConfig(connCfg, { npmResolver: mcpPackageResolver, uvxResolver: uvxPackageResolver, uvBinPath })
          if (spawn.command) connCfg.command = spawn.command
          if (spawn.args) connCfg.args = spawn.args
          if (connCfg.args) connCfg.args = connCfg.args.filter(Boolean)
          console.log(`[MCP] ${reason}: connecting "${serverName}" on host: ${connCfg.command} ${JSON.stringify(connCfg.args)}`)
        }
      }

      console.log(`[MCP] ${reason}: calling connect for "${serverName}": externalTransport=${!!connectOptions?.externalTransport}, transport=${connCfg.transport}`)
      const tools = await currentMcpManager.connect(connCfg, connectOptions)
      console.log(`[MCP] ${reason}: connect result for "${serverName}": tools=${tools?.length ?? 'null'}`)
      if (!tools) return { toolsDiscovered: 0 }

      const changed = syncDiscoveredMcpTools(freshConfig, serverCfg, tools, agentToolRegistry, currentMcpManager)
      const nextSchema = captureEnvSchema(serverCfg, appEnvKeys, agentEnvKeys)
      if (nextSchema) {
        serverCfg.env_schema = nextSchema
      }
      if (changed || nextSchema) {
        capturedWorkspace.setAgentConfig(freshConfig)
      }
      agentExecutor?.updateConfig(freshConfig)
      adfCallHandler?.updateConfig(freshConfig)
      return { toolsDiscovered: tools.length }
    }

    // Register MCP management tools
    if (config.tools.some((t) => t.name === 'mcp_install')) {
      agentToolRegistry.register(new McpInstallTool(async (serverName, installOptions) => {
        // Hot-reload: connect the newly installed server immediately
        console.log(`[MCP] Agent installed server "${serverName}" — connecting now`)
        console.log(`[MCP] Hot-load: mcpManager=${!!currentMcpManager}, workspace=${!!capturedWorkspace}`)
        try {
          const freshConfig = capturedWorkspace.getAgentConfig()
          const serverCfg = freshConfig.mcp?.servers?.find((s) => s.name === serverName)
          if (!serverCfg || !currentMcpManager) {
            console.warn(`[MCP] Hot-load abort: serverCfg=${!!serverCfg}, mcpManager=${!!currentMcpManager}`)
            return
          }

          const connCfg = { ...serverCfg }

          // Resolve uv binary path for pypi packages
          let uvBinPath: string | undefined
          if (serverCfg.pypi_package || serverCfg.command === 'uvx') {
            try { uvBinPath = await uvManager.ensureUv() } catch { /* uv not available */ }
          }

          // Resolve credentials from identity keystore
          const resolvedEnv = resolveMcpEnvVars(connCfg, (k) => capturedWorkspace.getIdentityDecrypted(k, capturedDerivedKey))
          if (Object.keys(resolvedEnv).length) {
            connCfg.env = { ...connCfg.env, ...resolvedEnv }
          }

          // --- Auth preflight: spawn stdio server once for interactive auth (OAuth etc.) ---
          if (installOptions?.auth && connCfg.transport !== 'http') {
            console.log(`[MCP] Auth preflight for "${serverName}" — spawning for interactive auth`)
            const { spawn: nodeSpawn } = await import('child_process')
            const { homedir } = await import('os')

            // Resolve the command the same way the connection path does
            const expandHome = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
            let preflightCmd = connCfg.command ? expandHome(connCfg.command) : 'npx'
            let preflightArgs = (connCfg.args ?? []).map(expandHome)

            // For npm packages without a resolved command, use npx
            if (serverCfg.npm_package && !serverCfg.command) {
              preflightCmd = 'npx'
              preflightArgs = ['-y', serverCfg.npm_package, ...preflightArgs.filter(a => a !== '-y' && a !== serverCfg.npm_package)]
            }
            // For pypi packages, use uv tool run
            if (serverCfg.pypi_package && uvBinPath) {
              preflightCmd = uvBinPath
              // Keep user args as-is — they already contain the right pypi invocation args
            }

            // Append auth-specific args (e.g. ["auth"] for servers with a dedicated auth subcommand)
            if (installOptions.authArgs?.length) {
              preflightArgs = [...preflightArgs, ...installOptions.authArgs]
            }

            const preflightEnv = { ...process.env, ...(connCfg.env ?? {}) }
            console.log(`[MCP] Auth preflight: ${preflightCmd} ${preflightArgs.join(' ')}`)

            const preflight = nodeSpawn(preflightCmd, preflightArgs, {
              env: preflightEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: false,
              shell: process.platform === 'win32',
            })
            preflight.on('error', (err) => {
              console.error(`[MCP] Auth preflight "${serverName}" spawn error:`, err)
            })

            // Watch stdout/stderr for auth URLs and open them via Electron shell.
            // The server is running in a dedicated auth mode (via auth_args), so any
            // HTTPS URL it prints is intentionally for the user to open.
            // Child process `open` may not work from Electron context, so we handle
            // browser opening ourselves via shell.openExternal.
            let authUrlOpened = false
            const openAuthUrl = (line: string) => {
              if (authUrlOpened) return
              const match = line.match(/https:\/\/\S+/)
              if (match) {
                authUrlOpened = true
                const url = match[0].replace(/[.,;)}\]]+$/, '') // strip trailing punctuation
                console.log(`[MCP] Auth preflight: opening auth URL in browser: ${url}`)
                shell.openExternal(url)
              }
            }

            preflight.stdout?.on('data', (chunk: Buffer) => {
              const text = chunk.toString().trim()
              console.log(`[MCP] Auth preflight "${serverName}" stdout: ${text}`)
              openAuthUrl(text)
            })
            preflight.stderr?.on('data', (chunk: Buffer) => {
              const text = chunk.toString().trim()
              console.log(`[MCP] Auth preflight "${serverName}" stderr: ${text}`)
              openAuthUrl(text)
            })

            // Give the process a moment to start and potentially open the browser itself
            await new Promise((r) => setTimeout(r, 3000))

            // Show dialog — blocks until user clicks Continue
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
            await dialog.showMessageBox({
              ...(win ? { window: win } : {}),
              type: 'info',
              title: `MCP Authorization — ${serverName}`,
              message: 'Complete authorization in your browser, then click Continue.',
              detail: authUrlOpened
                ? `An authorization page has been opened in your browser for "${serverName}". Complete the authorization flow, then click Continue.`
                : `The "${serverName}" MCP server is running for interactive authorization. If a browser window opened, complete the flow and click Continue. If no browser opened, check the logs for an authorization URL.`,
              buttons: ['Continue'],
              defaultId: 0,
            })

            // Kill the preflight process
            try {
              preflight.kill('SIGTERM')
              // Give it a moment to clean up, then force-kill
              setTimeout(() => { try { preflight.kill('SIGKILL') } catch { /* already dead */ } }, 2000)
            } catch { /* already exited */ }
            console.log(`[MCP] Auth preflight for "${serverName}" complete — proceeding to connect`)
          } else if (installOptions?.auth) {
            console.warn(`[MCP] Auth preflight skipped for HTTP server "${serverName}" — HTTP auth flows are configured through headers/env.`)
          }

          const result = await connectConfiguredMcpServer(freshConfig, serverName, 'Hot-load')
          if (result.toolsDiscovered > 0) {
            console.log(`[MCP] Hot-loaded "${serverName}" — ${result.toolsDiscovered} tools now available to agent`)
          } else {
            console.warn(`[MCP] Hot-load discovered no tools for "${serverName}" — server may need credentials or a later reconnect`)
          }
        } catch (err) {
          console.error(`[MCP] Hot-load failed for "${serverName}":`, err)
        }
      }))
    }
    if (config.tools.some((t) => t.name === 'mcp_restart')) {
      agentToolRegistry.register(new McpRestartTool(async (serverName) => {
        console.log(`[MCP] Agent requested reconnect for "${serverName}"`)
        const freshConfig = capturedWorkspace.getAgentConfig()
        return connectConfiguredMcpServer(freshConfig, serverName, 'Agent reconnect')
      }))
    }
    if (config.tools.some((t) => t.name === 'mcp_uninstall')) {
      agentToolRegistry.register(new McpUninstallTool((serverName) => {
        console.log(`[MCP] Agent uninstalled server "${serverName}"`)
        currentMcpManager?.disconnect(serverName).catch(() => {})
      }))
    }

    // Compute tools: always register (shared container is always available)
    const computeCaps: ComputeCapabilities = {
      hasIsolated: !!(config.compute?.enabled && podmanService),
      hasShared: !!podmanService,
      hasHost: !!config.compute?.host_access,
      isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
      agentId: config.id,
    }

    // Pre-create isolated container when compute.enabled
    if (computeCaps.hasIsolated && podmanService) {
      podmanService.ensureIsolatedRunning(config.name, config.id)
        .then(() => podmanService.ensureWorkspace(computeCaps.isolatedContainerName!, '/workspace'))
        .catch((err) => {
          console.warn(`[Compute] Pre-create isolated container failed:`, err instanceof Error ? err.message : err)
        })
    }

    agentToolRegistry.register(new FsTransferTool(podmanService, computeCaps))
    agentToolRegistry.register(new ComputeExecTool(podmanService, computeCaps, config.limits?.execution_timeout_ms))

    // Backward compat: rename container_exec → compute_exec in declarations
    const legacyDecl = config.tools.find((t) => t.name === 'container_exec')
    if (legacyDecl) legacyDecl.name = 'compute_exec'

    currentStreamBindingManager = new StreamBindingManager(config.id, config.name, capturedFilePath, config.stream_bind, wsConnectionManager, podmanService, capturedWorkspace)
    agentToolRegistry.register(new StreamBindTool(currentStreamBindingManager))
    agentToolRegistry.register(new StreamUnbindTool(currentStreamBindingManager))
    agentToolRegistry.register(new StreamBindingsTool(currentStreamBindingManager))

    // Wire fetch middleware deps into SysFetchTool
    if (adfCallHandler) {
      const fetchTool = agentToolRegistry.get('sys_fetch') as SysFetchTool | undefined
      if (fetchTool?.setMiddlewareDeps) {
        fetchTool.setMiddlewareDeps({
          codeSandboxService,
          adfCallHandler,
          agentId: capturedFilePath,
          getSecurityConfig: () => capturedWorkspace.getAgentConfig().security
        })
      }
    }

    // Create MCP manager (always — needed for hot-load even if no servers yet)
    let newMcpManager: McpClientManager | null = null
    let newScratchDir: string | null = createScratchDir(capturedFilePath)
    const mcpManager = new McpClientManager(newScratchDir)
    {

      // Forward supervisor events to renderer and cache logs
      mcpManager.on('status-changed', (name, status, error) => {
        const win = getMainWindow()
        win?.webContents.send(IPC.MCP_SERVER_STATUS_CHANGED, { name, status, error, toolCount: mcpManager.getServerState(name)?.toolCount })
        if (status === 'error') {
          try { capturedWorkspace.insertLog('error', 'mcp', 'status', name, error ?? 'MCP server entered error state') } catch { /* ignore */ }
        }
      })
      mcpManager.on('log', (name, entry) => {
        const cached = mcpLogCache.get(name) ?? []
        cached.push(entry)
        if (cached.length > 500) cached.splice(0, cached.length - 500)
        mcpLogCacheSet(name, cached)
        const level = entry.stream === 'stderr' ? 'warn' : 'info'
        try { capturedWorkspace.insertLog(level, 'mcp', entry.stream, name, entry.message) } catch { /* ignore */ }
      })

      // Re-register tools when a server reconnects after an unexpected disconnect
      mcpManager.on('tools-discovered', (serverName, tools) => {
        const serverCfg = config.mcp?.servers?.find((server) => server.name === serverName)
        if (serverCfg) {
          const changed = syncDiscoveredMcpTools(config, serverCfg, tools, agentToolRegistry, mcpManager)
          if (changed) {
            capturedWorkspace.setAgentConfig(config)
            agentExecutor?.updateConfig(config)
            adfCallHandler?.updateConfig(config)
          }
        } else {
          for (const toolInfo of tools) {
            const mcpTool = new McpTool(serverName, toolInfo, mcpManager)
            agentToolRegistry.register(mcpTool)
          }
        }
        console.log(`[MCP] Re-registered ${tools.length} tools for "${serverName}" after reconnect`)
      })

      try {
        if (!config.mcp?.servers?.length) {
          // No servers to connect, but manager is ready for hot-load
          newMcpManager = mcpManager
          // Jump past the server connection block
        } else {
        // Load Settings registrations to filter unregistered servers
        const mcpRegistrations = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
        const registeredNames = new Set(mcpRegistrations.map((r) => r.name))

        // Pre-resolve uv binary path once for all servers that need it
        const needsUv = config.mcp.servers.some((s) => s.pypi_package || s.command === 'uvx')
        let uvBinPath: string | undefined
        if (needsUv) {
          try { uvBinPath = await uvManager.ensureUv() } catch (e) {
            console.warn('[MCP] Failed to resolve uv binary:', e)
          }
        }

        const results = await Promise.allSettled(
          config.mcp.servers.map(async (serverCfg) => {
            // Skip servers not registered in Settings — unless they have a source
            // field (agent-installed via mcp_install or manually configured)
            if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
              console.log(`[MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
              return { serverCfg, tools: null as import('../../shared/types/adf-v02.types').McpToolInfo[] | null, skipped: true }
            }

            // Build a connection config — never mutate the original serverCfg
            // so the ADF config stays clean when saved back
            const connCfg = { ...serverCfg }

            // Wire per-server timeout from Settings registration
            const reg = mcpRegistrations.find((r) => r.name === connCfg.name)
            if (reg?.toolCallTimeout) {
              connCfg.tool_call_timeout_ms = reg.toolCallTimeout * 1000
            }
            if (reg?.url && connCfg.transport === 'http') connCfg.url = reg.url
            if (reg?.headers?.length) {
              const appHeaders: Record<string, string> = {}
              for (const { key, value } of reg.headers) {
                if (key && value) appHeaders[key] = value
              }
              if (Object.keys(appHeaders).length) connCfg.headers = { ...connCfg.headers, ...appHeaders }
            }
            if (reg?.headerEnv?.length) {
              connCfg.header_env = [
                ...(connCfg.header_env ?? []),
                ...reg.headerEnv
                  .filter((entry) => entry.key && entry.value)
                  .map((entry) => ({ header: entry.key, env: entry.value, required: true }))
              ]
            }
            if (reg?.bearerTokenEnvVar) {
              connCfg.bearer_token_env_var = reg.bearerTokenEnvVar
            }

            // Merge app-wide credentials from Settings registration (env key/value pairs)
            const appEnvKeys: string[] = []
            if (reg?.env?.length) {
              const appEnv: Record<string, string> = {}
              for (const { key, value } of reg.env) {
                if (key && value) { appEnv[key] = value; appEnvKeys.push(key) }
              }
              if (Object.keys(appEnv).length) {
                connCfg.env = { ...connCfg.env, ...appEnv }
              }
            }

            // Resolve env vars from identity keystore (per-agent credentials)
            const resolvedEnv = resolveMcpEnvVars(connCfg, (k) => capturedWorkspace.getIdentityDecrypted(k, capturedDerivedKey))
            const agentEnvKeys = Object.keys(resolvedEnv)
            if (agentEnvKeys.length) {
              connCfg.env = { ...connCfg.env, ...resolvedEnv }
            }

            // Compute environment routing: container vs host
            const computeSettings = (settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
            let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
            if (connCfg.transport === 'http') {
              console.log(`[MCP] Connecting "${connCfg.name}" (http): url=${connCfg.url}`)
            } else if (shouldContainerize(connCfg.name, serverCfg, config, computeSettings)) {
              // Container path: resolve commands for in-container execution
              const containerCmd = resolveContainerCommand(serverCfg)
              const isolated = shouldIsolate(config) && !isServerForceShared(serverCfg)
              try {
                if (isolated) {
                  await podmanService.ensureIsolatedRunning(config.name, config.id)
                } else {
                  await podmanService.ensureRunning()
                }
              } catch { /* fall through to host */ }
              const { isolatedContainerName } = await import('../services/podman.service')
              const podmanBin = await podmanService.findPodman()
              const containerName = isolated ? isolatedContainerName(config.name, config.id) : 'adf-mcp'
              try { await podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, config.id)) } catch { /* ignore */ }
              if (podmanBin) {
                const envKeys = connCfg.env ? Object.keys(connCfg.env) : []
                console.log(`[MCP] Connecting "${connCfg.name}" (container ${containerName}): ${containerCmd.command} ${containerCmd.args.join(' ')}${envKeys.length ? ` [env: ${envKeys.join(', ')}]` : ''}`)
                connectOptions = {
                  externalTransport: new PodmanStdioTransport({
                    podmanBin,
                    containerName,
                    command: containerCmd.command,
                    args: containerCmd.args,
                    env: connCfg.env,
                    cwd: containerWorkspacePath(isolated, config.id),
                  })
                }
              }
            } else {
              // Host path: resolve commands using host-installed packages
              const spawn = resolveMcpSpawnConfig(connCfg, { npmResolver: mcpPackageResolver, uvxResolver: uvxPackageResolver, uvBinPath })
              if (spawn.command) connCfg.command = spawn.command
              if (spawn.args) connCfg.args = spawn.args
              if (connCfg.args) connCfg.args = connCfg.args.filter(Boolean)
              console.log(`[MCP] Connecting "${connCfg.name}" (host): command=${connCfg.command}, args=${JSON.stringify(connCfg.args)}`)
            }

            const tools = await mcpManager.connect(connCfg, connectOptions)
            return { serverCfg, tools, skipped: false, appEnvKeys, agentEnvKeys }
          })
        )

        let configChanged = false

        // Collect names of servers that connected or attempted (vs skipped/unregistered)
        const connectedServerNames = new Set<string>()
        const attemptedServerNames = new Set<string>()
        for (const result of results) {
          if (result.status !== 'fulfilled') continue
          if (result.value.skipped) continue
          attemptedServerNames.add(result.value.serverCfg.name)
          if (!result.value.tools) continue
          const { serverCfg, tools, appEnvKeys, agentEnvKeys } = result.value
          connectedServerNames.add(serverCfg.name)

          if (syncDiscoveredMcpTools(config, serverCfg, tools, agentToolRegistry, mcpManager)) {
            configChanged = true
          }

          const nextSchema = captureEnvSchema(serverCfg, appEnvKeys ?? [], agentEnvKeys ?? [])
          if (nextSchema) {
            serverCfg.env_schema = nextSchema
            configChanged = true
          }

        }

        // Disable tools only from skipped (unregistered) servers — NOT from servers
        // that attempted connection but failed (e.g. timeout, auth error)
        for (const decl of config.tools) {
          if (!decl.name.startsWith('mcp_')) continue
          const serverName = config.mcp!.servers.find((s) => decl.name.startsWith(`mcp_${s.name}_`))?.name
          if (serverName && !connectedServerNames.has(serverName) && !attemptedServerNames.has(serverName) && decl.enabled) {
            decl.enabled = false
            configChanged = true
          }
        }

        if (configChanged) {
          capturedWorkspace.setAgentConfig(config)
        }

        } // end if (servers.length)
        newMcpManager = mcpManager
      } catch (mcpError) {
        // If MCP setup fails, clean up all connections to avoid orphaned processes
        console.error('[AGENT_START] MCP setup failed, cleaning up:', mcpError)
        await mcpManager.disconnectAll()
        removeScratchDir(newScratchDir)
        newScratchDir = null
      }
    }
    // Always assign the manager so hot-load can use it
    if (!newMcpManager) newMcpManager = mcpManager

    const sysGetConfigTool = agentToolRegistry.get('sys_get_config') as SysGetConfigTool | undefined
    sysGetConfigTool?.setToolDiscoveryProvider((ws) => buildToolDiscovery(ws.getAgentConfig(), agentToolRegistry))

    // --- Shell Tool Registration ---
    if (config.tools.some(t => t.name === 'adf_shell')) {
      const shellTool = new ShellTool(agentToolRegistry, capturedWorkspace, config, newMcpManager)
      if (triggerEvaluator) {
        const capturedTriggerEval = triggerEvaluator
        shellTool.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
          capturedTriggerEval.onToolCall(tool, args, taskId, origin, systemScopeHandled)
        }
      }
      agentToolRegistry.register(shellTool)
    }

    // --- Channel Adapter Setup ---
    let newAdapterManager: ChannelAdapterManager | null = null
    const adapterRegistrations = withBuiltInAdapterRegistrations(settings.get('adapters') as AdapterRegistration[] | undefined)
    if (adapterRegistrations.length > 0) {
      const adapterMgr = new ChannelAdapterManager()
      adapterMgr.on('log', (adapterType, entry) => {
        const level = entry.level === 'system' ? 'info' : entry.level
        try { capturedWorkspace.insertLog(level, 'adapter', null, adapterType, entry.message) } catch { /* ignore */ }
      })
      adapterMgr.on('status-changed', (adapterType, status, error) => {
        if (status === 'error') {
          try { capturedWorkspace.insertLog('error', 'adapter', 'status', adapterType, error ?? 'Adapter entered error state') } catch { /* ignore */ }
        }
      })

      const configuredAdapters = config.adapters ?? {}
      for (const registration of adapterRegistrations) {
        const adapterType = registration.type
        const adapterConfig = getEnabledAgentAdapterConfig(configuredAdapters, adapterType)
        if (!adapterConfig) continue

        // Resolve npm package
        const installed = registration.npmPackage ? adapterPackageResolver.getInstalled(registration.npmPackage) : null

        // Try in-tree adapter first (e.g., telegram), then npm package
        let createFn: CreateAdapterFn | null = null
        try {
          if (adapterType === 'telegram') {
            const mod = await import('../adapters/telegram/index')
            createFn = mod.createAdapter
          } else if (adapterType === 'email') {
            const mod = await import('../adapters/email/index')
            createFn = mod.createAdapter
          } else if (installed) {
            const mod = require(join(installed.installPath, 'node_modules', registration.npmPackage!))
            createFn = mod.createAdapter ?? mod.default?.createAdapter
          }
        } catch (err) {
          console.error(`[AGENT_START][Adapter] Failed to load "${adapterType}":`, err)
          continue
        }

        if (!createFn) {
          console.warn(`[AGENT_START][Adapter] No createAdapter() found for "${adapterType}"`)
          continue
        }

        const started = await adapterMgr.startAdapter(
          adapterType, createFn, adapterConfig, capturedWorkspace, currentDerivedKey, registration.env
        )
        if (started) {
          console.log(`[AGENT_START][Adapter] Started "${adapterType}"`)
        }
      }

      // Wire inbound events: update renderer + fire trigger
      adapterMgr.on('inbound', (type, msg, meta) => {
        const unread = capturedWorkspace.getInbox('unread')
        const read = capturedWorkspace.getInbox('read')
        const allMessages = [...unread, ...read]

        // Emit inbox_updated to renderer — transform to the same shape as DOC_GET_INBOX
        const win = getMainWindow()
        if (win) {
          win.webContents.send(IPC.INBOX_UPDATED, {
            inbox: {
              version: 1,
              messages: allMessages
            }
          })
        }

        // Fire on_inbox trigger with the adapter's source (e.g. 'telegram')
        if (triggerEvaluator) {
          const sender = `${type}:${msg.sender}`
          triggerEvaluator.onInbox(sender, msg.payload, {
            source: type,
            messageId: meta.inboxId,
            parentId: meta.parentId,
            sourceMeta: msg.sourceMeta
          })
        }
      })

      // Wire status changes to renderer
      adapterMgr.on('status-changed', (type, status, error) => {
        const win = getMainWindow()
        if (win) {
          win.webContents.send(IPC.ADAPTER_STATUS_CHANGED, { type, status, error })
        }
      })

      newAdapterManager = adapterMgr
    }

    const newExecutor = new AgentExecutor(config, provider, agentToolRegistry, session, basePrompt, toolPrompts, compactionPrompt)

    // Set up system scope handler if adf handler is available
    if (adfCallHandler) {
      newExecutor.setSystemScopeHandler(
        new SystemScopeHandler(capturedWorkspace, codeSandboxService, adfCallHandler, capturedFilePath)
      )
    }

    // Emit initial display state based on start_in_state config
    const initialDisplayState = config.start_in_state ?? 'idle'

    // If the user navigated away during setup, transition to background instead
    // of installing into foreground globals — mirrors what cleanupCurrentFile does.
    if (fileChanged()) {
      console.log(`[AGENT_START] File changed during startup, transitioning ${capturedFilePath} to background`)
      if (backgroundAgentManager && !backgroundAgentManager.hasAgent(capturedFilePath)) {
        const newTriggerEvaluator = new TriggerEvaluator(config)
        newTriggerEvaluator.setDisplayState(initialDisplayState)
        await backgroundAgentManager.transitionToBackground(
          capturedFilePath, config, session, capturedWorkspace,
          newExecutor, newTriggerEvaluator, agentToolRegistry, newMcpManager, newAdapterManager
        )
        if (meshManager?.isEnabled()) {
          const agentRefs = backgroundAgentManager.getAgent(capturedFilePath)
          if (agentRefs) {
            const bgMgr = backgroundAgentManager
            const fp = capturedFilePath
            meshManager.registerAgent(
              capturedFilePath, agentRefs.config, agentRefs.toolRegistry,
              agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
              () => bgMgr.getIsMessageTriggered(fp),
              agentRefs.executor,
              agentRefs.adfCallHandler,
              agentRefs.codeSandboxService
            )
            syncDerivedKeyToMesh(capturedFilePath, derivedKeyCache.get(capturedFilePath) ?? null)
            if (newAdapterManager) {
              meshManager.setAdapterManager(capturedFilePath, newAdapterManager)
            }
          }
        }
      } else {
        // Background manager unavailable or agent already there — just clean up
        newExecutor.abort()
        if (newMcpManager) await newMcpManager.disconnectAll()
        if (newAdapterManager) await newAdapterManager.stopAll()
      }
      startingFilePaths.delete(capturedFilePath)
      console.log(`[PERF] AGENT_START (fresh, to background): ${(performance.now() - t0).toFixed(1)}ms`)
      return { success: true, sessionId: session.getSessionId(), agentState: initialDisplayState }
    }

    newExecutor.on('event', async (event) => {
      if (currentFilePath === capturedFilePath) {
        const win = getMainWindow()
        if (win) {
          win.webContents.send(IPC.AGENT_EVENT, event)
        }
      }

      // Propagate display state changes to trigger evaluator (map executor → display states)
      if (event.type === 'state_changed' && triggerEvaluator) {
        const payload = event.payload as { state: string }
        triggerEvaluator.setDisplayState(executorToDisplayState(payload.state))
      }

      // Hard off: any path that lands on display state 'off' triggers full teardown.
      if (event.type === 'state_changed') {
        const payload = event.payload as { state: string }
        if (payload.state === 'off') {
          await handleAgentOff(capturedFilePath)
        }
      }

      // Refresh tracked directories when a new ADF file is created by the agent
      if (event.type === 'adf_file_created') {
        const payload = event.payload as { filePath?: string }
        if (payload?.filePath) {
          notifyAdfFileCreated(payload.filePath)
        }
      }

      // Turn complete - LLM messages persisted in loop automatically by AgentSession
    })

    const newTriggerEvaluator = new TriggerEvaluator(config)
    newTriggerEvaluator.setDisplayState(config.start_in_state ?? 'idle')
    newTriggerEvaluator.on('trigger', async (dispatch: AdfEventDispatch | AdfBatchDispatch) => {
      if (RuntimeGate.stopped) return
      if (newExecutor) {
        try {
          await newExecutor.executeTurn(dispatch)
        } catch (error) {
          const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
          try { capturedWorkspace.insertLog('error', 'runtime', 'trigger_error', eventType, String(error).slice(0, 200)) } catch { /* non-fatal */ }
          const win = getMainWindow()
          if (win) {
            win.webContents.send(IPC.AGENT_EVENT, {
              type: 'error',
              payload: { error: String(error) },
              timestamp: Date.now()
            })
          }
        }
      }
    })
    newTriggerEvaluator.on('event', (event: AgentExecutionEvent) => {
      const win = getMainWindow()
      if (win) win.webContents.send(IPC.AGENT_EVENT, event)
    })
    newTriggerEvaluator.startTimerPolling(capturedWorkspace)
    newTriggerEvaluator.setWorkspace(capturedWorkspace)

    // Wire on_logs trigger
    capturedWorkspace.setOnLogCallback((level, origin, event, target, message) => {
      newTriggerEvaluator.onLog(level, origin, event, target, message)
    })

    // Wire task lifecycle callbacks
    newExecutor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
      newTriggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
    newExecutor.onTaskCreated = (task) => {
      newTriggerEvaluator.onTaskCreate(task)
    }
    newExecutor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
      newTriggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
      if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
        try {
          const parsed = JSON.parse(result)
          if (parsed.target_state) newExecutor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
    }
    newExecutor.onLlmCall = (data) => {
      newTriggerEvaluator.onLlmCall(data)
    }
    if (adfCallHandler) {
      adfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
        newTriggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
        if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
          try {
            const parsed = JSON.parse(result)
            if (parsed.target_state) newExecutor.applyDeferredStateTransition(parsed.target_state)
          } catch { /* ignore parse errors */ }
        }
      }
      adfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
        if (tool !== 'sys_set_state') return
        try {
          const parsed = JSON.parse(resultContent)
          if (parsed.target_state) newExecutor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
      adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
        newExecutor.resolveHilTask(taskId, approved, modifiedArgs)
      }
      adfCallHandler.onLlmCall = (data) => {
        newTriggerEvaluator.onLlmCall(data)
      }
    }
    // Wire shell tool callbacks to executor and trigger evaluator
    const shellToolInstance = agentToolRegistry.get('adf_shell') as ShellTool | undefined
    if (shellToolInstance) {
      shellToolInstance.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
        newTriggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
      }
      shellToolInstance.onApprovalRequired = (toolName, command) => {
        return newExecutor.requestApproval(toolName, { command })
      }
    }

    // Install into foreground globals
    agentExecutor = newExecutor
    triggerEvaluator = newTriggerEvaluator
    currentSession = session
    currentAgentToolRegistry = agentToolRegistry
    currentMcpManager = newMcpManager
    currentScratchDir = newScratchDir
    currentAdapterManager = newAdapterManager

    // Umbilical bus + taps for the foreground agent
    {
      const bus = ensureWorkspaceUmbilicalBus(config.id, capturedWorkspace)
      currentUmbilicalAgentId = config.id
      const taps = config.umbilical_taps ?? []
      if (taps.length > 0 && adfCallHandler) {
        const tm = new TapManager(config.id, capturedWorkspace, bus, codeSandboxService, adfCallHandler)
        await tm.register(taps)
        currentTapManager = tm
      }
      currentStreamBindingManager?.loadDeclarations(config.stream_bindings ?? [])
    }

    // Wire sys_update_config propagation callback
    const sysUpdateTool = agentToolRegistry.get('sys_update_config') as SysUpdateConfigTool | undefined
    if (sysUpdateTool) {
      sysUpdateTool.onConfigChanged = (updatedConfig) => {
        if (agentExecutor) agentExecutor.updateConfig(updatedConfig)
        if (triggerEvaluator) triggerEvaluator.updateConfig(updatedConfig)
        adfCallHandler?.updateConfig(updatedConfig)
        if (meshManager && capturedFilePath) meshManager.updateAgentConfig(capturedFilePath, updatedConfig)
      }
    }

    // Wire sys_create_adf autostart + child review callbacks
    const createAdfTool = agentToolRegistry.get('sys_create_adf') as CreateAdfTool | undefined
    if (createAdfTool) {
      createAdfTool.onAutostartChild = async (childPath) => backgroundAgentManager?.startAgent(childPath) ?? false
      createAdfTool.onChildCreated = (_childPath, childConfig) => {
        settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), childConfig))
      }
    }

    if (meshManager?.isEnabled() && capturedFilePath) {
      meshManager.registerAgent(
        capturedFilePath, config, agentToolRegistry,
        capturedWorkspace, session, newTriggerEvaluator, true,
        () => newExecutor?.isMessageTriggered ?? false,
        newExecutor ?? null,
        adfCallHandler, codeSandboxService
      )
      newExecutor.updateConfig(config)
      adfCallHandler?.updateConfig(config)
      syncDerivedKeyToMesh(capturedFilePath, capturedDerivedKey)

      // Wire adapter manager to mesh for outbound routing
      if (newAdapterManager) {
        meshManager.setAdapterManager(capturedFilePath, newAdapterManager)
      }
    }

    // Fire on_startup trigger (once per agent start, independent of autonomous mode)
    if (!args?.hasUserMessage) {
      process.nextTick(() => {
        newTriggerEvaluator.onStartup()
      })
    }

    // Fire initial turn if start_in_state is active (the default).
    // Autonomous mode controls loop behavior (continuous vs interactive), not startup.
    // Skip if a user message is about to be sent — otherwise the start turn fires first
    // and the user message gets absorbed as an invisible interrupt.
    const startState = config.start_in_state ?? 'active'
    if (startState === 'active' && !args?.hasUserMessage) {
      process.nextTick(() => {
        newExecutor?.executeTurn(createDispatch(createEvent({ type: 'startup' as const, source: 'system', data: undefined }), { scope: 'agent' })).catch((error) => {
          const win = getMainWindow()
          if (win) {
            win.webContents.send(IPC.AGENT_EVENT, {
              type: 'error',
              payload: { error: String(error) },
              timestamp: Date.now()
            })
          }
        })
      })
    }

    startingFilePaths.delete(capturedFilePath)
    console.log(`[PERF] AGENT_START (fresh): ${(performance.now() - t0).toFixed(1)}ms`)
    return { success: true, sessionId: session.getSessionId(), agentState: initialDisplayState }
  })

  ipcMain.handle(IPC.AGENT_STOP, async () => {
    const stoppedFilePath = currentFilePath

    if (meshManager?.isEnabled() && stoppedFilePath) {
      meshManager.unregisterAgent(stoppedFilePath)
    }

    if (agentExecutor) {
      agentExecutor.abort()
      agentExecutor = null
    }
    if (triggerEvaluator) {
      triggerEvaluator.dispose()
      triggerEvaluator = null
    }
    currentAdfCallHandler = null

    if (stoppedFilePath) {
      codeSandboxService.destroy(stoppedFilePath)
    }

    if (currentMcpManager) {
      currentMcpManager.removeAllListeners()
      await currentMcpManager.disconnectAll()
      currentMcpManager = null
    }
    removeScratchDir(currentScratchDir)
    currentScratchDir = null

    // Unregister from compute environment
    if (stoppedFilePath) {
      try {
        const cfg = currentWorkspace?.getAgentConfig()
        if (cfg?.compute?.enabled) {
          podmanService.unregisterAgent(cfg.id)
        }
      } catch { /* workspace may already be closed */ }
    }

    // Stop channel adapters
    if (currentAdapterManager) {
      currentAdapterManager.removeAllListeners()
      if (meshManager && stoppedFilePath) {
        meshManager.removeAdapterManager(stoppedFilePath)
      }
      await currentAdapterManager.stopAll()
      currentAdapterManager = null
    }

    currentSession = null
    currentAgentToolRegistry = null

    return { success: true }
  })

  ipcMain.handle(IPC.AGENT_TOOL_APPROVAL_RESPOND, async (_event, args: { requestId: string; approved: boolean }) => {
    if (!agentExecutor) {
      return { success: false, error: 'Agent not running' }
    }
    agentExecutor.resolveApproval(args.requestId, args.approved)
    return { success: true }
  })

  ipcMain.handle(IPC.AGENT_ASK_RESPOND, async (_event, args: { requestId: string; answer: string }) => {
    if (!agentExecutor) {
      return { success: false, error: 'Agent not running' }
    }
    agentExecutor.resolveAsk(args.requestId, args.answer)
    return { success: true }
  })

  // Background agent ask/approval responses
  ipcMain.handle(IPC.BACKGROUND_AGENT_ASK_RESPOND, async (_event, args: { filePath: string; requestId: string; answer: string }) => {
    if (!backgroundAgentManager) {
      return { success: false, error: 'Background agent manager not initialized' }
    }
    const executor = backgroundAgentManager.getExecutor(args.filePath)
    if (!executor) {
      return { success: false, error: 'Background agent not found' }
    }
    executor.resolveAsk(args.requestId, args.answer)
    return { success: true }
  })

  ipcMain.handle(IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND, async (_event, args: { filePath: string; requestId: string; approved: boolean }) => {
    if (!backgroundAgentManager) {
      return { success: false, error: 'Background agent manager not initialized' }
    }
    const executor = backgroundAgentManager.getExecutor(args.filePath)
    if (!executor) {
      return { success: false, error: 'Background agent not found' }
    }
    executor.resolveApproval(args.requestId, args.approved)
    return { success: true }
  })

  ipcMain.handle(IPC.AGENT_SUSPEND_RESPOND, async (_event, args: { resume: boolean }) => {
    if (!agentExecutor) {
      return { success: false, error: 'Agent not running' }
    }
    agentExecutor.resolveSuspend(args.resume)
    return { success: true }
  })

  ipcMain.handle(IPC.AGENT_INVOKE, async (_event, args: { userMessage?: string; filePath?: string; content?: ContentBlock[] }) => {
    const targetFile = args.filePath
    const isForeground = !targetFile || targetFile === currentFilePath
    const contentJson: ContentBlock[] = Array.isArray(args.content) && args.content.length > 0
      ? args.content
      : [{ type: 'text', text: args?.userMessage ?? '' }]

    // If targeting the foreground agent
    if (isForeground) {
      if (!agentExecutor) {
        return { success: false, error: 'Agent not running' }
      }
      try {
        await agentExecutor.executeTurn(createDispatch(createEvent({
          type: 'chat' as const, source: 'system',
          data: { message: { seq: 0, role: 'user' as const, content_json: contentJson, created_at: Date.now() } },
        }), { scope: 'agent' }))
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }

    // Target is a background agent (user navigated away after submitting)
    if (backgroundAgentManager?.hasAgent(targetFile)) {
      const agentRefs = backgroundAgentManager.getAgent(targetFile)
      if (agentRefs) {
        try {
          await agentRefs.executor.executeTurn(createDispatch(createEvent({
            type: 'chat' as const, source: 'system',
            data: { message: { seq: 0, role: 'user' as const, content_json: contentJson, created_at: Date.now() } },
          }), { scope: 'agent' }))
          return { success: true }
        } catch (error) {
          return { success: false, error: String(error) }
        }
      }
    }

    return { success: false, error: 'Agent not running' }
  })

  ipcMain.handle(IPC.AGENT_STATUS, async () => {
    return {
      running: agentExecutor !== null,
      state: agentExecutor?.getState() ?? 'stopped'
    }
  })

  // --- Models ---

  ipcMain.handle(IPC.MODELS_LIST, async (_event, args: { provider: string; filePath?: string }) => {
    let cfg = settings.getProvider(args.provider)

    // If not found in app settings, check ADF-stored providers
    if (!cfg && args.filePath) {
      try {
        const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
        if (workspace) {
          try {
            const agentConfig = workspace.getAgentConfig()
            const adfProvider = agentConfig.providers?.find(p => p.id === args.provider)
            if (adfProvider) {
              const derivedKey = derivedKeyCache.get(args.filePath) ?? null
              const apiKey = workspace.getIdentityDecrypted(
                `provider:${adfProvider.id}:apiKey`, derivedKey
              ) ?? ''
              cfg = { ...adfProvider, apiKey }
            }
          } finally {
            if (args.filePath !== currentFilePath) workspace.close()
          }
        }
      } catch {
        // Fall through to not-found error
      }
    }

    if (!cfg) {
      return { models: [], error: `Provider "${args.provider}" not found in settings.` }
    }

    if (cfg.type === 'chatgpt-subscription') {
      const { CHATGPT_SUBSCRIPTION_MODELS } = await import('../providers/chatgpt-subscription')
      return { models: CHATGPT_SUBSCRIPTION_MODELS }
    }

    if (cfg.type === 'anthropic') {
      try {
        if (!cfg.apiKey) {
          return { models: [], error: 'Anthropic API key not configured.' }
        }
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01'
          },
          signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) {
          return { models: [], error: `Anthropic API returned ${response.status}` }
        }
        const json = await response.json() as { data?: { id: string; type: string }[] }
        const models = (json.data ?? [])
          .filter((m) => m.type === 'model')
          .map((m) => m.id)
        return { models }
      } catch (error) {
        return { models: [], error: String(error) }
      }
    }

    // openai + openai-compatible — both use Bearer auth and /models endpoint
    try {
      const baseUrl = cfg.type === 'openai' ? 'https://api.openai.com/v1' : cfg.baseUrl
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (cfg.apiKey) {
        headers['Authorization'] = `Bearer ${cfg.apiKey}`
      }
      const url = baseUrl.replace(/\/+$/, '') + '/models'
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
      if (!response.ok) {
        return { models: [], error: `Server returned ${response.status}` }
      }
      const json = await response.json() as { data?: { id: string }[] }
      const models = (json.data ?? []).map((m) => m.id)
      return { models }
    } catch (error) {
      return { models: [], error: String(error) }
    }
  })

  // --- Settings ---

  ipcMain.handle(IPC.SETTINGS_GET, async () => {
    return settings.getAll()
  })

  ipcMain.handle(IPC.SETTINGS_SET, async (_event, newSettings: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(newSettings)) {
      settings.set(key, value)
    }
    return { success: true }
  })

  // --- Tracked directories ---

  ipcMain.handle(IPC.TRACKED_DIRS_GET, async () => {
    const directories = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dirPath of directories) rememberTrackedDirectory(dirPath)
    startDirWatcher(directories)
    return { directories }
  })

  ipcMain.handle(IPC.TRACKED_DIRS_ADD, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      const directories = (settings.get('trackedDirectories') as string[]) ?? []
      return { directories }
    }
    const dirPath = result.filePaths[0]
    rememberTrackedDirectory(dirPath)
    const existing = (settings.get('trackedDirectories') as string[]) ?? []
    if (!existing.includes(dirPath)) {
      const updated = [...existing, dirPath]
      settings.set('trackedDirectories', updated)
      startDirWatcher(updated)
      if (meshManager) {
        meshManager.setTrackedDirectories(updated)
      }
      return { directories: updated }
    }
    return { directories: existing }
  })

  ipcMain.handle(IPC.TRACKED_DIRS_REMOVE, async (_event, args: { dirPath: string }) => {
    const existing = (settings.get('trackedDirectories') as string[]) ?? []
    const updated = existing.filter((d) => d !== args.dirPath)
    settings.set('trackedDirectories', updated)
    startDirWatcher(updated)
    if (meshManager) {
      meshManager.setTrackedDirectories(updated)
    }
    return { directories: updated }
  })

  ipcMain.handle(IPC.TRACKED_DIRS_SCAN, async (_event, args: { dirPath: string }) => {
    try {
      rememberTrackedDirectory(args.dirPath)
      const maxDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5
      const files = await scanDirectoryRecursive(args.dirPath, args.dirPath, maxDepth, 0)
      return { files }
    } catch {
      return { files: [] }
    }
  })

  interface TrackedDirEntry {
    filePath: string
    fileName: string
    canReceive?: boolean
    sendMode?: string
    autonomous?: boolean
    isDirectory: boolean
    children?: TrackedDirEntry[]
  }

  async function scanDirectoryRecursive(
    rootPath: string,
    currentPath: string,
    maxDepth: number,
    currentDepth: number
  ): Promise<TrackedDirEntry[]> {
    if (currentDepth > maxDepth) return []

    const entries = readdirSync(currentPath, { withFileTypes: true })
    const result: TrackedDirEntry[] = []

    const adfFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.adf'))
    for (const e of adfFiles) {
      const fp = join(currentPath, e.name)
      const msgConfig = AdfDatabase.peekMessagingConfig(fp)
      result.push({
        filePath: fp,
        fileName: e.name,
        canReceive: msgConfig ? msgConfig.receive : undefined,
        sendMode: msgConfig?.mode,
        autonomous: msgConfig?.autonomous,
        isDirectory: false
      })
    }

    const subdirs = entries.filter((e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      e.name !== 'node_modules'
    )

    for (const dir of subdirs) {
      const dirPath = join(currentPath, dir.name)
      const children = await scanDirectoryRecursive(rootPath, dirPath, maxDepth, currentDepth + 1)

      if (children.length > 0) {
        result.push({
          filePath: dirPath,
          fileName: dir.name,
          isDirectory: true,
          children
        })
      }
    }

    return result
  }

  // --- Mesh ---

  ipcMain.handle(IPC.MESH_ENABLE, async () => {
    try {
      if (meshManager) {
        meshManager.removeAllListeners()
        meshManager.disableMesh()
      }

      const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
      meshManager = new MeshManager(trackedDirs)
      meshManager.enableMesh()

      meshManager.on('mesh_event', (event: MeshEvent) => {
        const win = getMainWindow()
        if (win) {
          win.webContents.send(IPC.MESH_EVENT, event)
        }
      })

      meshManager.on('foreground_incoming', (data: {
        filePath: string
        fromAgent: string
        toAgent: string
        channel?: string
        content: string
      }) => {
        if (data.filePath === currentFilePath) {
          const win = getMainWindow()
          if (win) {
            win.webContents.send(IPC.AGENT_EVENT, {
              type: 'inter_agent_message',
              payload: {
                fromAgent: data.fromAgent,
                toAgent: data.toAgent,
                channel: data.channel,
                content: data.content,
                direction: 'incoming'
              },
              timestamp: Date.now()
            })
          }
        }
      })

      meshManager.on('inbox_updated', (data: { filePath: string; inbox: unknown }) => {
        if (data.filePath === currentFilePath) {
          const win = getMainWindow()
          if (win) {
            // Wrap raw InboxMessage[] in version envelope for renderer
            win.webContents.send(IPC.INBOX_UPDATED, { inbox: { version: 1, messages: data.inbox } })
          }
        }
      })

      // Wire background agent config changes to mesh cache
      if (backgroundAgentManager) {
        const mm = meshManager
        const bgMgr = backgroundAgentManager
        backgroundAgentManager.onAgentConfigChanged = (fp, cfg) => mm.updateAgentConfig(fp, cfg)
        backgroundAgentManager.onAgentStarted = (fp) => {
          if (!mm.isEnabled()) return
          const agentRefs = bgMgr.getAgent(fp)
          if (!agentRefs) return
          mm.registerAgent(
            fp, agentRefs.config, agentRefs.toolRegistry,
            agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
            () => bgMgr.getIsMessageTriggered(fp),
            agentRefs.executor,
            agentRefs.adfCallHandler,
            agentRefs.codeSandboxService
          )
          const key = derivedKeyCache.get(fp) ?? null
          if (key) mm.setDerivedKey(fp, key)
          if (agentRefs.adapterManager) {
            mm.setAdapterManager(fp, agentRefs.adapterManager)
          }
        }
      }

      if (backgroundAgentManager) {
        for (const filePath of backgroundAgentManager.getAllAgentFilePaths()) {
          const agentRefs = backgroundAgentManager.getAgent(filePath)
          if (agentRefs) {
            const bgMgr = backgroundAgentManager
            const fp = filePath
            meshManager.registerAgent(
              filePath, agentRefs.config, agentRefs.toolRegistry,
              agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
              () => bgMgr.getIsMessageTriggered(fp),
              agentRefs.executor,
              agentRefs.adfCallHandler,
              agentRefs.codeSandboxService
            )
            if (agentRefs.adapterManager) {
              meshManager.setAdapterManager(filePath, agentRefs.adapterManager)
            }
          }
        }
      }

      if (currentFilePath && triggerEvaluator && currentWorkspace && currentSession && currentAgentToolRegistry) {
        const config = currentWorkspace.getAgentConfig()
        const capturedExecutor = agentExecutor
        meshManager.registerAgent(
          currentFilePath, config, currentAgentToolRegistry,
          currentWorkspace, currentSession, triggerEvaluator, true,
          () => capturedExecutor?.isMessageTriggered ?? false,
          agentExecutor ?? null,
          currentAdfCallHandler, codeSandboxService
        )
        if (currentAdapterManager) {
          meshManager.setAdapterManager(currentFilePath, currentAdapterManager)
        }
        if (agentExecutor) {
          agentExecutor.updateConfig(config)
        }
        currentAdfCallHandler?.updateConfig(config)
      }

      // Sync cached derived keys so the pipeline can sign messages
      for (const [fp, key] of derivedKeyCache) {
        meshManager.setDerivedKey(fp, key)
      }

      // Wire mesh server to the new mesh manager
      if (meshServer) meshServer.setMeshManager(meshManager)

      // Set up WS connection manager
      const wsDelegate = meshManager.createWsDelegate()
      wsConnectionManager = new WsConnectionManager(wsDelegate)
      meshManager.setWsConnectionManager(wsConnectionManager)
      backgroundAgentManager?.setWsConnectionManager(wsConnectionManager)
      if (meshServer) meshServer.setWsConnectionManager(wsConnectionManager)

      // Start mDNS now that agents are registered and we can check the LAN-tier gate.
      void startMdnsIfEligible()

      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MESH_DISABLE, async () => {
    try {
      await stopMdnsAndCleanup()
      if (wsConnectionManager) {
        wsConnectionManager.stopAll()
        wsConnectionManager = null
      }
      backgroundAgentManager?.setWsConnectionManager(null)
      if (meshManager) {
        meshManager.removeAllListeners()
        meshManager.setWsConnectionManager(null)
        meshManager.disableMesh()
        meshManager = null
      }
      if (meshServer) {
        meshServer.setMeshManager(null)
        meshServer.setWsConnectionManager(null)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MESH_STATUS, async (_event, args?: { debug?: boolean }) => {
    if (!meshManager || !meshManager.isEnabled()) {
      if (args?.debug) {
        return {
          running: false,
          agents: [],
          busRegistrations: [],
          backgroundAgents: [],
          foregroundAgents: [],
          messageLog: []
        }
      }
      return { running: false, agents: [] }
    }

    const result: Record<string, unknown> = {
      running: true,
      agents: meshManager.getAgentStatuses()
    }

    if (args?.debug) {
      try {
        const debugInfo = meshManager.getDebugInfo()
        Object.assign(result, debugInfo)
      } catch (error) {
        console.error('[IPC] Mesh debug error:', error)
        result.busRegistrations = []
        result.backgroundAgents = []
        result.foregroundAgents = []
        result.messageLog = []
        result.error = String(error)
      }
    }

    return result
  })

  ipcMain.handle(IPC.MESH_GET_RECENT_TOOLS, async () => {
    // Start with mesh-registered agents
    const result = meshManager ? meshManager.getRecentTools(5) : {}

    // Supplement with background agents not already covered by mesh registration
    if (backgroundAgentManager) {
      for (const filePath of backgroundAgentManager.getAllAgentFilePaths()) {
        if (result[filePath]) continue // already have data from mesh
        const agentRefs = backgroundAgentManager.getAgent(filePath)
        if (!agentRefs) continue
        result[filePath] = readRecentToolsFromWorkspace(agentRefs.workspace, 5)
      }
    }

    // Supplement with foreground agent if not already covered
    if (currentFilePath && currentWorkspace && !result[currentFilePath]) {
      result[currentFilePath] = readRecentToolsFromWorkspace(currentWorkspace, 5)
    }

    return result
  })

  ipcMain.handle(IPC.MESH_SERVER_STATUS, async () => {
    return {
      running: meshServer?.isRunning() ?? false,
      port: meshServer?.getPort() ?? 7295,
      host: meshServer?.getHost() ?? '127.0.0.1'
    }
  })

  ipcMain.handle(IPC.MESH_SERVER_RESTART, async () => {
    if (!meshServer) return { success: false, error: 'No mesh server' }
    await stopMdnsAndCleanup()
    await meshServer.stop()
    await meshServer.start()
    void startMdnsIfEligible()
    return {
      success: true,
      running: meshServer.isRunning(),
      port: meshServer.getPort(),
      host: meshServer.getHost()
    }
  })

  ipcMain.handle(IPC.MESH_SERVER_START, async () => {
    if (!meshServer) return { success: false, error: 'No mesh server' }
    if (meshServer.isRunning()) return { success: true, running: true, port: meshServer.getPort(), host: meshServer.getHost() }
    await meshServer.start()
    void startMdnsIfEligible()
    return {
      success: meshServer.isRunning(),
      running: meshServer.isRunning(),
      port: meshServer.getPort(),
      host: meshServer.getHost(),
      ...(!meshServer.isRunning() && { error: 'Failed to start server' })
    }
  })

  ipcMain.handle(IPC.MESH_SERVER_LAN_IPS, async () => {
    return getLanAddresses()
  })

  ipcMain.handle(IPC.MESH_DISCOVERED_RUNTIMES, async () => {
    if (!mdnsService || !directoryFetchCache) return []
    const peers = mdnsService.getDiscoveredRuntimes()
    // Decorate each peer with the current cached agent count so the UI can render
    // "3 agents" without making its own fetch. Freshness comes from the cache's TTL.
    const enriched = await Promise.all(peers.map(async (peer) => {
      const cards = await directoryFetchCache!.fetch(peer.url)
      return { ...peer, agent_count: cards.length }
    }))
    return enriched
  })

  ipcMain.handle(IPC.MESH_SERVER_STOP, async () => {
    console.log('[IPC] MESH_SERVER_STOP called, meshServer exists:', !!meshServer, 'running:', meshServer?.isRunning())
    if (!meshServer) return { success: false, error: 'No mesh server' }
    await stopMdnsAndCleanup()
    await meshServer.stop()
    console.log('[IPC] MESH_SERVER_STOP done, running:', meshServer.isRunning())
    return {
      success: true,
      running: false,
      port: meshServer.getPort(),
      host: meshServer.getHost()
    }
  })

  // --- Background agents ---

  ipcMain.handle(IPC.BACKGROUND_AGENT_START, async (_event, args: { filePath: string }) => {
    if (!backgroundAgentManager) return { success: false, error: 'Background agent manager not initialized' }
    RuntimeGate.resume()
    rememberAdfDirectory(args.filePath)

    if (args.filePath === currentFilePath) {
      return { success: false, error: 'Cannot start background agent for the foreground file' }
    }

    // Review gate: refuse to start an unreviewed agent
    const reviewWorkspace = AdfWorkspace.open(args.filePath)
    try {
      const config = reviewWorkspace.getAgentConfig()
      if (!isConfigReviewed(settings.get('reviewedAgents'), config)) {
        return { success: false, error: 'Agent must be reviewed before starting. Open it in the foreground first.' }
      }
    } finally {
      reviewWorkspace.close()
    }

    // Block startup if password-protected and not yet unlocked
    const cachedKey = derivedKeyCache.get(args.filePath) ?? null
    try {
      const ws = AdfWorkspace.open(args.filePath)
      if (ws.isPasswordProtected() && !cachedKey) {
        ws.close()
        return { success: false, error: 'Agent is password-protected. Open it in the foreground and unlock first.' }
      }
      ws.close()
    } catch (err) {
      return { success: false, error: `Failed to check password status: ${err instanceof Error ? err.message : String(err)}` }
    }

    const success = await backgroundAgentManager.startAgent(args.filePath, cachedKey)
    if (!success) return { success: false, error: 'Failed to start agent' }

    if (meshManager?.isEnabled()) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs) {
        const bgMgr = backgroundAgentManager
        const fp = args.filePath
        meshManager.registerAgent(
          args.filePath, agentRefs.config, agentRefs.toolRegistry,
          agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
          () => bgMgr.getIsMessageTriggered(fp),
          agentRefs.executor,
          agentRefs.adfCallHandler,
          agentRefs.codeSandboxService
        )
        syncDerivedKeyToMesh(args.filePath, cachedKey)
        if (agentRefs.adapterManager) {
          meshManager.setAdapterManager(args.filePath, agentRefs.adapterManager)
        }
      }
    }

    return { success: true }
  })

  ipcMain.handle(IPC.BACKGROUND_AGENT_STATUS, async () => {
    if (!backgroundAgentManager) return { agents: [] }
    return { agents: backgroundAgentManager.getStatuses() }
  })

  ipcMain.handle(IPC.BACKGROUND_AGENT_STOP, async (_event, args: { filePath: string }) => {
    if (!backgroundAgentManager) return { success: false }

    if (meshManager?.isEnabled()) {
      meshManager.unregisterAgent(args.filePath)
    }

    const success = await backgroundAgentManager.stopAgent(args.filePath)
    return { success }
  })

  // --- Directory bulk operations ---

  ipcMain.handle(IPC.DIRECTORY_START_ALL, async (_event, args: { dirPath: string }) => {
    if (!backgroundAgentManager) return { success: false }
    RuntimeGate.resume()
    rememberTrackedDirectory(args.dirPath)

    try {
      const entries = readdirSync(args.dirPath, { withFileTypes: true })
      const adfFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.adf'))
        .map((e) => join(args.dirPath, e.name))

      for (const filePath of adfFiles) {
        rememberAdfDirectory(filePath)
        if (filePath === currentFilePath) continue
        if (backgroundAgentManager.hasAgent(filePath)) continue

        const cachedKey = derivedKeyCache.get(filePath) ?? null
        const success = await backgroundAgentManager.startAgent(filePath, cachedKey)
        if (success && meshManager?.isEnabled()) {
          const agentRefs = backgroundAgentManager.getAgent(filePath)
          if (agentRefs) {
            const bgMgr = backgroundAgentManager
            const fp = filePath
            meshManager.registerAgent(
              filePath, agentRefs.config, agentRefs.toolRegistry,
              agentRefs.workspace, agentRefs.session, agentRefs.triggerEvaluator, false,
              () => bgMgr.getIsMessageTriggered(fp),
              agentRefs.executor,
              agentRefs.adfCallHandler,
              agentRefs.codeSandboxService
            )
            syncDerivedKeyToMesh(filePath, cachedKey)
            if (agentRefs.adapterManager) {
              meshManager.setAdapterManager(filePath, agentRefs.adapterManager)
            }
          }
        }
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.DIRECTORY_STOP_ALL, async (_event, args: { dirPath: string }) => {
    if (!backgroundAgentManager) return { success: false }
    rememberTrackedDirectory(args.dirPath)

    try {
      const entries = readdirSync(args.dirPath, { withFileTypes: true })
      const adfFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.adf'))
        .map((e) => join(args.dirPath, e.name))

      for (const filePath of adfFiles) {
        if (filePath === currentFilePath) continue

        if (meshManager?.isEnabled()) {
          meshManager.unregisterAgent(filePath)
        }

        if (backgroundAgentManager.hasAgent(filePath)) {
          await backgroundAgentManager.stopAgent(filePath)
        }
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- Tools ---

  ipcMain.handle(IPC.TOOLS_DESCRIPTIONS, async () => {
    const t0 = performance.now()
    const definitions: Record<string, unknown> = {}
    for (const tool of toolRegistry.getAll()) {
      definitions[tool.name] = tool.toProviderFormat()
    }
    if (currentAgentToolRegistry) {
      for (const tool of currentAgentToolRegistry.getAll()) {
        if (!definitions[tool.name]) {
          definitions[tool.name] = tool.toProviderFormat()
        }
      }
    }
    // Always ensure runtime-registered tools have definitions (they may not be in the
    // global registry since they require per-agent dependencies)
    if (!definitions['sys_code']) {
      const sysCodeTool = new SysCodeTool(codeSandboxService, '')
      definitions['sys_code'] = sysCodeTool.toProviderFormat()
    }
    if (!definitions['sys_lambda']) {
      // Stub SysLambdaTool for schema display — uses null handler (never executed)
      const sysLambdaTool = new SysLambdaTool(codeSandboxService, null as any, '')
      definitions['sys_lambda'] = sysLambdaTool.toProviderFormat()
    }
    if (!definitions['msg_send']) {
      const sendMessageTool = new SendMessageTool(
        async () => { throw new Error('Not available') },
        () => ({ sendMode: 'respond_only', isMessageTriggered: false })
      )
      definitions['msg_send'] = sendMessageTool.toProviderFormat()
    }
    if (!definitions['agent_discover']) {
      const discoverTool = new AgentDiscoverTool(() => [])
      definitions['agent_discover'] = discoverTool.toProviderFormat()
    }
    if (!definitions['npm_install']) {
      definitions['npm_install'] = new NpmInstallTool(sandboxPackagesService).toProviderFormat()
    }
    if (!definitions['npm_uninstall']) {
      definitions['npm_uninstall'] = new NpmUninstallTool().toProviderFormat()
    }
    if (!definitions['fs_transfer']) {
      const stubCaps = { hasIsolated: false, hasShared: false, hasHost: false, agentId: '' }
      definitions['fs_transfer'] = new FsTransferTool(null, stubCaps).toProviderFormat()
    }
    if (!definitions['mcp_install']) {
      definitions['mcp_install'] = new McpInstallTool().toProviderFormat()
    }
    if (!definitions['mcp_uninstall']) {
      definitions['mcp_uninstall'] = new McpUninstallTool().toProviderFormat()
    }
    if (!definitions['mcp_restart']) {
      definitions['mcp_restart'] = new McpRestartTool().toProviderFormat()
    }
    if (!definitions['compute_exec']) {
      const stubCaps = { hasIsolated: false, hasShared: false, hasHost: false, agentId: '' }
      definitions['compute_exec'] = new ComputeExecTool(null, stubCaps).toProviderFormat()
    }
    if (!definitions['ws_connect']) {
      definitions['ws_connect'] = new WsConnectTool(async () => ({ error: 'Not available' })).toProviderFormat()
    }
    if (!definitions['ws_disconnect']) {
      definitions['ws_disconnect'] = new WsDisconnectTool(async () => ({ success: false })).toProviderFormat()
    }
    if (!definitions['ws_connections']) {
      definitions['ws_connections'] = new WsConnectionsTool(() => []).toProviderFormat()
    }
    if (!definitions['ws_send']) {
      definitions['ws_send'] = new WsSendTool(async () => ({ success: false })).toProviderFormat()
    }
    // Include code-execution-only method schemas (model_invoke, task_resolve, etc.)
    const ceSchemas = AdfCallHandler.getCodeExecutionSchemas()
    for (const [name, schema] of Object.entries(ceSchemas)) {
      if (!definitions[name]) {
        definitions[name] = schema
      }
    }
    console.log(`[PERF] TOOLS_DESCRIPTIONS: ${(performance.now() - t0).toFixed(1)}ms (tools=${Object.keys(definitions).length})`)
    return definitions
  })

  // --- Token Usage ---

  ipcMain.handle(IPC.TOKEN_USAGE_GET, async () => {
    const tokenUsageService = getTokenUsageService()
    return tokenUsageService.getUsageData()
  })

  ipcMain.handle(IPC.TOKEN_USAGE_CLEAR, async () => {
    const tokenUsageService = getTokenUsageService()
    tokenUsageService.clearAll()
    return { success: true }
  })

  ipcMain.handle(IPC.TOKEN_COUNT, async (_event, { text, provider, model }: { text: string; provider?: string; model?: string }) => {
    const tokenCounter = getTokenCounterService()
    const config = currentWorkspace?.getAgentConfig()
    const actualProvider = provider || config?.model?.provider || 'anthropic'
    const actualModel = model || config?.model?.model_id || ''
    return { count: tokenCounter.countTokens(text, actualProvider, actualModel) }
  })

  ipcMain.handle(IPC.TOKEN_COUNT_BATCH, async (_event, { texts, provider, model }: { texts: string[]; provider?: string; model?: string }) => {
    const tokenCounter = getTokenCounterService()
    const config = currentWorkspace?.getAgentConfig()
    const actualProvider = provider || config?.model?.provider || 'anthropic'
    const actualModel = model || config?.model?.model_id || ''

    // Process in chunks and yield to the event loop between them
    // to avoid blocking the main process for seconds with tiktoken WASM
    const CHUNK_SIZE = 10
    const counts: number[] = []
    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, texts.length)
      for (let j = i; j < end; j++) {
        counts.push(tokenCounter.countTokens(texts[j], actualProvider, actualModel))
      }
      // Yield to event loop between chunks so IPC handlers can process
      if (end < texts.length) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    return { counts }
  })

  // --- MCP IPC Argument Schemas ---

  const McpProbeArgs = z.object({
    transport: z.enum(['stdio', 'http']).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    name: z.string().min(1),
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    bearerTokenEnvVar: z.string().optional()
  }).refine((value) => {
    const transport = value.transport ?? 'stdio'
    return transport === 'http' ? !!value.url : !!value.command
  }, { message: 'HTTP probes require url; stdio probes require command.' })
  const McpPackageArgs = z.object({ package: z.string().min(1), name: z.string().min(1) })
  const McpUninstallArgs = z.object({ package: z.string().min(1) })
  const McpNameArgs = z.object({ name: z.string().min(1) })
  const McpCredentialSetArgs = z.object({
    filePath: z.string().min(1),
    npmPackage: z.string().min(1),
    envKey: z.string().min(1),
    value: z.string()
  })
  const McpCredentialGetArgs = z.object({
    filePath: z.string().min(1),
    npmPackage: z.string().min(1)
  })
  const McpCredentialListArgs = z.object({
    mcpServerName: z.string().min(1),
    npmPackage: z.string().min(1)
  })
  const McpAttachArgs = z.object({
    filePath: z.string().min(1),
    serverConfig: z.object({
      name: z.string().min(1),
      type: z.enum(['npm', 'uvx', 'pip', 'custom', 'http']).optional(),
      npmPackage: z.string().optional(),
      pypiPackage: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().url().optional(),
      envKeys: z.array(z.string()).optional(),
      headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      bearerTokenEnvVar: z.string().optional(),
      credentialStorage: z.enum(['app', 'agent']).optional()
    })
  })
  const McpDetachArgs = z.object({
    filePath: z.string().min(1),
    serverName: z.string().min(1),
    credentialNamespace: z.string().min(1)
  })

  /** Validate IPC args against a Zod schema, returning parsed data or an error response. */
  function validateMcpArgs<T>(schema: z.ZodType<T>, args: unknown): { data: T } | { error: string } {
    const result = schema.safeParse(args)
    if (!result.success) return { error: `Invalid arguments: ${result.error.issues.map((i) => i.message).join(', ')}` }
    return { data: result.data }
  }

  // --- MCP Server Probe ---

  ipcMain.handle(IPC.MCP_PROBE_SERVER, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpProbeArgs, rawArgs)
    if ('error' in v) return { success: false, tools: [], error: v.error }
    const args = v.data
    const transport = args.transport ?? 'stdio'

    if (transport === 'http') {
      console.log(`[MCP:probe] "${args.name}": url=${args.url}`)
      const tempManager = new McpClientManager()
      tempManager.on('log', (name, entry) => {
        const cached = mcpLogCache.get(name) ?? []
        cached.push(entry)
        if (cached.length > 500) cached.splice(0, cached.length - 500)
        mcpLogCache.set(name, cached)
      })
      try {
        const tools = await tempManager.connect({
          name: args.name,
          transport: 'http',
          url: args.url,
          env: args.env,
          headers: args.headers,
          header_env: args.headerEnv?.map((entry) => ({ header: entry.key, env: entry.value, required: true })),
          bearer_token_env_var: args.bearerTokenEnvVar
        })
        const serverState = tempManager.getServerState(args.name)
        await tempManager.disconnectAll()
        if (tools) return { success: true, tools }
        return { success: false, tools: [], error: serverState?.error ?? 'Failed to connect' }
      } catch (error) {
        await tempManager.disconnectAll()
        return { success: false, tools: [], error: String(error) }
      }
    }

    // Resolve uvx command to actual uv binary (uvx may not be on PATH inside Electron)
    let probeCommand = args.command!
    let probeArgs = args.args ?? []
    if (probeCommand === 'uvx') {
      try {
        const uvPath = await uvManager.ensureUv()
        probeCommand = uvPath
        probeArgs = ['tool', 'run', ...args.args]
      } catch (e) {
        console.warn('[MCP:probe] Failed to resolve uv binary for uvx command:', e)
      }
    }

    console.log(`[MCP:probe] "${args.name}": command=${probeCommand}, args=${JSON.stringify(probeArgs)}`)
    const tempManager = new McpClientManager()
    // Cache logs from the probe so the Logs panel can show them
    tempManager.on('log', (name, entry) => {
      const cached = mcpLogCache.get(name) ?? []
      cached.push(entry)
      if (cached.length > 500) cached.splice(0, cached.length - 500)
      mcpLogCache.set(name, cached)
    })
    try {
      const tools = await tempManager.connect({
        name: args.name,
        transport: 'stdio',
        command: probeCommand,
        args: probeArgs,
        env: args.env
      })
      const serverState = tempManager.getServerState(args.name)
      await tempManager.disconnectAll()
      if (tools) {
        return { success: true, tools }
      }
      const errorMsg = serverState?.error ?? 'Failed to connect'
      return { success: false, tools: [], error: errorMsg }
    } catch (error) {
      await tempManager.disconnectAll()
      return { success: false, tools: [], error: String(error) }
    }
  })

  // --- MCP Package Management ---

  ipcMain.handle(IPC.MCP_INSTALL_PACKAGE, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpPackageArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    try {
      const win = getMainWindow()
      const installed = await mcpPackageResolver.install(args.package, (message) => {
        win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
          package: args.package,
          status: 'installing',
          progress: message
        })
      })

      win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
        package: args.package,
        status: 'installed'
      })

      return { success: true, installed }
    } catch (error) {
      const win = getMainWindow()
      win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
        package: args.package,
        status: 'error',
        error: String(error)
      })
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MCP_UNINSTALL_PACKAGE, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpUninstallArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    try {
      await mcpPackageResolver.uninstall(args.package)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MCP_LIST_INSTALLED, async () => {
    return { packages: [...mcpPackageResolver.listInstalled(), ...uvxPackageResolver.listInstalled()] }
  })

  // --- Python MCP Package Management ---

  ipcMain.handle(IPC.MCP_INSTALL_PYTHON_PACKAGE, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpPackageArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    try {
      const win = getMainWindow()
      const installed = await uvxPackageResolver.install(args.package, undefined, (message) => {
        win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
          package: args.package,
          status: 'installing',
          progress: message
        })
      })

      win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
        package: args.package,
        status: 'installed'
      })

      return { success: true, installed }
    } catch (error) {
      const win = getMainWindow()
      win?.webContents.send(IPC.MCP_INSTALL_PROGRESS, {
        package: args.package,
        status: 'error',
        error: String(error)
      })
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MCP_UNINSTALL_PYTHON_PACKAGE, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpUninstallArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    try {
      await uvxPackageResolver.uninstall(args.package)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MCP_ENSURE_PYTHON_RUNTIME, async () => {
    try {
      const uvPath = await uvManager.ensureUv()
      const uvVersion = await uvManager.getUvVersion()
      const pythonAvailable = await uvManager.isPythonAvailable()

      if (!pythonAvailable) {
        await uvManager.ensurePython()
      }

      return {
        success: true,
        uvAvailable: true,
        uvVersion,
        pythonAvailable: true,
        uvPath
      }
    } catch (error) {
      return {
        success: false,
        error: String(error),
        uvAvailable: false,
        pythonAvailable: false
      }
    }
  })

  // --- Sandbox Package Management ---

  ipcMain.handle(IPC.SANDBOX_CHECK_MISSING, async (_event, packages: Array<{ name: string; version: string }>) => {
    try {
      const missing = sandboxPackagesService.checkMissing(packages)
      return { success: true, missing }
    } catch (error) {
      return { success: false, error: String(error), missing: packages }
    }
  })

  ipcMain.handle(IPC.SANDBOX_INSTALL_PACKAGES, async (_event, packages: Array<{ name: string; version: string }>) => {
    const win = getMainWindow()
    const results: Record<string, { success: boolean; version?: string; error?: string }> = {}

    for (const pkg of packages) {
      try {
        const result = await sandboxPackagesService.install(pkg.name, pkg.version, (message) => {
          win?.webContents.send(IPC.SANDBOX_INSTALL_PROGRESS, {
            package: pkg.name,
            status: 'installing',
            progress: message
          })
        })

        win?.webContents.send(IPC.SANDBOX_INSTALL_PROGRESS, {
          package: pkg.name,
          status: 'installed'
        })

        results[pkg.name] = { success: true, version: result.version }
      } catch (error) {
        win?.webContents.send(IPC.SANDBOX_INSTALL_PROGRESS, {
          package: pkg.name,
          status: 'error',
          error: String(error)
        })
        results[pkg.name] = { success: false, error: String(error) }
      }
    }

    return { success: true, results }
  })

  ipcMain.handle(IPC.SANDBOX_LIST_INSTALLED, async () => {
    return { packages: sandboxPackagesService.getInstalledPackages() }
  })

  ipcMain.handle(IPC.MCP_GET_SERVER_STATUS, async () => {
    if (!currentMcpManager) return { servers: [] }
    return { servers: currentMcpManager.getServerStates() }
  })

  ipcMain.handle(IPC.MCP_RESTART_SERVER, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpNameArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    if (!currentMcpManager) return { success: false, error: 'No MCP manager active' }
    try {
      const tools = await currentMcpManager.restart(args.name)
      return { success: tools !== null }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.MCP_GET_SERVER_LOGS, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpNameArgs, rawArgs)
    if ('error' in v) return { logs: [] }
    const args = v.data
    // Try live manager first, fall back to cached logs
    const live = currentMcpManager?.getServerLogs(args.name)
    if (live && live.length > 0) return { logs: live }
    return { logs: mcpLogCache.get(args.name) ?? [] }
  })

  // --- MCP Credential Management (multi-ADF) ---

  /**
   * Set a credential for a specific ADF file.
   * Opens the ADF temporarily if it's not the foreground workspace.
   * Credential purpose pattern: mcp:{npmPackage}:{envKey}
   */
  ipcMain.handle(IPC.MCP_CREDENTIAL_SET, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialSetArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    const purpose = `mcp:${args.npmPackage}:${args.envKey}`

    // Check if this is the currently-open foreground workspace
    if (currentWorkspace && currentWorkspace.getFilePath() === args.filePath) {
      if (currentDerivedKey) {
        const { ciphertext, iv } = encrypt(Buffer.from(args.value, 'utf-8'), currentDerivedKey)
        currentWorkspace.getDatabase().setIdentityRaw(
          purpose, ciphertext, 'aes-256-gcm', iv, null
        )
      } else {
        currentWorkspace.setIdentity(purpose, args.value)
      }
      return { success: true }
    }

    // Check background agents
    if (backgroundAgentManager?.hasAgent(args.filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs?.workspace) {
        agentRefs.workspace.setIdentity(purpose, args.value)
        return { success: true }
      }
    }

    // Open temporarily
    let tempWorkspace: AdfWorkspace | null = null
    try {
      tempWorkspace = AdfWorkspace.open(args.filePath)
      tempWorkspace.setIdentity(purpose, args.value)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      tempWorkspace?.close()
    }
  })

  /**
   * Get credentials for a specific ADF file and MCP server.
   * Returns key-value pairs for all mcp:{npmPackage}:* entries.
   */
  ipcMain.handle(IPC.MCP_CREDENTIAL_GET, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialGetArgs, rawArgs)
    if ('error' in v) return { credentials: {} }
    const args = v.data
    const prefix = `mcp:${args.npmPackage}:`
    const readFromWorkspace = (ws: AdfWorkspace, derivedKey: Buffer | null) => {
      const purposes = ws.listIdentityPurposes(prefix)
      const credentials: Record<string, string> = {}
      for (const purpose of purposes) {
        const envKey = purpose.slice(prefix.length)
        const value = ws.getIdentityDecrypted(purpose, derivedKey)
        if (value !== null) {
          credentials[envKey] = value
        }
      }
      return credentials
    }

    // Check foreground workspace
    if (currentWorkspace && currentWorkspace.getFilePath() === args.filePath) {
      return { credentials: readFromWorkspace(currentWorkspace, currentDerivedKey) }
    }

    // Check background agents
    if (backgroundAgentManager?.hasAgent(args.filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs?.workspace) {
        return { credentials: readFromWorkspace(agentRefs.workspace, null) }
      }
    }

    // Open temporarily
    let tempWorkspace: AdfWorkspace | null = null
    try {
      tempWorkspace = AdfWorkspace.open(args.filePath)
      return { credentials: readFromWorkspace(tempWorkspace, null) }
    } catch (error) {
      return { credentials: {}, error: String(error) }
    } finally {
      tempWorkspace?.close()
    }
  })

  /**
   * List all known ADF files (from tracked directories + current foreground)
   * that reference a given MCP server in their agent config.
   * Returns file path, name, and credential status.
   */
  ipcMain.handle(IPC.MCP_CREDENTIAL_LIST_FILES, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialListArgs, rawArgs)
    if ('error' in v) return { files: [] }
    const args = v.data
    const prefix = `mcp:${args.npmPackage}:`
    const results: Array<{
      filePath: string
      fileName: string
      hasCredentials: boolean
      populatedKeys: string[]
    }> = []
    const seen = new Set<string>()

    // Helper: check a single ADF file
    // Include if it has the MCP server in its config OR has stored credentials for it
    const checkFile = (filePath: string) => {
      if (seen.has(filePath)) return
      seen.add(filePath)

      try {
        const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
        const populatedKeys = purposes.map((p) => p.slice(prefix.length))

        // Include if file has stored credentials for this server
        if (populatedKeys.length > 0) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: true,
            populatedKeys
          })
          return
        }

        // Also include if the file references this MCP server in its config (even without creds yet)
        const mcpNames = AdfDatabase.peekMcpServerNames(filePath)
        if (mcpNames.includes(args.mcpServerName)) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: false,
            populatedKeys: []
          })
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Check foreground workspace
    if (currentWorkspace) {
      checkFile(currentWorkspace.getFilePath())
    }

    // Check background agents
    if (backgroundAgentManager) {
      for (const fp of backgroundAgentManager.getAllAgentFilePaths()) {
        checkFile(fp)
      }
    }

    // Scan tracked directories for ADF files
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dir of trackedDirs) {
      try {
        const scanFiles = (dirPath: string, depth: number) => {
          if (depth > 3) return
          const entries = readdirSync(dirPath, { withFileTypes: true })
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.adf')) {
              checkFile(join(dirPath, e.name))
            } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
              scanFiles(join(dirPath, e.name), depth + 1)
            }
          }
        }
        scanFiles(dir, 0)
      } catch {
        // Skip dirs that can't be read
      }
    }

    return { files: results }
  })

  /**
   * Attach an MCP server to an ADF file.
   * Writes a McpServerConfig entry to the ADF's adf_config.mcp.servers[] if not already present.
   */
  ipcMain.handle(IPC.MCP_ATTACH_SERVER, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpAttachArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    const writeConfig = (ws: AdfWorkspace) => {
      const config = ws.getAgentConfig()
      if (!config.mcp) config.mcp = { servers: [] }
      if (!config.mcp.servers) config.mcp.servers = []

      // Already attached?
      if (config.mcp.servers.some((s) => s.name === args.serverConfig.name)) {
        return { success: true, alreadyAttached: true }
      }

      const entry = buildMcpServerConfigFromRegistration({
        id: `mcp:${args.serverConfig.name}`,
        name: args.serverConfig.name,
        type: args.serverConfig.type,
        npmPackage: args.serverConfig.npmPackage,
        pypiPackage: args.serverConfig.pypiPackage,
        command: args.serverConfig.command,
        args: args.serverConfig.args,
        url: args.serverConfig.url,
        env: args.serverConfig.envKeys?.map((key) => ({ key, value: '' })),
        headers: args.serverConfig.headers,
        headerEnv: args.serverConfig.headerEnv,
        bearerTokenEnvVar: args.serverConfig.bearerTokenEnvVar,
        credentialStorage: args.serverConfig.credentialStorage
      })

      config.mcp.servers.push(entry)
      ws.setAgentConfig(config)
      return { success: true, alreadyAttached: false }
    }

    // Check foreground workspace
    if (currentWorkspace && currentWorkspace.getFilePath() === args.filePath) {
      return writeConfig(currentWorkspace)
    }

    // Check background agents
    if (backgroundAgentManager?.hasAgent(args.filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs?.workspace) {
        return writeConfig(agentRefs.workspace)
      }
    }

    // Open temporarily
    let tempWorkspace: AdfWorkspace | null = null
    try {
      tempWorkspace = AdfWorkspace.open(args.filePath)
      return writeConfig(tempWorkspace)
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      tempWorkspace?.close()
    }
  })

  /**
   * Detach an MCP server from an ADF file.
   * Removes the server from adf_config.mcp.servers[] and deletes all mcp:{namespace}:* identity entries.
   */
  ipcMain.handle(IPC.MCP_DETACH_SERVER, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpDetachArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const args = v.data
    const prefix = `mcp:${args.credentialNamespace}:`

    const detachFromWorkspace = (ws: AdfWorkspace) => {
      // Remove from config
      const config = ws.getAgentConfig()
      if (config.mcp?.servers) {
        config.mcp.servers = config.mcp.servers.filter((s) => s.name !== args.serverName)
        ws.setAgentConfig(config)
      }
      // Remove identity entries
      ws.deleteIdentityByPrefix(prefix)
    }

    // Check foreground workspace
    if (currentWorkspace && currentWorkspace.getFilePath() === args.filePath) {
      detachFromWorkspace(currentWorkspace)
      return { success: true }
    }

    // Check background agents
    if (backgroundAgentManager?.hasAgent(args.filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs?.workspace) {
        detachFromWorkspace(agentRefs.workspace)
        return { success: true }
      }
    }

    // Open temporarily
    let tempWorkspace: AdfWorkspace | null = null
    try {
      tempWorkspace = AdfWorkspace.open(args.filePath)
      detachFromWorkspace(tempWorkspace)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      tempWorkspace?.close()
    }
  })

  /**
   * Open a file dialog to pick an ADF file (for adding credentials to).
   * Returns the selected file path or null if cancelled.
   */
  ipcMain.handle(IPC.MCP_PICK_ADF_FILE, async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { filePath: null }
    }
    return { filePath: result.filePaths[0], fileName: basename(result.filePaths[0]) }
  })

  // --- Channel Adapters ---

  ipcMain.handle(IPC.ADAPTER_INSTALL_PACKAGE, async (_event, rawArgs: unknown) => {
    const args = z.object({ package: z.string() }).parse(rawArgs)
    try {
      const win = getMainWindow()
      const installed = await adapterPackageResolver.install(args.package, (msg) => {
        if (win) win.webContents.send(IPC.ADAPTER_INSTALL_PROGRESS, {
          package: args.package, status: 'installing', progress: msg
        })
      })
      if (win) win.webContents.send(IPC.ADAPTER_INSTALL_PROGRESS, {
        package: args.package, status: 'installed'
      })
      return { success: true, installed }
    } catch (error) {
      const win = getMainWindow()
      if (win) win.webContents.send(IPC.ADAPTER_INSTALL_PROGRESS, {
        package: args.package, status: 'error', error: String(error)
      })
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.ADAPTER_UNINSTALL_PACKAGE, async (_event, rawArgs: unknown) => {
    const args = z.object({ package: z.string() }).parse(rawArgs)
    try {
      await adapterPackageResolver.uninstall(args.package)
      // Remove from app settings
      const currentAdapters = (settings.get('adapters') as AdapterRegistration[] | undefined) ?? []
      const filtered = currentAdapters.filter(a => a.npmPackage !== args.package)
      settings.set('adapters', filtered)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.ADAPTER_LIST_INSTALLED, async () => {
    return { packages: adapterPackageResolver.listInstalled() }
  })

  ipcMain.handle(IPC.ADAPTER_GET_STATUS, async () => {
    if (!currentAdapterManager) return { adapters: [] }
    return { adapters: currentAdapterManager.getStates() }
  })

  ipcMain.handle(IPC.ADAPTER_RESTART, async (_event, rawArgs: unknown) => {
    const args = z.object({ type: z.string() }).parse(rawArgs)
    if (!currentAdapterManager) return { success: false, error: 'No adapter manager' }
    const success = await currentAdapterManager.restart(args.type)
    return { success }
  })

  ipcMain.handle(IPC.ADAPTER_GET_LOGS, async (_event, rawArgs: unknown) => {
    const args = z.object({ type: z.string() }).parse(rawArgs)
    if (!currentAdapterManager) return { logs: [] }
    return { logs: currentAdapterManager.getLogs(args.type) }
  })

  ipcMain.handle(IPC.ADAPTER_CREDENTIAL_SET, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      adapterType: z.string(),
      envKey: z.string(),
      value: z.string()
    }).parse(rawArgs)
    try {
      const workspace = AdfWorkspace.open(args.filePath)
      try {
        const purpose = `adapter:${args.adapterType}:${args.envKey}`
        const derivedKey = derivedKeyCache.get(args.filePath) ?? null
        if (derivedKey) {
          const { ciphertext, iv } = encrypt(Buffer.from(args.value, 'utf-8'), derivedKey)
          const kdfParamsJson = workspace.getDatabase().getIdentity('crypto:kdf:params')
          workspace.getDatabase().setIdentityRaw(purpose, ciphertext, 'aes-256-gcm', iv, kdfParamsJson)
        } else {
          workspace.setIdentity(purpose, args.value)
        }
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.ADAPTER_CREDENTIAL_GET, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      adapterType: z.string()
    }).parse(rawArgs)
    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { credentials: {} }
      try {
        const derivedKey = derivedKeyCache.get(args.filePath) ?? null
        const purposes = workspace.listIdentityPurposes(`adapter:${args.adapterType}:`)
        const credentials: Record<string, string> = {}
        for (const purpose of purposes) {
          const key = purpose.replace(`adapter:${args.adapterType}:`, '')
          const val = workspace.getIdentityDecrypted(purpose, derivedKey)
          if (val) credentials[key] = val
        }
        return { credentials }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { credentials: {}, error: String(error) }
    }
  })

  ipcMain.handle(IPC.ADAPTER_CREDENTIAL_LIST_FILES, async (_event, rawArgs: unknown) => {
    const args = z.object({ adapterType: z.string() }).parse(rawArgs)
    const prefix = `adapter:${args.adapterType}:`
    const results: { filePath: string; fileName: string; hasCredentials: boolean; populatedKeys: string[] }[] = []
    const seen = new Set<string>()

    // Helper: check a single ADF file
    const checkFile = (filePath: string) => {
      if (seen.has(filePath)) return
      seen.add(filePath)

      try {
        const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
        const populatedKeys = purposes.map((p) => p.slice(prefix.length))

        // Include if file has stored credentials for this adapter
        if (populatedKeys.length > 0) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: true,
            populatedKeys
          })
          return
        }

        // Also include if the file references this adapter type in its config
        const adapterTypes = AdfDatabase.peekAdapterTypes(filePath)
        if (adapterTypes.includes(args.adapterType)) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: false,
            populatedKeys: []
          })
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Check foreground workspace
    if (currentWorkspace) {
      checkFile(currentWorkspace.getFilePath())
    }

    // Check background agents
    if (backgroundAgentManager) {
      for (const fp of backgroundAgentManager.getAllAgentFilePaths()) {
        checkFile(fp)
      }
    }

    // Scan tracked directories for ADF files (recursive, depth 3)
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dir of trackedDirs) {
      try {
        const scanFiles = (dirPath: string, depth: number) => {
          if (depth > 3) return
          const entries = readdirSync(dirPath, { withFileTypes: true })
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.adf')) {
              checkFile(join(dirPath, e.name))
            } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
              scanFiles(join(dirPath, e.name), depth + 1)
            }
          }
        }
        scanFiles(dir, 0)
      } catch {
        // Skip dirs that can't be read
      }
    }

    return { files: results }
  })

  ipcMain.handle(IPC.ADAPTER_ATTACH, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      adapterType: z.string(),
      config: z.object({
        enabled: z.boolean(),
        credential_key: z.string().optional(),
        policy: z.object({
          dm: z.enum(['all', 'allowlist', 'none']).optional(),
          groups: z.enum(['all', 'mention', 'none']).optional(),
          allow_from: z.array(z.string()).optional()
        }).optional(),
        limits: z.object({
          max_attachment_size: z.number().int().positive().optional()
        }).optional()
      })
    }).parse(rawArgs)

    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { success: false, error: 'Cannot open file' }
      try {
        const agentConfig = workspace.getAgentConfig()
        const adapters = agentConfig.adapters ?? {}
        if (adapters[args.adapterType]) {
          return { success: true, alreadyAttached: true }
        }
        adapters[args.adapterType] = args.config
        agentConfig.adapters = adapters
        workspace.setAgentConfig(agentConfig)
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.ADAPTER_DETACH, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      adapterType: z.string()
    }).parse(rawArgs)

    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { success: false, error: 'Cannot open file' }
      try {
        const agentConfig = workspace.getAgentConfig()
        if (agentConfig.adapters) {
          delete agentConfig.adapters[args.adapterType]
          if (Object.keys(agentConfig.adapters).length === 0) {
            delete agentConfig.adapters
          }
          workspace.setAgentConfig(agentConfig)
        }
        // Remove credentials
        workspace.deleteIdentityByPrefix(`adapter:${args.adapterType}:`)
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- Provider Credentials (per-ADF) ---

  ipcMain.handle(IPC.PROVIDER_CREDENTIAL_SET, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      providerId: z.string(),
      value: z.string()
    }).parse(rawArgs)
    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { success: false, error: 'Cannot open file' }
      try {
        const purpose = `provider:${args.providerId}:apiKey`
        const derivedKey = derivedKeyCache.get(args.filePath) ?? null
        if (derivedKey) {
          const { ciphertext, iv } = encrypt(Buffer.from(args.value, 'utf-8'), derivedKey)
          const kdfParamsJson = workspace.getDatabase().getIdentity('crypto:kdf:params')
          workspace.getDatabase().setIdentityRaw(purpose, ciphertext, 'aes-256-gcm', iv, kdfParamsJson)
        } else {
          workspace.setIdentity(purpose, args.value)
        }
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.PROVIDER_CREDENTIAL_GET, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      providerId: z.string()
    }).parse(rawArgs)
    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { credentials: {} }
      try {
        const derivedKey = derivedKeyCache.get(args.filePath) ?? null
        const purposes = workspace.listIdentityPurposes(`provider:${args.providerId}:`)
        const credentials: Record<string, string> = {}
        for (const purpose of purposes) {
          const key = purpose.replace(`provider:${args.providerId}:`, '')
          const val = workspace.getIdentityDecrypted(purpose, derivedKey)
          if (val) credentials[key] = val
        }
        // Also return the provider config stored on this ADF
        const agentConfig = workspace.getAgentConfig()
        const adfProv = agentConfig.providers?.find(p => p.id === args.providerId)
        return {
          credentials,
          providerConfig: adfProv ? {
            defaultModel: adfProv.defaultModel,
            params: adfProv.params,
            requestDelayMs: adfProv.requestDelayMs
          } : undefined
        }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { credentials: {}, error: String(error) }
    }
  })

  ipcMain.handle(IPC.PROVIDER_CREDENTIAL_LIST_FILES, async (_event, rawArgs: unknown) => {
    const args = z.object({ providerId: z.string() }).parse(rawArgs)
    const prefix = `provider:${args.providerId}:`
    const results: { filePath: string; fileName: string; hasCredentials: boolean; populatedKeys: string[] }[] = []
    const seen = new Set<string>()

    const checkFile = (filePath: string) => {
      if (seen.has(filePath)) return
      seen.add(filePath)

      try {
        const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
        const populatedKeys = purposes.map((p) => p.slice(prefix.length))

        if (populatedKeys.length > 0) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: true,
            populatedKeys
          })
          return
        }

        // Also include if the file references this provider in its config
        const providerIds = AdfDatabase.peekProviderIds(filePath)
        if (providerIds.includes(args.providerId)) {
          results.push({
            filePath,
            fileName: basename(filePath),
            hasCredentials: false,
            populatedKeys: []
          })
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Check foreground workspace
    if (currentWorkspace) {
      checkFile(currentWorkspace.getFilePath())
    }

    // Check background agents
    if (backgroundAgentManager) {
      for (const fp of backgroundAgentManager.getAllAgentFilePaths()) {
        checkFile(fp)
      }
    }

    // Scan tracked directories for ADF files (recursive, depth 3)
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dir of trackedDirs) {
      try {
        const scanFiles = (dirPath: string, depth: number) => {
          if (depth > 3) return
          const entries = readdirSync(dirPath, { withFileTypes: true })
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.adf')) {
              checkFile(join(dirPath, e.name))
            } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
              scanFiles(join(dirPath, e.name), depth + 1)
            }
          }
        }
        scanFiles(dir, 0)
      } catch {
        // Skip dirs that can't be read
      }
    }

    return { files: results }
  })

  ipcMain.handle(IPC.PROVIDER_ATTACH, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      provider: z.object({
        id: z.string().min(1),
        type: z.enum(['anthropic', 'openai', 'openai-compatible']),
        name: z.string(),
        baseUrl: z.string(),
        defaultModel: z.string().optional(),
        params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        requestDelayMs: z.number().optional()
      })
    }).parse(rawArgs)

    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { success: false, error: 'Cannot open file' }
      try {
        const agentConfig = workspace.getAgentConfig()
        const providers = agentConfig.providers ?? []
        const existingIdx = providers.findIndex(p => p.id === args.provider.id)
        if (existingIdx >= 0) {
          providers[existingIdx] = { ...providers[existingIdx], ...args.provider }
          agentConfig.providers = providers
          workspace.setAgentConfig(agentConfig)
          return { success: true, alreadyAttached: true }
        }
        providers.push(args.provider)
        agentConfig.providers = providers
        workspace.setAgentConfig(agentConfig)
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.PROVIDER_DETACH, async (_event, rawArgs: unknown) => {
    const args = z.object({
      filePath: z.string(),
      providerId: z.string()
    }).parse(rawArgs)

    try {
      const workspace = args.filePath === currentFilePath ? currentWorkspace : AdfWorkspace.open(args.filePath)
      if (!workspace) return { success: false, error: 'Cannot open file' }
      try {
        const agentConfig = workspace.getAgentConfig()
        if (agentConfig.providers) {
          agentConfig.providers = agentConfig.providers.filter(p => p.id !== args.providerId)
          if (agentConfig.providers.length === 0) {
            delete agentConfig.providers
          }
          workspace.setAgentConfig(agentConfig)
        }
        // Remove credentials
        workspace.deleteIdentityByPrefix(`provider:${args.providerId}:`)
        return { success: true }
      } finally {
        if (args.filePath !== currentFilePath) workspace.close()
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- Identity / Keystore ---

  ipcMain.handle(IPC.IDENTITY_SET, async (_event, args: { purpose: string; value: string }) => {
    if (!currentWorkspace) return { error: 'No ADF open' }
    if (currentDerivedKey) {
      const { ciphertext, iv } = encrypt(Buffer.from(args.value, 'utf-8'), currentDerivedKey)
      const kdfParamsJson = currentWorkspace.getDatabase().getIdentity('crypto:kdf:params')
      currentWorkspace.getDatabase().setIdentityRaw(
        args.purpose, ciphertext, 'aes-256-gcm', iv, kdfParamsJson
      )
    } else {
      currentWorkspace.setIdentity(args.purpose, args.value)
    }
  })

  ipcMain.handle(IPC.IDENTITY_GET, async (_event, args: { purpose: string }) => {
    if (!currentWorkspace) return null
    return currentWorkspace.getIdentityDecrypted(args.purpose, currentDerivedKey)
  })

  ipcMain.handle(IPC.IDENTITY_DELETE, async (_event, args: { purpose: string }) => {
    if (!currentWorkspace) return
    currentWorkspace.deleteIdentity(args.purpose)
  })

  ipcMain.handle(IPC.IDENTITY_DELETE_PREFIX, async (_event, args: { prefix: string }) => {
    if (!currentWorkspace) return 0
    return currentWorkspace.deleteIdentityByPrefix(args.prefix)
  })

  ipcMain.handle(IPC.IDENTITY_LIST, async (_event, args: { prefix?: string }) => {
    if (!currentWorkspace) return []
    return currentWorkspace.listIdentityPurposes(args.prefix)
  })

  // --- Identity Password & Encryption ---

  ipcMain.handle(IPC.IDENTITY_PASSWORD_CHECK, async () => {
    if (!currentWorkspace) return { needsPassword: false }
    return { needsPassword: currentWorkspace.isPasswordProtected() }
  })

  ipcMain.handle(IPC.IDENTITY_PASSWORD_UNLOCK, async (_event, args: { password: string }) => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    try {
      currentDerivedKey = currentWorkspace.unlockWithPassword(args.password)
      derivedKeyCache.set(currentFilePath, currentDerivedKey)
      syncDerivedKeyToMesh(currentFilePath, currentDerivedKey)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IDENTITY_PASSWORD_UNLOCK] Failed:', msg)
      // GCM auth tag failures surface as "Unsupported state or unable to authenticate data"
      const isWrongPassword = msg.includes('authenticate data') || msg.includes('auth')
      return { success: false, error: isWrongPassword ? 'Wrong password' : msg }
    }
  })

  ipcMain.handle(IPC.IDENTITY_PASSWORD_SET, async (_event, args: { password: string }) => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    try {
      currentDerivedKey = currentWorkspace.setPassword(args.password)
      derivedKeyCache.set(currentFilePath, currentDerivedKey)
      syncDerivedKeyToMesh(currentFilePath, currentDerivedKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_PASSWORD_REMOVE, async () => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    if (!currentDerivedKey) return { success: false, error: 'Not unlocked' }
    try {
      currentWorkspace.removePassword(currentDerivedKey)
      currentDerivedKey = null
      derivedKeyCache.delete(currentFilePath)
      syncDerivedKeyToMesh(currentFilePath, null)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_PASSWORD_CHANGE, async (_event, args: { newPassword: string }) => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    if (!currentDerivedKey) return { success: false, error: 'Not unlocked' }
    try {
      currentDerivedKey = currentWorkspace.changePassword(currentDerivedKey, args.newPassword)
      derivedKeyCache.set(currentFilePath, currentDerivedKey)
      syncDerivedKeyToMesh(currentFilePath, currentDerivedKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_LIST_ENTRIES, async () => {
    if (!currentWorkspace) return { entries: [] }
    return { entries: currentWorkspace.listIdentityEntries() }
  })

  ipcMain.handle(IPC.IDENTITY_SET_CODE_ACCESS, async (_event, args: { purpose: string; codeAccess: boolean }) => {
    if (!currentWorkspace) return { success: false }
    return { success: currentWorkspace.setIdentityCodeAccess(args.purpose, args.codeAccess) }
  })

  ipcMain.handle(IPC.IDENTITY_REVEAL, async (_event, args: { purpose: string }) => {
    if (!currentWorkspace) return { value: null }
    return { value: currentWorkspace.getIdentityDecrypted(args.purpose, currentDerivedKey) }
  })

  ipcMain.handle(IPC.IDENTITY_WIPE_ALL, async () => {
    if (!currentWorkspace || !currentFilePath) return { success: false }
    currentWorkspace.wipeAllIdentity()
    currentDerivedKey = null
    derivedKeyCache.delete(currentFilePath)
    syncDerivedKeyToMesh(currentFilePath, null)
    return { success: true }
  })

  ipcMain.handle(IPC.IDENTITY_GET_DID, async () => {
    if (!currentWorkspace) return { did: null }
    return { did: currentWorkspace.getDid() }
  })

  ipcMain.handle(IPC.IDENTITY_GENERATE_KEYS, async () => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    try {
      const result = currentWorkspace.generateIdentityKeys(currentDerivedKey)
      return { success: true, did: result.did }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_CLAIM, async () => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    try {
      // If password-protected, decrypt everything first, then remove password
      if (currentWorkspace.isPasswordProtected() && currentDerivedKey) {
        currentWorkspace.removePassword(currentDerivedKey)
        currentDerivedKey = null
        derivedKeyCache.delete(currentFilePath)
      }
      // Wipe old identity keys and regenerate
      const db = currentWorkspace.getDatabase()
      // Delete only crypto keys, keep other identity entries (API keys etc.)
      db.deleteIdentity('crypto:signing:private_key')
      db.deleteIdentity('crypto:signing:public_key')
      // Generate new keys
      const result = currentWorkspace.generateIdentityKeys(null)
      // Stamp new owner
      const claimIdentity = settings.ensureRuntimeIdentity()
      db.setMeta('adf_owner_did', claimIdentity.ownerDid)
      db.setMeta('adf_runtime_did', claimIdentity.runtimeDid)
      return { success: true, did: result.did }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // --- ChatGPT Subscription Auth ---

  ipcMain.handle(IPC.CHATGPT_AUTH_START, async () => {
    try {
      const { getChatGptAuthManager } = await import('../providers/chatgpt-subscription/auth-manager')
      const authManager = getChatGptAuthManager()
      await authManager.startAuthFlow()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.CHATGPT_AUTH_STATUS, async () => {
    try {
      const { getChatGptAuthManager } = await import('../providers/chatgpt-subscription/auth-manager')
      const authManager = getChatGptAuthManager()
      return authManager.getAuthStatus()
    } catch {
      return { authenticated: false }
    }
  })

  ipcMain.handle(IPC.CHATGPT_AUTH_LOGOUT, async () => {
    try {
      const { getChatGptAuthManager } = await import('../providers/chatgpt-subscription/auth-manager')
      const authManager = getChatGptAuthManager()
      authManager.logout()
      return { success: true }
    } catch {
      return { success: true }
    }
  })

  // --- Emergency Stop ---

  ipcMain.handle(IPC.EMERGENCY_STOP, async () => {
    console.log('[EmergencyStop] Shutting down everything...')
    // Each step is independently try-caught so a failure in one (e.g. corrupt DB)
    // never prevents subsequent steps from running. Shutdown MUST complete.

    // Flip the global gate FIRST so any in-flight microtasks (queued 'trigger'
    // listeners, pending executeTurn calls, mid-tick checkTimers) noop instead
    // of leaking past the kill switch. Resume() runs on the next deliberate start.
    RuntimeGate.stop()

    try { if (meshManager?.isEnabled()) meshManager.disableMesh() }
    catch (e) { console.error('[EmergencyStop] mesh disable error:', e) }

    try { if (triggerEvaluator) { triggerEvaluator.dispose(); triggerEvaluator = null } }
    catch (e) { console.error('[EmergencyStop] trigger dispose error:', e) }

    try { if (agentExecutor) { agentExecutor.abort(); agentExecutor = null } }
    catch (e) { console.error('[EmergencyStop] foreground abort error:', e); agentExecutor = null }

    try { if (backgroundAgentManager) await backgroundAgentManager.stopAll() }
    catch (e) { console.error('[EmergencyStop] background stop error:', e) }

    try { if (currentFilePath) codeSandboxService.destroy(currentFilePath) }
    catch (e) { console.error('[EmergencyStop] sandbox destroy error:', e) }

    currentSession = null
    currentAgentToolRegistry = null

    try { if (currentMcpManager) { await currentMcpManager.disconnectAll(); currentMcpManager = null } }
    catch (e) { console.error('[EmergencyStop] MCP disconnect error:', e); currentMcpManager = null }

    try { if (currentAdapterManager) { await currentAdapterManager.stopAll(); currentAdapterManager = null } }
    catch (e) { console.error('[EmergencyStop] adapter stop error:', e); currentAdapterManager = null }

    try { await stopMdnsAndCleanup() }
    catch (e) { console.error('[EmergencyStop] mDNS stop error:', e) }

    try { if (meshServer) { await meshServer.stop(); meshServer = null } }
    catch (e) { console.error('[EmergencyStop] mesh server stop error:', e); meshServer = null }

    console.log('[EmergencyStop] All agents stopped, mesh disabled.')
    return { success: true }
  })

  // =========================================================================
  // Compute environment
  // =========================================================================

  ipcMain.handle(IPC.COMPUTE_STATUS, async () => {
    return podmanService.getStatus()
  })

  ipcMain.handle(IPC.COMPUTE_INIT, async () => {
    try {
      await podmanService.ensureRunning()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.COMPUTE_STOP, async () => {
    try {
      await podmanService.stop()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.COMPUTE_DESTROY, async () => {
    try {
      await podmanService.destroy()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.COMPUTE_LIST_CONTAINERS, async () => {
    return { containers: await podmanService.listContainers() }
  })

  ipcMain.handle(IPC.COMPUTE_STOP_CONTAINER, async (_event, args: { name: string }) => {
    const bin = await podmanService.findPodman()
    if (!bin) return { success: false, error: 'Podman not found' }
    const { execFile } = await import('child_process')
    return new Promise((resolve) => {
      execFile(bin, ['stop', '-t', '5', args.name], { timeout: 30_000 }, (err) => {
        resolve({ success: !err })
      })
    })
  })

  ipcMain.handle(IPC.COMPUTE_START_CONTAINER, async (_event, args: { name: string }) => {
    const bin = await podmanService.findPodman()
    if (!bin) return { success: false, error: 'Podman not found' }
    const { execFile } = await import('child_process')
    return new Promise((resolve) => {
      execFile(bin, ['start', args.name], { timeout: 30_000 }, (err) => {
        resolve({ success: !err })
      })
    })
  })

  ipcMain.handle(IPC.COMPUTE_DESTROY_CONTAINER, async (_event, args: { name: string }) => {
    const bin = await podmanService.findPodman()
    if (!bin) return { success: false, error: 'Podman not found' }
    const { execFile } = await import('child_process')
    return new Promise((resolve) => {
      execFile(bin, ['rm', '-f', args.name], { timeout: 30_000 }, (err) => {
        resolve({ success: !err })
      })
    })
  })

  ipcMain.handle(IPC.COMPUTE_CONTAINER_DETAIL, async (_event, args: { name: string }) => {
    try {
      const detail = await podmanService.getContainerDetail(args.name)
      return { success: true, ...detail }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.COMPUTE_EXEC_LOG, async (_event, args: { name?: string }) => {
    return { entries: podmanService.getExecLog(args.name) }
  })

  ipcMain.handle(IPC.COMPUTE_SETUP, async (_event, args: { step: 'install' | 'machine_init' | 'machine_start' | 'check'; installCommand?: string }) => {
    const { checkPodmanAvailability } = await import('../services/podman-bootstrap')
    const { execFile } = await import('child_process')

    const run = (cmd: string, cmdArgs: string[], timeout = 300_000): Promise<{ stdout: string; stderr: string; code: number }> =>
      new Promise((resolve) => {
        execFile(cmd, cmdArgs, { timeout }, (error, stdout, stderr) => {
          resolve({ stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '', code: error ? 1 : 0 })
        })
      })

    const explainMachineError = (op: 'init' | 'start', stderr: string): string => {
      // wsl.exe outputs UTF-16; Node reads it as UTF-8 with interleaved null bytes.
      const normalized = stderr.replace(/\u0000/g, '')
      if (process.platform === 'win32' && /Windows Subsystem for Linux is not installed/i.test(normalized)) {
        return 'WSL is required but not installed. Run `wsl --install` in an admin terminal, reboot, then retry.'
      }
      return normalized.trim() || `podman machine ${op} failed`
    }

    try {
      if (args.step === 'check') {
        return { success: true, availability: await checkPodmanAvailability() }
      }

      if (args.step === 'install') {
        // Parse the install command from the availability info
        const cmdStr = args.installCommand
        if (!cmdStr) return { success: false, error: 'No install command provided' }

        // Split command string: handle "brew install podman", "winget install -e --id RedHat.Podman", etc.
        const parts = cmdStr.split(/\s+/).filter(Boolean)
        // Skip 'sudo' — we can't run sudo from Electron
        const startIdx = parts[0] === 'sudo' ? 1 : 0
        const cmd = parts[startIdx]
        const cmdArgs = parts.slice(startIdx + 1)

        console.log(`[Compute] Running: ${cmd} ${cmdArgs.join(' ')}`)
        const result = await run(cmd, cmdArgs)
        if (result.code !== 0) {
          return { success: false, error: result.stderr || `${cmd} failed` }
        }
        console.log('[Compute] Podman installed successfully')
        return { success: true, availability: await checkPodmanAvailability() }
      }

      if (args.step === 'machine_init') {
        const info = await checkPodmanAvailability()
        if (!info.binPath) return { success: false, error: 'Podman not installed' }
        const missingPrereq = info.prerequisites.find((p) => !p.installed)
        if (missingPrereq) {
          return { success: false, error: `Missing prerequisite: ${missingPrereq.name}. Run \`${missingPrereq.installCommand}\` first.`, availability: info }
        }
        console.log('[Compute] Initializing Podman machine...')
        const result = await run(info.binPath, ['machine', 'init', '--memory', '2048', '--cpus', '2'], 300_000)
        if (result.code !== 0) {
          // "already exists" is fine — means a previous init succeeded
          if (!result.stderr.includes('already exists')) {
            return { success: false, error: explainMachineError('init', result.stderr), availability: await checkPodmanAvailability() }
          }
        }
        console.log('[Compute] Podman machine initialized')
        return { success: true, availability: await checkPodmanAvailability() }
      }

      if (args.step === 'machine_start') {
        const info = await checkPodmanAvailability()
        if (!info.binPath) return { success: false, error: 'Podman not installed' }
        const missingPrereq = info.prerequisites.find((p) => !p.installed)
        if (missingPrereq) {
          return { success: false, error: `Missing prerequisite: ${missingPrereq.name}. Run \`${missingPrereq.installCommand}\` first.`, availability: info }
        }
        console.log('[Compute] Starting Podman machine...')
        const result = await run(info.binPath, ['machine', 'start'], 120_000)
        if (result.code !== 0) {
          if (!result.stderr.includes('already running')) {
            return { success: false, error: explainMachineError('start', result.stderr), availability: await checkPodmanAvailability() }
          }
        }
        console.log('[Compute] Podman machine started')
        return { success: true, availability: await checkPodmanAvailability() }
      }

      return { success: false, error: `Unknown step: ${args.step}` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * Gracefully clean up all running processes. Called from app before-quit.
 */
export async function cleanupAllProcesses(): Promise<void> {
  console.log('[Cleanup] App quitting — cleaning up all processes...')
  // Each step is independently try-caught so a corrupt DB never prevents shutdown.
  const trackedCleanupDirs = new Set<string>()
  try {
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dirPath of trackedDirs) {
      const normalized = resolve(dirPath)
      trackedCleanupDirs.add(normalized)
      rememberTrackedDirectory(normalized)
    }
  } catch { /* ignore */ }

  try { if (currentMcpManager) { await currentMcpManager.disconnectAll(); currentMcpManager = null } }
  catch (e) { console.error('[Cleanup] MCP disconnect error:', e); currentMcpManager = null }

  try { if (agentExecutor) { agentExecutor.abort(); agentExecutor = null } }
  catch (e) { console.error('[Cleanup] foreground abort error:', e); agentExecutor = null }

  try { if (triggerEvaluator) { triggerEvaluator.dispose(); triggerEvaluator = null } }
  catch (e) { console.error('[Cleanup] trigger dispose error:', e); triggerEvaluator = null }

  // Collect background agent directories before stopAll clears the map
  try { if (backgroundAgentManager) for (const fp of backgroundAgentManager.getAllAgentFilePaths()) rememberAdfDirectory(fp) }
  catch { /* ignore */ }

  try { if (backgroundAgentManager) await backgroundAgentManager.stopAll() }
  catch (e) { console.error('[Cleanup] background stop error:', e) }

  try { if (wsConnectionManager) { wsConnectionManager.stopAll(); wsConnectionManager = null } }
  catch (e) { console.error('[Cleanup] WS connection manager error:', e); wsConnectionManager = null }

  try { await stopMdnsAndCleanup() }
  catch (e) { console.error('[Cleanup] mDNS stop error:', e) }

  try { if (meshManager?.isEnabled()) meshManager.disableMesh() }
  catch (e) { console.error('[Cleanup] mesh disable error:', e) }

  try { if (currentAdapterManager) { await currentAdapterManager.stopAll(); currentAdapterManager = null } }
  catch (e) { console.error('[Cleanup] adapter stop error:', e); currentAdapterManager = null }

  try { if (meshServer) { await meshServer.stop(); meshServer = null } }
  catch (e) { console.error('[Cleanup] mesh server stop error:', e); meshServer = null }

  // Checkpoint + close the foreground workspace before sweeping closed WAL sidecars.
  if (currentFilePath) rememberAdfDirectory(currentFilePath)
  try { if (currentWorkspace) { currentWorkspace.close(); currentWorkspace = null } }
  catch (e) { console.error('[Cleanup] foreground workspace close error:', e); currentWorkspace = null }

  // Sweep exact directories we opened an .adf from.
  for (const dir of openedAdfDirs) {
    try { AdfDatabase.cleanupOrphanedWalFiles(dir) }
    catch (e) { console.error(`[Cleanup] WAL file cleanup error in ${dir}:`, e) }
  }

  // Sweep tracked directory trees because sidebar scans can include nested ADFs.
  const maxWalCleanupDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5
  for (const dir of trackedCleanupDirs) {
    try { cleanupWalFilesRecursive(dir, maxWalCleanupDepth) }
    catch (e) { console.error(`[Cleanup] recursive WAL file cleanup error in ${dir}:`, e) }
  }

  // Stop all compute containers (shared + isolated)
  try { await podmanService.stopAll() }
  catch (e) { console.error('[Cleanup] Podman stop error:', e) }

  // Purge all scratch directories as a safety net
  purgeAllScratchDirs()

  console.log('[Cleanup] All processes cleaned up.')
}

/** Expose the active workspace for the adf-file:// protocol handler. */
export function getCurrentWorkspace(): AdfWorkspace | null {
  return currentWorkspace
}
