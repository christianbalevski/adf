import { z } from 'zod'
import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync, renameSync, copyFileSync, writeFileSync, mkdirSync, type Dirent } from 'fs'
import { join, dirname, basename, resolve, relative } from 'path'
import { networkInterfaces, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { canonicalizePath, containsPath, isSameOrSubPath, dedupeTrackedDirectories } from '../utils/tracked-paths'
import { initApplicationMenu, recordRecentFile } from '../menu'
import { verifyCardSignature } from '../services/mesh-server'
import { verifyAttestation } from '../services/attestation.service'
import { BackgroundEventBatcher } from './background-event-batch'

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
/**
 * Per-session cache of provider connection test results.
 * Keyed by a snapshot of fields that materially affect the test
 * (type/baseUrl/apiKey-presence). Cleared on app restart only.
 * Used by the home dashboard so revisiting the home screen doesn't
 * re-hit `/models` for every provider every time.
 */
const providerTestSessionCache = new Map<string, 'ok' | 'failed' | 'unconfigured'>()

function providerTestCacheKey(cfg: ProviderConfig): string {
  // `id` alone isn't enough — the same provider id may have its key
  // rotated mid-session. Include the credentials so edits bust the cache.
  return `${cfg.id}::${cfg.type}::${cfg.baseUrl ?? ''}::${cfg.apiKey ? 'k' : '-'}`
}

async function testProviderCredentialsForDashboard(
  cfg: ProviderConfig,
  force = false
): Promise<'ok' | 'failed' | 'unconfigured'> {
  const cacheKey = providerTestCacheKey(cfg)
  if (force) providerTestSessionCache.delete(cacheKey)
  const cached = providerTestSessionCache.get(cacheKey)
  if (cached) return cached

  const finish = (result: 'ok' | 'failed' | 'unconfigured') => {
    providerTestSessionCache.set(cacheKey, result)
    return result
  }

  if (cfg.type === 'chatgpt-subscription') {
    // No /models endpoint we can hit cheaply — treat session-auth presence as "ok".
    return finish(getChatGptAuthManager().isAuthenticated() ? 'ok' : 'unconfigured')
  }

  if (cfg.type === 'grok-subscription') {
    const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
    return finish(getGrokAuthManager().isAuthenticated() ? 'ok' : 'unconfigured')
  }

  if (cfg.type === 'anthropic') {
    if (!cfg.apiKey) return finish('unconfigured')
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(5000),
      })
      return finish(response.ok ? 'ok' : 'failed')
    } catch {
      return finish('failed')
    }
  }

  if (cfg.type === 'openrouter') {
    if (!cfg.apiKey) return finish('unconfigured')
    try {
      const url = (cfg.baseUrl?.replace(/\/+$/, '') || 'https://openrouter.ai/api/v1') + '/models'
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(5000),
      })
      return finish(response.ok ? 'ok' : 'failed')
    } catch {
      return finish('failed')
    }
  }

  // openai + openai-compatible — both use /models with Bearer.
  // openai requires a key; openai-compatible may omit one (local proxies).
  if (cfg.type === 'openai' && !cfg.apiKey) return finish('unconfigured')
  if (cfg.type === 'openai-compatible' && !cfg.baseUrl) return finish('unconfigured')

  try {
    const baseUrl = cfg.type === 'openai' ? 'https://api.openai.com/v1' : cfg.baseUrl
    const url = baseUrl.replace(/\/+$/, '') + '/models'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    return finish(response.ok ? 'ok' : 'failed')
  } catch {
    return finish('failed')
  }
}

import chokidar from 'chokidar'
import { IPC } from '../../shared/constants/ipc-channels'
import { AdfWorkspace } from '../adf/adf-workspace'
import { setWorkspaceIdentityHooks, unlockWorkspaceEnvelopes } from '../runtime/identity-provisioner'
import { AdfDatabase } from '../adf/adf-database'
import { applyDefaultProviderToOptions, resolveDefaultProvider } from '../adf/apply-default-provider'
import { AgentExecutor } from '../runtime/agent-executor'
import { AgentSession } from '../runtime/agent-session'
import { TriggerEvaluator } from '../runtime/trigger-evaluator'
import { withSource } from '../runtime/execution-context'
import { assembleAgent, type AgentHostBindings, type AssembledAgent, type HostAttachment } from '../runtime/assemble-agent'
import type { AgentProfileName } from '../runtime/agent-capability-profiles'
import { RuntimeGate } from '../runtime/runtime-gate'
import { MeshManager } from '../runtime/mesh-manager'
import { BackgroundAgentManager, toDisplayState } from '../runtime/background-agent-manager'
import { deriveHandle } from '../utils/handle'
import type { AgentState, FleetPendingInteraction, FleetAgentStatus, FleetStatusResult, FleetMessageResult, FleetStateResult, FleetSettableState } from '../../shared/types/ipc.types'
import { createProvider } from '../providers/provider-factory'
import { seedMandatoryReasoningModels, setMandatoryReasoningPersister } from '../providers/ai-sdk-provider'
import { ToolRegistry } from '../tools/tool-registry'
import { SendMessageTool, AgentDiscoverTool, SysCodeTool, SysLambdaTool, SysGetConfigTool, SysUpdateConfigTool, SysFetchTool, CreateAdfTool, NpmInstallTool, NpmUninstallTool, FsTransferTool, ComputeExecTool, McpInstallTool, McpUninstallTool, McpRestartTool, WsConnectTool, WsDisconnectTool, WsConnectionsTool, WsSendTool, StreamBindTool, StreamUnbindTool, StreamBindingsTool, buildToolDiscovery, type McpConnectOutcome } from '../tools/built-in'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import { StreamBindingManager } from '../runtime/stream-binding-manager'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import { AdfCallHandler } from '../runtime/adf-call-handler'
import { createUmbilicalResources } from '../runtime/umbilical-lifecycle'
import type { TapManager } from '../runtime/tap-manager'
import { SystemScopeHandler } from '../runtime/system-scope-handler'
import { CodeSandboxService } from '../runtime/code-sandbox'
import { SettingsService } from '../services/settings.service'
import { issueOwnerAttestation, readAdfAttestations, verifyAttestation } from '../services/attestation.service'
import { MeshServer } from '../services/mesh-server'
import { MdnsService, type DiscoveredRuntime } from '../services/mdns-service'
import { DirectoryFetchCache } from '../services/directory-fetch-cache'
import { getOrCreateRuntimeId } from '../utils/runtime-id'
import { TailnetDiscovery } from '../services/tailnet-discovery'
import { McpClientManager } from '../services/mcp-client-manager'
import { McpRegistryFetchService } from '../services/mcp-registry-fetch.service'
import { parseSkillsCatalogDocument, MAX_CATALOG_BYTES, MAX_SKILL_PACKAGE_BYTES } from '../../shared/schemas/skills-catalog.schema'
import { applySkillsConfigChange } from '../adf/skill-indexer'
import { guardedFetch } from '../utils/guarded-fetch'
import { createScratchDir, removeScratchDir, purgeAllScratchDirs } from '../utils/scratch-dir'
import { killAllTracked } from '../utils/child-registry'
import { runMcpAuthPreflight, type McpAuthPreflightRunner } from '../services/mcp-auth-preflight'
import { materializeCredentialFiles, writeBackCredentialFiles, containerCredentialTarget, expandCredentialPath, CREDENTIAL_FILE_MAX_BYTES, type CredentialFileTarget } from '../services/mcp-credential-files'
import { AppSettingsOAuthStore, AgentKeystoreOAuthStore, resolveOAuthStoreForConnect, captureOAuthToAgent } from '../services/mcp-oauth-store'
import { buildOAuthProviderFactory, gateInteractiveOAuthSignIn } from '../services/mcp-oauth-connect'
import { runMcpHttpOAuthFlow, type McpHttpOAuthIO } from '../services/mcp-http-oauth'
import { mapWithConcurrency, withDeadline } from '../utils/concurrency'
import { DEFAULT_COMPUTE_SETTINGS } from '../../shared/constants/compute-defaults'
import { killAllHostExecs } from '../services/host-exec.service'
import { getLanAddresses } from '../utils/network'
import { McpPackageResolver, PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpSpawnConfig, resolveMcpEnvVars } from '../services/mcp-spawn-utils'
import { SandboxStdlibService } from '../services/sandbox-stdlib.service'
import { SandboxPackagesService } from '../services/sandbox-packages.service'
import { PodmanService, isolatedContainerName, containerWorkspacePath, containerAgentHome } from '../services/podman.service'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { shouldContainerize, shouldIsolate, isServerForceShared, hostDenialReason, type ComputeSettings } from '../services/container-routing'
import { resolveContainerCommand } from '../services/container-command-resolver'
import { resolveAgentComputeTargetSelection } from '../services/execution-target-settings'
import { ExternalExecutionService } from '../services/external-execution.service'
import { syncDiscoveredMcpTools, resyncServerTools, diffMcpServerNames } from '../services/mcp-tool-sync'
import { pickFresherConfig } from '../runtime/config-freshness'
import { buildMcpServerConfigFromRegistration, deriveRegistrationTestPlan, pinServerConfigToRegistration } from '../../shared/utils/mcp-config'
import { ChannelAdapterManager } from '../services/channel-adapter-manager'
import { WsConnectionManager } from '../services/ws-connection-manager'
import { getTokenUsageService } from '../services/token-usage.service'
import { getFleetBurnService } from '../services/fleet-burn.service'
import { getTokenCounterService } from '../services/token-counter.service'
import { buildConfigSummary, deriveReviewIdentity, autoLockFields, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { createEvent, createDispatch, type AdfEventDispatch, type AdfBatchDispatch } from '../../shared/types/adf-event.types'
import type { MeshEvent, BackgroundAgentEvent, AgentExecutionEvent, McpServerRegistration, McpRegistrationTestResult, AdapterRegistration, ProviderConfig, AgentConfigSummary } from '../../shared/types/ipc.types'
import { getChatGptAuthManager } from '../providers/chatgpt-subscription/auth-manager'
import type { AgentConfig, MetaProtectionLevel } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { loadBuiltInAdapter } from '../adapters/built-in-loaders'

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
let currentAssembledAgent: AssembledAgent<AgentProfileName> | null = null
let currentHostAttachment: HostAttachment | null = null
let currentTapManager: TapManager | null = null
let currentStreamBindingManager: StreamBindingManager | null = null
let currentUmbilicalAgentId: string | null = null
let currentSession: AgentSession | null = null
let toolRegistry: ToolRegistry
let settings: SettingsService
let meshManager: MeshManager | null = null
let backgroundAgentManager: BackgroundAgentManager | null = null
let backgroundEventBatcher: BackgroundEventBatcher | null = null
let codeSandboxService: CodeSandboxService = new CodeSandboxService()
const sandboxStdlibService = new SandboxStdlibService()
const sandboxPackagesService = new SandboxPackagesService()
let meshServer: MeshServer | null = null
let mdnsService: MdnsService | null = null
let directoryFetchCache: DirectoryFetchCache | null = null
let tailnetDiscovery: TailnetDiscovery | null = null
let wsConnectionManager: WsConnectionManager | null = null
let currentAgentToolRegistry: ToolRegistry | null = null
let currentMcpManager: McpClientManager | null = null
// Live MCP reconcile for the foreground agent: connects newly-added servers and
// disconnects removed ones when the config changes (Agents-screen edit or agent
// sys_update_config) without a full restart. Reassigned on each foreground
// attach, nulled on teardown. See the fresh-construction attach in AGENT_START.
let currentMcpReconcile: ((nextConfig: AgentConfig) => Promise<void>) | null = null
let currentScratchDir: string | null = null
let currentAdapterManager: ChannelAdapterManager | null = null
let currentAdfCallHandler: AdfCallHandler | null = null
let mcpRegistryFetchService: McpRegistryFetchService | null = null

/**
 * Lazily construct the registry-fetch service (first MCP_REGISTRY_GET call):
 * the service itself is Electron-free, so the userData dir is injected here,
 * and the 24h background refresh starts with it.
 */
function getMcpRegistryFetchService(): McpRegistryFetchService {
  if (!mcpRegistryFetchService) {
    mcpRegistryFetchService = new McpRegistryFetchService({ userDataDir: app.getPath('userData') })
    mcpRegistryFetchService.startPeriodicRefresh()
  }
  return mcpRegistryFetchService
}

/**
 * Forward workspace data-change signals (inbox/outbox/tables) to the renderer
 * so open views refresh live instead of only on file switch. Attached to every
 * workspace that becomes `currentWorkspace`; detached in cleanupCurrentFile so
 * a workspace transitioning to background stops notifying. Bursts are coalesced
 * per scope — the renderer refetches, so dropping intermediate signals is safe.
 */
function attachWorkspaceDataForwarder(workspace: AdfWorkspace): void {
  const pending = new Map<string, NodeJS.Timeout>()
  workspace.setOnDataChangeCallback((scope) => {
    if (pending.has(scope)) return
    const timer = setTimeout(() => {
      pending.delete(scope)
      getMainWindow()?.webContents.send(IPC.WORKSPACE_DATA_CHANGED, { scope })
    }, 250)
    timer.unref?.()
    pending.set(scope, timer)
  })
}

/**
 * Start mDNS announce/browse if the runtime is eligible: mesh server running,
 * bound to `0.0.0.0`, and (for announcement) at least one LAN- or public-tier
 * agent. Browsing happens whenever the server is LAN-bound — a runtime without
 * LAN-visible agents can still *discover* peers without being announced itself.
 *
 * Safe to call repeatedly: single-flight, and re-runs once if invoked while a
 * run is in flight. Re-invoked on `agent_joined` so a LAN/public agent that
 * registers after boot upgrades a browse-only service to announcing without a
 * restart.
 */
let mdnsRunning = false
let mdnsRerunRequested = false
async function startMdnsIfEligible(): Promise<void> {
  // Single-flight: never run two of these concurrently. Two passes can both
  // clear the `if (mdnsService)` guard below during the window between
  // `service.start()` (which publishes) and the `mdnsService = service`
  // assignment — publishing the same `adf-<runtimeId>` name twice and tripping
  // bonjour's "Service name is already in use on the network".
  //
  // But a call arriving *while* one is in flight may be reacting to freshly
  // changed state — e.g. a LAN/public-visible agent that registered after the
  // boot call already landed a browse-only service. Dropping it (the old
  // behaviour) left the runtime stuck browsing-but-never-announcing. So we
  // request exactly one trailing re-run, which executes only after the current
  // run completes (and thus sees the up-to-date `mdnsService`/announce state).
  if (mdnsRunning) { mdnsRerunRequested = true; return }
  mdnsRunning = true
  try {
    do {
      mdnsRerunRequested = false
      await startMdnsIfEligibleInner()
    } while (mdnsRerunRequested)
  } finally {
    mdnsRunning = false
  }
}

async function startMdnsIfEligibleInner(): Promise<void> {
  if (!meshServer || !meshServer.isRunning()) return
  const host = meshServer.getHost()
  if (host !== '0.0.0.0') return  // only announce/browse when LAN-bound

  // LAN-visible spans both 'lan' and 'public' tiers: a public agent is
  // reachable from the public internet, which subsumes the LAN, so it must
  // announce over mDNS too. (The old gate checked only 'lan', so a runtime
  // whose sole reachable agent was 'public' never announced.)
  const hasLanAgent =
    (meshManager?.hasAgentOfTier('lan') ?? false) ||
    (meshManager?.hasAgentOfTier('public') ?? false)

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

  // Beyond the broadcast domain: tailnet sweep + manual peers feed the same
  // table, so friends' hubs on your tailnet land on the map like LAN peers.
  // Guarantee the runtime answers /ping with a stable id first.
  getOrCreateRuntimeId(settings)
  if (!tailnetDiscovery) {
    const svc = new TailnetDiscovery({
      getPorts: () => {
        const own = meshServer?.getPort() ?? 7295
        return own === 7295 ? [7295] : [own, 7295]
      },
      isTailnetEnabled: () => settings.get('tailnetDiscovery') !== false,
      getManualPeers: () => (settings.get('meshManualPeers') as string[]) ?? [],
      getExistingRoute: (runtimeId) => mdnsService?.getDiscovered(runtimeId),
      onPeer: (peer, opts) => mdnsService?.upsertExternalPeer(peer, opts),
      onExpire: (runtimeId) => mdnsService?.removeExternalPeer(runtimeId)
    })
    svc.start()
    tailnetDiscovery = svc
  }

  startNetworkWatch()
}

/**
 * Restart peer discovery when the machine's IPv4 addresses change (Wi-Fi
 * roam, hotspot join, VPN up/down). The mDNS socket's multicast membership is
 * pinned to the boot-time interface and silently dies on a network move, and
 * the browser's discovered entries are only removed by goodbye packets — so
 * without this, a runtime that switched networks keeps stale peers and never
 * hears new ones until an app restart.
 */
let netWatchTimer: NodeJS.Timeout | null = null
let lastNetSignature: string | null = null

function networkSignature(): string {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) =>
      (addrs ?? [])
        .filter((a) => !a.internal && a.family === 'IPv4')
        .map((a) => `${name}=${a.address}`)
    )
    .sort()
    .join(',')
}

function startNetworkWatch(): void {
  if (netWatchTimer) return
  lastNetSignature = networkSignature()
  netWatchTimer = setInterval(() => {
    const sig = networkSignature()
    if (sig === lastNetSignature) return
    lastNetSignature = sig
    console.log(`[mdns] network change (${sig || 'no IPv4 addresses'}) — restarting peer discovery`)
    void (async () => {
      await stopMdnsAndCleanup()
      await startMdnsIfEligible()
    })()
  }, 10_000)
  // Never keep the process alive, and never resurrect mDNS mid-shutdown.
  netWatchTimer.unref?.()
}

function stopNetworkWatch(): void {
  if (netWatchTimer) {
    clearInterval(netWatchTimer)
    netWatchTimer = null
  }
}

/**
 * Stop mDNS cleanly (sends goodbye packets). Must be called before mesh server
 * shutdown so peers evict our entry before the socket goes away.
 */
async function stopMdnsAndCleanup(): Promise<void> {
  // Stop the network-change watcher first — its callback restarts discovery,
  // which would resurrect mDNS in the middle of a teardown. Paths that want
  // the watcher back (network-change restart) re-arm it via startMdnsIfEligible.
  stopNetworkWatch()
  tailnetDiscovery?.stop()
  tailnetDiscovery = null
  const svc = mdnsService
  mdnsService = null
  meshManager?.setMdnsService(null)
  directoryFetchCache?.invalidate()
  if (svc) {
    try { await svc.stop() } catch (err) { console.error('[mdns] stop failed:', err) }
  }
}
const podmanService = new PodmanService()
const externalExecutionService = new ExternalExecutionService()
// Mount host MCP install directories into the container so MCP servers can run
// No host mounts — MCP packages are installed directly inside the container
// via npx/uvx on first connection. This provides true isolation.
// Lazy settings accessor — settings may not be initialized yet at import time.
// Fallbacks come from the shared single source of truth — a local copy
// previously drifted (py3-pip / node:20-alpine) from the real defaults.
podmanService.setSettingsAccessor(() => {
  const raw = settings?.get('compute') as Record<string, unknown> | undefined
  return {
    containerPackages: (raw?.containerPackages as string[]) ?? DEFAULT_COMPUTE_SETTINGS.containerPackages,
    machineCpus: (raw?.machineCpus as number) ?? DEFAULT_COMPUTE_SETTINGS.machineCpus,
    machineMemoryMb: (raw?.machineMemoryMb as number) ?? DEFAULT_COMPUTE_SETTINGS.machineMemoryMb,
    containerImage: (raw?.containerImage as string) ?? DEFAULT_COMPUTE_SETTINGS.containerImage,
  }
})
const mcpPackageResolver = new McpPackageResolver()
const adapterPackageResolver = new PackageResolver('channel-adapters')
import { UvManager } from '../services/uv-manager'
import { UvxPackageResolver } from '../services/uvx-package-resolver'
const uvManager = new UvManager()
const uvxPackageResolver = new UvxPackageResolver(uvManager)

// Heal manifest entries whose recorded entry point isn't a spawnable file
// (pre-fix installs recorded uv's per-tool venv DIRECTORY, which spawns EACCES).
// Only broken entries touch uv, so a clean manifest costs nothing.
uvxPackageResolver.repairManifest().catch((err) =>
  console.warn('[UvxPackageResolver] Manifest repair failed:', err)
)

/**
 * Settings registrations exposed to the agent's mcp_install attach mode.
 * Read at call time so registry edits are visible immediately.
 */
const getMcpRegistrationsForAttach = (): McpServerRegistration[] =>
  (settings?.get('mcpServers') as McpServerRegistration[] | undefined) ?? []

/**
 * Interactive MCP auth preflight for Studio: opens the auth URL via the OS
 * browser and blocks on a native "Continue" dialog. Shared by the foreground
 * AGENT_START registration and (via injection) BackgroundAgentManager, so
 * agents built in either host — and handed off between them — get the same
 * interactive flow instead of the headless fail-plainly path.
 */
const studioMcpAuthPreflight: McpAuthPreflightRunner = (serverCfg, opts) =>
  runMcpAuthPreflight(serverCfg, opts, {
    openUrl: (url) => { shell.openExternal(url) },
    log: (msg) => console.log(msg),
    confirm: async ({ serverName, authUrlOpened }) => {
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
    },
  })

/**
 * Studio IO for the interactive HTTP-OAuth sign-in (runMcpHttpOAuthFlow): opens
 * the (https) authorization URL in the OS browser; the loopback callback server
 * completes the flow, so there is no confirm dialog. Never logs token/code
 * values — the provider logs query-stripped URLs only.
 */
const studioOAuthIO: McpHttpOAuthIO = {
  openUrl: (url) => { shell.openExternal(url) },
  log: (msg) => console.log(msg),
}

/**
 * App-level (Studio) OAuth token store — the "signed-in" source of truth (one
 * safeStorage secret). Lazy because `settings` is assigned during init, after
 * module load; every handler that touches it runs post-init.
 */
let _appOAuthStore: AppSettingsOAuthStore | undefined
function getAppOAuthStore(): AppSettingsOAuthStore {
  if (!_appOAuthStore) _appOAuthStore = new AppSettingsOAuthStore(settings)
  return _appOAuthStore
}

/** Per-agent MCP connect budget for the foreground start path — same figure
 * as agent-runtime-builder / background-agent-manager. */
const MCP_CONNECT_BUDGET_MS = 25_000
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

