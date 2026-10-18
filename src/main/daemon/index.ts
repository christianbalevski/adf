import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { RuntimeService, type RuntimeAgentLoadedEvent } from '../runtime/runtime-service'
import { AgentRuntimeBuilder } from '../runtime/agent-runtime-builder'
import { CodeSandboxService } from '../runtime/code-sandbox'
import { MeshManager } from '../runtime/mesh-manager'
import { createProvider, resolveAgentProviderConfig } from '../providers/provider-factory'
import { seedMandatoryReasoningModels, setMandatoryReasoningPersister } from '../providers/ai-sdk-provider'
import { type ComputeEnvSettings } from '../services/podman.service'
import { createComputeService } from '../services/compute-service-factory'
import { setManagedBrowserEnsurer } from '../services/managed-browser-hook'
import { SandboxPackagesService } from '../services/sandbox-packages.service'
import { SandboxStdlibService } from '../services/sandbox-stdlib.service'
import { MeshServer } from '../services/mesh-server'
import { LanReach } from '../services/lan-reach'
import { WsConnectionManager } from '../services/ws-connection-manager'
import { PackageResolver } from '../services/mcp-package-resolver'
import { UvManager } from '../services/uv-manager'
import { UvxPackageResolver } from '../services/uvx-package-resolver'
import { killAllHostExecs } from '../services/host-exec.service'
import { getTokenUsageService } from '../services/token-usage.service'
import { DaemonHost } from './daemon-host'
import { RemoteAccessService } from './remote-access/service'
import { isLoopbackName } from './request-guard'
import { DaemonEventBus } from './event-bus'
import { defaultSettingsPath, FileSettingsStore } from './file-settings-store'
import { noteAutostartReport } from './tracked-dirs'
import { TrackedDirWatcher } from './dir-watcher'
import { createMeshControls, createMeshServerBinder } from './mesh-controls'
import { ensureDaemonEncKey, type DaemonEncKey } from './daemon-enc-key'
import { ensureDaemonToken } from './daemon-token'
import { BEHIND_PROXY_ENV, behindProxyFromEnv, mintLocalProof, noteLocalProofProblem } from './local-access'
import { DaemonIdentity, readBootPassphrase } from './daemon-identity'
import { DaemonAgentFactory } from './daemon-agent-factory'
import { setWorkspaceIdentityHooks } from '../runtime/identity-provisioner'
import { setChildTrustRegistrar } from '../runtime/child-trust'
import { markConfigReviewed } from '../services/agent-review'
import { withSource } from '../runtime/execution-context'
import { registerDaemonEventBus, emitUmbilicalEvent } from '../runtime/emit-umbilical'
import { getLanAddresses } from '../utils/network'
import { purgeAllScratchDirs, purgeStaleProcessDirs } from '../utils/scratch-dir'
import { killAllTracked } from '../utils/child-registry'
import { withDeadline } from '../utils/concurrency'
import { AdfDatabase } from '../adf/adf-database'
import { DEFAULT_COMPUTE_SETTINGS } from '../../shared/constants/compute-defaults'
import { CLIENT_API_VERSION, takeLaunchEnv } from './routes/meta-routes'
import { daemonGapRouteDeps } from './routes/gap-deps'
import { RuntimeDiscovery } from '../services/runtime-discovery'
import { applySettingLive } from './live-setting'
import { approvalHub } from '../runtime/approval-hub'
import { createDaemonClientSessions } from './client-wiring'
import { wireRuntimeToMesh } from './runtime-mesh-wiring'
import { processAgentLeases } from '../runtime/agent-lease'
import { createBootEnvelopeSweep } from './boot-envelope-sweep'
import { testSeamsAllowed } from '../utils/test-seams'
import { sweepStaleSnapshots } from './file-ops'

