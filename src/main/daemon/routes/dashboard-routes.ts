// Home dashboard slices, provider connection tests, the tool schema catalog
// and token-usage reset over the daemon API.
//
//   GET    /dashboard/quick-stats          DASHBOARD_QUICK_STATS
//   GET    /dashboard/provider-tests       DASHBOARD_PROVIDER_TESTS (session-cached; honours providerChecksEnabled)
//   GET    /dashboard/agent-stats          DASHBOARD_AGENT_STATS
//   POST   /runtime/providers/:id/test     PROVIDER_TEST  { force? }
//   GET    /runtime/tools/descriptions     TOOLS_DESCRIPTIONS
//   DELETE /runtime/usage                  TOKEN_USAGE_CLEAR
//
// Bodies are Studio's (services/dashboard-stats.ts, provider-checks.ts,
// tool-descriptions.ts). Provider checks make one request per provider with
// a 5 s timeout; automatic ones honour the owner's providerChecksEnabled
// opt-out, an explicit Test (force) always probes.

import { readdir } from 'fs/promises'
import { statSync, type Dirent } from 'fs'
import { join } from 'path'
import type { FastifyInstance } from 'fastify'
import { AdfDatabase } from '../../adf/adf-database'
import { CodeSandboxService } from '../../runtime/code-sandbox'
import { buildAgentStats, buildQuickStats, runDashboardProviderTests, testProviderById } from '../../services/dashboard-stats'
import { ProviderChecks } from '../../services/provider-checks'
import type { SandboxPackagesService } from '../../services/sandbox-packages.service'
import { getTokenUsageService } from '../../services/token-usage.service'
import { buildToolDescriptions } from '../../services/tool-descriptions'
import { registerBuiltInTools } from '../../tools/built-in/register-built-in-tools'
import { ToolRegistry } from '../../tools/tool-registry'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { gapDeps } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { flagParam, badRequest } from './route-helpers'

type AgentMeta = NonNullable<ReturnType<typeof AdfDatabase.peekAgentMeta>>

/** Async walk of one tracked directory for .adf files (dot folders and node_modules skipped), as Studio's listAdfFiles. */
async function listAdfFiles(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.adf')) files.push(join(dir, e.name))
      else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') subdirs.push(join(dir, e.name))
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }
  await walk(root, 0)
  return files
}

export function registerDashboardRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const settings = ctx.options.settingsStore
  const providers = (): ProviderConfig[] => (settings?.get('providers') as ProviderConfig[] | undefined) ?? []
  const checks = new ProviderChecks({ isEnabled: () => settings?.get('providerChecksEnabled') !== false })

  // mtime-keyed peek cache: an unchanged agent file is never reopened.
  const metaCache = new Map<string, { mtimeMs: number; size: number; value: AgentMeta }>()
  const peekMeta = (filePath: string): AgentMeta | null => {
    let stat: { mtimeMs: number; size: number }
    try {
      // One stat per tracked agent, as Studio's peek cache does.
      stat = statSync(filePath)
    } catch {
      metaCache.delete(filePath)
      return null
    }
    const hit = metaCache.get(filePath)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value
    const value = AdfDatabase.peekAgentMeta(filePath)
    if (value) {
      metaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
      return value
    }
    return hit?.value ?? null
  }

  server.get('/dashboard/quick-stats', async () => buildQuickStats({
    get: (key) => settings?.get(key),
    installedPackageCount: () => ctx.options.sandboxPackageService?.getInstalledPackages().length ?? 0,
    tokenSummary: () => getTokenUsageService().getSummary(),
  }))

  server.get('/dashboard/provider-tests', async () => runDashboardProviderTests(providers(), checks))

  server.get('/dashboard/agent-stats', async () =>
    buildAgentStats((settings?.get('trackedDirectories') as string[] | undefined) ?? [], { listAdfFiles, peekMeta }))

  server.post<{ Params: { id: string }; Body: { force?: unknown } }>('/runtime/providers/:id/test', async (request, reply) => {
    const force = flagParam(request.body?.force)
    if (force === null) return badRequest(reply, 'force must be a boolean')
    return testProviderById(providers(), request.params.id, force, checks)
  })

  // The built-in registry plus the stubbed runtime tools; Studio also folds
  // in the open agent's own tools, which a daemon session has no notion of.
  let builtIns: ToolRegistry | null = null
  let schemaSandbox: CodeSandboxService | null = null
  server.get('/runtime/tools/descriptions', async () => {
    if (!builtIns) {
      builtIns = new ToolRegistry()
      registerBuiltInTools(builtIns)
    }
    // Stub instances only: their schemas are read, they never execute.
    schemaSandbox ??= gapDeps(ctx).codeSandboxService ?? new CodeSandboxService()
    return buildToolDescriptions([builtIns], {
      codeSandboxService: schemaSandbox,
      sandboxPackagesService: ctx.options.sandboxPackageService as unknown as SandboxPackagesService,
    })
  })

  server.delete('/runtime/usage', async () => {
    getTokenUsageService().clearAll()
    console.log('[ADF Daemon] Token usage cleared on request')
    return { success: true }
  })
}