function cleanupWalFilesRecursive(directory: string, maxDepth: number, skipPaths?: Set<string>, currentDepth = 0): void {
  AdfDatabase.cleanupOrphanedWalFiles(directory, skipPaths)
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
    cleanupWalFilesRecursive(join(directory, entry.name), maxDepth, skipPaths, currentDepth + 1)
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

/**
 * Issue owner (+ runtime operator) attestations for the workspace's agent DID,
 * replacing existing ones. Called after any flow that mints or re-keys an
 * agent DID under this app's ownership. Best-effort: never throws.
 */
function issueAttestationsForCurrentOwner(workspace: AdfWorkspace): void {
  try {
    const ownerIdentity = settings.getOwnerIdentity()
    issueOwnerAttestation(workspace, {
      ownerDid: ownerIdentity.getOwnerDid(),
      ownerPrivateKey: ownerIdentity.getOwnerSigningKey(),
      runtimeDid: ownerIdentity.getRuntimeDid(),
      runtimePrivateKey: ownerIdentity.getRuntimeSigningKey()
    })
  } catch (err) {
    console.warn('[OwnerIdentity] Attestation issuance failed:', err)
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
/**
 * Fleet map: announce an inbound adapter message as station traffic so the
 * base station's tower lights toward the receiving agent. Same event shape
 * as agent-to-agent routing with the station id as the source.
 */
function notifyStationInbound(adapterType: string, agentFilePath: string): void {
  const win = getMainWindow()
  if (!win) return
  win.webContents.send(IPC.MESH_EVENT, {
    type: 'message_routed',
    payload: { filePath: `station:${adapterType}`, toFilePaths: [agentFilePath] },
    timestamp: Date.now()
  })
}

function notifyAdfFileCreated(newFilePath: string): void {
  rememberAdfDirectory(newFilePath)
  const win = getMainWindow()
  if (!win) return
  const dirPath = dirname(canonicalizePath(newFilePath))
  const existing = (settings.get('trackedDirectories') as string[]) ?? []

  // Check if this directory is already covered by a tracked parent
  const trackedParent = existing.find((d) => isSameOrSubPath(d, dirPath))
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

/**
 * Tracked-directory roots currently being watched. We hold onto these so we
 * can map a changed file back to its tracked root when emitting the
 * `TRACKED_DIRS_CHANGED` event — the renderer's `scanTrackedDirectory` call
 * only works against a tracked root, not an arbitrary nested parent dir.
 */
let watchedDirectoryRoots: string[] = []

function findTrackedRootFor(filePath: string): string | null {
  // Prefer the longest match in case of nested tracked dirs.
  const canonFile = canonicalizePath(filePath)
  let best: string | null = null
  let bestLen = -1
  for (const root of watchedDirectoryRoots) {
    const canonRoot = canonicalizePath(root)
    if (containsPath(canonRoot, canonFile) && canonRoot.length > bestLen) {
      best = root
      bestLen = canonRoot.length
    }
  }
  return best
}

function startDirWatcher(directories: string[]): void {
  // Idempotent: rebuilding the watcher for an unchanged directory set drops
  // events during the teardown/setup gap (TRACKED_DIRS_GET is called twice at
  // boot). No-op when the watched set is already identical.
  const nextSet = new Set(directories.map((d) => canonicalizePath(d)))
  const currentSet = new Set(watchedDirectoryRoots.map((d) => canonicalizePath(d)))
  const unchanged = nextSet.size === currentSet.size && [...nextSet].every((d) => currentSet.has(d))
  if (unchanged && (dirWatcher || directories.length === 0)) return

  stopDirWatcher()
  watchedDirectoryRoots = [...directories]
  if (directories.length === 0) return

  // Watch each tracked root recursively. Chokidar v4+ removed glob support,
  // so we watch the directory itself and filter to .adf files in `ignored`
  // and in the event handler. The `ignored` filter also keeps chokidar from
  // descending into common heavy dirs (node_modules, dotfolders) which would
  // otherwise blow up fd counts.
  dirWatcher = chokidar.watch(directories, {
    ignoreInitial: true,
    // Don't fire 'add' until the file has stopped growing — new .adf files
    // are SQLite databases written in multiple steps, and autostart peeks
    // into them.
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: (path: string, stats?: import('fs').Stats) => {
      const base = basename(path)
      if (base.startsWith('.') && base !== '.') return true
      if (base === 'node_modules') return true
      // Only ignore non-.adf files — directories must stay traversable
      if (stats?.isFile() && !path.endsWith('.adf')) return true
      return false
    },
  })

  const emit = (filePath: string) => {
    if (!filePath.endsWith('.adf')) return
    const root = findTrackedRootFor(filePath)
    if (!root) return
    const win = getMainWindow()
    if (win) {
      win.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: root })
    }
  }

  dirWatcher.on('add', (filePath: string) => {
    emit(filePath)
    maybeAutostartTrackedFile(filePath)
  })
  dirWatcher.on('unlink', emit)
}

/**
 * When a new .adf file appears in a tracked directory, start it in the
 * background if its config has autostart enabled. Skips the foreground file
 * and anything already running; password-protection and review gates are
 * enforced by tryAutostart. Agents already started through other paths
 * (boot scan, sys_create_adf child autostart) are no-ops here.
 */
function maybeAutostartTrackedFile(filePath: string): void {
  if (!filePath.endsWith('.adf') || !backgroundAgentManager) return
  if (currentFilePath && canonicalizePath(filePath) === canonicalizePath(currentFilePath)) return
  backgroundAgentManager.tryAutostart(filePath).catch((err) =>
    console.warn(`[autostart] Watcher autostart failed for ${basename(filePath)}:`, err)
  )
}

function stopDirWatcher(): void {
  if (dirWatcher) {
    dirWatcher.close()
    dirWatcher = null
  }
  watchedDirectoryRoots = []
}

/**
 * Clean up the currently open file, agent, and session.
 */
async function cleanupCurrentFile(): Promise<void> {
  const t0 = performance.now()
  const filePath = currentFilePath
  const workspace = currentWorkspace
  const assembledAgent = currentAssembledAgent
  // Stop forwarding data-change signals — the file is no longer on screen,
  // and a background transition keeps this workspace instance alive.
  workspace?.setOnDataChangeCallback(null)
  currentHostAttachment?.detach()
  currentHostAttachment = null
  currentAssembledAgent = null

  // Foreground globals are aliases only; the stable handle retains the tap.
  currentTapManager = null
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
  const willTransitionToBackground = !!(assembledAgent && backgroundAgentManager && filePath && workspace)

  // Unregister from mesh (keep WS connections alive if transitioning to background)
  if (meshManager?.isEnabled() && filePath) {
    meshManager.unregisterAgent(filePath, { keepWsConnections: willTransitionToBackground })
  }

  if (willTransitionToBackground) {
    const config = workspace.getAgentConfig()

    // The handle retains resource ownership; foreground globals are aliases only.
    currentMcpManager = null
    currentMcpReconcile = null
    currentScratchDir = null
    currentAdapterManager = null
    currentStreamBindingManager = null
    currentTapManager = null

    const t1 = performance.now()
    await backgroundAgentManager.transitionToBackground(
      filePath, config, assembledAgent, derivedKeyCache.get(filePath) ?? null,
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
        if (assembledAgent.adapterManager) {
          meshManager.setAdapterManager(filePath, assembledAgent.adapterManager)
        }
      }
    }

    currentWorkspace = null
    currentSession = null
    currentFilePath = null
    console.log(`[PERF] cleanupCurrentFile (with transition): ${(performance.now() - t0).toFixed(1)}ms`)
    return
  }

  // No transition — the stable handle remains the sole teardown owner.
  if (assembledAgent) await assembledAgent.disposeAsync({ mode: 'immediate' })
  currentAdapterManager = null
  currentStreamBindingManager = null
  currentMcpManager = null
  currentMcpReconcile = null
  currentScratchDir = null
  currentTapManager = null
  currentSession = null

  // Don't close the workspace if AGENT_START is in-flight for this file —
  // it still needs the database connection. AGENT_START will handle cleanup.
  if (workspace && !(filePath && startingFilePaths.has(filePath))) {
    workspace.close()
  }

  currentWorkspace = null
  currentFilePath = null
  if (filePath) applyPendingRename(filePath)
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
      // Foreground aliases never own lifecycle resources. Detach the host and
      // let the stable handle perform the one authoritative owner-off teardown.
      const assembled = currentAssembledAgent
      currentHostAttachment?.detach()
      currentHostAttachment = null
      currentAssembledAgent = null
      agentExecutor = null
      triggerEvaluator = null
      currentMcpManager = null
      currentMcpReconcile = null
      currentAdapterManager = null
      currentStreamBindingManager = null
      currentTapManager = null
      currentScratchDir = null
      currentSession = null
      currentAgentToolRegistry = null
      currentAdfCallHandler = null
      if (meshManager) meshManager.removeAdapterManager(filePath)
      if (assembled) await assembled.disposeAsync({ mode: 'owner-off' })
      applyPendingRename(filePath)
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

// --- Agent file rename (file name follows agent name) ---

/**
 * Renames scheduled while the agent (foreground or background) was running.
 * SQLite files cannot be safely renamed under a live executor, so the physical
 * rename is applied when the agent stops. Keyed by current file path.
 */
const pendingAgentRenames = new Map<string, string>()

/** Characters not allowed in file names on Windows (superset of POSIX). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

function isValidAgentFileName(name: string): boolean {
  return name.length > 0 && !INVALID_FILENAME_CHARS.test(name) && !name.endsWith('.') && !name.endsWith(' ')
}

function isAgentFileRunning(filePath: string): boolean {
  if (startingFilePaths.has(filePath)) return true
  if (filePath === currentFilePath && (agentExecutor || currentAssembledAgent)) return true
  return backgroundAgentManager?.hasAgent(filePath) ?? false
}

function notifyTrackedRootChanged(filePath: string): void {
  const root = findTrackedRootFor(filePath)
  if (root) getMainWindow()?.webContents.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: root })
}

/**
 * Physically rename an .adf file (+ WAL/SHM sidecars) and set the agent name
 * inside to match. Must not be called while the agent is running — callers
 * defer via `pendingAgentRenames` instead.
 */
function performAdfRename(filePath: string, newName: string): { success: boolean; filePath?: string; error?: string } {
  try {
    const newPath = join(dirname(filePath), `${newName}.adf`)
    rememberAdfDirectory(filePath)
    rememberAdfDirectory(newPath)

    if (newPath !== filePath && existsSync(newPath)) {
      return { success: false, error: `A file named "${newName}.adf" already exists.` }
    }
    if (isAgentFileRunning(filePath)) {
      return { success: false, error: 'Agent is running — rename deferred until it stops.' }
    }

    // Close current workspace if it's the file being renamed
    const wasCurrent = filePath === currentFilePath
    if (wasCurrent && currentWorkspace) {
      currentWorkspace.checkpoint()
      currentWorkspace.close()
      currentWorkspace = null
    }

    if (newPath !== filePath) {
      // Merge any WAL frames into the main file BEFORE moving it. If sidecars
      // survive the checkpoint (e.g. another process holds the DB), abort:
      // renaming the base file away from live sidecars would leave orphaned
      // WAL files whose deletion by a later sweep silently loses frames.
      if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
        try {
          const checkpointWs = AdfWorkspace.open(filePath)
          checkpointWs.checkpoint()
          checkpointWs.close()
        } catch (err) {
          console.warn(`[Rename] Pre-rename checkpoint of ${basename(filePath)} failed:`, err)
        }
      }
      if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
        return { success: false, error: 'WAL sidecars could not be checkpointed — rename aborted to avoid losing unflushed data.' }
      }
      renameSync(filePath, newPath)
    }

    // Update agent name inside
    const workspace = AdfWorkspace.open(newPath)
    const config = workspace.getAgentConfig()
    config.name = newName
    workspace.setAgentConfig(config)
    workspace.close()

    // Reopen if it was the current file. Re-run the envelope unlock the
    // FILE_OPEN path performs — a freshly opened workspace has no cached
    // envelope DEKs, which reads as a "foreign" identity and breaks signing.
    if (wasCurrent) {
      currentWorkspace = AdfWorkspace.open(newPath)
      currentFilePath = newPath
      attachWorkspaceDataForwarder(currentWorkspace)
      try { unlockWorkspaceEnvelopes(currentWorkspace) }
      catch (err) { console.warn('[Rename] Envelope unlock after reopen failed:', err) }
    }

    // Migrate path-keyed state
    const cachedKey = derivedKeyCache.get(filePath)
    if (cachedKey) {
      derivedKeyCache.delete(filePath)
      derivedKeyCache.set(newPath, cachedKey)
    }
    pendingAgentRenames.delete(filePath)

    getMainWindow()?.webContents.send(IPC.FILE_RENAMED, { oldPath: filePath, newPath })
    notifyTrackedRootChanged(newPath)
    return { success: true, filePath: newPath }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * Managed home for accepted/claimed agents that arrive from untracked paths.
 * The agentsFolder setting overrides the built-in default; a configured path
 * under the OS temp dir is ignored (a temp destination defeats the whole
 * point of the move). Created on first use, never at boot.
 */
function defaultAgentsFolder(): string {
  let folder = ''
  const configured = settings.get('agentsFolder')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const candidate = resolve(configured.trim())
    if (isSameOrSubPath(app.getPath('temp'), candidate) || isSameOrSubPath(tmpdir(), candidate)) {
      console.warn(`[Review] agentsFolder setting points into the OS temp dir — ignoring: ${candidate}`)
    } else {
      folder = candidate
    }
  }
  if (!folder) folder = join(app.getPath('documents'), 'adf-agents')
  mkdirSync(folder, { recursive: true })
  return folder
}

/** First free "name.adf" / "name (2).adf" / … path in dir. */
function availableAdfPath(dir: string, baseName: string): string {
  let candidate = join(dir, `${baseName}.adf`)
  for (let n = 2; existsSync(candidate); n++) {
    candidate = join(dir, `${baseName} (${n}).adf`)
  }
  return candidate
}

/**
 * Rename, falling back to copy+delete only for cross-volume moves (EXDEV —
 * the OS temp dir is often on another volume, especially on Windows). Any
 * other rename error propagates. Returns 'moved' on a clean move, or
 * 'copied-source-remains' when the destination copy is intact but the source
 * could not be deleted (e.g. a Windows lock) — the caller must surface the
 * leftover, since it is a byte-identical duplicate.
 */
function moveFileWithFallback(src: string, dest: string): 'moved' | 'copied-source-remains' {
  try {
    renameSync(src, dest)
    return 'moved'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  try {
    copyFileSync(src, dest)
    // Verify before deleting the source — it is the only remaining copy.
    if (statSync(dest).size !== statSync(src).size) {
      throw new Error(`Copy size mismatch for ${basename(src)}`)
    }
  } catch (copyErr) {
    try {
      if (existsSync(dest)) unlinkSync(dest)
    } catch {
      /* partial-copy cleanup is best-effort */
    }
    throw copyErr
  }
  try {
    unlinkSync(src)
    return 'moved'
  } catch (unlinkErr) {
    console.warn(`[Review] Source not removed after copy (${basename(src)}):`, unlinkErr)
    return 'copied-source-remains'
  }
}

/**
 * Reopen the foreground workspace at the first candidate path that exists
 * and opens (duplicates in the list act as retries — e.g. an AV scanner
 * briefly holding a fresh copy). Never throws; returns the path that opened,
 * or null when every attempt failed (currentWorkspace is then null and the
 * caller must say so in its result).
 */
function reopenWorkspaceAt(paths: string[]): string | null {
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const ws = AdfWorkspace.open(p)
      currentWorkspace = ws
      currentFilePath = p
      attachWorkspaceDataForwarder(ws)
      try {
        unlockWorkspaceEnvelopes(ws)
      } catch (err) {
        console.warn('[Review] Envelope unlock after reopen failed:', err)
      }
      return p
    } catch (err) {
      console.warn(`[Review] Reopen at ${basename(p)} failed:`, err)
    }
  }
  return null
}

/**
 * Persistence step of review accept/claim: the sidebar lists only
 * trackedDirectories, so a file opened from an untracked location (temp
 * attachment, Downloads) vanishes on restart — and a temp copy may be
 * OS-cleaned. Move it into the managed adf-agents folder and track that.
 * Files already under a tracked directory stay where the user organized
 * them. Best-effort: a failed move never rolls back the accept — the
 * fallback tracks the file's own directory instead, except an OS temp dir
 * (never tracked; the failure is surfaced as moveError).
 */