// Defined by the builds that ship the daemon (electron.vite.config.ts for
// out/main/daemon.js, scripts/build-npm.mjs for the npm package).
declare const __ADF_VERSION__: string | undefined

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
  // Log only — never exit (Studio parity). The daemon hosts the whole agent
  // fleet; an escaped exception from one agent's config or a dependency timer
  // must not take it down.
  console.error('[ADF Daemon] Uncaught exception:', err?.stack ?? err)
})
process.on('unhandledRejection', (reason) => {
  // Log only (Studio parity) — one stray rejection deep in a dependency
  // (grammy polling, imapflow, etc.) must not take down the whole fleet.
  console.error('[ADF Daemon] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
})

const port = Number(process.env.ADF_DAEMON_PORT ?? 7385)
const host = process.env.ADF_DAEMON_HOST ?? '127.0.0.1'
const pidFile = process.env.ADF_DAEMON_PIDFILE
const settingsPath = process.env.ADF_DAEMON_SETTINGS ?? defaultSettingsPath()
const daemonVersion = typeof __ADF_VERSION__ === 'string' ? __ADF_VERSION__ : process.env.ADF_VERSION ?? process.env.npm_package_version ?? 'dev'
// Also strips ELECTRON_RUN_AS_NODE and ADF_DAEMON_STARTED_BY from process.env (see takeLaunchEnv).
const startedBy = takeLaunchEnv()
console.log(`[ADF Daemon] Version ${daemonVersion} (pid ${process.pid}, started by ${startedBy})`)

const settings = new FileSettingsStore(settingsPath)
// Runtime host record (§10.3) at boot, with this build's version (the
// registry's default reads npm_package_version, absent in the bundle).
void processAgentLeases().configure({ kind: 'daemon', settingsPath, version: daemonVersion })
const eventBus = new DaemonEventBus(1000)
registerDaemonEventBus(eventBus)

// --- Envelope keys + owner identity -----------------------------------------
// The daemon's X25519 key lives next to its settings file. It is this
// daemon's runtime encryption key, and Studio also wraps a credentials-
// envelope keyslot to it for every trusted daemon (`trustedDaemonEncKeys`),
// so env:credentials rows decrypt here even before the owner identity is set.
//
// The owner identity is opt-in: the user creates or restores it (`adf
// identity`), and the phrase lives in the OS keychain (shared with Studio on
// this machine) or a passphrase file. Until then the hooks stay unlock-only
// and nothing mints identities; once ready, the daemon provisions agents
// exactly like Studio (sealed keys, owner/runtime stamps, attestations).
let daemonEncKey: DaemonEncKey | null = null
try {
  daemonEncKey = ensureDaemonEncKey(dirname(settingsPath))
  console.log(`[ADF Daemon] Envelope key ${daemonEncKey.label} — public key file: ${daemonEncKey.pubKeyPath}`)
  console.log(`[ADF Daemon] To let this daemon unlock agent credentials, add this public key to Studio's trusted daemon keys (trustedDaemonEncKeys): ${daemonEncKey.publicKeyB64}`)
} catch (err) {
  console.error('[ADF Daemon] Envelope key unavailable — credentials envelopes stay locked on this daemon:', err instanceof Error ? err.message : err)
}
// --- Access token ------------------------------------------------------------
// Every HTTP route but GET /health requires it (request-guard.ts). Local
// clients read the file; ADF_DAEMON_TOKEN overrides it (and is what remote
// clients use). Failing to write the file is fatal: an unauthenticated
// daemon is exactly what the token exists to prevent.
let daemonToken: string
if (process.env.ADF_DAEMON_TOKEN) {
  daemonToken = process.env.ADF_DAEMON_TOKEN
  console.log('[ADF Daemon] Access token: ADF_DAEMON_TOKEN')
} else {
  const minted = ensureDaemonToken(dirname(settingsPath))
  daemonToken = minted.token
  console.log(`[ADF Daemon] Access token: ${minted.path}${minted.created ? ' (new)' : ''} — local adf clients read it automatically; print it with: adf daemon token`)
}

// --- Proxy mode (local-access.ts) ---------------------------------------------
// Behind a same-host reverse proxy every proxied request arrives from loopback,
// so identity secrets and shutdown additionally need the per-run local proof
// that only this machine's adf clients can read.
// The proof is minted on every run: POST /identity/import (owner switch)
// requires it in every mode, the other local-only routes only behind a proxy.
const behindProxy = behindProxyFromEnv()
let localProof: string | null = null
if (behindProxy) {
  const minted = mintLocalProof(dirname(settingsPath), port)
  localProof = minted.proof
  console.log(`[ADF Daemon] Proxy mode (${BEHIND_PROXY_ENV}): identity and shutdown routes need the local proof in ${minted.path}; run those adf commands on this host`)
} else {
  try {
    localProof = mintLocalProof(dirname(settingsPath), port).proof
  } catch (err) {
    // Visible in GET /version (`localProof`), Studio's Settings → Backend and `adf daemon status`.
    noteLocalProofProblem(`the local proof file could not be written or protected: ${err instanceof Error ? err.message : String(err)}`)
    console.error('[ADF Daemon] Could not write or protect the local proof file; owner import (adf identity import) and the stored-value reveal routes stay unavailable:', err instanceof Error ? err.message : err)
  }
}

const ownerIdentity = new DaemonIdentity({
  settings,
  settingsPath,
  encKey: daemonEncKey,
  bootPassphrase: readBootPassphrase((path) => readFileSync(path, 'utf-8')),
})
// Provider API keys added through the daemon live in the same secret store.
settings.setProviderKeyVault(ownerIdentity.providerKeys)
{
  const initial = ownerIdentity.refresh()
  console.log(`[ADF Daemon] Owner identity: ${initial.status}${initial.ownerDid ? ` (${initial.ownerDid})` : ''}, ${initial.storage} storage — ${initial.message}`)
}
// Unlock cascade: Studio's runtime key when adopted (design daemon-backend.md
// §5.3), then the daemon's own runtime-enc-key, then the owner key.
setWorkspaceIdentityHooks(ownerIdentity.workspaceHooks())
// Children spawned via sys_create_adf are trusted (parity with Studio; see
// child-trust.ts). RuntimeService also wires the per-agent hook.
setChildTrustRegistrar((childConfig) => {
  settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), childConfig))
})
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
// Same global worker ceiling as Studio — the daemon hosts every background
// agent in one process, so it is exactly where the cap has to bind.
// Applies live, as Studio's SETTINGS_SET: the gate re-pumps its queue, so a
// raised ceiling releases waiting executions without a restart.
applySettingLive(settings, 'sandboxMaxWorkers', (value, initial) => {
  codeSandboxService.setMaxWorkers(value as number | undefined)
  if (initial) return
  const { maxCold, maxWarm } = codeSandboxService.getResourceStats()
  console.log(`[ADF Daemon] sandboxMaxWorkers changed to ${value ?? 'default'}: sandbox worker ceiling now ${maxCold} cold / ${maxWarm} warm`)
})
const sandboxPackagesService = new SandboxPackagesService()
// Runtime packages (Settings > Packages) are importable by every agent; read
// at each execution so a settings change applies without a restart. Each
// agent's own packages are added on top (assembleAgent).
codeSandboxService.setUserPackages(sandboxPackagesService.getBasePath(), () =>
  ((settings.get('sandboxPackages') as Array<{ name: string }> | undefined) ?? []).map((p) => p.name))
