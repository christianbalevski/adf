import type { AdfApi } from '../../../preload/api'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import { reconcileHostApprovedRegistrations, sameExecutableIdentity } from '../../../shared/utils/mcp-config'
import { invalidateConfigCaches } from '../../utils/config-caches'
import { writeSettings } from '../settings/settings-save'
import { bundledServerFor } from './McpAddServerModal'

type BundledServers = { npmPackage: string; version: string }[] | undefined

/**
 * The server this app ships that a new managed registration launches
 * (bundledServerFor: the runtime's catalog shape, on the host): saving it
 * downloads nothing. Undefined: install the npm/pypi package as before.
 */
export function builtInManagedServer(
  reg: McpServerRegistration,
  bundledServers: BundledServers,
  hostAccessEnabled: boolean | undefined,
  mcpOnHost: boolean | undefined,
): { npmPackage: string; version: string } | undefined {
  if (!reg.managed || reg.type === 'uvx' || reg.type === 'pip') return undefined
  return bundledServerFor(reg, bundledServers, hostAccessEnabled, mcpOnHost)
}

/**
 * Download a new managed registration's package. Resolves the installed
 * version; undefined when there is nothing to install or it failed (the
 * install progress events carry the reason).
 */
export async function installManagedMcpPackage(api: AdfApi, reg: McpServerRegistration): Promise<string | undefined> {
  if (!reg.managed) return undefined
  const isPython = reg.type === 'uvx' || reg.type === 'pip'
  const pkg = isPython ? reg.pypiPackage : reg.npmPackage
  if (!pkg) return undefined
  try {
    const result = isPython
      ? await api?.installPythonMcpPackage({ package: pkg, name: reg.name })
      : await api?.installMcpPackage({ package: pkg, name: reg.name })
    return result?.success ? result.installed?.version : undefined
  } catch {
    return undefined
  }
}

async function writeOrThrow(api: AdfApi, patch: Record<string, unknown>): Promise<void> {
  const outcome = await writeSettings(patch, api)
  if (!outcome.ok) throw new Error(outcome.error)
  invalidateConfigCaches()
}

/**
 * Register a server in the runtime from outside Settings → MCP (an agent's
 * Config tab). Same rules as the Settings list: a host registration is
 * approved for its package, a bundled server is stamped with its version,
 * and a managed package downloads in the background. Refused when the
 * runtime already has a server by that name.
 */
export async function addRuntimeMcpServer(api: AdfApi, reg: McpServerRegistration, bundledServers: BundledServers): Promise<void> {
  const settings = await api.getSettings()
  const current = (settings.mcpServers as McpServerRegistration[] | undefined) ?? []
  if (current.some((s) => s.name === reg.name)) {
    // The list this was picked from was out of date: the next read gets the current one.
    invalidateConfigCaches()
    throw new Error(`a server named "${reg.name}" is already registered in this runtime`)
  }
  const compute = settings.compute
  const builtIn = builtInManagedServer(reg, bundledServers, compute?.hostAccessEnabled, compute?.mcpOnHost === true)
  const next = [...current, builtIn ? { ...reg, version: builtIn.version } : reg]
  const approval = reconcileHostApprovedRegistrations(current, next, (compute?.hostApproved as string[] | undefined) ?? [], compute?.hostApprovedSources as Record<string, string> | undefined)
  await writeOrThrow(api, { mcpServers: next, compute: { hostApproved: approval.approved, hostApprovedSources: approval.sources } })

  if (!builtIn && reg.managed) {
    void installManagedMcpPackage(api, reg).then(async (version) => {
      if (!version) return
      // Onto the list as it is now; never onto a registration edited since.
      const latest = ((await api.getSettings()).mcpServers as McpServerRegistration[] | undefined) ?? []
      await writeOrThrow(api, {
        mcpServers: latest.map((s) => (s.id === reg.id && sameExecutableIdentity(s, reg) ? { ...s, version } : s)),
      })
    }).catch((err: unknown) => console.warn(`[MCP] The installed version of ${reg.name} was not recorded:`, err))
  }
}