function persistAcceptedAgent(): { movedTo?: string; moveError?: string } {
  const filePath = currentFilePath
  if (!filePath || !currentWorkspace) return {}
  const dirPath = dirname(canonicalizePath(filePath))
  const tracked = (settings.get('trackedDirectories') as string[]) ?? []
  if (tracked.some((d) => isSameOrSubPath(d, dirPath))) return {}

  const inTempDir =
    isSameOrSubPath(app.getPath('temp'), dirPath) || isSameOrSubPath(tmpdir(), dirPath)
  const fallback = (err: unknown): { moveError?: string } => {
    console.warn(`[Review] Could not move ${basename(filePath)} to the adf-agents folder:`, err)
    if (inTempDir) {
      return {
        moveError: `The agent file could not be moved out of the temporary folder and may be deleted by the OS: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    // Track its own directory so the agent at least persists in the sidebar.
    notifyAdfFileCreated(filePath)
    return {}
  }

  if (isAgentFileRunning(filePath)) return fallback(new Error('agent is running'))

  let newPath: string
  try {
    newPath = availableAdfPath(defaultAgentsFolder(), basename(filePath, '.adf'))
  } catch (err) {
    return fallback(err)
  }

  currentWorkspace.checkpoint()
  currentWorkspace.close()
  currentWorkspace = null

  // Live-sidecar abort guard (mirrors performAdfRename): sidecars surviving
  // close mean another connection holds the DB. Rename mode would move the
  // base away from a live WAL; copy mode would copy it without those frames.
  // Re-checkpoint, and if they still persist, abort — accept still succeeds,
  // the file just stays put.
  if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
    try {
      const checkpointWs = AdfWorkspace.open(filePath)
      checkpointWs.checkpoint()
      checkpointWs.close()
    } catch (err) {
      console.warn(`[Review] Pre-move checkpoint of ${basename(filePath)} failed:`, err)
    }
  }
  if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
    reopenWorkspaceAt([filePath, filePath])
    return fallback(new Error('WAL sidecars could not be checkpointed — move aborted to avoid losing unflushed data'))
  }

  let moveOutcome: 'moved' | 'copied-source-remains'
  try {
    moveOutcome = moveFileWithFallback(filePath, newPath)
  } catch (err) {
    reopenWorkspaceAt([filePath, filePath])
    return fallback(err)
  }

  // The move is done — repoint, migrate path-keyed state, and track BEFORE
  // the reopen, which can throw (e.g. Windows AV briefly holding the fresh
  // copy): the accept must leave the file tracked and the renderer
  // repointable regardless. The early currentFilePath repoint also closes
  // the autostart race — the watcher's 'add' for newPath skips the
  // foreground file only when currentFilePath already matches.
  currentFilePath = newPath
  const cachedKey = derivedKeyCache.get(filePath)
  if (cachedKey) {
    derivedKeyCache.delete(filePath)
    derivedKeyCache.set(newPath, cachedKey)
  }
  const pendingRename = pendingAgentRenames.get(filePath)
  if (pendingRename) {
    pendingAgentRenames.delete(filePath)
    pendingAgentRenames.set(newPath, pendingRename)
  }
  // Open Recent: re-key the moved entry, then re-record so the menu and the
  // OS recent-documents list rebuild against the new path.
  const recent = settings.get('recentFiles')
  if (Array.isArray(recent) && recent.includes(filePath)) {
    settings.set('recentFiles', recent.map((p) => (p === filePath ? newPath : p)))
  }
  recordRecentFile(newPath)
  // Tracks the adf-agents folder (watcher + mesh + TRACKED_DIRS_CHANGED)
  notifyAdfFileCreated(newPath)

  const openedAt = reopenWorkspaceAt([newPath, newPath, filePath])
  if (openedAt !== filePath) {
    // Not sent when the leftover source ended up reopened — the renderer
    // must keep pointing at what is actually open.
    getMainWindow()?.webContents.send(IPC.FILE_RENAMED, { oldPath: filePath, newPath })
  }

  if (openedAt === null) {
    return {
      movedTo: newPath,
      moveError: `Moved to ${newPath}, but the file could not be reopened — reopen it manually`
    }
  }
  if (openedAt !== newPath) {
    // Copy-mode leftover source opened instead (dest copy unopenable). Don't
    // report movedTo — the renderer must keep pointing at what is open.
    return {
      moveError: `A copy was placed at ${newPath} but could not be opened; still using the original at ${filePath}. Delete the copy to avoid a duplicate agent.`
    }
  }
  if (moveOutcome === 'copied-source-remains') {
    return {
      movedTo: newPath,
      moveError: `Moved to ${newPath}, but the original at ${filePath} could not be deleted — remove it manually to avoid a duplicate agent`
    }
  }
  return { movedTo: newPath }
}

/**
 * Keep the .adf file name in sync with the agent's config name. Renames
 * immediately when the agent is stopped; schedules a deferred rename (applied
 * on stop) when it is running. Invalid file names are left un-synced.
 */
function syncAgentFileToName(filePath: string, name: string): { filePath?: string; deferred?: boolean } {
  const trimmed = (name ?? '').trim()
  if (!isValidAgentFileName(trimmed)) {
    console.warn(`[Rename] Agent name "${name}" is not a valid file name; keeping ${basename(filePath)}`)
    return {}
  }
  if (basename(filePath, '.adf') === trimmed) {
    pendingAgentRenames.delete(filePath)
    return {}
  }
  if (isAgentFileRunning(filePath)) {
    pendingAgentRenames.set(filePath, trimmed)
    // Refresh the sidebar so it shows the new agent name ahead of the rename
    notifyTrackedRootChanged(filePath)
    return { deferred: true }
  }
  const result = performAdfRename(filePath, trimmed)
  if (!result.success) {
    console.warn(`[Rename] Could not rename ${basename(filePath)} to "${trimmed}.adf": ${result.error}`)
    return {}
  }
  return { filePath: result.filePath }
}

/** Apply a deferred rename once the agent that held the file has stopped. */
function applyPendingRename(filePath: string): void {
  const newName = pendingAgentRenames.get(filePath)
  if (!newName) return
  if (isAgentFileRunning(filePath)) return
  pendingAgentRenames.delete(filePath)
  const result = performAdfRename(filePath, newName)
  if (!result.success) {
    console.warn(`[Rename] Deferred rename of ${basename(filePath)} to "${newName}.adf" failed: ${result.error}`)
  }
}

/** Update a running agent's config name in place (foreground or background). */
function setLiveAgentName(filePath: string, name: string): void {
  if (filePath === currentFilePath && currentWorkspace) {
    const config = currentWorkspace.getAgentConfig()
    if (config.name === name) return
    config.name = name
    currentWorkspace.setAgentConfig(config)
    agentExecutor?.updateConfig(config)
    triggerEvaluator?.updateConfig(config)
    currentAdfCallHandler?.updateConfig(config)
    meshManager?.updateAgentConfig(filePath, config)
  } else {
    backgroundAgentManager?.setAgentName(filePath, name)
  }
}

export function registerAllIpcHandlers(): void {
  settings = new SettingsService()
  initApplicationMenu(settings)

  // Seed + persist the set of OpenRouter models that mandate reasoning (they 400
  // on an explicit disable). Persisting means a model fails at most once, ever.
  seedMandatoryReasoningModels((settings.get('openrouterMandatoryReasoningModels') as string[]) ?? [])
  setMandatoryReasoningPersister((modelId) => {
    const cur = (settings.get('openrouterMandatoryReasoningModels') as string[]) ?? []
    if (!cur.includes(modelId)) settings.set('openrouterMandatoryReasoningModels', [...cur, modelId])
  })

  // Generate owner + runtime DIDs on first launch
  const { ownerDid, runtimeDid } = settings.ensureRuntimeIdentity()
  console.log(`[Runtime] Owner DID: ${ownerDid}`)
  console.log(`[Runtime] Runtime DID: ${runtimeDid}`)

  // Workspace identity hooks (spec D1/D10): creation and agent-start paths
  // provision/unlock through these instead of threading the service around.
  setWorkspaceIdentityHooks({
    ensureIdentity: (ws) => settings.getOwnerIdentity().ensureWorkspaceIdentity(ws),
    unlockEnvelopes: (ws) => settings.getOwnerIdentity().unlockWorkspaceEnvelopes(ws)
  })

  // Envelope migration sweep (spec §8): idempotent, cheap once migrated.
  // Deferred — it opens every tracked .adf, which must not block window
  // creation. Behavior is otherwise identical to the old synchronous sweep.
  setTimeout(() => {
    try {
      const t0 = performance.now()
      const sweep = settings.getOwnerIdentity().sweepEnvelopeMigration()
      if (sweep.provisioned || sweep.sealed || sweep.failures.length) {
        console.log(`[OwnerIdentity] Envelope sweep: ${sweep.provisioned} provisioned, ${sweep.sealed} rows sealed, ${sweep.failures.length} failure(s) in ${(performance.now() - t0).toFixed(0)}ms`)
      }
    } catch (err) {
      console.warn('[OwnerIdentity] Envelope sweep failed:', err)
    }
  }, 2_000).unref?.()

  toolRegistry = new ToolRegistry()
  registerBuiltInTools(toolRegistry)

  // Global sandbox worker ceiling. The service is the process-wide singleton,
  // so this is the one place that bounds how many V8 isolates every agent's
  // lambdas can claim between them. 0/absent = CPU-derived default.
  codeSandboxService.setMaxWorkers(settings.get('sandboxMaxWorkers') as number | undefined)

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
  // Studio background agents share the interactive auth preflight — same
  // Electron main process, so browser + dialog work exactly as in foreground.
  backgroundAgentManager.setMcpAuthPreflight(studioMcpAuthPreflight)
  // Studio background agents share the interactive HTTP-OAuth sign-in — same
  // Electron main process, so shell.openExternal + the loopback callback work
  // exactly as in foreground. The manager raises the blocking HIL approval;
  // this runner only performs the browser flow + keystore seal once approved
  // (mirrors setMcpAuthPreflight injection — Electron wiring stays in ipc).
  backgroundAgentManager.setMcpHttpOAuthSignIn(async (ctx) => {
    const appStore = getAppOAuthStore()
    const flow = await runMcpHttpOAuthFlow(ctx.url, appStore, studioOAuthIO, {
      clientId: ctx.oauthClientId,
      scopes: ctx.oauthScopes,
    })
    if (!flow.authorized) {
      console.warn(`[MCP] Background OAuth sign-in for "${ctx.serverName}" did not complete: ${flow.error ?? 'unknown'}`)
      return false
    }
    // Seal the freshly-signed-in token into the agent keystore so the silent
    // connect factory finds it (and it travels with the .adf).
    await captureOAuthToAgent(appStore, ctx.agentStore, ctx.url)
    return true
  })
  backgroundAgentManager.onAgentOff = handleAgentOff
  // Agent renamed itself (sys_update_config) while running in background —
  // schedule the .adf file rename for when it stops.
  backgroundAgentManager.onAgentRenamed = (fp, name) => syncAgentFileToName(fp, name)

  // Auto-start the shared MCP container in the background.
  // All MCP servers run here by default. Non-blocking — agents that start
  // before the container is ready will connect MCP servers on host.
  // Deferred a few seconds so podman probing never competes with first paint;
  // settings expose no compute-enabled flag (compute.enabled is per-agent
  // config), so this stays unconditional. Agents that need the container
  // earlier trigger ensureRunning() themselves via their start path.
  setTimeout(() => {
    podmanService.ensureRunning().then(() => {
      console.log('[Compute] Shared MCP container ready')
    }).catch((err) => {
      console.warn('[Compute] Shared container failed to start (MCP servers will run on host):', err instanceof Error ? err.message : err)
    })
  }, 5_000).unref?.()

  backgroundEventBatcher = new BackgroundEventBatcher((events) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.BACKGROUND_AGENT_EVENT_BATCH, events)
  })

  backgroundAgentManager.on('background_agent_event', (event: BackgroundAgentEvent) => {
    const win = getMainWindow()
    if (win) {
      backgroundEventBatcher?.push(event)

      // Refresh tracked directories when a background agent creates a new ADF file
      if (event.type === 'adf_file_created') {
        const payload = event.payload as { filePath?: string }
        if (payload?.filePath) {
          notifyAdfFileCreated(payload.filePath)
        }
      }
    }

    // Apply a deferred file rename once the agent that held the file stopped
    if (event.type === 'agent_stopped') {
      const payload = event.payload as { filePath?: string }
      if (payload?.filePath) applyPendingRename(payload.filePath)
    }
  })

  // Fleet map: background adapter inbound → station tower pulse
  backgroundAgentManager.on('adapter_inbound', (data: { filePath: string; type: string }) => {
    notifyStationInbound(data.type, data.filePath)
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

  // Mesh enablement must not depend on the renderer WelcomeScreen mounting —
  // when a file is already open on reload the welcome screen never renders and
  // mesh (and the background agents' WS manager) would never start. Enable it
  // from main BEFORE autostart so agents starting at boot never capture a null
  // wsConnectionManager (the previous 1s timer left exactly that window); the
  // renderer's own MESH_ENABLE call stays harmless thanks to the idempotency
  // guard in enableMeshInMain.
  const meshBoot: Promise<unknown> = settings.get('meshEnabled') === false
    ? Promise.resolve()
    : enableMeshInMain().then((result) => {
        if (!result.success) console.error('[Mesh] Boot enablement failed:', result.error)
      }).catch((err) => console.error('[Mesh] Boot enablement failed:', err))

  // Autostart agents from tracked directories (fire-and-forget, after mesh)
  const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
  for (const d of trackedDirs) rememberTrackedDirectory(d)

  // Boot WAL sweep: reap sidecars left by a previous unclean exit (crash /
  // kill). Deferred until autostart has settled (plus a grace timer) so
  // agents started at boot are already in openFilePaths(); reapSidecars'
  // exclusive-lock probe makes this safe even when the daemon or another
  // process holds a file — those come back 'busy' and are left alone.
  // Covers tracked directory trees plus the directories of last session's
  // recent files (foreground opens that live outside tracked dirs).
  const scheduleBootWalSweep = (): void => {
    const timer = setTimeout(() => {
      try {
        let openDbPaths: Set<string> | undefined
        try { openDbPaths = new Set(AdfDatabase.openFilePaths()) }
        catch { /* sweep unskipped rather than not at all */ }
        const sweepDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5
        for (const dir of trackedDirs) {
          try { cleanupWalFilesRecursive(resolve(dir), sweepDepth, openDbPaths) }
          catch (e) { console.error(`[Boot] WAL sweep error in ${dir}:`, e) }
        }
        const recentDirs = new Set<string>()
        try {
          const recent = settings.get('recentFiles')
          if (Array.isArray(recent)) {
            for (const f of recent) if (typeof f === 'string' && f) recentDirs.add(resolve(dirname(f)))
          }
        } catch { /* ignore */ }
        for (const dir of recentDirs) {
          try { AdfDatabase.cleanupOrphanedWalFiles(dir, openDbPaths) }
          catch (e) { console.error(`[Boot] WAL sweep error in ${dir}:`, e) }
        }
      } catch (err) { console.error('[Boot] WAL sweep failed:', err) }
    }, 3_000)
    timer.unref?.()
  }

  if (trackedDirs.length > 0) {
    const bootScanDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5
    void meshBoot.then(() =>
      backgroundAgentManager?.autostartFromDirectories(trackedDirs, bootScanDepth)
    ).catch(err =>
      console.error('[autostart] Boot scan failed:', err)
    ).finally(scheduleBootWalSweep)
  } else {
    scheduleBootWalSweep()
  }

  // --- App ---

  // Returns the running app version. In a packaged build app.getVersion()
  // reads the bundled package.json version (== the release tag, kept in sync
  // by `npm version`; see RELEASING.md); in dev it's package.json directly.
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion())

  // --- File operations ---

  // Session resync for a fresh renderer (window reload / recreation). Main
  // outlives the renderer, so a running foreground agent would otherwise be
  // invisible until the user happens to re-open its file.
  ipcMain.handle(IPC.FILE_GET_CURRENT, () => ({
    filePath: currentFilePath,
    agentRunning: agentExecutor !== null,
  }))

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
      recordRecentFile(filePath)

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
            attachWorkspaceDataForwarder(currentWorkspace)
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
          attachWorkspaceDataForwarder(currentWorkspace)
          currentSession = extracted.session
          agentExecutor = extracted.executor
          triggerEvaluator = extracted.triggerEvaluator
          currentAgentToolRegistry = extracted.toolRegistry
          currentMcpManager = extracted.mcpManager
          currentScratchDir = extracted.scratchDir
          currentAdapterManager = extracted.adapterManager
          currentAdfCallHandler = extracted.adfCallHandler
          currentStreamBindingManager = extracted.streamBindingManager
          currentAssembledAgent = extracted.assembledAgent
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
      attachWorkspaceDataForwarder(currentWorkspace)

      // Check if password-protected
      if (currentWorkspace.isPasswordProtected()) {
        const cachedKey = derivedKeyCache.get(filePath)
        if (cachedKey) {
          // Verify the cached key against a row that actually exists —
          // probing a fixed purpose misread row-missing as key-stale and
          // re-prompted on every reopen of legacy files without that row.
          if (currentWorkspace.verifyDerivedKey(cachedKey)) {
            currentDerivedKey = cachedKey
            // Deliberately NOT converting the legacy file here: conversion
            // carries the original password forward as a credentials
            // share-password slot, and this path only holds the derived KEY,
            // not the password string — converting would strip the password
            // route. IDENTITY_PASSWORD_UNLOCK owns conversion; it happens on
            // the next fresh-session unlock, when the password is in hand.
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

      // Lazy legacy-DID restamp: files outside tracked directories (or busy
      // during boot migration) converge to the key-backed owner DID on open.
      try {
        const { restamped } = settings.getOwnerIdentity().restampAndAttest(currentWorkspace)
        if (restamped) console.log(`[OwnerIdentity] Restamped legacy owner DID on open: ${filePath}`)
      } catch (err) {
        console.warn('[OwnerIdentity] Lazy restamp failed:', err)
      }

      // Lazy envelope migration + unlock (spec §8 fallback for files the boot
      // sweep didn't reach; unlocks sealed rows for this workspace instance).
      // Unreviewed files get unlock-only: minting keys / stamping ownership
      // waits for review-accept, so rejecting a file leaves it untouched.
      try {
        const reviewed = isConfigReviewed(settings.get('reviewedAgents'), currentWorkspace.getAgentConfig())
        settings.getOwnerIdentity().ensureWorkspaceIdentity(currentWorkspace, { mintKeys: reviewed })
      } catch (err) {
        console.warn('[OwnerIdentity] Lazy envelope migration failed:', err)
      }

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

      // Self-heal a claimed-but-stranded temp file: review was already
      // accepted (so the review dialog won't run persist again) but a prior
      // move failed and the file still sits in the OS temp dir — retry the
      // move into the managed folder on this open.
      const openDirPath = dirname(canonicalizePath(filePath))
      if (
        (isSameOrSubPath(app.getPath('temp'), openDirPath) || isSameOrSubPath(tmpdir(), openDirPath)) &&
        isConfigReviewed(settings.get('reviewedAgents'), config)
      ) {
        const healed = persistAcceptedAgent()
        if (healed.movedTo) {
          console.log(`[Review] Self-healed stranded temp agent -> ${healed.movedTo}`)
          return { success: true, filePath: healed.movedTo, agentWasRunning, movedTo: healed.movedTo }
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
      recordRecentFile(result.filePath)
      await cleanupCurrentFile()

      const agentName = basename(result.filePath, '.adf')
      console.log('[IPC] FILE_CREATE: Creating workspace for agent:', agentName)
      const appProviders = (settings.get('providers') as import('../../shared/types/ipc.types').ProviderConfig[]) ?? []
      const defaultProvider = resolveDefaultProvider(appProviders, settings.get('defaultProviderId') as string | undefined)
      const createOptions = applyDefaultProviderToOptions({ name: agentName }, defaultProvider)
      currentWorkspace = AdfWorkspace.create(result.filePath, createOptions)
      currentFilePath = result.filePath
      attachWorkspaceDataForwarder(currentWorkspace)

      // D1: every new file gets identity keys, sealed in owner/runtime envelopes.
      try {
        settings.getOwnerIdentity().ensureWorkspaceIdentity(currentWorkspace)
      } catch (err) {
        console.warn('[OwnerIdentity] Identity provisioning on create failed:', err)
      }

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

        // Identity handling: if identity table was not selected, provision fresh
        // keys sealed in owner/runtime envelopes (D1). If it was selected,
        // preserve it exactly (including password protection) — existing
        // attestations stay valid since the agent DID is unchanged.
        if (!selectedSet.has('adf_identity')) {
          const cloneIdentity = settings.ensureRuntimeIdentity()
          newWorkspace.getDatabase().setMeta('adf_owner_did', cloneIdentity.ownerDid, 'readonly')
          newWorkspace.getDatabase().setMeta('adf_runtime_did', cloneIdentity.runtimeDid, 'readonly')
          // Envelopes + fresh keys + attestations (new agent DID → old certs are subject-mismatched)
          settings.getOwnerIdentity().ensureWorkspaceIdentity(newWorkspace)
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
      const { filePath } = args
      const newName = args.newName.trim()
      if (!isValidAgentFileName(newName)) {
        return { success: false, error: 'Name contains characters not allowed in file names.' }
      }
      const newPath = join(dirname(filePath), `${newName}.adf`)
      if (newPath !== filePath && existsSync(newPath)) {
        return { success: false, error: `A file named "${newName}.adf" already exists.` }
      }

      if (isAgentFileRunning(filePath)) {
        // Update the live config name now; move the file when the agent stops.
        setLiveAgentName(filePath, newName)
        const sync = syncAgentFileToName(filePath, newName)
        rememberAdfDirectory(filePath)
        notifyTrackedRootChanged(filePath)
        return { success: true, filePath, renameDeferred: sync.deferred ?? false }
      }

      return performAdfRename(filePath, newName)
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
      const svc = settings.getOwnerIdentity()
      const agentDid = currentWorkspace.getDid()
      // Owner shown in review: verified attestation first (proof), meta
      // fallback (fact) — never the agent's own DID.
      const ownerAtt = readAdfAttestations(currentWorkspace)
        .filter((a) => a.role === 'owner')
        .find((a) => verifyAttestation(a, agentDid ? { expectedSubject: agentDid } : undefined))
      const credentialSlots = currentWorkspace.readEnvelopeSlots('credentials') ?? []
      const identity = deriveReviewIdentity({
        agentDid,
        fileOwnerDid: ownerAtt?.issuer ?? currentWorkspace.getMeta('adf_owner_did') ?? null,
        fileRuntimeDid: currentWorkspace.getMeta('adf_runtime_did') ?? null,
        localOwnerDid: svc.getOwnerDid(),
        localRuntimeDid: svc.getRuntimeDid(),
        identityEnvelope: currentWorkspace.getEnvelopeState('identity'),
        credentialsEnvelope: currentWorkspace.getEnvelopeState('credentials'),
        sharePasswordSet: credentialSlots.some((s) => s.type === 'password'),
        filePasswordProtected: currentWorkspace.isPasswordProtected(),
        ownerKeyAvailable: svc.getOwnerEncPrivateKey() !== null
      })
      // Provider usability: can this install actually run the agent's model?
      // Resolve the configured provider id against local settings, falling
      // back to a local provider of the same type as the embedded entry.
      const appProviders = (settings.get('providers') as ProviderConfig[]) ?? []
      const embedded = config.providers?.find((p) => p.id === config.model.provider)
      const localProvider =
        appProviders.find((p) => p.id === config.model.provider) ??
        (embedded ? appProviders.find((p) => p.type === embedded.type) : undefined)
      const provider: AgentConfigSummary['provider'] = {
        configuredId: config.model.provider,
        configuredType: embedded?.type,
        modelId: config.model.model_id,
        status: localProvider ? await testProviderCredentialsForDashboard(localProvider) : 'missing',
        ...(localProvider ? { resolvedLocalId: localProvider.id } : {})
      }
      const configSummary: AgentConfigSummary = { ...buildConfigSummary(config, identity), provider }
      return { needsReview: true, configSummary }
    } catch (err) {
      console.warn('[IPC] FILE_CHECK_REVIEW error:', err)
      return { needsReview: false }
    }
  })

  ipcMain.handle(IPC.FILE_REVIEW_ACCEPT, async (
    _event,
    args?: { claim?: boolean; expectedPath?: string; model?: { provider: string; model_id: string } }
  ) => {
    if (!currentWorkspace || !currentFilePath) {
      return { success: false, error: 'No workspace open' }
    }
    // The dialog's verdict is bound to the file it reviewed — if another file
    // was opened mid-dialog, accepting must not lock/claim the newcomer.
    if (!args?.expectedPath || canonicalizePath(args.expectedPath) !== canonicalizePath(currentFilePath)) {
      return { success: false, error: 'The open file changed while the review dialog was up — review the current file again' }
    }
    try {
      // Resolve any model override up front — an unknown provider must fail
      // before claim mutates the file.
      let chosenProvider: ProviderConfig | undefined
      if (args.model) {
        const appProviders = (settings.get('providers') as ProviderConfig[]) ?? []
        chosenProvider = appProviders.find((p) => p.id === args.model!.provider)
        if (!chosenProvider) {
          return { success: false, error: `Provider "${args.model.provider}" is not configured in Settings` }
        }
      }

      if (args?.claim) {
        // Claim & Open: foreign or identity-less file — mint a fresh identity
        // under the local owner. Legacy whole-file password is removed first
        // (same preamble as IDENTITY_CLAIM).
        if (currentWorkspace.isPasswordProtected() && !currentDerivedKey) {
          // Claiming without the derived key would wipe the signing keys and
          // then bail at provisioning, leaving the file key-less and still
          // password-protected.
          return { success: false, error: 'File is password-protected — enter the password before claiming' }
        }
        if (!settings.getOwnerIdentity().getEnvelopeRecipients()) {
          // Fail plainly: claiming without envelope recipients would mint an
          // identity with no envelopes (plaintext keys, no credential sealing).
          return { success: false, error: 'Owner/runtime encryption keys are unavailable (keystore locked?) — cannot claim securely' }
        }
        if (currentWorkspace.isPasswordProtected() && currentDerivedKey) {
          currentWorkspace.removePassword(currentDerivedKey)
          currentDerivedKey = null
          derivedKeyCache.delete(currentFilePath)
        }
        settings.getOwnerIdentity().claimWorkspace(currentWorkspace)
      } else {
        // Accepting review is the trust decision that unblocks provisioning
        // deferred at FILE_OPEN (envelopes, sealing) for the user's own files.
        settings.getOwnerIdentity().ensureWorkspaceIdentity(currentWorkspace)
      }

      // Auto-lock security-sensitive fields
      const config = currentWorkspace.getAgentConfig()
      // Apply the model chosen at accept (provider params copied like the
      // AgentConfig provider switch does).
      if (args.model && chosenProvider) {
        config.model.provider = args.model.provider
        config.model.model_id = args.model.model_id
        config.model.params = chosenProvider.params?.length
          ? chosenProvider.params.map((p) => ({ ...p }))
          : undefined
      }
      const fieldsToLock = autoLockFields(config)
      const existing = new Set(config.locked_fields ?? [])
      for (const f of fieldsToLock) {
        existing.add(f)
      }
      config.locked_fields = [...existing]
      currentWorkspace.setAgentConfig(config)

      // Mark agent ID as reviewed
      settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), config))

      // An accepted agent must survive restart: files opened from untracked
      // locations move into the managed adf-agents folder.
      return { success: true, ...persistAcceptedAgent() }
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

  ipcMain.handle(IPC.DOC_GET_AGENT_CONFIG, async () => {
    if (!currentWorkspace) return null
    return currentWorkspace.getAgentConfig()
  })

  ipcMain.handle(IPC.DOC_SET_AGENT_CONFIG, async (_event, config: AgentConfig) => {
    if (!currentWorkspace) return { success: false, error: 'No file open' }
    const previousConfig = currentWorkspace.getAgentConfig()
    // A save racing a file switch must never write one agent's entire config
    // into another agent's workspace: config identity is authoritative. The
    // renderer re-syncs from the backend when a save is refused.
    if (config?.id && previousConfig.id && config.id !== previousConfig.id) {
      return { success: false, error: 'Save refused: config belongs to a different agent file' }
    }
    currentWorkspace.setAgentConfig(config)

    // Turning skills on has to reindex right now: the indexer only ever runs
    // off a file write, so without this the catalog stays empty (and any
    // agent-authored skills-registry.json stays un-adopted at protection
    // `none`) until something happens to touch skills/. Turning it off hands
    // the derived registry back to the agent.
    applySkillsConfigChange(currentWorkspace, previousConfig, config)

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

    // Connect newly-attached MCP servers (and disconnect removed ones) live, so
    // a server added from the Agents screen loads its tools without a restart.
    // Fire-and-forget: never block the config save on an MCP connect; the
    // reconcile logs and continues past any single server's failure. Only set
    // when a foreground agent is running (nulled on teardown).
    if (currentMcpReconcile) {
      void currentMcpReconcile(config).catch((err) =>
        console.error('[MCP] Config-driven reconcile failed:', err instanceof Error ? err.message : err))
    }

    // Keep the .adf file name in sync with a changed agent name
    if (currentFilePath && config.name !== previousConfig.name) {
      const sync = syncAgentFileToName(currentFilePath, config.name)
      if (sync.filePath) return { success: true, filePath: sync.filePath }
      if (sync.deferred) return { success: true, renameDeferred: true }
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
          llmMessages: [],
          earlierCount: offset
        }
      }
    } catch (error) {
      console.error('[IPC] DOC_GET_CHAT error:', error)
      return { chatHistory: null }
    }
  })

  // Keyset page of loop entries older than `beforeSeq` (for scroll-back).
  // OFFSET-based paging is unstable while the agent appends; seq is not.
  ipcMain.handle(IPC.DOC_GET_CHAT_OLDER, async (_event, args: { beforeSeq: number; limit?: number }) => {
    try {
      if (!currentWorkspace) return { uiLog: [], earlierCount: 0 }
      const limit = Math.min(Math.max(args?.limit ?? LOOP_DISPLAY_LIMIT, 1), 500)
      const loopEntries = currentWorkspace.getLoopBefore(args.beforeSeq, limit)
      const earlierCount = loopEntries.length > 0
        ? currentWorkspace.getLoopCountBefore(loopEntries[0].seq)
        : 0
      return { uiLog: parseLoopToDisplay(loopEntries), earlierCount }
    } catch (error) {
      console.error('[IPC] DOC_GET_CHAT_OLDER error:', error)
      return { uiLog: [], earlierCount: 0 }
    }
  })

  ipcMain.handle(IPC.DOC_SET_CHAT, async () => {
    // In v0.1, chat is stored in loop table and managed by the runtime
    // UI doesn't directly set chat history
    return { success: true }
  })

  ipcMain.handle(IPC.DOC_CLEAR_CHAT, async () => {
    if (!currentWorkspace) return { success: false }

    // onCommitted runs synchronously in the loop-table COMMIT's tick, so a turn
    // dispatched while clearLoop awaited its backup/compression cannot slip
    // between the wipe and the session reset.
    await currentWorkspace.clearLoop({
      onCommitted: () => {
        currentSession?.reset()
        // Reset executor context state so the system prompt / dynamic
        // instructions are re-injected into the wiped loop and injected files
        // re-snapshotted (same reset the loop_clear tool does internally).
        agentExecutor?.resetContextState()
      }
    })

    if (meshManager?.isEnabled() && currentFilePath) {
      await meshManager.resetAgentSession(currentFilePath)
    }

    return { success: true }
  })

  // --- Inbox ---

  ipcMain.handle(IPC.DOC_GET_INBOX, async () => {
    const t0 = performance.now()
    if (!currentWorkspace) return { inbox: null }
    // Include archived: the agent's tools can read archived messages, so the
    // operator must be able to see them too (the Archived tab was always empty).
    const unread = currentWorkspace.getInbox('unread')
    const read = currentWorkspace.getInbox('read')
    const archived = currentWorkspace.getInbox('archived')
    const messages = [...unread, ...read, ...archived]
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
    withSource('system:studio', currentWorkspace.getAgentConfig().id, () => {
      currentWorkspace!.writeFileBuffer(path, buffer, mimeType ?? 'application/octet-stream')
    })
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
        withSource('system:studio', currentWorkspace!.getAgentConfig().id, () => {
          currentWorkspace!.writeFileBuffer(vfsPath, data, currentWorkspace!.getMimeType(vfsPath))
        })
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
        withSource('system:studio', currentWorkspace!.getAgentConfig().id, () => {
          currentWorkspace!.writeFileBuffer(vfsPath, data, currentWorkspace!.getMimeType(vfsPath))
        })
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
    return { success: withSource('system:studio', currentWorkspace.getAgentConfig().id, () => currentWorkspace!.deleteFile(path)) }
  })

  ipcMain.handle(IPC.DOC_RENAME_INTERNAL_FILE, async (_event, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
    if (!currentWorkspace) return { success: false }
    try {
      return { success: withSource('system:studio', currentWorkspace.getAgentConfig().id, () => currentWorkspace!.renameInternalFile(oldPath, newPath)) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DOC_RENAME_FOLDER, async (_event, { oldPrefix, newPrefix }: { oldPrefix: string; newPrefix: string }) => {
    if (!currentWorkspace) return { success: false, count: 0 }
    try {
      const count = withSource('system:studio', currentWorkspace.getAgentConfig().id, () => currentWorkspace!.renameFolder(oldPrefix, newPrefix))
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
    withSource('system:studio', currentWorkspace.getAgentConfig().id, () => {
      currentWorkspace!.writeFile(path, content)
    })
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
      return { document: '', agentConfig: null, chat: null }
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
    const agentConfig = currentWorkspace.getAgentConfig()
    const lastTokens = currentWorkspace.getLastAssistantTokens()
    const statusText = currentWorkspace.getMeta('status') ?? ''
    console.log(`[PERF] DOC_GET_BATCH.readDocConfig: ${(performance.now() - t1).toFixed(1)}ms`)

    const result = {
      document,
      agentConfig,
      lastTokens,
      statusText,
      chat: {
        version: 1,
        uiLog: displayEntries,
        llmMessages: [],
        earlierCount: offset
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
      if (currentAssembledAgent) {
        const handle = currentAssembledAgent
        const capturedWorkspace = currentWorkspace
        const capturedSession = currentSession!
        const capturedFilePath = currentFilePath
        const config = capturedWorkspace.getAgentConfig()
        let lastAgentName = config.name
        agentExecutor.updateConfig(config)
        currentHostAttachment?.detach()
        currentHostAttachment = handle.attachHost({
          onEvent: (event) => {
            if (currentFilePath === capturedFilePath) getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event)
            if (event.type === 'state_changed' && (event.payload as { state?: string }).state === 'off') {
              void handleAgentOff(capturedFilePath)
            }
            if (event.type === 'adf_file_created') {
              const createdPath = (event.payload as { filePath?: string }).filePath
              if (createdPath) notifyAdfFileCreated(createdPath)
            }
          },
          onAdfEvent: (event) => {
            if (currentFilePath === capturedFilePath) getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event)
          },
          onTriggerEvent: (event) => getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event),
          onTriggerError: (error, dispatch) => {
            const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
            try { capturedWorkspace.insertLog('error', 'runtime', 'trigger_error', eventType, String(error).slice(0, 200)) } catch { /* non-fatal */ }
            getMainWindow()?.webContents.send(IPC.AGENT_EVENT, {
              type: 'error',
              payload: { error: String(error) },
              timestamp: Date.now(),
            })
          },
          onConfigChanged: async (updatedConfig) => {
            meshManager?.updateAgentConfig(capturedFilePath, updatedConfig)
            if (capturedFilePath && updatedConfig.name !== lastAgentName) {
              lastAgentName = updatedConfig.name
              syncAgentFileToName(capturedFilePath, updatedConfig.name)
            }
            if (!currentAdapterManager) return
            await currentAdapterManager.reconcile({
              registrations: withBuiltInAdapterRegistrations(settings.get('adapters') as AdapterRegistration[] | undefined),
              adaptersConfig: updatedConfig.adapters,
              workspace: capturedWorkspace,
              derivedKey: currentDerivedKey,
              resolveFactory: async (type, reg) => {
                const installed = reg.npmPackage ? adapterPackageResolver.getInstalled(reg.npmPackage) : null
                let createFn = await loadBuiltInAdapter(type)
                if (!createFn && installed && reg.npmPackage) {
                  const mod = require(join(installed.installPath, 'node_modules', reg.npmPackage))
                  createFn = mod.createAdapter ?? mod.default?.createAdapter
                }
                return createFn ?? null
              },
            })
          },
          onAutostartChild: async (childPath) => backgroundAgentManager?.startAgent(childPath) ?? false,
        })
        triggerEvaluator = handle.triggerEvaluator
        currentSession = handle.session
        currentAgentToolRegistry = handle.registry
        extractedDisplayState = null

        if (meshManager?.isEnabled()) {
          meshManager.registerAgent(
            capturedFilePath, config, handle.registry,
            capturedWorkspace, capturedSession, handle.triggerEvaluator, true,
            () => handle.executor.isMessageTriggered,
            handle.executor,
            handle.adfCallHandler, codeSandboxService,
          )
          syncDerivedKeyToMesh(capturedFilePath, currentDerivedKey)
          if (currentAdapterManager) meshManager.setAdapterManager(capturedFilePath, currentAdapterManager)
        }

        const displayState = handle.triggerEvaluator.getDisplayState()
        return {
          success: true,
          sessionId: capturedSession.getSessionId(),
          agentState: displayState,
          pendingApprovals: handle.executor.getPendingApprovals(),
          pendingAsks: handle.executor.getPendingAsks(),
        }
      }
      throw new Error('Running foreground executor is missing its assembled lifecycle handle')
    }

    // Error/stopped handles cannot restart. Dispose the old recipe once, retain
    // its session for loop continuity, and construct a fresh stable handle.
    if (currentAssembledAgent) {
      const staleHandle = currentAssembledAgent
      currentHostAttachment?.detach()
      currentHostAttachment = null
      currentAssembledAgent = null
      await staleHandle.disposeAsync({ mode: 'immediate' })
      agentExecutor = null
      triggerEvaluator = null
      currentMcpManager = null
      currentMcpReconcile = null
      currentScratchDir = null
      currentAdapterManager = null
      currentStreamBindingManager = null
      currentTapManager = null
    }

    // Capture all context BEFORE any async operations so concurrent FILE_OPEN
    // cannot swap the globals out from under us during awaits.
    const capturedFilePath = currentFilePath
    const capturedWorkspace = currentWorkspace
    const capturedSession = currentSession
    const capturedDerivedKey = currentDerivedKey

    // Hybrid capture-on-attach (docs/design/mcp-http-oauth.md, decision #1):
    // before an http+oauth connect, seal the Settings-level (app-store) token
    // into THIS agent's keystore so the grant travels with the .adf and a daemon
    // with a provisioned key can refresh it. No-op when the user isn't signed in
    // — the connect then fails plainly with the "sign in from Settings" status.
    // Never fatal: a locked keystore is logged, not thrown, so the surrounding
    // connect path is unaffected.
    const captureAttachedOAuthToken = async (
      cfg: import('../../shared/types/adf-v02.types').McpServerConfig,
    ): Promise<void> => {
      if (!cfg.oauth || !cfg.url) return
      const appStore = getAppOAuthStore()
      const agentStore = new AgentKeystoreOAuthStore(capturedWorkspace, cfg.name, capturedDerivedKey)
      try {
        await captureOAuthToAgent(appStore, agentStore, cfg.url)
      } catch (e) {
        console.warn(`[MCP] OAuth capture-on-attach failed for "${cfg.name}":`, e instanceof Error ? e.message : e)
      }

      // FOREGROUND interactive sign-in: when an agent attaches/installs an OAuth
      // remote from its loop and the server has no stored token yet, drive the
      // browser consent flow here — the same interactive capability the stdio
      // auth preflight (studioMcpAuthPreflight) already grants agents in Studio.
      // This runs blockingly during the agent's mcp_install/mcp_restart call.
      //
      // CONSENT: routed through the SAME shared HIL gate as the background path
      // (gateInteractiveOAuthSignIn). getMainWindow() is only a PRECONDITION
      // (headless can't prompt), NOT consent — the live agent executor's HIL
      // approval is. So an autonomous mcp_restart/mcp_install (e.g. driven by a
      // prompt-injected inbound message or an on_timer trigger) can never
      // surprise-open a browser without human approval, matching the background
      // gate. No live executor (an initial-startup connect, not a loop call) ⇒
      // the helper never prompts and never opens a browser (a token must
      // pre-exist). The daemon/background connect paths build their own managers
      // with the SILENT provider and never call this helper.
      try {
        if (getMainWindow()) {
          const regs = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
          const reg = regs.find((r) => r.name === cfg.name) as
            | { oauthClientId?: string; oauthScopes?: string[] }
            | undefined
          const url = cfg.url
          await gateInteractiveOAuthSignIn({
            server: { name: cfg.name, url },
            // Live foreground executor at connect time (module-level; set during a
            // hot mcp_restart/mcp_install call, null during initial-startup connect).
            executor: agentExecutor,
            isAlreadySignedIn: async () => !!(await appStore.get(url))?.tokens,
            runInteractiveFlow: async () => {
              console.log(`[MCP] OAuth sign-in approved for "${cfg.name}" — opening browser for authorization.`)
              const flow = await runMcpHttpOAuthFlow(url, appStore, studioOAuthIO, {
                clientId: reg?.oauthClientId,
                scopes: reg?.oauthScopes,
              })
              if (!flow.authorized) {
                console.warn(`[MCP] OAuth sign-in for "${cfg.name}" did not complete: ${flow.error ?? 'unknown'}`)
                return false
              }
              // Seal the freshly-signed-in token into this agent's keystore so the
              // silent connect factory finds it (and it travels with the .adf).
              await captureOAuthToAgent(appStore, agentStore, url)
              return true
            },
            log: (level, message) => (level === 'warn' ? console.warn : console.log)(`[MCP] ${message}`),
          })
        }
      } catch (e) {
        console.warn(`[MCP] OAuth interactive sign-in failed for "${cfg.name}":`, e instanceof Error ? e.message : e)
      }
    }

    // Signal that a start is in-flight — prevents cleanupCurrentFile from
    // closing the workspace database while we're still using it.
    startingFilePaths.add(capturedFilePath)

    // Helper: check if the foreground file has changed during an await
    const fileChanged = () => currentFilePath !== capturedFilePath

    // Fresh construction begins with no prior lifecycle owner installed.
    agentExecutor = null
    triggerEvaluator = null
    currentTapManager = null
    currentUmbilicalAgentId = null
    currentStreamBindingManager = null
    currentAdapterManager = null

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
    // Restore when the session is fresh OR was emptied by the background idle
    // sweep — adopting an empty session as-is would silently truncate the LLM
    // context to post-adoption messages while the loop retains full history.
    if (!capturedSession || session.getMessages().length === 0) {
      const tLoop = performance.now()
      const loopEntries = capturedWorkspace.getLoop()
      console.log(`[PERF] AGENT_START.getLoop: ${(performance.now() - tLoop).toFixed(1)}ms (entries=${loopEntries.length})`)
      if (loopEntries.length > 0) {
        session.restoreMessages(loopEntries.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))
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
        // ONLY reads from adf_identity — code_access + spec-D13 key-material guard.
        resolveIdentity: (purpose: string) => capturedWorkspace.getIdentityForCode(purpose, capturedDerivedKey),
        getSigningKey: () => capturedWorkspace.getSigningKeys(capturedDerivedKey)?.privateKey ?? null
      })
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
    ): Promise<McpConnectOutcome> => {
      const serverCfg = freshConfig.mcp?.servers?.find((server) => server.name === serverName)
      if (!serverCfg) throw new Error(`Server "${serverName}" not found.`)
      if (!currentMcpManager) throw new Error('No MCP manager active.')

      const mcpRegistrations = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
      const reg = mcpRegistrations.find((registration) => registration.name === serverCfg.name)
      // SECURITY: for a Settings-registered server, the executable identity
      // (command/args/package/source/run_location/...) comes from the
      // registration, never the agent-writable .adf copy — see
      // pinServerConfigToRegistration. This also lets the Settings "Runs on"
      // toggle govern Settings-managed servers past an attach-time snapshot.
      const connCfg = reg
        ? pinServerConfigToRegistration(serverCfg, reg)
        : { ...serverCfg }

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
      if (connCfg.transport !== 'http' && (connCfg.pypi_package || connCfg.command === 'uvx')) {
        try { uvBinPath = await uvManager.ensureUv() } catch { /* uv not available */ }
      }

      const computeSettings = (settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
      let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
      let location: McpConnectOutcome['location'] = 'host'
      let hostDenied: string | undefined
      if (connCfg.transport === 'http') {
        location = 'remote http'
        await captureAttachedOAuthToken(connCfg)
        console.log(`[MCP] ${reason}: connecting "${serverName}" over HTTP: ${connCfg.url}`)
      } else {
        const willContainer = shouldContainerize(connCfg.name, connCfg, freshConfig, computeSettings)
        console.log(`[MCP] ${reason} routing: containerize=${willContainer}, isolated=${shouldIsolate(freshConfig)}, run_location=${connCfg.run_location ?? 'default'}`)
        if (willContainer) {
          const containerCmd = resolveContainerCommand(connCfg)
          const isolated = shouldIsolate(freshConfig) && !isServerForceShared(connCfg)
          location = isolated ? 'isolated container' : 'shared container'
          hostDenied = hostDenialReason(connCfg.name, connCfg, freshConfig, computeSettings) ?? undefined

          try {
            await (isolated
              ? podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
              : podmanService.ensureRunning())
          } catch (containerErr) {
            const detail = containerErr instanceof Error ? containerErr.message : String(containerErr)
            throw new Error(`MCP container for "${serverName}" is not ready: ${detail} Once the compute environment is fixed, call mcp_restart("${serverName}") to reconnect.`)
          }
          const { isolatedContainerName } = await import('../services/podman.service')
          const podmanBin = await podmanService.findPodman()
          if (!podmanBin) throw new Error(`Podman is unavailable for MCP server "${serverName}" — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute, then call mcp_restart("${serverName}").`)
          const containerName = isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp'
          try { await podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, freshConfig.id)) } catch { /* ignore */ }
          try { await podmanService.ensureWorkspace(containerName, containerAgentHome(isolated, freshConfig.id)) } catch { /* ignore */ }
          // Materialize keystore-held credential files into the container before spawn.
          await materializeCredentialFiles(
            { getDecrypted: (p) => capturedWorkspace.getIdentityDecrypted(p, capturedDerivedKey), hasRow: (p) => capturedWorkspace.getIdentityRow(p) !== null },
            connCfg,
            containerCredentialTarget(podmanService, containerName, containerAgentHome(isolated, freshConfig.id)),
          )
          if (podmanBin) {
            const browserEnv = await podmanService.getBrowserRuntimeEnv()
            console.log(`[MCP] ${reason}: connecting "${serverName}" in container ${containerName}: ${containerCmd.command} ${containerCmd.args.join(' ')}`)
            connectOptions = {
              externalTransport: new PodmanStdioTransport({
                podmanBin,
                containerName,
                command: containerCmd.command,
                args: containerCmd.args,
                // Agent-scoped HOME first — an explicit serverCfg.env.HOME still wins.
                env: { HOME: containerAgentHome(isolated, freshConfig.id), ...connCfg.env, ...browserEnv },
                cwd: containerWorkspacePath(isolated, freshConfig.id),
              })
            }
          }
        } else {
          // Routing chose host: materialize keystore-held credential files to the host home.
          await materializeCredentialFiles(
            { getDecrypted: (p) => capturedWorkspace.getIdentityDecrypted(p, capturedDerivedKey), hasRow: (p) => capturedWorkspace.getIdentityRow(p) !== null },
            connCfg,
            { kind: 'host' },
          )
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
      if (!tools) {
        const state = currentMcpManager.getServerState(serverName)
        const stderrTail = state?.logs.filter((l) => l.stream === 'stderr').slice(-5).map((l) => l.message)
        return {
          toolsDiscovered: 0,
          location,
          hostDenied,
          error: state?.error,
          stderrTail: stderrTail?.length ? stderrTail : undefined
        }
      }

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
      return { toolsDiscovered: tools.length, location, hostDenied }
    }

    // --- Live MCP reconcile ---------------------------------------------------
    // Connect servers newly added to the config, and disconnect ones removed,
    // WITHOUT restarting the agent. Two drivers call this: the Agents-screen
    // edit (DOC_SET_AGENT_CONFIG) and an agent's own sys_update_config
    // (foregroundHost.onConfigChanged). Before this, a user-added server was
    // written to disk + executor config but never spawned — no tools loaded
    // until a stop/restart.
    //
    // `previousReconciledMcpConfig` is the single source of truth for the diff's
    // "before" side, shared across both drivers (the workspace already holds the
    // NEW config by the time either driver fires, so it can't be read there).
    let previousReconciledMcpConfig: AgentConfig = config
    const reconcileMcpServers = async (nextConfig: AgentConfig): Promise<void> => {
      // A save racing a file switch must not reconcile another agent's servers.
      if (currentFilePath !== capturedFilePath || !currentMcpManager) return
      const prev = previousReconciledMcpConfig
      previousReconciledMcpConfig = nextConfig
      const { added, removed } = diffMcpServerNames(prev, nextConfig)
      if (added.length === 0 && removed.length === 0) return

      const mcpRegistrations = (settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
      const registeredNames = new Set(mcpRegistrations.map((r) => r.name))

      for (const name of added) {
        const serverCfg = nextConfig.mcp?.servers?.find((s) => s.name === name)
        if (!serverCfg) continue
        // Same skip rule as the start-up connect loop: never try to spawn a
        // server that isn't Settings-registered unless it carries a `source`
        // (agent-installed via mcp_install or manually configured) — otherwise
        // it's unroutable.
        if (!registeredNames.has(name) && !serverCfg.source) {
          console.log(`[MCP] Reconcile: skipping "${name}" — not registered in Settings`)
          continue
        }
        try {
          const result = await connectConfiguredMcpServer(nextConfig, name, 'Attached')
          if (result.toolsDiscovered > 0) {
            console.log(`[MCP] Reconcile: connected "${name}" — ${result.toolsDiscovered} tools now available to agent`)
          } else if (result.error) {
            // Don't dress a hard connect failure up as a credentials hint —
            // the error is the answer.
            console.error(`[MCP] Reconcile: "${name}" failed to connect — no tools available to agent: ${result.error}`)
          } else {
            console.warn(`[MCP] Reconcile: "${name}" connected with no tools (may need credentials or a later reconnect)`)
          }
        } catch (err) {
          // One server's failure must not abort the others or the config save.
          console.error(`[MCP] Reconcile: connect failed for "${name}":`, err instanceof Error ? err.message : err)
        }
      }

      for (const name of removed) {
        try {
          await currentMcpManager.disconnect(name)
        } catch (err) {
          console.warn(`[MCP] Reconcile: disconnect failed for "${name}":`, err instanceof Error ? err.message : err)
        }
        // Unregister the server's discovered tools from the live registry so
        // they stop reaching the model (mirrors mcp_uninstall's config-tool
        // cleanup, which strips the same mcp_{name}_* prefix).
        const toolPrefix = `mcp_${name}_`
        for (const tool of agentToolRegistry.getAll()) {
          if (tool.name.startsWith(toolPrefix)) agentToolRegistry.unregister(tool.name)
        }
      }
    }

    // Register MCP management tools unconditionally — declared/enabled gating
    // happens per-call in AdfCallHandler, and gating registration on the
    // start-time config leaves the registry stale when tools are enabled later.
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

          // SECURITY: pin the executable identity to the Settings registration
          // (if any) so a tampered .adf command/args can't run under auth or
          // hot-load. The .adf's agent-scoped env values still apply.
          const hotReg = ((settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []).find((r) => r.name === serverName)
          const connCfg = hotReg ? pinServerConfigToRegistration(serverCfg, hotReg) : { ...serverCfg }

          // Resolve uv binary path for pypi packages
          let uvBinPath: string | undefined
          if (connCfg.pypi_package || connCfg.command === 'uvx') {
            try { uvBinPath = await uvManager.ensureUv() } catch { /* uv not available */ }
          }

          // Resolve credentials from identity keystore
          const resolvedEnv = resolveMcpEnvVars(connCfg, (k) => capturedWorkspace.getIdentityDecrypted(k, capturedDerivedKey))
          if (Object.keys(resolvedEnv).length) {
            connCfg.env = { ...connCfg.env, ...resolvedEnv }
          }

          // --- Auth preflight: spawn stdio server once for interactive auth (OAuth etc.) ---
          // connCfg.env already carries the identity-resolved credentials, so no
          // separate resolvedEnv is passed here (container mode forwards
          // connCfg.env as -e flags).
          if (installOptions?.auth && connCfg.transport !== 'http') {
            // Mirror the connect path's routing: containerized servers run the
            // auth subcommand INSIDE their container so tokens persist where
            // the server will run; genuinely host-routed servers stay on host.
            let container: import('../services/mcp-auth-preflight').ContainerAuthTarget | undefined
            const computeSettings = (settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
            const willContainerize = shouldContainerize(connCfg.name, connCfg, freshConfig, computeSettings)
            if (podmanService && willContainerize) {
              const isolated = shouldIsolate(freshConfig) && !isServerForceShared(connCfg)
              await (isolated
                ? podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
                : podmanService.ensureRunning())
              const podmanBin = await podmanService.findPodman()
              if (!podmanBin) throw new Error(`Podman is unavailable for MCP server "${serverName}" — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute, then call mcp_restart("${serverName}").`)
              const cc = resolveContainerCommand(connCfg)
              container = {
                podmanBin,
                containerName: isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp',
                command: cc.command,
                args: cc.args,
                home: containerAgentHome(isolated, freshConfig.id),
              }
              // The auth subcommand writes tokens into $HOME — make sure it exists.
              try { await podmanService.ensureWorkspace(container.containerName, container.home!) } catch { /* wrapper-less exec may still mkdir via server */ }
            }
            const credStore = { getDecrypted: (p: string) => capturedWorkspace.getIdentityDecrypted(p, capturedDerivedKey), hasRow: (p: string) => capturedWorkspace.getIdentityRow(p) !== null }
            // Host credential target ONLY when routing chose host — a
            // container-intended server must never materialize or capture
            // credentials on the host filesystem.
            const credTarget: CredentialFileTarget | null = container
              ? containerCredentialTarget(podmanService, container.containerName, container.home ?? '/root')
              : (!willContainerize ? { kind: 'host' } : null)
            if (credTarget) await materializeCredentialFiles(credStore, connCfg, credTarget)
            await studioMcpAuthPreflight(connCfg, { authArgs: installOptions.authArgs, uvBinPath, container, authPort: installOptions.authPort })
            // Auth succeeded: capture files the flow stored (tokens) into the keystore.
            if (credTarget) await writeBackCredentialFiles({ setIdentitySealed: (p, v) => capturedWorkspace.setIdentitySealed(p, v) }, connCfg, credTarget, new Date().toISOString(), (m) => { console.log(m); try { capturedWorkspace.insertLog('info', 'mcp', 'credential_writeback', connCfg.name, m.slice(0, 500)) } catch { /* non-fatal */ } })
          } else if (installOptions?.auth) {
            console.warn(`[MCP] Auth preflight skipped for HTTP server "${serverName}" — HTTP auth flows are configured through headers/env.`)
          }

          const result = await connectConfiguredMcpServer(freshConfig, serverName, 'Hot-load')
          if (result.toolsDiscovered > 0) {
            console.log(`[MCP] Hot-loaded "${serverName}" — ${result.toolsDiscovered} tools now available to agent`)
          } else {
            console.warn(`[MCP] Hot-load discovered no tools for "${serverName}" — server may need credentials or a later reconnect`)
          }
          return result
        } catch (err) {
          console.error(`[MCP] Hot-load failed for "${serverName}":`, err)
          throw err
        }
    }, getMcpRegistrationsForAttach))
    agentToolRegistry.register(new McpRestartTool(async (serverName) => {
      console.log(`[MCP] Agent requested reconnect for "${serverName}"`)
      const freshConfig = capturedWorkspace.getAgentConfig()
      return connectConfiguredMcpServer(freshConfig, serverName, 'Agent reconnect')
    }))
    agentToolRegistry.register(new McpUninstallTool((serverName) => {
      console.log(`[MCP] Agent uninstalled server "${serverName}"`)
      currentMcpManager?.disconnect(serverName).catch(() => {})
    }))

    // Compute tools: always register (shared container is always available)
    const computeSettings = settings.get('compute') as Record<string, unknown> | undefined
    const targetSelection = resolveAgentComputeTargetSelection(computeSettings, config.compute)
    const computeCaps: ComputeCapabilities = {
      hasIsolated: !!(config.compute?.enabled && podmanService),
      hasShared: !!podmanService,
      hasHost: !!config.compute?.host_access && computeSettings?.hostAccessEnabled === true,
      ...targetSelection,
      isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
      browserDisplay: config.compute?.browser !== false,
      agentId: config.id,
    }

    // Pre-create isolated container when compute.enabled
    if (computeCaps.hasIsolated && podmanService) {
      podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip, currentFilePath ?? undefined, config.compute?.browser !== false)
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

    const newStreamBindingManager = new StreamBindingManager(config.id, config.name, capturedFilePath, config.stream_bind, wsConnectionManager, podmanService, capturedWorkspace)
    agentToolRegistry.register(new StreamBindTool(newStreamBindingManager))
    agentToolRegistry.register(new StreamUnbindTool(newStreamBindingManager))
    agentToolRegistry.register(new StreamBindingsTool(newStreamBindingManager))

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
    // True when the MCP startup sync persisted onto the live workspace config —
    // the workspace copy is then authoritative over the start-time snapshot.
    let mcpStartupSyncPersisted = false
    let newScratchDir: string | null = createScratchDir(capturedFilePath)
    // OAuth (http) connect factory: prefer the agent-sealed token (capture-on-
    // attach seals it into this agent's keystore before the http connect below),
    // falling back to the app store only when there is no agent keystore. Silent
    // attach + refresh only — the interactive sign-in lives in the Settings test
    // handler, never in a connect.
    const mcpOAuthProviderFactory = buildOAuthProviderFactory((cfg) =>
      resolveOAuthStoreForConnect({
        agentStore: new AgentKeystoreOAuthStore(capturedWorkspace, cfg.name, capturedDerivedKey),
        appStore: getAppOAuthStore(),
      }),
    )
    const mcpManager = new McpClientManager(newScratchDir, mcpOAuthProviderFactory)
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

      // Re-register tools when a server reconnects after an unexpected disconnect.
      // This listener lives for the agent's whole lifetime, so it MUST NOT sync
      // into the start-time `config` snapshot: doing so wrote that snapshot back
      // over the workspace + executor on every reconnect, silently reverting all
      // config changes made since start (UI toggles, sys_update_config, Always
      // approve) — the UI kept showing a tool enabled while the shell gate saw
      // the clobbered declaration and exited 126 "disabled".
      mcpManager.on('tools-discovered', (serverName, tools) => {
        // After a transition to background this agent has its own listener in
        // BackgroundAgentManager; the foreground globals (agentExecutor) then
        // belong to a DIFFERENT agent and must not receive this config.
        if (currentFilePath !== capturedFilePath) return
        try {
          resyncServerTools({
            getFreshConfig: () => capturedWorkspace.getAgentConfig(),
            serverName,
            tools,
            registry: agentToolRegistry,
            manager: mcpManager,
            persist: (fresh) => capturedWorkspace.setAgentConfig(fresh),
            fanOut: (fresh) => {
              agentExecutor?.updateConfig(fresh)
              adfCallHandler?.updateConfig(fresh)
            },
          })
        } catch (err) {
          console.error(`[MCP] Reconnect tool resync failed for "${serverName}":`, err)
          return
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

        const connectPromise = Promise.allSettled(
          config.mcp.servers.map(async (serverCfg) => {
            // Skip servers not registered in Settings — unless they have a source
            // field (agent-installed via mcp_install or manually configured)
            if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
              console.log(`[MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
              return { serverCfg, tools: null as import('../../shared/types/adf-v02.types').McpToolInfo[] | null, skipped: true }
            }

            // Build a connection config — never mutate the original serverCfg
            // so the ADF config stays clean when saved back.
            // SECURITY: for a Settings-registered server, the executable
            // identity (command/args/package/source/run_location/...) comes
            // from the registration, never the agent-writable .adf copy —
            // see pinServerConfigToRegistration.
            const reg = mcpRegistrations.find((r) => r.name === serverCfg.name)
            const connCfg = reg
              ? pinServerConfigToRegistration(serverCfg, reg)
              : { ...serverCfg }

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
              await captureAttachedOAuthToken(connCfg)
              console.log(`[MCP] Connecting "${connCfg.name}" (http): url=${connCfg.url}`)
            } else if (shouldContainerize(connCfg.name, connCfg, config, computeSettings)) {
              // Container path: resolve commands for in-container execution
              const containerCmd = resolveContainerCommand(connCfg)
              const isolated = shouldIsolate(config) && !isServerForceShared(connCfg)
              try {
                if (isolated) {
                  await podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip)
                } else {
                  await podmanService.ensureRunning()
                }
              } catch (containerErr) {
                const detail = containerErr instanceof Error ? containerErr.message : String(containerErr)
                throw new Error(`MCP container for "${connCfg.name}" is not ready: ${detail} Once the compute environment is fixed, call mcp_restart("${connCfg.name}") to reconnect.`)
              }
              const { isolatedContainerName } = await import('../services/podman.service')
              const podmanBin = await podmanService.findPodman()
              if (!podmanBin) throw new Error(`Podman is unavailable for MCP server "${connCfg.name}" — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute, then call mcp_restart("${connCfg.name}").`)
              const containerName = isolated ? isolatedContainerName(config.name, config.id) : 'adf-mcp'
              try { await podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, config.id)) } catch { /* ignore */ }
              try { await podmanService.ensureWorkspace(containerName, containerAgentHome(isolated, config.id)) } catch { /* ignore */ }
              await materializeCredentialFiles(
                { getDecrypted: (p) => capturedWorkspace.getIdentityDecrypted(p, capturedDerivedKey), hasRow: (p) => capturedWorkspace.getIdentityRow(p) !== null },
                connCfg,
                containerCredentialTarget(podmanService, containerName, containerAgentHome(isolated, config.id)),
              )
              const browserEnv = await podmanService.getBrowserRuntimeEnv()
              // Agent-scoped HOME first — an explicit serverCfg.env.HOME still wins.
              const transportEnv = { HOME: containerAgentHome(isolated, config.id), ...connCfg.env, ...browserEnv }
              const envKeys = Object.keys(transportEnv)
              console.log(`[MCP] Connecting "${connCfg.name}" (container ${containerName}): ${containerCmd.command} ${containerCmd.args.join(' ')}${envKeys.length ? ` [env: ${envKeys.join(', ')}]` : ''}`)
              connectOptions = {
                externalTransport: new PodmanStdioTransport({
                  podmanBin,
                  containerName,
                  command: containerCmd.command,
                  args: containerCmd.args,
                  env: transportEnv,
                  cwd: containerWorkspacePath(isolated, config.id),
                })
              }
            } else {
              // Routing chose host: materialize keystore-held credential files to the host home.
              await materializeCredentialFiles(
                { getDecrypted: (p) => capturedWorkspace.getIdentityDecrypted(p, capturedDerivedKey), hasRow: (p) => capturedWorkspace.getIdentityRow(p) !== null },
                connCfg,
                { kind: 'host' },
              )
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

        // Per-agent MCP connect budget (parity with the background paths): a
        // single hung server must not stall foreground agent start. Past the
        // deadline the agent proceeds degraded — unconnected servers' tools
        // stay unavailable and auto-restart recovers in the background.
        const { timedOut: mcpTimedOut, value: mcpResults } = await withDeadline(connectPromise, MCP_CONNECT_BUDGET_MS, () => {
          console.error(`[MCP] Connect budget (${MCP_CONNECT_BUDGET_MS}ms) exceeded for ${config.name} — starting degraded; pending MCP servers will keep connecting in the background`)
          try { capturedWorkspace.insertLog('error', 'mcp', 'connect_timeout', null, `MCP connect budget exceeded after ${MCP_CONNECT_BUDGET_MS}ms — agent started degraded; pending servers recover in background`) } catch { /* ignore */ }
        })
        const results = mcpTimedOut || !mcpResults ? [] : mcpResults

        // Collect names of servers that connected or attempted (vs skipped/unregistered)
        const connectedServerNames = new Set<string>()
        const attemptedServerNames = new Set<string>()
        const syncedResults: Array<{ name: string; tools: import('../../shared/types/adf-v02.types').McpToolInfo[]; appEnvKeys?: string[]; agentEnvKeys?: string[] }> = []
        if (mcpTimedOut) {
          // Deadline hit: treat every registered server as "attempted" so the
          // disable-loop below does not persistently turn off tools for
          // servers that may still connect late or via auto-restart.
          for (const serverCfg of config.mcp.servers) {
            if (registeredNames.has(serverCfg.name) || serverCfg.source) attemptedServerNames.add(serverCfg.name)
          }
        }
        for (let index = 0; index < results.length; index++) {
          const result = results[index]
          if (result.status !== 'fulfilled') {
            const serverName = config.mcp.servers[index]?.name
            if (serverName) attemptedServerNames.add(serverName)
            console.warn(`[MCP] Startup connection failed for "${serverName ?? 'unknown'}":`, result.reason)
            continue
          }
          if (result.value.skipped) continue
          attemptedServerNames.add(result.value.serverCfg.name)
          if (!result.value.tools) continue
          const { serverCfg, tools, appEnvKeys, agentEnvKeys } = result.value
          connectedServerNames.add(serverCfg.name)
          syncedResults.push({ name: serverCfg.name, tools, appEnvKeys, agentEnvKeys })
        }

        // Apply the sync results onto the CURRENT workspace config, not the
        // start-time snapshot. The connect phase awaits for seconds; a config
        // write landing in that window (UI toggle via DOC_SET — which finds no
        // executor to fan out to yet) lives only in the workspace. Persisting
        // the snapshot here would silently revert it, leaving the UI showing a
        // tool enabled while the executor/shell gate sees it disabled. This
        // block has no awaits between the read and the write, so it cannot
        // race another IPC handler on the main thread.
        {
          const freshStartConfig = capturedWorkspace.getAgentConfig()
          let configChanged = false
          for (const synced of syncedResults) {
            const freshServerCfg = freshStartConfig.mcp?.servers?.find((s) => s.name === synced.name)
            if (!freshServerCfg) continue // server removed mid-start — nothing to persist
            if (syncDiscoveredMcpTools(freshStartConfig, freshServerCfg, synced.tools, agentToolRegistry, mcpManager)) {
              configChanged = true
            }
            const nextSchema = captureEnvSchema(freshServerCfg, synced.appEnvKeys ?? [], synced.agentEnvKeys ?? [])
            if (nextSchema) {
              freshServerCfg.env_schema = nextSchema
              configChanged = true
            }
          }

          // Disable tools only from skipped (unregistered) servers — NOT from servers
          // that attempted connection but failed (e.g. timeout, auth error)
          for (const decl of freshStartConfig.tools) {
            if (!decl.name.startsWith('mcp_')) continue
            const serverName = freshStartConfig.mcp?.servers?.find((s) => decl.name.startsWith(`mcp_${s.name}_`))?.name
            if (serverName && !connectedServerNames.has(serverName) && !attemptedServerNames.has(serverName) && decl.enabled) {
              decl.enabled = false
              configChanged = true
            }
          }

          if (configChanged) {
            capturedWorkspace.setAgentConfig(freshStartConfig)
            mcpStartupSyncPersisted = true
          }
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

    // adf_shell registration happens in assembleAgent (always registered;
    // exposure is governed solely by the declaration's enabled/visible flags).

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

        // Try in-tree built-in adapter first, then fall back to npm package
        let createFn: CreateAdapterFn | null = null
        try {
          createFn = await loadBuiltInAdapter(adapterType)
          if (!createFn && installed) {
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

      // Render inbound state here; the canonical assembler is the sole owner
      // of adapter-inbound trigger delivery.
      adapterMgr.on('inbound', () => {
        const unread = capturedWorkspace.getInbox('unread')
        const read = capturedWorkspace.getInbox('read')
        const archived = capturedWorkspace.getInbox('archived')
        const allMessages = [...unread, ...read, ...archived]

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

    newStreamBindingManager.loadDeclarations(config.stream_bindings ?? [])

    // Shared with the daemon and the Studio background manager — bus, taps,
    // agent.loaded/unloaded, and the adapter/MCP umbilical bridges all come
    // from runtime/umbilical-lifecycle.ts. Listed FIRST so its start runs
    // before every other resource and its stop runs last.
    const umbilical = createUmbilicalResources({
      agentId: config.id,
      workspace: capturedWorkspace,
      filePath: capturedFilePath,
      config,
      codeSandboxService,
      adfCallHandler,
      adapterManager: newAdapterManager,
      mcpManager: newMcpManager,
    })

    const assembled = assembleAgent({
      profile: 'studioForeground',
      workspace: capturedWorkspace,
      config,
      provider,
      registry: agentToolRegistry,
      session,
      basePrompt,
      toolPrompts,
      compactionPrompt,
      adfCallHandler,
      systemScopeHandler: adfCallHandler
        ? new SystemScopeHandler(capturedWorkspace, codeSandboxService, adfCallHandler, capturedFilePath)
        : null,
      mcpManager: newMcpManager,
      adapterManager: newAdapterManager,
      codeSandboxService,
      streamBindingManager: newStreamBindingManager,
      getTapManager: () => umbilical.lifecycle.getTapManager(),
      scratchDir: newScratchDir,
      ownsWorkspace: false,
      resources: [
        ...umbilical.resources,
        {
          name: 'studio-foreground-resources',
          stop: async () => {
            if (newMcpManager) {
              newMcpManager.removeAllListeners()
              await newMcpManager.disconnectAll()
            }
            if (newAdapterManager) {
              newAdapterManager.removeAllListeners()
              await newAdapterManager.stopAll()
            }
            newStreamBindingManager.stopAll('agent_stopped')
            removeScratchDir(newScratchDir)
            // Prefix reap: lambdas/middleware/taps run in derived sandbox ids
            // (cold lambdas mint one per invocation), so destroying the agent's
            // own id alone would leave those workers running.
            codeSandboxService.destroyForAgent(capturedFilePath)
            codeSandboxService.destroyForAgent(config.id)
            if (config.compute?.enabled) {
              podmanService.unregisterAgent(config.id)
              await podmanService.stopIsolated(config.name, config.id).catch(() => {})
            }
          },
        },
      ],
    })
    const newExecutor = assembled.executor
    const newTriggerEvaluator = assembled.triggerEvaluator
    let lastAgentName = config.name
    const foregroundHost: AgentHostBindings = {
      onEvent: (event) => {
        if (currentFilePath === capturedFilePath) {
          getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event)
        }
        if (event.type === 'state_changed' && (event.payload as { state?: string }).state === 'off') {
          void handleAgentOff(capturedFilePath)
        }
        if (event.type === 'adf_file_created') {
          const createdPath = (event.payload as { filePath?: string }).filePath
          if (createdPath) notifyAdfFileCreated(createdPath)
        }
      },
      onAdfEvent: (event) => {
        if (currentFilePath === capturedFilePath) getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event)
      },
      onTriggerEvent: (event) => getMainWindow()?.webContents.send(IPC.AGENT_EVENT, event),
      onTriggerError: (error, dispatch) => {
        const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
        try { capturedWorkspace.insertLog('error', 'runtime', 'trigger_error', eventType, String(error).slice(0, 200)) } catch { /* non-fatal */ }
        getMainWindow()?.webContents.send(IPC.AGENT_EVENT, {
          type: 'error',
          payload: { error: String(error) },
          timestamp: Date.now(),
        })
      },
      onConfigChanged: async (updatedConfig) => {
        if (meshManager) meshManager.updateAgentConfig(capturedFilePath, updatedConfig)
        if (updatedConfig.name !== lastAgentName) {
          lastAgentName = updatedConfig.name
          syncAgentFileToName(capturedFilePath, updatedConfig.name)
        }
        // Parity with the Agents-screen edit: an agent that adds/removes an MCP
        // server via sys_update_config (rather than mcp_install/mcp_uninstall)
        // gets it connected/disconnected live. Fire-and-forget — never block the
        // tool return on a container spawn; failures are logged inside.
        void reconcileMcpServers(updatedConfig).catch((err) =>
          console.error('[MCP] sys_update_config reconcile failed:', err instanceof Error ? err.message : err))
        if (!newAdapterManager) return
        await newAdapterManager.reconcile({
          registrations: adapterRegistrations,
          adaptersConfig: updatedConfig.adapters,
          workspace: capturedWorkspace,
          derivedKey: capturedDerivedKey,
          resolveFactory: async (type, reg) => {
            const installed = reg.npmPackage ? adapterPackageResolver.getInstalled(reg.npmPackage) : null
            let createFn = await loadBuiltInAdapter(type)
            if (!createFn && installed && reg.npmPackage) {
              const mod = require(join(installed.installPath, 'node_modules', reg.npmPackage))
              createFn = mod.createAdapter ?? mod.default?.createAdapter
            }
            return createFn ?? null
          },
        })
      },
      onAutostartChild: async (childPath) => backgroundAgentManager?.startAgent(childPath) ?? false,
    }
    await assembled.start()

    // Adopt config writes that landed during the async startup window. While
    // this handler was awaiting (provider validation, MCP connects, adapters,
    // assembled.start()), `agentExecutor` was null, so DOC_SET_AGENT_CONFIG
    // persisted to the workspace with no executor to fan out to. Without this
    // adoption the fresh executor — and the adf_shell gate, which reads
    // through it — would keep the pre-start snapshot: the UI shows a tool
    // enabled while the shell exits 126 "disabled" until the next config
    // write happens to fan out. There are no further awaits before install,
    // so this cannot race another IPC handler.
    const workspaceConfigAtInstall = capturedWorkspace.getAgentConfig()
    const finalConfig = mcpStartupSyncPersisted
      ? workspaceConfigAtInstall
      : pickFresherConfig(config, workspaceConfigAtInstall)
    if (finalConfig !== config) {
      newExecutor.updateConfig(finalConfig)
      newTriggerEvaluator.updateConfig(finalConfig)
      adfCallHandler?.updateConfig(finalConfig)
      lastAgentName = finalConfig.name
    }

    // Emit initial display state based on start_in_state config
    const initialDisplayState = finalConfig.start_in_state ?? 'idle'

    // If the user navigated away during setup, transition to background instead
    // of installing into foreground globals — mirrors what cleanupCurrentFile does.
    if (fileChanged()) {
      console.log(`[AGENT_START] File changed during startup, transitioning ${capturedFilePath} to background`)
      if (backgroundAgentManager && !backgroundAgentManager.hasAgent(capturedFilePath)) {
        await backgroundAgentManager.transitionToBackground(
          capturedFilePath, finalConfig, assembled, capturedDerivedKey,
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
        assembled.setWorkspaceOwnership(true)
        await assembled.disposeAsync({ mode: 'immediate' })
      }
      startingFilePaths.delete(capturedFilePath)
      console.log(`[PERF] AGENT_START (fresh, to background): ${(performance.now() - t0).toFixed(1)}ms`)
      return { success: true, sessionId: session.getSessionId(), agentState: initialDisplayState }
    }

    // Install into foreground globals
    const foregroundAttachment = assembled.attachHost(foregroundHost)
    currentAssembledAgent = assembled
    currentHostAttachment = foregroundAttachment
    currentUmbilicalAgentId = config.id
    agentExecutor = newExecutor
    triggerEvaluator = newTriggerEvaluator
    currentSession = session
    currentAgentToolRegistry = agentToolRegistry
    currentMcpManager = newMcpManager
    // Adopt any config writes from the startup window as the reconcile baseline,
    // then expose the reconcile to the module-level DOC_SET_AGENT_CONFIG handler.
    previousReconciledMcpConfig = finalConfig
    currentMcpReconcile = reconcileMcpServers
    currentScratchDir = newScratchDir
    currentAdapterManager = newAdapterManager
    currentStreamBindingManager = newStreamBindingManager

    // Taps register inside the umbilical lifecycle resource's start().
    currentTapManager = assembled.tapManager

    // Wire sys_create_adf autostart + child review + default-provider callbacks
    const createAdfTool = agentToolRegistry.get('sys_create_adf') as CreateAdfTool | undefined
    if (createAdfTool) {
      createAdfTool.onChildCreated = (_childPath, childConfig) => {
        settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), childConfig))
      }
      createAdfTool.onAutostartChild = async (childPath) => {
        if (!backgroundAgentManager) return false
        return backgroundAgentManager.tryAutostart(childPath)
      }
      createAdfTool.getDefaultProvider = () => {
        const appProviders = (settings.get('providers') as ProviderConfig[] | undefined) ?? []
        return resolveDefaultProvider(appProviders, settings.get('defaultProviderId') as string | undefined)
      }
    }

    if (meshManager?.isEnabled() && capturedFilePath) {
      meshManager.registerAgent(
        capturedFilePath, finalConfig, agentToolRegistry,
        capturedWorkspace, session, newTriggerEvaluator, true,
        () => newExecutor?.isMessageTriggered ?? false,
        newExecutor ?? null,
        adfCallHandler, codeSandboxService
      )
      newExecutor.updateConfig(finalConfig)
      adfCallHandler?.updateConfig(finalConfig)
      syncDerivedKeyToMesh(capturedFilePath, capturedDerivedKey)

      // Wire adapter manager to mesh for outbound routing
      if (newAdapterManager) {
        meshManager.setAdapterManager(capturedFilePath, newAdapterManager)
      }
    }

    // Startup triggers and the default active-state turn have one shared,
    // handle-owned once gate. A pending user message suppresses both.
    process.nextTick(() => {
      void assembled.dispatchStartup({ hasUserMessage: args?.hasUserMessage }).catch((error) => {
        getMainWindow()?.webContents.send(IPC.AGENT_EVENT, {
          type: 'error',
          payload: { error: String(error) },
          timestamp: Date.now(),
        })
      })
    })

    startingFilePaths.delete(capturedFilePath)
    console.log(`[PERF] AGENT_START (fresh): ${(performance.now() - t0).toFixed(1)}ms`)
    return { success: true, sessionId: session.getSessionId(), agentState: initialDisplayState }
  })

  ipcMain.handle(IPC.AGENT_STOP, async () => {
    const stoppedFilePath = currentFilePath
    const assembled = currentAssembledAgent

    if (meshManager?.isEnabled() && stoppedFilePath) {
      meshManager.unregisterAgent(stoppedFilePath)
    }

    currentHostAttachment?.detach()
    currentHostAttachment = null
    currentAssembledAgent = null
    agentExecutor = null
    triggerEvaluator = null
    currentAdfCallHandler = null
    currentMcpManager = null
    currentMcpReconcile = null
    currentScratchDir = null
    currentAdapterManager = null
    currentStreamBindingManager = null
    currentTapManager = null
    currentSession = null
    currentAgentToolRegistry = null

    if (meshManager && stoppedFilePath) meshManager.removeAdapterManager(stoppedFilePath)
    if (assembled) await assembled.disposeAsync({ mode: 'graceful' })

    if (stoppedFilePath) applyPendingRename(stoppedFilePath)

    return { success: true }
  })

  ipcMain.handle(IPC.AGENT_TOOL_APPROVAL_RESPOND, async (_event, args: { requestId: string; approved: boolean; feedback?: string }) => {
    if (!agentExecutor) {
      return { success: false, error: 'Agent not running' }
    }
    agentExecutor.resolveApproval(args.requestId, args.approved, args.feedback)
    return { success: true }
  })

  // "Always approve": drop the HIL gate on this tool (enabled, un-restricted),
  // persist + propagate the config, then approve the pending request. Refused
  // server-side when the declaration is locked or the approval is a protection
  // override — the UI disables the option, but the backend is the authority.
  ipcMain.handle(IPC.AGENT_TOOL_ALWAYS_APPROVE, async (_event, args: { requestId: string; toolName: string }) => {
    if (!agentExecutor || !currentWorkspace) {
      return { success: false, error: 'Agent not running' }
    }
    const meta = agentExecutor.getPendingApprovalMeta(args.requestId)
    const config = currentWorkspace.getAgentConfig()
    const decl = config.tools?.find((t) => t.name === args.toolName)
    if (meta?.canAlwaysApprove === false || decl?.locked === true) {
      return { success: false, error: meta?.alwaysApproveBlockedReason ?? 'Tool declaration is locked' }
    }
    const tools = config.tools ? [...config.tools] : []
    const idx = tools.findIndex((t) => t.name === args.toolName)
    if (idx >= 0) tools[idx] = { ...tools[idx], enabled: true, restricted: false }
    else tools.push({ name: args.toolName, enabled: true, visible: true, restricted: false })
    const updated: AgentConfig = { ...config, tools }
    currentWorkspace.setAgentConfig(updated)
    agentExecutor.updateConfig(updated)
    triggerEvaluator?.updateConfig(updated)
    currentAdfCallHandler?.updateConfig(updated)
    if (meshManager && currentFilePath) {
      meshManager.updateAgentConfig(currentFilePath, updated)
    }
    agentExecutor.resolveHilTask(args.requestId, true)
    return { success: true }
  })

  // "Approve all": batch-resolve every pending GATED (reason === 'restricted')
  // approval for the foreground agent in one action. Protection/lock overrides
  // are NEVER included — the executor enforces the filter server-side, so the
  // client cannot batch-approve a destructive override. Returns how many were
  // approved and how many protection overrides still need individual review.
  ipcMain.handle(IPC.AGENT_TOOL_APPROVE_ALL_GATED, async () => {
    if (!agentExecutor) {
      return { success: false, error: 'Agent not running' }
    }
    const { approved, skippedProtection } = agentExecutor.approveAllGatedHilTasks()
    return { success: true, approved, skippedProtection }
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

  ipcMain.handle(IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND, async (_event, args: { filePath: string; requestId: string; approved: boolean; feedback?: string }) => {
    if (!backgroundAgentManager) {
      return { success: false, error: 'Background agent manager not initialized' }
    }
    const executor = backgroundAgentManager.getExecutor(args.filePath)
    if (!executor) {
      return { success: false, error: 'Background agent not found' }
    }
    executor.resolveApproval(args.requestId, args.approved, args.feedback)
    return { success: true }
  })

  ipcMain.handle(IPC.BACKGROUND_AGENT_ALWAYS_APPROVE, async (_event, args: { filePath: string; requestId: string; toolName: string }) => {
    if (!backgroundAgentManager) {
      return { success: false, error: 'Background agent manager not initialized' }
    }
    return backgroundAgentManager.alwaysApproveTool(args.filePath, args.requestId, args.toolName)
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
      if (!currentAssembledAgent) {
        return { success: false, error: 'Agent not running' }
      }
      try {
        await currentAssembledAgent.dispatch(createDispatch(createEvent({
          type: 'chat' as const, source: 'system',
          data: { message: { seq: 0, role: 'user' as const, content_json: contentJson, created_at: Date.now() }, echoed: true },
        }), { scope: 'agent' }))
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }

    // Target is a background agent (user navigated away after submitting)
    if (backgroundAgentManager?.hasAgent(targetFile)) {
      const agentRefs = backgroundAgentManager.getAgent(targetFile)
      if (agentRefs?.assembledAgent) {
        try {
          // Direct executor invoke bypasses the trigger evaluator's rehydrate —
          // restore the session first if the idle sweep released it.
          backgroundAgentManager.ensureSessionHydrated(targetFile)
          await agentRefs.assembledAgent.dispatch(createDispatch(createEvent({
            type: 'chat' as const, source: 'system',
            data: { message: { seq: 0, role: 'user' as const, content_json: contentJson, created_at: Date.now() }, echoed: true },
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

    if (cfg.type === 'grok-subscription') {
      const { listGrokSubscriptionModels } = await import('../providers/grok-subscription')
      const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
      return { models: await listGrokSubscriptionModels(getGrokAuthManager()) }
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

    // openai + openai-compatible + openrouter — all use Bearer auth and /models
    try {
      const baseUrl = cfg.type === 'openai'
        ? 'https://api.openai.com/v1'
        : cfg.type === 'openrouter'
          ? (cfg.baseUrl || 'https://openrouter.ai/api/v1')
          : cfg.baseUrl
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
    // Applies live — the gate re-pumps its queue, so raising the ceiling
    // releases waiting executions immediately instead of on restart.
    if ('sandboxMaxWorkers' in newSettings) {
      codeSandboxService.setMaxWorkers(newSettings.sandboxMaxWorkers as number | undefined)
    }
    return { success: true }
  })

  // --- Tracked directories ---

  ipcMain.handle(IPC.TRACKED_DIRS_GET, async () => {
    const stored = (settings.get('trackedDirectories') as string[]) ?? []
    // Collapse duplicates and subdirectories of other tracked dirs that
    // accumulated from earlier auto-track bugs; persist the cleaned list.
    const directories = dedupeTrackedDirectories(stored)
    if (directories.length !== stored.length) {
      settings.set('trackedDirectories', directories)
      if (meshManager) meshManager.setTrackedDirectories(directories)
    }
    for (const dirPath of directories) rememberTrackedDirectory(dirPath)
    startDirWatcher(directories)
    return { directories }
  })

  // Generic directory picker (no side effects — unlike TRACKED_DIRS_ADD,
  // which also tracks the chosen directory). Used by settings fields such as
  // agentsFolder.
  ipcMain.handle(IPC.DIALOG_PICK_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
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
    // Already covered by an existing tracked dir (same dir or a parent)
    if (existing.some((d) => isSameOrSubPath(d, dirPath))) {
      return { directories: existing }
    }
    // A new parent absorbs existing tracked subdirectories
    const updated = [...existing.filter((d) => !isSameOrSubPath(dirPath, d)), dirPath]
    settings.set('trackedDirectories', updated)
    startDirWatcher(updated)
    if (meshManager) {
      meshManager.setTrackedDirectories(updated)
    }
    return { directories: updated }
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
    agentName?: string
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
        agentName: msgConfig?.name,
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

  // Shared by the MESH_ENABLE IPC handler and main-side boot enablement.
  // Idempotent: when mesh is already up (manager enabled + WS manager wired),
  // the renderer's boot-time MESH_ENABLE call is a harmless no-op instead of
  // a full teardown/rebuild that would drop registrations mid-flight.
  async function enableMeshInMain(): Promise<{ success: boolean; error?: string }> {
    try {
      if (meshManager?.isEnabled() && wsConnectionManager) {
        return { success: true }
      }
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
        // A newly-joined agent may be the first LAN/public-visible one, which
        // flips the mDNS announce gate from browse-only to announcing. The gate
        // is otherwise only re-evaluated at server start / mesh enable / restart,
        // so agents that register later (background agents, opening files) would
        // never trigger an upgrade. Re-evaluate on every join (idempotent).
        if (event.type === 'agent_joined') {
          void startMdnsIfEligible()
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
  }

  ipcMain.handle(IPC.MESH_ENABLE, async () => {
    // Persist so an explicit enable survives restart (boot auto-enables
    // unless meshEnabled === false).
    settings.set('meshEnabled', true)
    return enableMeshInMain()
  })

  // (Boot-time mesh enablement runs earlier in registerAllIpcHandlers, right
  // before the tracked-directory autostart, so agents never start into a null
  // wsConnectionManager.)

  ipcMain.handle(IPC.MESH_DISABLE, async () => {
    try {
      // Persist first: boot auto-enables mesh when meshEnabled !== false, so
      // without this a user's disable would not survive restart.
      settings.set('meshEnabled', false)
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

  // Live mesh-registered agents enriched with executor states —
  // getAgentStatuses() has no runtime state access and reports 'idle' for
  // everyone, which made each poll visually reset active nodes in the graph.
  // Shared by MESH_STATUS and MESH_FLEET_STATUS.
  function getLiveMeshAgents() {
    if (!meshManager || !meshManager.isEnabled()) return []
    const liveStates = new Map<string, AgentState>()
    if (backgroundAgentManager) {
      for (const s of backgroundAgentManager.getStatuses()) liveStates.set(s.filePath, s.state)
    }
    if (currentFilePath && agentExecutor) {
      liveStates.set(currentFilePath, toDisplayState(agentExecutor.getState()))
    }
    return meshManager.getAgentStatuses().map((a) => {
      const live = liveStates.get(a.filePath)
      return live ? { ...a, state: live } : a
    })
  }

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

    const agents = getLiveMeshAgents()

    const result: Record<string, unknown> = {
      running: true,
      agents
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

  // Ghost metadata cache, keyed by file path. Two jobs:
  // 1. Perf — the 5s fleet poll would otherwise open every offline agent's
  //    SQLite each cycle; unchanged mtime serves from memory.
  // 2. Stability — a peek can fail transiently (SQLITE_BUSY while an agent
  //    is mass-starting and writing its own file). Serving the last good
  //    meta instead of dropping the entry stops agents blinking off the map.
  const fleetMetaCache = new Map<string, { mtimeMs: number; meta: NonNullable<ReturnType<typeof AdfDatabase.peekFleetMeta>> }>()
  // First-observed time of each agent's current status line (for status age)
  const statusSinceMap = new Map<string, { value: string; since: number }>()
  const peekFleetMetaCached = (filePath: string): ReturnType<typeof AdfDatabase.peekFleetMeta> => {
    let mtimeMs: number
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      fleetMetaCache.delete(filePath) // file gone — genuine removal
      return null
    }
    const cached = fleetMetaCache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta
    const meta = AdfDatabase.peekFleetMeta(filePath)
    if (meta) {
      fleetMetaCache.set(filePath, { mtimeMs, meta })
      return meta
    }
    // Peek failed (likely transient lock) — serve stale rather than blink
    return cached?.meta ?? null
  }

  // Fleet map: live mesh agents plus on-disk .adf files in tracked
  // directories that have no running executor ("ghost" nodes). Works even
  // with the mesh disabled — every on-disk agent is then a ghost.
  ipcMain.handle(IPC.MESH_FLEET_STATUS, async (): Promise<FleetStatusResult> => {
    const running = !!(meshManager && meshManager.isEnabled())

    const liveContext = (filePath: string): { tokens: number; threshold: number } | undefined => {
      if (filePath === currentFilePath && agentExecutor) return agentExecutor.getContextGauge()
      return backgroundAgentManager?.getExecutor(filePath)?.getContextGauge()
    }
    const agents: FleetAgentStatus[] = getLiveMeshAgents().map((a) => {
      const ctx = liveContext(a.filePath)
      return {
      ...a,
      online: true,
      contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
      contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined,
      // Standing boundary links — open WS pipes render as dashed channel
      // edges to the perimeter, distinct from request traffic
      wsConnections: wsConnectionManager
        ? wsConnectionManager.getConnections(a.filePath).length || undefined
        : undefined
    }})

    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    const maxDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5
    const seen = new Set(agents.map((a) => canonicalizePath(a.filePath)))

    // Longest-prefix tracked-dir match, mirroring MeshManager.findTrackedDirRoot.
    const findGhostTrackedDirRoot = (filePath: string): string | undefined => {
      const canonFile = canonicalizePath(filePath)
      let longestMatch: string | undefined
      let longestLen = -1
      for (const dir of trackedDirs) {
        const canonDir = canonicalizePath(dir)
        if (containsPath(canonDir, canonFile) && canonDir.length > longestLen) {
          longestMatch = dir
          longestLen = canonDir.length
        }
      }
      return longestMatch
    }

    // Same walk rules as scanDirectoryRecursive (depth cap, skip dotdirs and
    // node_modules) but only collects .adf paths — the fleet peek below reads
    // each file once, so the per-file messaging peek would be wasted work.
    const collectAdfFilePaths = (currentPath: string, currentDepth: number, out: string[]): void => {
      if (currentDepth > maxDepth) return
      let entries: Dirent[]
      try {
        entries = readdirSync(currentPath, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.adf')) {
          out.push(join(currentPath, e.name))
        } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          collectAdfFilePaths(join(currentPath, e.name), currentDepth + 1, out)
        }
      }
    }

    // Live executors independent of mesh registration — with the mesh
    // disabled, getLiveMeshAgents() is empty, so a foreground chat-started
    // agent (or a background executor) would otherwise be reported as an
    // offline ghost on every poll, stomping the event-driven state the
    // renderer just applied. Overlay their real display state so the poll
    // stays truthful; a genuinely stopped executor leaves these maps and
    // the ghost settles back to 'off' within one poll cycle.
    const liveExecStates = new Map<string, AgentState>()
    if (backgroundAgentManager) {
      for (const s of backgroundAgentManager.getStatuses()) {
        liveExecStates.set(canonicalizePath(s.filePath), s.state)
      }
    }
    if (currentFilePath && agentExecutor) {
      liveExecStates.set(canonicalizePath(currentFilePath), toDisplayState(agentExecutor.getState()))
    }

    for (const dir of trackedDirs) {
      const filePaths: string[] = []
      collectAdfFilePaths(dir, 0, filePaths)
      for (const filePath of filePaths) {
        const canon = canonicalizePath(filePath)
        if (seen.has(canon)) continue
        seen.add(canon)
        const meta = peekFleetMetaCached(filePath)
        if (!meta) continue
        const live = liveExecStates.get(canon)
        const isLive = live !== undefined && live !== 'off'
        const ctx = isLive ? liveContext(filePath) : undefined
        agents.push({
          filePath,
          handle: meta.handle || deriveHandle(filePath),
          did: meta.did ?? undefined,
          agentId: meta.agentId ?? undefined,
          parentDid: meta.parentDid ?? undefined,
          didHistory: meta.didHistory.length > 0 ? meta.didHistory : undefined,
          icon: meta.icon ?? undefined,
          state: isLive ? live : 'off',
          status: meta.status ?? undefined,
          model: meta.model ?? undefined,
          trackedDirRoot: findGhostTrackedDirRoot(filePath),
          createdAt: meta.createdAt ?? undefined,
          participating: false,
          online: isLive,
          contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
          contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined
        })
      }
    }

    // Status age — when the current status line was first observed. adf_meta
    // has no timestamps, so this is poll-observation memory: good enough for
    // the "now / 4m / 1h" chip, resets on app restart.
    const now = Date.now()
    for (const a of agents) {
      if (!a.status) {
        statusSinceMap.delete(a.filePath)
        continue
      }
      const prev = statusSinceMap.get(a.filePath)
      if (!prev || prev.value !== a.status) {
        statusSinceMap.set(a.filePath, { value: a.status, since: now })
      }
      a.statusSince = statusSinceMap.get(a.filePath)!.since
    }

    return { running, agents }
  })

  // Σ totals survive restarts — the renderer persists them in fleetMapState
  // on its save cycle; rates start fresh (a rolling window can't span a boot).
  try {
    const savedState = settings.get('fleetMapState') as { burnTotals?: Record<string, number> } | undefined
    if (savedState?.burnTotals) getFleetBurnService().hydrate(savedState.burnTotals)
  } catch { /* fresh start */ }

  ipcMain.handle(IPC.MESH_TOKEN_BURN, async () => {
    return getFleetBurnService().getBurn()
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

  // Aggregate pending HIL asks/approvals across every live executor (foreground +
  // background). Pending requests only exist in executor memory — without this
  // snapshot the fleet alert layer misses anything that fired while the graph
  // view wasn't listening.
  ipcMain.handle(IPC.MESH_PENDING_INTERACTIONS, async (): Promise<FleetPendingInteraction[]> => {
    const pending: FleetPendingInteraction[] = []

    const collect = (filePath: string, handle: string, executor: AgentExecutor) => {
      for (const ask of executor.getPendingAsks()) {
        pending.push({ filePath, handle, type: 'ask', requestId: ask.requestId, question: ask.question })
      }
      for (const approval of executor.getPendingApprovals()) {
        pending.push({
          filePath,
          handle,
          type: 'approval',
          requestId: approval.requestId,
          toolName: approval.name,
          input: approval.input,
          reason: approval.reason,
          protection: approval.protection,
          canAlwaysApprove: approval.canAlwaysApprove,
          alwaysApproveBlockedReason: approval.alwaysApproveBlockedReason
        })
      }
    }

    if (currentFilePath && agentExecutor) {
      const config = currentWorkspace?.getAgentConfig()
      collect(currentFilePath, config?.handle || deriveHandle(currentFilePath), agentExecutor)
    }

    if (backgroundAgentManager) {
      for (const filePath of backgroundAgentManager.getAllAgentFilePaths()) {
        if (filePath === currentFilePath) continue
        const executor = backgroundAgentManager.getExecutor(filePath)
        const agent = backgroundAgentManager.getAgent(filePath)
        if (!executor || !agent) continue
        collect(filePath, agent.config.handle || deriveHandle(filePath), executor)
      }
    }

    return pending
  })

  // Fleet map group command: deliver a user message to multiple agents' inboxes.
  // Live (mesh-registered) agents get the same rails as inter-agent delivery —
  // inbox insert + on_inbox trigger — so they wake immediately. Offline agents
  // get the message inserted into their workspace inbox (brief open/close) so
  // they see it on next start.
  ipcMain.handle(IPC.MESH_MESSAGE_AGENTS, async (_e, args: { filePaths: string[]; content: string }): Promise<FleetMessageResult> => {
    const delivered: string[] = []
    const failed: { filePath: string; error: string }[] = []
    const filePaths = Array.isArray(args?.filePaths) ? args.filePaths : []
    const content = typeof args?.content === 'string' ? args.content : ''

    if (!content.trim()) {
      return { delivered, failed: filePaths.map((filePath) => ({ filePath, error: 'empty message' })) }
    }

    // Refresh an open loop panel after a direct loop append — the write went
    // straight to SQLite, so no executor event will repaint the panel. Skipped
    // while the foreground agent is mid-turn: chat_updated would clobber the
    // streaming UI, and the trigger turn repaints it moments later anyway.
    const pushForegroundLoop = (filePath: string): void => {
      if (filePath !== currentFilePath || !currentWorkspace) return
      if (agentExecutor && toDisplayState(agentExecutor.getState()) === 'active') return
      const win = getMainWindow()
      if (!win) return
      win.webContents.send(IPC.AGENT_EVENT, {
        type: 'chat_updated',
        payload: { uiLog: parseLoopToDisplay(currentWorkspace.getLoop()) },
        timestamp: Date.now()
      })
    }

    // Owner → agent is plain CHAT, not mesh mail: these are our own agents,
    // so the message rides the same rails as typing in the chat panel — a
    // real user turn (recovers error state and interrupts a busy
    // turn), and NO ALF inbox envelope (an unread inbox row on top of the
    // loop entry was pure noise).
    const chatDispatch = () =>
      createDispatch(createEvent({
        type: 'chat' as const, source: 'system',
        data: { message: { seq: 0, role: 'user' as const, content_json: [{ type: 'text', text: content }] as ContentBlock[], created_at: Date.now() } },
      }), { scope: 'agent' })

    for (const filePath of filePaths) {
      try {
        // Foreground agent with a running assembled handle.
        if (filePath === currentFilePath && currentAssembledAgent) {
          void currentAssembledAgent.dispatch(chatDispatch()).catch((err) => {
            console.error('[Fleet] Owner chat turn failed (foreground):', err)
          })
          delivered.push(filePath)
          continue
        }

        // Running background agent — chat turn on its executor. Not awaited:
        // the promise resolves only when the whole LLM turn completes.
        if (backgroundAgentManager?.hasAgent(filePath)) {
          backgroundAgentManager.ensureSessionHydrated(filePath)
          const refs = backgroundAgentManager.getAgent(filePath)
          if (refs?.assembledAgent) {
            void refs.assembledAgent.dispatch(chatDispatch()).catch((err) => {
              console.error('[Fleet] Owner chat turn failed (background):', err)
            })
            delivered.push(filePath)
            continue
          }
        }

        // Offline: a message IS a summons — start the agent (full gates:
        // review, password) and deliver the chat turn to the fresh executor.
        if (!existsSync(filePath)) {
          failed.push({ filePath, error: 'file not found' })
          continue
        }
        const started = await startBackgroundAgentGated(filePath)
        if (started.success && backgroundAgentManager?.hasAgent(filePath)) {
          const refs = backgroundAgentManager.getAgent(filePath)
          if (refs?.assembledAgent) {
            void refs.assembledAgent.dispatch(chatDispatch()).catch((err) => {
              console.error('[Fleet] Owner chat turn failed (cold start):', err)
            })
            delivered.push(filePath)
            continue
          }
        }
        // Start refused (unreviewed / password-locked / foreground file) —
        // write the chat into the loop so it's the next thing the agent sees
        // when the user starts it properly. No inbox row.
        const isForeground = filePath === currentFilePath && !!currentWorkspace
        const workspace = isForeground ? currentWorkspace! : AdfWorkspace.open(filePath)
        try {
          workspace.appendToLoop('user', [{ type: 'text', text: content }])
          if (isForeground) pushForegroundLoop(filePath)
        } finally {
          if (!isForeground) workspace.close()
        }
        delivered.push(filePath)
      } catch (error) {
        failed.push({ filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return { delivered, failed }
  })

  // Fleet map founding: create a new agent (and folder, if needed) directly
  // from the map — click an empty tile, name it, brief it. Destination must
  // sit inside a tracked directory; never writes elsewhere. The file is
  // created, identity-provisioned, auto-reviewed (the owner made it), then
  // closed — the renderer opens it through the normal FILE_OPEN flow.
  ipcMain.handle(IPC.MESH_FOUND_AGENT, async (_e, args: { dir: string; name: string; newRoot?: boolean }): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      const name = (args?.name ?? '').trim()
      const dir = args?.dir ?? ''
      if (!name) return { success: false, error: 'Agent name required' }

      const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
      const canonDir = canonicalizePath(dir)
      const inTracked = trackedDirs.some((d) => containsPath(canonicalizePath(d), canonDir))
      // New-root founding: the folder may sit OUTSIDE tracked space, but only
      // as a sibling of an existing tracked root (its parent must be some
      // tracked root's parent) — never an arbitrary disk location. The
      // notifyAdfFileCreated call below auto-tracks it as a new terrain root.
      const allowedAsNewRoot = args?.newRoot === true && trackedDirs.some((d) =>
        containsPath(dirname(canonicalizePath(d)), canonDir)
      )
      if (!inTracked && !allowedAsNewRoot) return { success: false, error: 'Destination is outside tracked directories' }

      mkdirSync(dir, { recursive: true })
      const fileName = name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
      const filePath = join(dir, `${fileName}.adf`)
      if (existsSync(filePath)) return { success: false, error: `${fileName}.adf already exists here` }

      const appProviders = (settings.get('providers') as import('../../shared/types/ipc.types').ProviderConfig[]) ?? []
      const defaultProvider = resolveDefaultProvider(appProviders, settings.get('defaultProviderId') as string | undefined)
      const createOptions = applyDefaultProviderToOptions({ name }, defaultProvider)
      const workspace = AdfWorkspace.create(filePath, createOptions)
      try {
        try {
          settings.getOwnerIdentity().ensureWorkspaceIdentity(workspace)
        } catch (err) {
          console.warn('[OwnerIdentity] Identity provisioning on found failed:', err)
        }
        const newConfig = workspace.getAgentConfig()
        settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), newConfig))
      } finally {
        workspace.close()
      }
      notifyAdfFileCreated(filePath)
      return { success: true, filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Fleet map state set: end any active turn and enter idle or hibernate. Uses
  // the executor's normal state_changed event, which is what
  // syncs TriggerEvaluator.setDisplayState (foreground: the agent-event
  // listener in this file; background: BackgroundAgentManager's executor
  // listener) — TriggerEvaluator remains the single owner of wake behavior.
  ipcMain.handle(IPC.MESH_SET_AGENT_STATE, async (_e, args: { filePaths: string[]; state: FleetSettableState }): Promise<FleetStateResult> => {
    const updated: string[] = []
    const failed: { filePath: string; error: string }[] = []
    const filePaths = Array.isArray(args?.filePaths) ? args.filePaths : []
    const state = args?.state

    if (state !== 'hibernate' && state !== 'idle') {
      return { updated, failed: filePaths.map((filePath) => ({ filePath, error: 'invalid state' })) }
    }

    for (const filePath of filePaths) {
      try {
        const isForeground = filePath === currentFilePath && !!agentExecutor
        const executor = isForeground ? agentExecutor : backgroundAgentManager?.getExecutor(filePath)
        if (!executor) {
          failed.push({ filePath, error: 'agent offline' })
          continue
        }
        const executorState = executor.getState()
        if (executorState === 'stopped' || executorState === 'error') {
          failed.push({ filePath, error: `agent ${executorState}` })
          continue
        }
        executor.endTurnAndSetState(state)
        updated.push(filePath)
      } catch (error) {
        failed.push({ filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return { updated, failed }
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

  // Fetch a peer's runtime metadata (alias + opt-in owner identity) from its
  // /ping. Cheap and best-effort; returns null on any failure so peer
  // discovery never blocks on it.
  interface RuntimeMeta {
    runtime_alias?: string
    owner_did?: string
    owner_alias?: string
    owner_delegation?: { issuer: string; subject: string; role: string; issued_at: string; expires_at?: string; scope?: string; signature: string }
  }
  const fetchRuntimeMeta = async (baseUrl: string): Promise<RuntimeMeta | null> => {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/ping`, { signal: AbortSignal.timeout(4_000) })
      if (!res.ok) return null
      return (await res.json()) as RuntimeMeta
    } catch {
      return null
    }
  }

  ipcMain.handle(IPC.MESH_DISCOVERED_RUNTIMES, async (_event, args?: { force?: boolean }) => {
    if (!mdnsService || !directoryFetchCache) return []
    // The 5s peer poll doubles as the staleness signal for the tailnet
    // sweep — a freshly added manual peer appears within seconds. `force`
    // (the manual refresh button) awaits a full re-probe before answering.
    if (args?.force) {
      try { await tailnetDiscovery?.sweepNow() } catch { /* results below reflect whatever we have */ }
      directoryFetchCache.invalidate()
    } else {
      tailnetDiscovery?.ensureFresh()
    }
    const peers = mdnsService.getDiscoveredRuntimes()
    const ourOwnerDid = settings.getOwnerIdentity().getOwnerDid()
    // Decorate each peer with the cached directory: count for the summary,
    // full cards so the fleet map can render one tile per remote agent.
    // `undefined` count = peer discovered but its directory is UNREACHABLE —
    // the UI must not conflate that with a reachable-but-empty 0.
    const enriched = await Promise.all(peers.map(async (peer) => {
      const [cards, meta] = await Promise.all([
        directoryFetchCache!.fetch(peer.url),
        fetchRuntimeMeta(peer.url)
      ])
      // Owner identity is opt-in on the peer; when shared it ships a delegation
      // so we can VERIFY the owner→runtime link rather than trust the alias.
      // The alias is a display nickname keyed to the DID, never an auth anchor.
      let ownerVerified = false
      let isSelf = false
      if (meta?.owner_did && meta.owner_delegation && peer.runtime_did) {
        const del = meta.owner_delegation
        ownerVerified =
          del.role === 'runtime' &&
          del.issuer === meta.owner_did &&
          del.subject === peer.runtime_did &&
          verifyAttestation(del, { expectedSubject: peer.runtime_did })
        isSelf = ownerVerified && !!ourOwnerDid && meta.owner_did === ourOwnerDid
      }
      // Trust decoration — the same judgment agent_discover applies to
      // remote cards (mesh-manager getRemoteDirectoryForAgent): verify the
      // card signature, then look for a verified owner attestation. Without
      // this the fleet map shows every signed peer card as "unverified".
      const decorated = cards?.map((card) => {
        const cardVerified = !!card.did && !!card.signature && verifyCardSignature(card)
        const ownerAtt = cardVerified
          ? (card.attestations ?? []).find(
              (a) => a.role === 'owner' && verifyAttestation(a, { expectedSubject: card.did })
            )
          : undefined
        return {
          ...card,
          card_verified: cardVerified,
          owner_attested: !!ownerAtt,
          ...(ownerAtt ? { attested_owner_did: ownerAtt.issuer } : {})
        }
      })
      return {
        ...peer,
        agent_count: decorated ? decorated.length : undefined,
        agents: decorated ?? undefined,
        runtime_alias: meta?.runtime_alias,
        owner_alias: meta?.owner_alias,
        owner_did: meta?.owner_did,
        owner_verified: ownerVerified,
        is_self_owned: isSelf
      }
    }))
    return enriched
  })

  // Live health probe for a remote agent — the fleet map's peer readout shows
  // the /health state (idle/active) on open. Runs in main because the mesh
  // server doesn't send CORS headers.
  ipcMain.handle(IPC.MESH_PEER_AGENT_HEALTH, async (_event, healthUrl: string) => {
    if (typeof healthUrl !== 'string' || !/^https?:\/\//.test(healthUrl)) {
      return { ok: false as const, error: 'Bad health URL' }
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
      const body = (await res.json()) as { status?: string; state?: string }
      return { ok: true as const, status: body?.status, state: body?.state }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Fetch failed' }
    }
  })

  // LAN reachability preconditions: is the mesh server LAN-bound, and is the
  // inbound firewall rule that lets peers fetch our directory in place? Drives
  // the "Visible on LAN" gate in Settings → Networking. Read-only, no elevation.
  ipcMain.handle(IPC.MESH_FIREWALL_CHECK, async () => {
    const { checkLanFirewall } = await import('../services/firewall-service')
    const port = meshServer?.getPort() ?? 7295
    const serverLanBound = meshServer?.getHost() === '0.0.0.0'
    const fw = await checkLanFirewall(port)
    // "Visible on LAN" needs the server bound to 0.0.0.0 AND the inbound path
    // open. On platforms we can manage (win/mac), trust the rule check; where we
    // can't (linux), fall back to the self-probe as the best available signal.
    const verified = serverLanBound && (
      fw.supported ? fw.ruleConfigured === true : fw.reachable === true
    )
    return { ...fw, port, serverLanBound, verified }
  })

  // Create/repair the inbound firewall rule, prompting the user for elevation
  // (UAC on Windows, admin prompt on macOS). One prompt covers all rules.
  ipcMain.handle(IPC.MESH_FIREWALL_APPLY, async () => {
    const { applyLanFirewall } = await import('../services/firewall-service')
    const port = meshServer?.getPort() ?? 7295
    return applyLanFirewall(port)
  })

  // Fetch one of a remote agent's shared files for the fleet-map card viewer.
  // Runs in main because the mesh server doesn't send CORS headers, so the
  // renderer can't fetch a peer directly. baseUrl is the agent's base
  // (<runtime>/<handle>); shared files are served at <base>/<path>
  // (mesh-server agentCatchAll).
  ipcMain.handle(IPC.MESH_PEER_SHARED_FILE, async (_event, baseUrl: string, filePath: string) => {
    const MAX_BYTES = 2_000_000
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
      return { ok: false as const, error: 'Bad base URL' }
    }
    if (typeof filePath !== 'string' || filePath.includes('..') || filePath.startsWith('/')) {
      return { ok: false as const, error: 'Bad file path' }
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/${filePath.split('/').map(encodeURIComponent).join('/')}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_BYTES) return { ok: false as const, error: 'File too large to preview (>2 MB)' }
      // Null byte in the head = binary; the viewer offers download-only
      const binary = buf.subarray(0, 8192).includes(0)
      return {
        ok: true as const,
        mime: res.headers.get('content-type') ?? '',
        size: buf.length,
        binary,
        content: binary ? buf.toString('base64') : buf.toString('utf8')
      }
    } catch {
      return { ok: false as const, error: 'Peer unreachable' }
    }
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

  // Gated background start — the single path for starting an agent from
  // main, shared by the IPC handler and owner-message delivery (messaging an
  // offline agent starts it). All gates apply: review, password, foreground.
  async function startBackgroundAgentGated(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!backgroundAgentManager) return { success: false, error: 'Background agent manager not initialized' }
    RuntimeGate.resume()
    rememberAdfDirectory(filePath)

    if (filePath === currentFilePath) {
      return { success: false, error: 'Cannot start background agent for the foreground file' }
    }

    // Review gate: refuse to start an unreviewed agent
    const reviewWorkspace = AdfWorkspace.open(filePath)
    try {
      const config = reviewWorkspace.getAgentConfig()
      if (!isConfigReviewed(settings.get('reviewedAgents'), config)) {
        return { success: false, error: 'Agent must be reviewed before starting. Open it in the foreground first.' }
      }
    } finally {
      reviewWorkspace.close()
    }

    // Block startup if password-protected and not yet unlocked
    const cachedKey = derivedKeyCache.get(filePath) ?? null
    try {
      const ws = AdfWorkspace.open(filePath)
      if (ws.isPasswordProtected() && !cachedKey) {
        ws.close()
        return { success: false, error: 'Agent is password-protected. Open it in the foreground and unlock first.' }
      }
      ws.close()
    } catch (err) {
      return { success: false, error: `Failed to check password status: ${err instanceof Error ? err.message : String(err)}` }
    }

    const success = await backgroundAgentManager.startAgent(filePath, cachedKey)
    if (!success) return { success: false, error: 'Failed to start agent' }

    if (meshManager?.isEnabled()) {
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

    return { success: true }
  }
  ipcMain.handle(IPC.BACKGROUND_AGENT_START, async (_event, args: { filePath: string }) => {
    return startBackgroundAgentGated(args.filePath)
  })

  ipcMain.handle(IPC.BACKGROUND_AGENT_STATUS, async () => {
    if (!backgroundAgentManager) return { agents: [], starting: [] }
    return { agents: backgroundAgentManager.getStatuses(), starting: backgroundAgentManager.getPendingStarts() }
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

      // Bounded-parallel start (5 in flight) — a serial loop made large fleets
      // take minutes. Per-file events/registrations are unchanged; failures are
      // isolated per file by mapWithConcurrency and surfaced in the result.
      const bgMgr = backgroundAgentManager
      const settled = await mapWithConcurrency(adfFiles, 5, async (filePath) => {
        rememberAdfDirectory(filePath)
        if (filePath === currentFilePath) return
        if (bgMgr.hasAgent(filePath)) return

        const cachedKey = derivedKeyCache.get(filePath) ?? null
        const success = await bgMgr.startAgent(filePath, cachedKey)
        if (!success) throw new Error('Failed to start agent')
        if (meshManager?.isEnabled()) {
          const agentRefs = bgMgr.getAgent(filePath)
          if (agentRefs) {
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
      })

      // Surface per-file failures — success stays true for backward compat
      // (partial starts still started agents), failures list what didn't.
      const failures: { file: string; error: string }[] = []
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]
        if (result.status === 'rejected') {
          const reason = result.reason
          failures.push({ file: adfFiles[i], error: reason instanceof Error ? reason.message : String(reason) })
        }
      }
      return failures.length > 0 ? { success: true, failures } : { success: true }
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

  // --- Home dashboard (split into 4 slices so each tile loads as its
  // data resolves rather than waiting on the slowest one). ---

  // Slice 1: instant. Settings reads + in-memory services.
  ipcMain.handle(IPC.DASHBOARD_QUICK_STATS, async () => {
    const providers = (settings.get('providers') as ProviderConfig[]) ?? []
    const mcpServers = (settings.get('mcpServers') as McpServerRegistration[]) ?? []
    const adapters = (settings.get('adapters') as AdapterRegistration[]) ?? []
    const compute = (settings.get('compute') as { hostAccessEnabled?: boolean } | undefined) ?? {}

    return {
      providers: { total: providers.length },
      mcp: { configured: mcpServers.length },
      adapters: {
        configured: adapters.length,
        types: Array.from(new Set(adapters.map((a) => a.type).filter(Boolean))),
      },
      packages: { total: sandboxPackagesService.getInstalledPackages().length },
      hostAccess: { enabledGlobally: !!compute.hostAccessEnabled },
      tokens: getTokenUsageService().getSummary(),
    }
  })

  // Slice 2: provider connection tests. Session-cached in main.
  ipcMain.handle(IPC.DASHBOARD_PROVIDER_TESTS, async () => {
    const providers = (settings.get('providers') as ProviderConfig[]) ?? []
    let ok = 0
    let failed = 0
    let unconfigured = 0
    await Promise.all(providers.map(async (cfg) => {
      const result = await testProviderCredentialsForDashboard(cfg)
      if (result === 'ok') ok++
      else if (result === 'failed') failed++
      else unconfigured++
    }))
    return { ok, failed, unconfigured }
  })

  // Test a single provider's connection. `force` busts the session cache so the
  // Settings "Test" button always re-checks live.
  ipcMain.handle(IPC.PROVIDER_TEST, async (_event, args: { providerId: string; force?: boolean }) => {
    const providers = (settings.get('providers') as ProviderConfig[]) ?? []
    const cfg = providers.find((p) => p.id === args?.providerId)
    if (!cfg) return { status: 'unconfigured' as const }
    const status = await testProviderCredentialsForDashboard(cfg, args?.force === true)
    return { status }
  })

  // Slice 3: podman container probe.
  // `listContainers()` returns `{ name, status, running }` — the `running`
  // boolean is the authoritative signal (parsed from podman's `{{.State}}`).
  // An earlier version of this handler filtered on a non-existent `state`
  // field and always reported 0 running, even when containers were live.
  ipcMain.handle(IPC.DASHBOARD_CONTAINERS, async () => {
    try {
      const list = await podmanService.listContainers()
      return {
        total: list.length,
        running: list.filter((c) => c.running).length,
        // listContainers returns [] rather than throwing when podman is
        // missing — surface the not_installed status so the dashboard can
        // stop polling a podman that isn't there.
        unavailable: podmanService.getStatus().status === 'not_installed' || undefined,
      }
    } catch {
      // Podman not installed / unavailable. The extra flag lets the dashboard
      // stop polling instead of hammering a podman that isn't there.
      return { total: 0, running: 0, unavailable: true }
    }
  })

  // Slice 4: readonly peek across tracked .adf files.
  ipcMain.handle(IPC.DASHBOARD_AGENT_STATS, async () => {
    const { readdirSync, realpathSync } = await import('fs')
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []

    const collectAdfFiles = (dir: string, depth: number, maxDepth = 5): string[] => {
      if (depth > maxDepth) return []
      const results: string[] = []
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isFile() && entry.name.endsWith('.adf')) {
            results.push(full)
          } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            results.push(...collectAdfFiles(full, depth + 1, maxDepth))
          }
        }
      } catch { /* skip unreadable dirs */ }
      return results
    }

    const seen = new Set<string>()
    const uniqueFiles: string[] = []
    for (const dir of trackedDirs) {
      for (const file of collectAdfFiles(dir, 0)) {
        let resolved: string
        try { resolved = realpathSync(file) } catch { resolved = file }
        if (!seen.has(resolved)) {
          seen.add(resolved)
          uniqueFiles.push(file)
        }
      }
    }

    let autostart = 0
    let autonomous = 0
    let hostAccessAgents = 0
    for (const filePath of uniqueFiles) {
      const meta = AdfDatabase.peekAgentMeta(filePath)
      if (!meta) continue
      if (meta.autostart) autostart++
      if (meta.autonomous) autonomous++
      if (meta.hostAccess) hostAccessAgents++
    }

    return { total: uniqueFiles.length, autostart, autonomous, hostAccessAgents }
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

  // Per-request context token breakdown (system prompt / injected files / tool
  // schemas / messages) for whichever executor owns the file — foreground or
  // background, mirroring MESH_FLEET_STATUS's liveContext resolution. Null when
  // no executor is running for that path.
  ipcMain.handle(IPC.CONTEXT_BREAKDOWN_GET, async (_event, { filePath }: { filePath: string }): Promise<import('../../shared/types/ipc.types').ContextBreakdown | null> => {
    if (filePath === currentFilePath && agentExecutor) return agentExecutor.getContextBreakdown()
    return backgroundAgentManager?.getExecutor(filePath)?.getContextBreakdown() ?? null
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
      credentialStorage: z.enum(['app', 'agent']).optional(),
      runLocation: z.enum(['host', 'shared']).optional(),
      // OAuth remote flags — see McpRegistrationTestArgs: Zod strips unlisted
      // keys, which would drop oauth on agent attach too. Keep in sync with
      // McpServerRegistration / McpServerConfig.
      oauth: z.boolean().optional(),
      oauthClientId: z.string().optional(),
      oauthScopes: z.array(z.string()).optional()
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


  // --- MCP Registration Connect Test (Settings "Connect" button) ---
  // Runs the real pipeline for a registration draft: credential-file
  // materialization + auth preflight on host-located servers, containerized
  // launch for shared-located ones (ephemeral test home, cleaned up), plain
  // HTTP connect for remote servers. See deriveRegistrationTestPlan for what
  // each location can meaningfully verify.
  const McpRegistrationTestArgs = z.object({
    registration: z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      type: z.enum(['npm', 'uvx', 'pip', 'custom', 'http']).optional(),
      npmPackage: z.string().optional(),
      pypiPackage: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().url().optional(),
      headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      bearerTokenEnvVar: z.string().optional(),
      env: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      toolCallTimeout: z.number().optional(),
      runLocation: z.enum(['host', 'shared']).optional(),
      // OAuth remote (Streamable HTTP): without these, Zod strips the flags at
      // the IPC boundary and the handler's `reg.oauth` check below is never
      // true — the interactive sign-in is silently skipped and the connect goes
      // out with no Authorization header (401 "Missing or invalid authorization
      // header"). Keep in sync with McpServerRegistration.
      oauth: z.boolean().optional(),
      oauthClientId: z.string().optional(),
      oauthScopes: z.array(z.string()).optional(),
      auth: z.boolean().optional(),
      authArgs: z.array(z.string()).optional(),
      authPort: z.number().int().min(1).max(65535).optional(),
      credentialFiles: z.array(z.object({
        path: z.string().min(1),
        required: z.boolean().optional(),
        writeBack: z.boolean().optional(),
      })).optional(),
    }),
    credentialFiles: z.array(z.object({
      path: z.string().min(1),
      contentB64: z.string(),
    })).optional(),
  })

  ipcMain.handle(IPC.MCP_REGISTRATION_TEST, async (_event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpRegistrationTestArgs, rawArgs)
    if ('error' in v) {
      // Type-complete failure: McpRegistrationTestResult declares
      // location/authRan/notes non-optional, and this exit runs before the
      // test plan exists — derive location best-effort from the raw input.
      const rawReg = (rawArgs as { registration?: { url?: unknown; type?: unknown; runLocation?: unknown } } | null | undefined)?.registration
      const location: McpRegistrationTestResult['location'] =
        rawReg?.type === 'http' || typeof rawReg?.url === 'string'
          ? 'remote http'
          : rawReg?.runLocation === 'host' ? 'host' : 'shared container'
      return { success: false, tools: [], error: v.error, location, authRan: false, notes: [] } satisfies McpRegistrationTestResult
    }
    const { registration, credentialFiles } = v.data
    const reg = registration as McpServerRegistration
    const testComputeSettings = (settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
    const plan = deriveRegistrationTestPlan(reg, { hostAccessEnabled: testComputeSettings.hostAccessEnabled })
    const notes = [...plan.notes]
    // Whether an interactive OAuth sign-in was driven during this test.
    let oauthRan = false
    const serverCfg = buildMcpServerConfigFromRegistration(reg)

    const env: Record<string, string> = {}
    for (const e of reg.env ?? []) { if (e.key && e.value) env[e.key] = e.value }

    // Settings-only test: no agent context, so the app store IS the token store
    // (see resolveOAuthStoreForConnect). The connect factory attaches the token
    // stored by the interactive flow below; it returns undefined for non-oauth
    // servers, so it is harmless on the host/container branches.
    const appOAuthStore = getAppOAuthStore()
    const tempManager = new McpClientManager(undefined, buildOAuthProviderFactory(
      () => resolveOAuthStoreForConnect({ appStore: appOAuthStore }),
    ))
    tempManager.on('log', (name, entry) => {
      const cached = mcpLogCache.get(name) ?? []
      cached.push(entry)
      if (cached.length > 500) cached.splice(0, cached.length - 500)
      mcpLogCache.set(name, cached)
    })
    const finish = async (result: { success: boolean; tools: unknown[]; error?: string }) => {
      // Capture state BEFORE disconnect — teardown clears the log buffer.
      const state = tempManager.getServerState(reg.name)
      const stderrTail = state?.logs.filter((l) => l.stream === 'stderr').slice(-10).map((l) => l.message)
      // Version from the initialize handshake (serverInfo.version) — the
      // truthful version for host npx/uvx and remote HTTP servers whose
      // registration never gets a resolvable package version.
      const serverVersion = tempManager.getServerReportedVersion(reg.name)
      await tempManager.disconnectAll().catch(() => {})
      return { ...result, location: plan.location, authRan: plan.authMode === 'run', oauthRan, notes, ...(serverVersion ? { serverVersion } : {}), ...(stderrTail?.length && !result.success ? { stderrTail } : {}) }
    }

    try {
      if (plan.location === 'remote http') {
        // Interactive OAuth sign-in BEFORE connect when this is an OAuth remote.
        // Idempotent: runMcpHttpOAuthFlow returns AUTHORIZED with no browser hop
        // when a valid token/refresh is already stored. The app store is the
        // Studio "signed-in" source of truth; the connect factory built above
        // then attaches the freshly-stored token to the transport.
        if (reg.oauth && serverCfg.url) {
          const oauthReg = reg as { oauthClientId?: string; oauthScopes?: string[] }
          oauthRan = true
          const flow = await runMcpHttpOAuthFlow(serverCfg.url, appOAuthStore, studioOAuthIO, {
            clientId: oauthReg.oauthClientId,
            scopes: oauthReg.oauthScopes,
          })
          if (!flow.authorized) {
            return finish({ success: false, tools: [], error: flow.error ?? 'OAuth sign-in did not complete.' })
          }
        }
        const tools = await tempManager.connect({ ...serverCfg, env: Object.keys(env).length ? env : undefined })
        if (tools) return finish({ success: true, tools })
        return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
      }

      if (plan.location === 'host') {
        // Materialize provided credential files into the real host home —
        // for a host-located server the host FS IS the runtime credential
        // store, so these persist (write-if-absent: never clobber existing
        // credentials). Paths are ~-confined by expandCredentialPath.
        for (const f of credentialFiles ?? []) {
          const dest = expandCredentialPath(f.path, { kind: 'host' })
          if (existsSync(dest)) { notes.push(`${f.path} already exists on the host — kept the existing file.`); continue }
          const content = Buffer.from(f.contentB64, 'base64')
          if (content.length > CREDENTIAL_FILE_MAX_BYTES) {
            return finish({ success: false, tools: [], error: `Credential file ${f.path} exceeds the ${Math.round(CREDENTIAL_FILE_MAX_BYTES / 1024)}KiB cap.` })
          }
          mkdirSync(dirname(dest), { recursive: true })
          writeFileSync(dest, content, { mode: 0o600 })
          notes.push(`Wrote ${f.path} to the host home.`)
        }

        // Resolve the launch command the way the probe does — BEFORE the auth
        // preflight, which needs the exact invocation. A registration-shaped
        // serverCfg has package fields but no command, and runMcpAuthPreflight
        // would fall through to `npx <authArgs>` for a pypi package (executing
        // an unrelated npm package literally named e.g. "auth").
        let command: string
        let args: string[]
        const userArgs = (reg.args ?? []).filter(Boolean)
        if (reg.pypiPackage) {
          try {
            const uvPath = await uvManager.ensureUv()
            command = uvPath
            args = ['tool', 'run', reg.pypiPackage, ...userArgs]
          } catch {
            command = 'uvx'
            args = [reg.pypiPackage, ...userArgs]
          }
        } else if (reg.npmPackage) {
          command = 'npx'
          args = ['-y', reg.npmPackage, ...userArgs]
        } else {
          command = reg.command ?? ''
          args = userArgs
        }
        if (!command) return finish({ success: false, tools: [], error: 'No command or package to launch.' })

        if (plan.authMode === 'run') {
          // Pass the fully resolved invocation: with command set, the
          // preflight's own npx/uv fallbacks never fire, so the auth run is
          // exactly `<command> <args> <authArgs>` — e.g.
          // `uv tool run <pkg> <userArgs> <authArgs>` for pypi.
          await studioMcpAuthPreflight({ ...serverCfg, command, args }, { authArgs: reg.authArgs, authPort: reg.authPort, resolvedEnv: env })
        }
        const tools = await tempManager.connect({ name: reg.name, transport: 'stdio', command, args, env: Object.keys(env).length ? env : undefined })
        if (tools) return finish({ success: true, tools })
        return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
      }

      // Shared container: real containerized launch under an ephemeral test
      // home (auth + credential capture are per-agent concerns — see plan
      // notes). Cleaned up afterwards.
      await podmanService.ensureRunning()
      const podmanBin = await podmanService.findPodman()
      if (!podmanBin) return finish({ success: false, tools: [], error: 'Podman is unavailable — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute.' })
      // Per-invocation test dir so overlapping Connect/Reconnect tests never
      // delete each other's ephemeral home.
      const testDir = `/workspace/_settings_test_${randomUUID()}`
      const testHome = `${testDir}/home`
      try { await podmanService.ensureWorkspace('adf-mcp', testHome) } catch { /* mkdir in wrapper */ }
      const containerCmd = resolveContainerCommand(serverCfg)
      try {
        const tools = await tempManager.connect(
          { name: reg.name, transport: 'stdio', env },
          { externalTransport: new PodmanStdioTransport({ podmanBin, containerName: 'adf-mcp', command: containerCmd.command, args: containerCmd.args, env: { HOME: testHome, ...env }, cwd: testDir }) },
        )
        if (tools) return finish({ success: true, tools })
        return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
      } finally {
        podmanService.execInContainer('adf-mcp', '/workspace', `rm -rf ${testDir}`).catch(() => {})
      }
    } catch (error) {
      return finish({ success: false, tools: [], error: error instanceof Error ? error.message : String(error) })
    }
  })

  // Phase 4 HTTP OAuth: clear the stored token for a remote server URL so the
  // renderer's "Sign out" works. Clears the app-level (Studio) store — the
  // sign-in source of truth. Agent-sealed copies are re-captured on the next
  // attach, so this does not need to reach into every .adf.
  ipcMain.handle(IPC.MCP_OAUTH_SIGNOUT, async (_event, rawArgs: unknown) => {
    const url = (rawArgs as { url?: unknown } | null | undefined)?.url
    if (typeof url !== 'string' || !url) return { success: false, error: 'A server url is required to sign out.' }
    try {
      await getAppOAuthStore().invalidate(url, 'all')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Phase 4 HTTP OAuth: whether a valid token is stored (app store) for a URL —
  // lets the renderer show a "signed in" indicator without exposing the token.
  ipcMain.handle(IPC.MCP_OAUTH_STATUS, async (_event, rawArgs: unknown) => {
    const url = (rawArgs as { url?: unknown } | null | undefined)?.url
    if (typeof url !== 'string' || !url) return { signedIn: false }
    try {
      const record = await getAppOAuthStore().get(url)
      return { signedIn: !!record?.tokens }
    } catch {
      return { signedIn: false }
    }
  })

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

  // Curated registry — remote-first with cached/bundled fallback; the service
  // never rejects, so this always yields a usable entry list.
  ipcMain.handle(IPC.MCP_REGISTRY_GET, async () => {
    return getMcpRegistryFetchService().getRegistry()
  })

  // --- Skill catalogs ---
  //
  // Both run in main because the renderer's CSP forbids remote origins. They
  // are pure network reads: neither one touches the workspace. Installing is
  // the renderer writing the fetched body to skills/<name>/SKILL.md through the
  // ordinary file-write path, which is what triggers the indexer.
  //
  // Both fetch through the SHARED catalog guard (src/main/utils/guarded-fetch.ts)
  // rather than a bare fetch(): a catalog URL is remote data, so https-only, the
  // SSRF/egress guard (with the daemon port, so a redirect can never reach the
  // local control API), the redirect hop cap, and the size ceiling all have to
  // hold on every hop — not just the one the user typed.

  const SKILLS_FETCH_TIMEOUT_MS = 10_000

  ipcMain.handle(IPC.SKILLS_CATALOG_GET, async (_event, { url }: { url: string }) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      return { ok: false as const, error: 'Catalog URL must be https' }
    }
    const body = await guardedFetch(url, {
      maxBytes: MAX_CATALOG_BYTES,
      timeoutMs: SKILLS_FETCH_TIMEOUT_MS
    })
    if ('error' in body) return { ok: false as const, error: body.error }
    let json: unknown
    try {
      json = JSON.parse(body.bytes.toString('utf8'))
    } catch {
      return { ok: false as const, error: 'Catalog is not valid JSON' }
    }
    const parsed = parseSkillsCatalogDocument(json)
    if (!parsed) return { ok: false as const, error: 'Unrecognized catalog schema' }
    return {
      ok: true as const,
      entries: parsed.entries,
      publisher: parsed.publisher,
      dropped: parsed.dropped
    }
  })

  ipcMain.handle(IPC.SKILLS_PACKAGE_GET, async (_event, { url }: { url: string }) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      return { ok: false as const, error: 'Package URL must be https' }
    }
    // The indexer rejects anything past this bound anyway — the guard aborts the
    // stream at the cap rather than installing a package that could never index.
    const body = await guardedFetch(url, {
      maxBytes: MAX_SKILL_PACKAGE_BYTES,
      timeoutMs: SKILLS_FETCH_TIMEOUT_MS
    })
    if ('error' in body) return { ok: false as const, error: body.error }
    if (body.bytes.subarray(0, 8192).includes(0)) {
      return { ok: false as const, error: 'SKILL.md is not text' }
    }
    return { ok: true as const, content: body.bytes.toString('utf8') }
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

    // A credentials envelope that exists but cannot be opened here must never
    // degrade to a plaintext identity row (setIdentity's fallback). 'absent'
    // (legacy pre-envelope file) keeps its existing plaintext contract.
    const refuseLockedEnvelope = (ws: AdfWorkspace): { success: false; error: string } | null => {
      const state = ws.getEnvelopeState('credentials')
      if (state === 'locked' || state === 'foreign') {
        return {
          success: false,
          error: `Credentials envelope is ${state} for this file — refusing to store the credential in plaintext. Open the file in ADF Studio to unlock it, then retry.`,
        }
      }
      return null
    }

    // Check if this is the currently-open foreground workspace
    if (currentWorkspace && currentWorkspace.getFilePath() === args.filePath) {
      if (currentDerivedKey) {
        const { ciphertext, iv } = encrypt(Buffer.from(args.value, 'utf-8'), currentDerivedKey)
        currentWorkspace.getDatabase().setIdentityRaw(
          purpose, ciphertext, 'aes-256-gcm', iv, null
        )
      } else {
        const refusal = refuseLockedEnvelope(currentWorkspace)
        if (refusal) return refusal
        currentWorkspace.setIdentity(purpose, args.value)
      }
      return { success: true }
    }

    // Check background agents
    if (backgroundAgentManager?.hasAgent(args.filePath)) {
      const agentRefs = backgroundAgentManager.getAgent(args.filePath)
      if (agentRefs?.workspace) {
        const refusal = refuseLockedEnvelope(agentRefs.workspace)
        if (refusal) return refusal
        agentRefs.workspace.setIdentity(purpose, args.value)
        return { success: true }
      }
    }

    // Open temporarily
    let tempWorkspace: AdfWorkspace | null = null
    try {
      tempWorkspace = AdfWorkspace.open(args.filePath)
      // A temp-open starts locked even in Studio — run the D10 unlock cascade
      // first so the refusal below only fires when this install's keys
      // genuinely cannot open the envelope (foreign file, degraded keychain).
      unlockWorkspaceEnvelopes(tempWorkspace)
      const refusal = refuseLockedEnvelope(tempWorkspace)
      if (refusal) return refusal
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
        credentialStorage: args.serverConfig.credentialStorage,
        runLocation: args.serverConfig.runLocation
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
    // Merge adapter states across the foreground agent AND every background
    // agent — adapters run per-agent, and the fleet map's base stations must
    // exist regardless of which agent hosts the channel. Deduped by type,
    // healthiest instance wins.
    const rank = (status: string): number =>
      status === 'connected' || status === 'running' ? 2 : status === 'error' ? 1 : 0
    const byType = new Map<string, ReturnType<ChannelAdapterManager['getStates']>[number]>()
    const fold = (states: ReturnType<ChannelAdapterManager['getStates']>): void => {
      for (const s of states) {
        const prev = byType.get(s.type)
        if (!prev || rank(s.status) > rank(prev.status)) byType.set(s.type, s)
      }
    }
    if (currentAdapterManager) fold(currentAdapterManager.getStates())
    if (backgroundAgentManager) {
      for (const fp of backgroundAgentManager.getAllAgentFilePaths()) {
        const refs = backgroundAgentManager.getAgent(fp)
        if (refs?.adapterManager) fold(refs.adapterManager.getStates())
      }
    }
    return { adapters: [...byType.values()] }
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
        type: z.enum(['anthropic', 'openai', 'openai-compatible', 'openrouter']),
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

      // Whole-file passwords are deprecated: convert the user's OWN files on
      // unlock — strip the whole-file password, mint keys + envelopes, then
      // carry the SAME password forward as a credentials-envelope password
      // slot (multi-route: opens silently via owner/runtime keys, and the
      // password keeps working as a share password). Foreign files are left
      // exactly as-is — the claim flow owns their conversion. Without
      // envelope recipients, skip silently: never strip protection without
      // re-protecting.
      let converted = false
      try {
        const svc = settings.getOwnerIdentity()
        const fileOwnerDid = currentWorkspace.getMeta('adf_owner_did')
        const isMine = fileOwnerDid
          ? fileOwnerDid === svc.getOwnerDid()
          : !readAdfAttestations(currentWorkspace).some((a) => a.role === 'owner')
        if (isMine && svc.getEnvelopeRecipients()) {
          currentWorkspace.removePassword(currentDerivedKey)
          currentDerivedKey = null
          derivedKeyCache.delete(currentFilePath)
          syncDerivedKeyToMesh(currentFilePath, null)
          converted = true
          // Now unblocked (no longer password-protected): envelopes + keys +
          // sealing. A failure here leaves a plain file that the FILE_OPEN
          // lazy migration retries on next open.
          try {
            svc.ensureWorkspaceIdentity(currentWorkspace)
            if (currentWorkspace.getEnvelopeState('credentials') === 'unlocked') {
              // Same replace pattern as the share-password set flow.
              currentWorkspace.removeEnvelopePasswordSlots('credentials')
              currentWorkspace.addEnvelopePasswordSlot('credentials', args.password)
            }
          } catch (err) {
            console.warn('[IDENTITY_PASSWORD_UNLOCK] Post-convert provisioning failed:', err)
          }
        }
      } catch (err) {
        console.warn('[IDENTITY_PASSWORD_UNLOCK] Auto-convert check failed:', err)
      }
      return { success: true, converted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IDENTITY_PASSWORD_UNLOCK] Failed:', msg)
      // GCM auth tag failures surface as "Unsupported state or unable to authenticate data"
      const isWrongPassword = msg.includes('authenticate data') || msg.includes('auth')
      return { success: false, error: isWrongPassword ? 'Wrong password' : msg }
    }
  })

  // Deprecated: legacy whole-file password CREATION is removed. The channel
  // stays so old callers fail loudly. Unlock/remove/claim-conversion paths
  // remain — existing legacy files must still open and convert.
  ipcMain.handle(IPC.IDENTITY_PASSWORD_SET, async () => {
    return { success: false, error: 'Whole-file passwords are no longer supported — use a share password instead.' }
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

  // Deprecated alongside IDENTITY_PASSWORD_SET: re-keying is continued use of
  // the removed mechanism. Remove the password (still supported) instead.
  ipcMain.handle(IPC.IDENTITY_PASSWORD_CHANGE, async () => {
    return { success: false, error: 'Whole-file passwords are no longer supported — remove the password and use a share password instead.' }
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
      issueAttestationsForCurrentOwner(currentWorkspace)
      return { success: true, did: result.did }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_CLAIM, async () => {
    if (!currentWorkspace || !currentFilePath) return { success: false, error: 'No ADF open' }
    try {
      if (currentWorkspace.isPasswordProtected() && !currentDerivedKey) {
        // Claiming without the derived key would wipe the signing keys and
        // then bail at provisioning, leaving the file key-less and still
        // password-protected.
        return { success: false, error: 'File is password-protected — enter the password before claiming' }
      }
      settings.ensureRuntimeIdentity()
      if (!settings.getOwnerIdentity().getEnvelopeRecipients()) {
        // Fail plainly: claiming without envelope recipients would mint an
        // identity with no envelopes (plaintext keys, no credential sealing).
        return { success: false, error: 'Owner/runtime encryption keys are unavailable (keystore locked?) — cannot claim securely' }
      }
      // If password-protected, decrypt everything first, then remove password
      if (currentWorkspace.isPasswordProtected() && currentDerivedKey) {
        currentWorkspace.removePassword(currentDerivedKey)
        currentDerivedKey = null
        derivedKeyCache.delete(currentFilePath)
      }
      const { did } = settings.getOwnerIdentity().claimWorkspace(currentWorkspace)
      return { success: true, did }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // --- Owner identity (app-level, mnemonic-backed) ---

  ipcMain.handle(IPC.IDENTITY_OWNER_STATUS, async () => {
    return settings.getOwnerIdentity().getStatus()
  })

  ipcMain.handle(IPC.IDENTITY_OWNER_REVEAL_MNEMONIC, async () => {
    return { mnemonic: settings.getOwnerIdentity().revealMnemonic() }
  })

  ipcMain.handle(IPC.IDENTITY_OWNER_CONFIRM_BACKUP, async () => {
    settings.getOwnerIdentity().confirmBackup()
    return { success: true }
  })

  ipcMain.handle(IPC.IDENTITY_OWNER_IMPORT, async (_event, mnemonic: string) => {
    try {
      const result = settings.getOwnerIdentity().importMnemonic(mnemonic)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_ATTESTATIONS_GET, async () => {
    if (!currentWorkspace) return { attestations: [] }
    return { attestations: readAdfAttestations(currentWorkspace), did: currentWorkspace.getDid() }
  })

  ipcMain.handle(IPC.IDENTITY_ATTESTATIONS_REISSUE, async () => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    if (!currentWorkspace.getDid()) return { success: false, error: 'Agent has no DID — generate keys first' }
    issueAttestationsForCurrentOwner(currentWorkspace)
    return { success: true, attestations: readAdfAttestations(currentWorkspace) }
  })

  // --- Envelope keystore (dual-envelope secret protection) ---

  ipcMain.handle(IPC.IDENTITY_ENVELOPE_STATUS, async () => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    // 'foreign' from getEnvelopeState only means "no cached DEK, no password
    // slot" — a session-cache artifact for an own file whose open path never
    // unlocked (e.g. legacy password gate). Attempt the local-key unwrap
    // first, then classify leftovers by slot DIDs: local owner/runtime slot
    // present → ours-but-not-unlocked → 'locked', never 'foreign'.
    unlockWorkspaceEnvelopes(currentWorkspace)
    const svc = settings.getOwnerIdentity()
    const localDids = new Set([svc.getOwnerDid(), svc.getRuntimeDid()])
    const classify = (name: 'identity' | 'credentials') => {
      const state = currentWorkspace!.getEnvelopeState(name)
      if (state !== 'foreign') return state
      const slots = currentWorkspace!.readEnvelopeSlots(name) ?? []
      const oursBySlot = slots.some(
        (s) => s.type !== 'password' && localDids.has((s as { recipient_did?: string }).recipient_did ?? '')
      )
      return oursBySlot ? 'locked' : 'foreign'
    }
    const credentialSlots = currentWorkspace.readEnvelopeSlots('credentials') ?? []
    return {
      success: true,
      identity: classify('identity'),
      credentials: classify('credentials'),
      sharePasswordSet: credentialSlots.some((s) => s.type === 'password')
    }
  })

  // Share flow (D12): add a password slot to the credentials envelope so the
  // file can travel; identity is never password-shareable.
  ipcMain.handle(IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD, async (_event, password: string) => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    if (typeof password !== 'string' || password.length < 8) {
      return { success: false, error: 'Share password must be at least 8 characters' }
    }
    try {
      // One password slot at a time — replace rather than accumulate.
      currentWorkspace.removeEnvelopePasswordSlots('credentials')
      currentWorkspace.addEnvelopePasswordSlot('credentials', password)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD, async () => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    currentWorkspace.removeEnvelopePasswordSlots('credentials')
    return { success: true }
  })

  // Recipient flow (D12): unlock foreign credentials with the share password.
  // adopt: true (the post-claim manual path, e.g. IdentityPanel) additionally
  // re-wraps to the local owner/runtime; the password slot is PRESERVED
  // (multi-route — the same password keeps working for re-sharing). adopt:
  // false (the pre-accept review flow) caches the DEK for this session only
  // and writes NOTHING — rejecting the review must leave the file untouched;
  // adoption then happens inside the claim path.
  ipcMain.handle(IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD, async (
    _event,
    password: string,
    adopt?: boolean
  ) => {
    if (!currentWorkspace) return { success: false, error: 'No ADF open' }
    if (!currentWorkspace.unlockEnvelopeWithPassword('credentials', String(password))) {
      return { success: false, error: 'Wrong password' }
    }
    if (adopt === false) {
      return { success: true, adopted: false, credentials: currentWorkspace.getEnvelopeState('credentials') }
    }
    try {
      const svc = settings.getOwnerIdentity()
      const ownerEncPub = svc.getOwnerEncPublicKey()
      const runtimeEncPub = svc.getRuntimeEncPublicKey()
      const adopted = !!(ownerEncPub && runtimeEncPub)
      if (ownerEncPub && runtimeEncPub) {
        currentWorkspace.adoptEnvelope('credentials', {
          ownerDid: svc.getOwnerDid(),
          ownerEncPublicKey: ownerEncPub,
          runtimeDid: svc.getRuntimeDid(),
          runtimeEncPublicKey: runtimeEncPub
        })
      }
      // Credentials written while the envelope was locked landed plain —
      // seal them now that the DEK is available.
      currentWorkspace.sealPlainRowsIntoEnvelopes()
      return {
        success: true,
        adopted,
        // Adopt skipped ≠ adopted: the envelope stays usable this session but
        // no local key slots were added — the password stays the only route
        // on this machine. Warn, don't fail — failing here would block
        // credential use entirely.
        ...(adopted
          ? {}
          : { warning: 'Owner/runtime encryption keys are unavailable — envelope unlocked for this session only; the password will be required again next time' }),
        credentials: currentWorkspace.getEnvelopeState('credentials')
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
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

  // --- Grok (xAI) Subscription Auth ---

  // Device-code flow: returns the user code immediately; approval is awaited in
  // the background and surfaced via GROK_AUTH_STATUS polling from the renderer.
  ipcMain.handle(IPC.GROK_AUTH_START, async () => {
    try {
      const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
      const flow = await getGrokAuthManager().startAuthFlowDetached()
      return {
        success: true,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        verificationUriComplete: flow.verificationUriComplete,
        expiresIn: flow.expiresIn
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.GROK_AUTH_STATUS, async () => {
    try {
      const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
      return getGrokAuthManager().getAuthStatus()
    } catch {
      return { authenticated: false }
    }
  })

  ipcMain.handle(IPC.GROK_AUTH_LOGOUT, async () => {
    try {
      const { getGrokAuthManager } = await import('../providers/grok-subscription/auth-manager')
      getGrokAuthManager().logout()
      return { success: true }
    } catch {
      return { success: true }
    }
  })

  // --- Emergency Stop ---

  ipcMain.handle(IPC.EMERGENCY_STOP, async () => {
    console.log('[EmergencyStop] Shutting down everything...')
    await teardownRuntime({ disposeMode: 'emergency' })
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
    try { return { success: await podmanService.stopContainer(args.name) } }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle(IPC.COMPUTE_START_CONTAINER, async (_event, args: { name: string }) => {
    try { return { success: await podmanService.startContainer(args.name) } }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle(IPC.COMPUTE_DESTROY_CONTAINER, async (_event, args: { name: string }) => {
    try { return { success: await podmanService.destroyContainer(args.name) } }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
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

  // Visible agent browser: forward container browser-session events and expose
  // the noVNC port lookup for manual/post-restart tab reopen.
  podmanService.on('browser-session', (payload) => {
    getMainWindow()?.webContents.send(IPC.COMPUTE_BROWSER_SESSION, payload)
  })

  ipcMain.handle(IPC.COMPUTE_BROWSER_INFO, async (_event, args: { agentName: string; agentId: string }) => {
    const containerName = isolatedContainerName(args.agentName, args.agentId)
    // Browser bring-up is lazy — wait for readiness so the viewer tab never
    // opens onto connection-refused right after a container restart.
    await podmanService.browserReady(containerName).catch(() => { /* degrade to whatever port state exists */ })
    const hostPort = await podmanService.getNovncHostPort(containerName)
    return { containerName, hostPort }
  })

  ipcMain.handle(IPC.COMPUTE_TEST_EXECUTION_TARGET, async (_event, target) => {
    return externalExecutionService.probe(target)
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
 * Shared runtime teardown used by both EMERGENCY_STOP and cleanupAllProcesses
 * so the two paths can't drift. Flips the runtime gate, stops all agents,
 * mesh/WS/mDNS services, tracked child processes, host execs, sandbox workers,
 * and compute containers. Each step is independently try-caught so a failure
 * in one never prevents subsequent steps. Deliberately does NOT close
 * workspaces or sweep WAL files — cleanupAllProcesses layers that on for app
 * quit; EMERGENCY_STOP leaves files reopenable.
 */
async function teardownRuntime(opts: { disposeMode: 'graceful' | 'emergency'; finalTeardown?: boolean }): Promise<void> {
  // Flip the global gate FIRST so any in-flight microtasks (queued 'trigger'
  // listeners, pending executeTurn calls, mid-tick checkTimers) noop instead
  // of leaking past teardown. Resume() runs on the next deliberate start.
  RuntimeGate.stop()
  if (opts.finalTeardown) {
    // App-quit path only (EMERGENCY_STOP must stay resumable): latch the gate
    // so a stray resume() can't restart work mid-quit, and latch podman so new
    // ensureRunning calls reject instead of racing stopAll below.
    RuntimeGate.beginTeardown()
    podmanService.beginShutdown()
  }

  // Mesh off early so nothing routes new work into agents mid-teardown.
  try { if (meshManager?.isEnabled()) meshManager.disableMesh() }
  catch (e) { console.error('[Teardown] mesh disable error:', e) }

  const foregroundHandle = currentAssembledAgent
  try { currentHostAttachment?.detach() }
  catch (e) { console.error('[Teardown] foreground host detach error:', e) }
  currentHostAttachment = null
  currentAssembledAgent = null
  agentExecutor = null
  triggerEvaluator = null
  currentMcpManager = null
  currentMcpReconcile = null
  currentAdapterManager = null
  currentStreamBindingManager = null
  currentTapManager = null
  currentScratchDir = null
  currentAdfCallHandler = null
  try { if (foregroundHandle) await foregroundHandle.disposeAsync({ mode: opts.disposeMode }) }
  catch (e) { console.error('[Teardown] foreground dispose error:', e) }

  try { if (backgroundAgentManager) await backgroundAgentManager.stopAll({ finalTeardown: opts.finalTeardown }) }
  catch (e) { console.error('[Teardown] background stop error:', e) }

  // Timer cleanup: drop the pending 50ms batch timer and flush whatever is
  // still buffered. Not what delivers the final agent_stopped events — those
  // are IMMEDIATE_TYPES already flushed inside stopAll() above — and teardown
  // runs under a deadline, so this line is best-effort and may not run at all.
  try { backgroundEventBatcher?.dispose() }
  catch (e) { console.error('[Teardown] background event batcher error:', e) }

  currentSession = null
  currentAgentToolRegistry = null

  try { if (wsConnectionManager) { wsConnectionManager.stopAll(); wsConnectionManager = null } }
  catch (e) { console.error('[Teardown] WS connection manager error:', e); wsConnectionManager = null }
  try { backgroundAgentManager?.setWsConnectionManager(null) } catch { /* ignore */ }

  try { await stopMdnsAndCleanup() }
  catch (e) { console.error('[Teardown] mDNS stop error:', e) }

  try { if (meshServer) { await meshServer.stop(); meshServer = null } }
  catch (e) { console.error('[Teardown] mesh server stop error:', e); meshServer = null }

  // Reap stray child process trees (MCP preflights, shims) and host execs.
  try { await killAllTracked() }
  catch (e) { console.error('[Teardown] tracked child kill error:', e) }
  try { await killAllHostExecs() }
  catch (e) { console.error('[Teardown] host exec kill error:', e) }

  // Terminate sandbox workers before any DB close.
  try { codeSandboxService.destroyAll() }
  catch (e) { console.error('[Teardown] sandbox destroy error:', e) }

  // Stop all compute containers (shared + isolated). Wait for in-flight
  // container starts first so a container finishing its bring-up mid-quit
  // cannot outlive the single stopAll below (daemon-host parity).
  try { await podmanService.pendingStarts?.() }
  catch (e) { console.error('[Teardown] Podman pendingStarts error:', e) }
  try { await podmanService.stopAll() }
  catch (e) { console.error('[Teardown] Podman stop error:', e) }
}

/** Phase-2 budget for cleanupAllProcesses. The app-level shutdown budget in
 * src/main/index.ts is 8s; leaving headroom guarantees the synchronous
 * workspace-close/WAL-sweep phase below always gets to run. */
const CLEANUP_TEARDOWN_BUDGET_MS = 6_000

/**
 * Fast-path durability flush for OS session end (Windows logoff/shutdown
 * gives ~5s of grace): runtime-gate latch, token flush, workspace checkpoint,
 * then a bounded kill of all tracked children. No container/workspace
 * teardown — the OS is about to reclaim everything anyway; what matters is
 * that SQLite data is durable and no child outlives the session.
 */
export async function fastSessionEndCleanup(killBudgetMs = 2_000): Promise<void> {
  console.log('[Cleanup] Session ending — fast durability flush...')
  RuntimeGate.beginTeardown()
  podmanService.beginShutdown()
  try { getTokenUsageService().flush() }
  catch (e) { console.error('[Cleanup] token usage flush error:', e) }
  // Flush buffered loop entries (foreground + background) BEFORE the WAL
  // checkpoint so a session end mid-turn doesn't drop the in-memory buffer.
  // Plain synchronous better-sqlite3 writes (sub-ms) — a full executor
  // abort() is deliberately avoided here: resolving pending HIL/ask promises
  // can cascade continuation work we can't afford inside the OS grace window.
  try { currentSession?.flushToLoop() }
  catch (e) { console.error('[Cleanup] foreground loop flush error:', e) }
  try { backgroundAgentManager?.flushAllSessions() }
  catch (e) { console.error('[Cleanup] background loop flush error:', e) }
  try { currentWorkspace?.checkpoint() }
  catch (e) { console.error('[Cleanup] workspace checkpoint error:', e) }
  try { await killAllTracked(killBudgetMs) }
  catch (e) { console.error('[Cleanup] tracked child kill error:', e) }
}

/**
 * Gracefully clean up all running processes. Called from app before-quit.
 * Phase 1 (must-complete): runtime gate, token-usage flush, WAL checkpoint.
 * Phase 2 (best-effort, budgeted): full runtime teardown via teardownRuntime.
 * Phase 3 (unconditional, synchronous): workspace close + WAL sweeps + scratch purge.
 * `teardownBudgetMs` shrinks phase 2 on fast paths (Windows signals give ~5s
 * total) so phase 3 still gets to run inside the OS grace window.
 */
export async function cleanupAllProcesses(opts?: { teardownBudgetMs?: number }): Promise<void> {
  console.log('[Cleanup] App quitting — cleaning up all processes...')

  // ---- Phase 1: fast, must-complete (data durability) ----
  // Latch the gate + podman for the rest of the process lifetime: a stray
  // resume() or ensureRunning() must not restart work mid-quit.
  RuntimeGate.beginTeardown()
  podmanService.beginShutdown()
  // Flush debounced token usage data before anything can go wrong.
  try { getTokenUsageService().flush() }
  catch (e) { console.error('[Cleanup] token usage flush error:', e) }
  // Checkpoint the foreground workspace WAL now, while the DB is guaranteed
  // open — even if the phase-2 budget expires, the data is already durable.
  try { currentWorkspace?.checkpoint() }
  catch (e) { console.error('[Cleanup] workspace checkpoint error:', e) }
  // Apply deferred renames that are already applicable (agent not running) —
  // cheap and synchronous; doing it here guarantees them even if the outer
  // app budget cuts phase 3 short. Renames still blocked by a running agent
  // are retried in phase 3 after teardown stops the agents.
  try { for (const fp of [...pendingAgentRenames.keys()]) applyPendingRename(fp) }
  catch (e) { console.error('[Cleanup] early deferred rename error:', e) }

  const trackedCleanupDirs = new Set<string>()
  try {
    const trackedDirs = (settings.get('trackedDirectories') as string[]) ?? []
    for (const dirPath of trackedDirs) {
      const normalized = resolve(dirPath)
      trackedCleanupDirs.add(normalized)
      rememberTrackedDirectory(normalized)
    }
  } catch { /* ignore */ }

  // Collect agent directories before teardown clears the maps.
  try { if (backgroundAgentManager) for (const fp of backgroundAgentManager.getAllAgentFilePaths()) rememberAdfDirectory(fp) }
  catch { /* ignore */ }
  if (currentFilePath) rememberAdfDirectory(currentFilePath)

  // ---- Phase 2: best-effort, budgeted runtime teardown ----
  const teardownBudgetMs = opts?.teardownBudgetMs ?? CLEANUP_TEARDOWN_BUDGET_MS
  const { timedOut } = await withDeadline(
    teardownRuntime({ disposeMode: 'graceful', finalTeardown: true }),
    teardownBudgetMs,
    () => console.error(`[Cleanup] Runtime teardown exceeded ${teardownBudgetMs}ms — proceeding to workspace close`)
  )
  if (timedOut) {
    // Ensure no tracked child survives even when graceful teardown hung.
    try { await killAllTracked(1_000) } catch { /* ignore */ }
  }

  // ---- Phase 3: workspace close + sweeps (synchronous, unconditional) ----
  // A phase-2 timeout can leave teardown unfinished with loop entries still
  // buffered in memory — flush them before the DB closes. No-op when phase 2
  // completed (teardown flushed via abort() and nulled currentSession).
  try { currentSession?.flushToLoop() } catch { /* best-effort against a closing DB */ }
  try { backgroundAgentManager?.flushAllSessions() } catch { /* best-effort */ }
  try { if (currentWorkspace) { currentWorkspace.close(); currentWorkspace = null } }
  catch (e) { console.error('[Cleanup] foreground workspace close error:', e); currentWorkspace = null }

  // Apply any renames that were deferred while agents were running.
  currentFilePath = null
  try { for (const fp of [...pendingAgentRenames.keys()]) applyPendingRename(fp) }
  catch (e) { console.error('[Cleanup] deferred rename error:', e) }

  // Skip any DB still open in this process — a phase-2 timeout can leave
  // agents (and their SQLite handles) alive, and checkpoint+unlink of a live
  // DB's sidecars loses frames. openFilePaths() is the live registry.
  let openDbPaths: Set<string> | undefined
  try { openDbPaths = new Set(AdfDatabase.openFilePaths()) }
  catch { /* sweep unskipped rather than not at all */ }

  // Sweep exact directories we opened an .adf from.
  for (const dir of openedAdfDirs) {
    try { AdfDatabase.cleanupOrphanedWalFiles(dir, openDbPaths) }
    catch (e) { console.error(`[Cleanup] WAL file cleanup error in ${dir}:`, e) }
  }

  // Sweep tracked directory trees because sidebar scans can include nested ADFs.
  let maxWalCleanupDepth = 5
  try { maxWalCleanupDepth = (settings.get('maxDirectoryScanDepth') as number) ?? 5 } catch { /* pre-init quit */ }
  for (const dir of trackedCleanupDirs) {
    try { cleanupWalFilesRecursive(dir, maxWalCleanupDepth, openDbPaths) }
    catch (e) { console.error(`[Cleanup] recursive WAL file cleanup error in ${dir}:`, e) }
  }

  // Purge all scratch directories as a safety net
  purgeAllScratchDirs()

  console.log('[Cleanup] All processes cleaned up.')
}

/** Expose the active workspace for the adf-file:// protocol handler. */
export function getCurrentWorkspace(): AdfWorkspace | null {
  return currentWorkspace
}