const sandboxStdlibService = new SandboxStdlibService()
// ADF_COMPUTE=fake (test seam, never in a packaged app): no podman/wsl at all.
const podmanService = createComputeService()
// Container MCP servers that attach over CDP ask for the managed browser before spawning.
setManagedBrowserEnsurer((containerName) => podmanService.ensureManagedBrowserUp(containerName))
podmanService.setSettingsAccessor(() => readComputeSettings(settings.get('compute')))
const uvManager = new UvManager()
const mcpPackageResolver = new PackageResolver('mcp-servers')
const adapterPackageResolver = new PackageResolver('channel-adapters')
const uvxPackageResolver = new UvxPackageResolver(uvManager)

// Heal manifest entries whose recorded entry point isn't a spawnable file
// (pre-fix installs recorded uv's per-tool venv DIRECTORY, which spawns EACCES).
// Only broken entries touch uv, so a clean manifest costs nothing.
uvxPackageResolver.repairManifest().catch((err) =>
  console.warn('[UvxPackageResolver] Manifest repair failed:', err)
)
const meshManager = new MeshManager(trackedDirs)
const wsConnectionManager = new WsConnectionManager(meshManager.createWsDelegate())
meshManager.setWsConnectionManager(wsConnectionManager)
// /ping advertises the runtime DID + delegation the daemon signs with (Studio's
// only when adopted), not whatever the shared settings file holds.
const meshServer = new MeshServer(codeSandboxService, ownerIdentity.presentedSettings(settings))
// LAN mode: only on networks the user allowed, the rule and the list remote access uses (remote-access.md §3.3.1).
meshServer.setLanReach(new LanReach({ settingsDir: dirname(settingsPath) }))
// When the mesh server binds, and a stop on request that holds (mesh-controls.ts).
const meshServerBinder = createMeshServerBinder({ settings, mesh: meshManager, server: meshServer })
meshServer.setMeshManager(meshManager)
meshServer.setWsConnectionManager(wsConnectionManager)
if (settings.get('meshEnabled') !== false) {
  meshManager.enableMesh()
}
// Peer discovery: mDNS announce/browse, tailnet sweep, manual peers (Studio
// parity for Settings → Networking and the fleet map). Follows the mesh
// server on its own; stopped before it at shutdown so goodbyes go out.
const runtimeDiscovery = new RuntimeDiscovery({
  settings,
  meshServer,
  mesh: meshManager,
  getRuntimeDid: discoveryRuntimeDid,
  getOwnerDid: () => (settings.get('ownerDid') as string | undefined) || undefined,
  // The one tailnet sweep also asks each peer's daemon port for /remote/hello (remote-access.md §5.2).
  daemonPort: port,
})
runtimeDiscovery.start()
// The mDNS TXT record carries the runtime DID: re-announce when the daemon
// starts or stops presenting Studio's.
ownerIdentity.onRuntimeChange(() => {
  void runtimeDiscovery.stop().then(() => runtimeDiscovery.start())
})

