/**
 * The home dashboard's slices (split so each tile loads as its data
 * resolves) and the single-provider Test. Shared by Studio's DASHBOARD_* /
 * PROVIDER_TEST handlers and the daemon's /dashboard routes.
 */

import { realpath } from 'fs/promises'
import type { AdapterRegistration, McpServerRegistration, ProviderConfig } from '../../shared/types/ipc.types'
import { mapWithConcurrency } from '../utils/concurrency'
import type { ProviderChecks } from './provider-checks'

export interface QuickStatsSource {
  get(key: string): unknown
  installedPackageCount(): number
  /** getTokenUsageService().getSummary(). */
  tokenSummary(): unknown
}

/** Slice 1: instant. Settings reads + in-memory services. */
export function buildQuickStats(src: QuickStatsSource) {
  const providers = (src.get('providers') as ProviderConfig[]) ?? []
  const mcpServers = (src.get('mcpServers') as McpServerRegistration[]) ?? []
  const adapters = (src.get('adapters') as AdapterRegistration[]) ?? []
  const compute = (src.get('compute') as { hostAccessEnabled?: boolean } | undefined) ?? {}

  return {
    providers: { total: providers.length },
    mcp: { configured: mcpServers.length },
    adapters: {
      configured: adapters.length,
      types: Array.from(new Set(adapters.map((a) => a.type).filter(Boolean))),
    },
    packages: { total: src.installedPackageCount() },
    hostAccess: { enabledGlobally: !!compute.hostAccessEnabled },
    tokens: src.tokenSummary(),
  }
}

/** Slice 2: provider connection tests (session-cached, honours the opt-out). */
export async function runDashboardProviderTests(providers: ProviderConfig[], checks: ProviderChecks) {
  let ok = 0
  let failed = 0
  let unconfigured = 0
  await Promise.all(providers.map(async (cfg) => {
    const result = await checks.autoCheck(cfg)
    if (result === 'ok') ok++
    else if (result === 'failed') failed++
    else if (result === 'unconfigured') unconfigured++
  }))
  return { ok, failed, unconfigured }
}

/**
 * Test a single provider's connection. `force` busts the session cache so the
 * Settings "Test" button always re-checks live; otherwise this is an
 * automatic check and honours the opt-out ('unknown' when it skipped).
 */
export async function testProviderById(providers: ProviderConfig[], providerId: string | undefined, force: boolean, checks: ProviderChecks) {
  const cfg = providers.find((p) => p.id === providerId)
  if (!cfg) return { status: 'unconfigured' as const }
  // force = the owner clicked Test; the automatic first-sight test honors the opt-out.
  if (force !== true) {
    const auto = await checks.autoCheck(cfg)
    return { status: auto === 'unchecked' ? 'unknown' as const : auto }
  }
  const status = await checks.test(cfg, true)
  return { status }
}

export interface AgentStatsSource {
  /** Cached async walk of one tracked directory (depth-limited). */
  listAdfFiles(root: string, maxDepth: number): Promise<string[]>
  /** mtime-cached AdfDatabase.peekAgentMeta. */
  peekMeta(filePath: string): { autostart: boolean; autonomous: boolean; hostAccess: boolean } | null
}

/** Slice 4: readonly peek across tracked .adf files. */
export async function buildAgentStats(trackedDirs: string[], src: AgentStatsSource) {
  const seen = new Set<string>()
  const uniqueFiles: string[] = []
  for (const dir of trackedDirs) {
    // Shared cached async walk — the same listing the fleet poll uses.
    const files = await src.listAdfFiles(dir, 5)
    const resolved = await mapWithConcurrency(files, 8, async (file) => {
      try { return await realpath(file) } catch { return file }
    })
    files.forEach((file, i) => {
      const settled = resolved[i]
      const canon = settled.status === 'fulfilled' ? settled.value : file
      if (seen.has(canon)) return
      seen.add(canon)
      uniqueFiles.push(file)
    })
  }

  let autostart = 0
  let autonomous = 0
  let hostAccessAgents = 0
  for (const filePath of uniqueFiles) {
    // mtime-keyed — an unchanged agent file is never reopened.
    const meta = src.peekMeta(filePath)
    if (!meta) continue
    if (meta.autostart) autostart++
    if (meta.autonomous) autonomous++
    if (meta.hostAccess) hostAccessAgents++
  }

  return { total: uniqueFiles.length, autostart, autonomous, hostAccessAgents }
}
