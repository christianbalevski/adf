// The agent registry and the curated MCP registry over the daemon API.
//
//   GET  /registry/agents                     AGENT_REGISTRY_GET
//   POST /registry/agents/refresh             AGENT_REGISTRY_REFRESH
//   POST /registry/agents/:id/bring-home      AGENT_REGISTRY_BRING_HOME
//   GET  /registry/mcp                        MCP_REGISTRY_GET
//
// The same services as Studio: bundled entries always, the live index layered
// on top, the last fetched copy cached in the daemon's data directory. Both
// honour the owner's `remoteCatalogsEnabled` opt-out (read per fetch: off =
// bundled + cached only, no request) and time out their fetches. The routes
// never fail on the network: with no network the bundled gallery still
// renders, with remoteError set.

import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { FastifyInstance } from 'fastify'
import { AgentRegistryService } from '../../services/agent-registry.service'
import { McpRegistryFetchService } from '../../services/mcp-registry-fetch.service'
import { bringRegistryAgentHome } from '../../services/registry-bring-home'
import { getUserDataPath } from '../../utils/user-data-path'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { gapDeps } from './gap-deps'
import type { DaemonRouteContext } from './index'

/**
 * Where the bundled registry lives. Packaged Studio ships it as
 * <resources>/registry (extraResources; SQLite cannot open a file inside the
 * asar); the daemon Studio spawns runs from <resources>/app.asar/out/main.
 * In a dev tree it is the repo's registry/ folder.
 */
export function bundledRegistryDir(): string {
  const candidates: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'registry'))
  const starts = [typeof __dirname !== 'undefined' ? __dirname : null, process.cwd()].filter((s): s is string => !!s)
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, 'registry'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return candidates.find((dir) => existsSync(join(dir, 'index.json'))) ?? candidates[0] ?? resolve('registry')
}

export function registerRegistryRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const settings = ctx.options.settingsStore
  const overrides = gapDeps(ctx).registry ?? {}
  const isRemoteEnabled = () => settings?.get('remoteCatalogsEnabled') !== false
  // The daemon's data directory (next to its settings file; Studio's userData in local mode).
  const userDataDir = () => overrides.userDataDir ?? (settings?.filePath ? dirname(settings.filePath) : getUserDataPath())

  let agents: AgentRegistryService | null = null
  const agentRegistry = (): AgentRegistryService => {
    agents ??= new AgentRegistryService({
      bundledDir: overrides.bundledDir ?? bundledRegistryDir(),
      userDataDir: userDataDir(),
      appVersion: overrides.appVersion ?? ctx.options.version ?? process.env.ADF_VERSION ?? process.env.npm_package_version ?? '0.0.0',
      ...(overrides.agentFetchFn ? { fetchFn: overrides.agentFetchFn } : {}),
      isRemoteEnabled,
    })
    return agents
  }

  // Lazy, as in Studio: the first GET builds it and starts the 24 h refresh.
  let mcp: McpRegistryFetchService | null = null
  server.addHook('onClose', (_instance, done) => { mcp?.stop(); done() })
  const mcpRegistry = (): McpRegistryFetchService => {
    if (!mcp) {
      mcp = new McpRegistryFetchService({ userDataDir: userDataDir(), ...(overrides.mcpFetchFn ? { fetchFn: overrides.mcpFetchFn } : {}), isRemoteEnabled })
      mcp.startPeriodicRefresh()
    }
    return mcp
  }

  server.get('/registry/agents', async () => agentRegistry().getRegistry())

  server.post('/registry/agents/refresh', async () => {
    const service = agentRegistry()
    await service.refresh()
    return service.getRegistry()
  })

  // "Bring home": copy into the agents folder (settings.agentsFolder, else
  // the daemon's default), strip identity, fresh config.id, default provider.
  // The client opens the returned path through its ordinary open flow.
  server.post<{ Params: { id: string } }>('/registry/agents/:id/bring-home', async (request) => {
    const id = request.params.id
    const factory = ctx.options.agentFactory
    const result = await bringRegistryAgentHome(() => agentRegistry().resolveFile(id), {
      agentsFolder: () => {
        const configured = settings?.get('agentsFolder')
        const folder = factory?.defaultDirectory()
          ?? (typeof configured === 'string' && configured.trim() ? resolve(configured.trim()) : join(homedir(), 'Documents', 'adf-agents'))
        mkdirSync(folder, { recursive: true })
        return folder
      },
      providers: (settings?.get('providers') as ProviderConfig[] | undefined) ?? [],
      defaultProviderId: settings?.get('defaultProviderId') as string | undefined,
    })
    if (result.success) console.log(`[ADF Daemon] Registry agent "${id}" brought home: ${result.filePath}`)
    return result
  })

  server.get('/registry/mcp', async () => mcpRegistry().getRegistry())
}