/**
 * The runtime DID mDNS advertises: the one this daemon signs with, the
 * adopted Studio runtime DID while adoption is active, else its own
 * (`daemonRuntimeDid`). Same source as mesh /ping (presentedSettings).
 */
function discoveryRuntimeDid(): string | undefined {
  return ownerIdentity.presentedRuntime().did ?? undefined
}
const agentRuntimeBuilder = new AgentRuntimeBuilder({
  settings,
  codeSandboxService,
  sandboxPackagesService,
  podmanService,
  credentialEnvelopeLockedHint: daemonEncKey
    ? `Make the owner identity available (\`adf identity restore\` / \`adf identity unlock\`, or /identity in the TUI), or add this daemon's runtime key (${daemonEncKey.pubKeyPath}) to Studio's trusted daemon keys (trustedDaemonEncKeys) and open the agent in Studio once.`
    : undefined,
  wsConnectionManager,
  mcpPackageResolver,
  adapterPackageResolver,
  uvManager,
  uvxPackageResolver,
  basePrompt,
  toolPrompts,
  compactionPrompt,
  // App-level MCP OAuth sign-ins: capture-on-attach and interactive sign-in
  // store here first, as Studio's mcpOauthCredentials.
  mcpOAuthAppStore: ownerIdentity.mcpOAuth,
})
const runtime = new RuntimeService({
  settings,
  // Same resolution as Studio: the agent's own providers[] entry (base URL,
  // params, per-agent key) wins; the daemon's settings supply the rest.
  providerFactory: (config, _filePath, context) => createProvider(
    config,
    settings,
    context ? resolveAgentProviderConfig(config, context.workspace, context.derivedKey, settings) : undefined,
  ),
  basePrompt,
  toolPrompts,
  compactionPrompt,
  agentRuntimeBuilder,
})
// Envelope unlock otherwise only runs at agent load. When the owner identity
// becomes ready (create/restore/unlock, or a phrase Studio put in the shared
// keychain), re-check every agent loaded while it was not.
ownerIdentity.onReady(() => {
  runtime.refreshAgentCredentials('owner identity ready')
    .catch(err => console.error('[ADF Daemon] Credential re-check failed:', err))
})
// Same when the daemon starts or stops using Studio's runtime identity.
ownerIdentity.onRuntimeChange((adoption) => {
  runtime.refreshAgentCredentials(`runtime identity ${adoption.state}`)
    .catch(err => console.error('[ADF Daemon] Credential re-check failed:', err))
})
// While any agent is degraded, re-check once a minute: picks up a keychain
// phrase, a Studio runtime entry or a trusted-daemon slot Studio wrote, with
// no daemon restart. Silent while nothing changes; every unlock is logged +
// evented.
const CREDENTIAL_RECHECK_MS = 60_000
setInterval(() => {
  if (!runtime.hasDegradedAgents()) return
  try {
    ownerIdentity.refresh() // a transition fires onReady / onRuntimeChange
  } catch (err) {
    console.error('[ADF Daemon] Owner identity refresh failed:', err)
  }
  runtime.refreshAgentCredentials('periodic re-check')
    .catch(err => console.error('[ADF Daemon] Credential re-check failed:', err))
}, CREDENTIAL_RECHECK_MS).unref?.()
// Template changes (route writes and the templates-folder watcher) go to
// every client session as `templates`, Studio's TEMPLATES_CHANGED.
const agentFactory = new DaemonAgentFactory({ settings, identity: ownerIdentity, runtime, notifyTemplatesChanged: () => client.sessions.publishPush('templates', {}) })
// Tracked-folder watcher (W1-E): autostarts new agent files and feeds the
// tracked_dirs / file_renamed pushes. Started when the HTTP server is ready,
// closed with it, and closed again (idempotent) in the shutdown hooks.
const trackedDirWatcher = new TrackedDirWatcher({
  runtime,
  settings,
  onTrackedDirectoriesChanged: (dirs) => meshManager.setTrackedDirectories(dirs),
})
// Client sessions and the client event stream (design daemon-backend.md D5):
// every push Studio's window gets in embedded mode, as frames, and session
// documents as W2-A's open documents. Built by client-wiring.ts (the gate
// test builds the same); the HTTP side is routes/client-routes.ts.
const client = createDaemonClientSessions({
  runtime,
  mesh: meshManager,
  compute: podmanService,
  approvals: approvalHub,
  trackedDirWatcher,
  eventBus,
  packages: { mcp: mcpPackageResolver, python: uvxPackageResolver, adapters: adapterPackageResolver, sandbox: sandboxPackagesService },
  options: {
    startedBy,
    // Test seam (ADF_TEST_SEAMS=1, unpackaged): a short session expiry, so the orphan rule is testable end to end.
    ...(testSeamsAllowed() && Number(process.env.ADF_TEST_CLIENT_SESSION_EXPIRY_MS) > 0
      ? { expiryMs: Number(process.env.ADF_TEST_CLIENT_SESSION_EXPIRY_MS) }
      : {}),
    // §8.3 orphan rule: the session of a Studio that crashed expired.
    requestShutdown: () => {
      console.log('[ADF Daemon] The last client session that owned this daemon run expired — shutting down...')
      void boundedShutdown(0)
    },
  },
})
// --- Remote access (docs/design/remote-access.md) -------------------------------
// Other computers reach this daemon on its private and Tailscale addresses
// when remote-access.json says so, whoever started it. Listeners open after
// the loopback one (DaemonHost.start). A non-loopback ADF_DAEMON_HOST is the
// older env path and wins.
const remoteAccess = new RemoteAccessService({
  settingsDir: dirname(settingsPath),
  port,
  clientApiVersion: CLIENT_API_VERSION,
  envBindHost: isLoopbackName(host) ? null : host,
  // tailscale serve's Tailscale-User-* headers are trusted only in proxy mode, from a loopback peer.
  behindProxy,
  sessions: () => client.sessions,
  // One name for other computers: the runtime alias (Settings → Identity), else the host name.
  runtimeAlias: { get: () => settings.get('runtimeAlias'), set: (name) => settings.set('runtimeAlias', name) },
  // This machine's own clients only (LOCAL_ONLY_PUSH_TOPICS): never the
  // umbilical bus, which GET /events serves to device tokens and agent taps read.
  emit: (event) => client.sessions.publishPush('remote_access', event),
  // One announcement (remote-access.md §5.1): remote access's fields join the discovery service's _adf-runtime._tcp record.
  announcer: runtimeDiscovery.remoteAnnouncer(),
  // One consent list: the mesh's LAN listeners follow an allow or a remove at once.
  onNetworksChanged: () => { void meshServer.syncLan(true) },
  meshLan: () => meshServer.isLanMode(),
})
// The feed changed: this machine's own clients re-read GET /network/peers (one event stream, peers_changed).
runtimeDiscovery.onPeersChanged(() => client.sessions.publishPush('remote_access', { type: 'peers_changed' }))
agentFactory.startTemplatesWatcher()
// Snapshot folders a previous run left in the temp dir (killed mid-download): they can hold a full .adf.
void sweepStaleSnapshots().then((removed) => {
  if (removed.length > 0) console.log(`[ADF Daemon] Removed ${removed.length} leftover snapshot folder(s) from the temp dir: ${removed.join(', ')}`)
}).catch((err) => console.warn('[ADF Daemon] Leftover snapshot sweep failed:', err instanceof Error ? err.message : err))

const daemon = new DaemonHost({
  runtime,
  identity: ownerIdentity,
  agentFactory,
  // `adf daemon stop`: the same bounded shutdown as Ctrl+C / SIGTERM.
  requestShutdown: () => {
    console.log('[ADF Daemon] Stop requested over HTTP — shutting down...')
    void boundedShutdown(0)
  },
  host,
  port,
  token: daemonToken,
  behindProxy,
  localProof,
  pidFile,
  version: daemonVersion,
  // Services the W1-D gap routes reach (routes/gap-deps.ts): emergency stop
  // stops the mesh server and sandbox workers; MCP admin shares the uv
  // install and the app-level OAuth store (DaemonAppOAuthStore) the builder uses.
  routes: { startedBy, gaps: daemonGapRouteDeps({ codeSandboxService, meshServer, uvManager, mcpAppOAuthStore: ownerIdentity.mcpOAuth }), trackedDirWatcher, remoteAccess },
  // POST/DELETE /tracked-dirs: the mesh resolves agents by tracked root, so
  // it must see the new list now, not at the next boot (Studio parity).
  onTrackedDirectoriesChanged: (dirs) => meshManager.setTrackedDirectories(dirs),
  computeService: podmanService,
  settingsStore: settings,
  providerKeys: ownerIdentity.providerKeys,
  eventBus,
  wsService: wsConnectionManager,
  mesh: meshManager,
  networkService: {
    getStatus: () => ({
      meshEnabled: meshManager.isEnabled(),
      meshServerRunning: meshServer.isRunning(),
      meshServer: {
        running: meshServer.isRunning(),
        port: meshServer.getPort(),
        host: meshServer.getHost(),
        lanAddresses: meshServer.getLanAddresses(),
      },
      agents: meshManager.getAgentStatuses(),
      debug: meshManager.getDebugInfo(),
    }),
    // Mesh on/off (off closes WS connections) and server start/stop/restart (mesh-controls.ts).
    ...createMeshControls({
      settings,
      mesh: meshManager,
      server: meshServer,
      ws: wsConnectionManager,
      registerLoaded: () => { for (const event of meshWiring.loaded()) registerAgentWithMesh(event) },
      onServerSwitch: (state) => meshServerBinder.serverSwitched(state),
    }),
    getRecentTools: (limit) => meshManager.getRecentTools(limit),
    getServerStatus: () => ({
      running: meshServer.isRunning(),
      port: meshServer.getPort(),
      host: meshServer.getHost(),
      lanAddresses: meshServer.getLanAddresses(),
    }),
    getLanAddresses,
    getDiscoveredRuntimes: (args?: { force?: boolean }) => runtimeDiscovery.getDiscoveredRuntimes(args),
    getPeers: (args: { waitMs?: number }) => runtimeDiscovery.peers(args),
  },
  // The admin install routes report progress on the client stream, as
  // Studio's install handlers push *_INSTALL_PROGRESS (client-wiring.ts).
  mcpPackageService: client.packages.mcp,
  mcpPythonPackageService: client.packages.python,
  adapterPackageService: client.packages.adapters,
  sandboxPackageService: client.packages.sandbox,
  // Runs FIRST in DaemonHost.stop(), before server close and agent unload —
  // debounced token usage is the most losable data, and a hang anywhere later
  // in shutdown must not cost it (Studio's cleanupAllProcesses phase-1 parity).
  onShutdownStart: [
    () => getTokenUsageService().flush(),
  ],
  // Runs inside DaemonHost.stop() after agents and compute are down — keeps
  // daemon shutdown at parity with Studio's cleanupAllProcesses. Each hook is
  // independently try-caught by the host.
  onShutdown: [
    () => trackedDirWatcher.close(),
    () => agentFactory.stopTemplatesWatcher(),
    () => wsConnectionManager.stopAll(),
    () => runtimeDiscovery.stop(),
    () => meshServer.stop(),
    () => meshManager.disableMesh(),
    () => codeSandboxService.destroyAll(),
    () => killAllTracked(),
    () => killAllHostExecs(),
    () => sweepTrackedDirWalFiles(),
    () => purgeAllScratchDirs(),
  ],
  // Signals are handled by the index-level boundedShutdown handlers installed
  // above — DaemonHost's own SIGINT/SIGTERM handlers would double-run stop()
  // and race process.exit codes.
  installSignalHandlers: false,
})
hostForShutdown = daemon

/**
 * Checkpoint + remove WAL sidecars across tracked directory trees (recursive
 * with the same depth cap as autostart scans — Studio parity), skipping any
 * DB still open in this process. AdfDatabase.openFilePaths() is the live
 * registry; the previous loadedAgentEvents-derived skip-set dropped entries
 * on 'agent-unloaded' before dispose finished closing the DB, leaving a
 * window where a still-open DB's sidecars could be checkpointed+unlinked.
 */
function sweepTrackedDirWalFiles(): void {
  let openPaths: Set<string> | undefined
  try { openPaths = new Set(AdfDatabase.openFilePaths()) }
  catch { /* sweep unskipped rather than not at all */ }
  const maxDepth = (settings.get('maxDirectoryScanDepth') as number | undefined) ?? 5
  const dirs = (settings.get('trackedDirectories') as string[] | undefined) ?? []
  for (const dir of dirs) {
    try { sweepWalFilesRecursive(dir, maxDepth, openPaths, 0) }
    catch (err) { console.error(`[ADF Daemon] WAL sweep failed in ${dir}:`, err) }
  }
  // Directories of every agent loaded THIS SESSION (HTTP-API loads can point
  // outside trackedDirectories) — swept non-recursively so shutdown leaves
  // zero sidecars for anything this process opened.
  for (const dir of sessionAdfDirs) {
    try { AdfDatabase.cleanupOrphanedWalFiles(dir, openPaths) }
    catch (err) { console.error(`[ADF Daemon] WAL sweep failed in ${dir}:`, err) }
  }
}

/**
 * Directories of every .adf loaded at any point in this daemon session.
 * Unlike the mesh wiring's loaded list this never shrinks on unload, so the shutdown
 * sweep covers agents that were loaded outside tracked dirs and already
 * unloaded (their sidecars may have been left by a kill/crash of a helper).
 */
const sessionAdfDirs = new Set<string>()

function sweepWalFilesRecursive(directory: string, maxDepth: number, skipPaths: Set<string> | undefined, currentDepth: number): void {
  AdfDatabase.cleanupOrphanedWalFiles(directory, skipPaths)
  if (currentDepth >= maxDepth) return
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(directory, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    sweepWalFilesRecursive(join(directory, entry.name), maxDepth, skipPaths, currentDepth + 1)
  }
}

// Umbilical wiring (bus, taps, agent.loaded/unloaded, adapter/MCP bridges)
// lives in runtime/umbilical-lifecycle.ts and is attached as lifecycle
// resources by AgentRuntimeBuilder, so the daemon and both Studio hosts emit
// the identical stream. These listeners carry only daemon-specific bookkeeping.
// Mesh registration follows load, stop (unregistered before the teardown,
// as Studio) and path changes: runtime-mesh-wiring.ts.
const meshWiring = wireRuntimeToMesh(runtime, {
  register: registerAgentWithMesh,
  unregister: (filePath) => meshManager.unregisterAgent(filePath),
})
runtime.on('agent-loaded', (event) => {
  if (event.filePath) { try { sessionAdfDirs.add(resolve(dirname(event.filePath))) } catch { /* ignore */ } }
})

// --- Boot envelope sweep (spec §8) -------------------------------------------
// As Studio (registerAllIpcHandlers), 2 s after boot: boot-envelope-sweep.ts.
// Test seam ADF_TEST_ENVELOPE_SWEEP (ADF_TEST_SEAMS=1, unpackaged), the
// daemon side of the parity harness's switch: `off` never runs it, `boot`
// runs it before the daemon listens.
const envelopeSweepSeam = testSeamsAllowed() ? process.env.ADF_TEST_ENVELOPE_SWEEP : undefined
const envelopeSweep = createBootEnvelopeSweep({
  identity: ownerIdentity,
  leases: processAgentLeases(),
  openHere: () => [
    ...runtime.listAgents().map((ref) => ref.filePath).filter((p): p is string => !!p),
    ...runtime.listOpenDocuments().map((doc) => doc.filePath),
  ],
})
const runEnvelopeSweep = () => envelopeSweep.run()
let bootEnvelopeSweep: Promise<void> = Promise.resolve()
if (envelopeSweepSeam === 'boot') bootEnvelopeSweep = runEnvelopeSweep()
else if (envelopeSweepSeam !== 'off') setTimeout(() => { void runEnvelopeSweep() }, 2_000).unref?.()
if (envelopeSweepSeam) console.log(`[ADF Daemon] Test seam: boot envelope sweep ${envelopeSweepSeam} (ADF_TEST_ENVELOPE_SWEEP)`)

withSource('system:daemon', () => {
  // Clean up scratch dirs left by previous processes that exited uncleanly
  // (parity with Studio boot).
  try { purgeStaleProcessDirs() } catch (err) { console.warn('[ADF Daemon] Stale scratch purge failed:', err) }

  bootEnvelopeSweep.then(() => daemon.start())
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
      ensureMeshServer()

      // Sweep closed WAL sidecars in tracked dirs, deferred until after
      // autostart so open agents are skipped (parity with Studio cleanup).
      const scheduleWalSweep = () => {
        setTimeout(() => {
          try { sweepTrackedDirWalFiles() } catch (err) { console.error('[ADF Daemon] WAL sweep failed:', err) }
        }, 2_000).unref?.()
      }

      if (trackedDirs.length > 0) {
        meshServerBinder.autostartSettling(true)
        withSource('system:daemon', () => runtime.autostartFromDirectories(trackedDirs, { maxDepth }))
          .then(report => {
            console.log('[ADF Daemon] Autostart report:', JSON.stringify(report))
            noteAutostartReport(report)
            withSource('system:daemon', () => {
              emitUmbilicalEvent({ event_type: 'daemon.autostart.report', payload: { report } })
            })
          })
          .catch(err => console.error('[ADF Daemon] Autostart failed:', err))
          .finally(() => {
            meshServerBinder.autostartSettling(false)
            scheduleWalSweep()
          })
      } else {
        // No tracked dirs: still schedule the sweep (Studio parity) — it
        // covers sessionAdfDirs, so HTTP-API loads outside tracked dirs get
        // their crash leftovers reaped too.
        scheduleWalSweep()
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
    // Stored only when the agent registered; dropped when it unregisters.
    event.agent.adapterManager ?? null,
  )
  ensureMeshServer()
}

function ensureMeshServer(): void {
  meshServerBinder.ensure()
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
