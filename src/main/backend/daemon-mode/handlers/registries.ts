import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import { enc, type DaemonHandlerTable } from '../context'
import { atPath, errorCode, errorText, runInstallJob } from '../mcp/common'
import type { InstallEnd } from '../mcp/install-progress'
import { samePath } from '../session'

/**
 * Daemon-mode handlers for sandbox packages, skill catalogs, the agent
 * registry and "set model" on a fleet card (tracker W3-C). Answers have the
 * embedded handlers' shapes (src/main/ipc/index.ts).
 */

type SandboxPackage = { name: string; version: string }
type SandboxResults = { success: true; results: Record<string, { success: boolean; version?: string; error?: string }> }

/** Network reads behind the daemon's catalog guard (10 s per hop, a few hops). */
const CATALOG_TIMEOUT_MS = 60_000

export const REGISTRY_HANDLERS: DaemonHandlerTable = {
  // --- sandbox packages ----------------------------------------------------------

  [IPC.SANDBOX_CHECK_MISSING]: async (ctx, _event, packages: SandboxPackage[]) => {
    try {
      const { missing } = await (await ctx.ready()).request<{ missing: SandboxPackage[] }>('POST', '/admin/sandbox/packages/check', { body: { packages } })
      return { success: true, missing }
    } catch (error) {
      return { success: false, error: errorText(error), missing: packages }
    }
  },

  // One job installs them in turn; each package's end is its own push, as embedded.
  [IPC.SANDBOX_INSTALL_PACKAGES]: async (ctx, _event, packages: SandboxPackage[]) => {
    const list = Array.isArray(packages) ? packages : []
    return runInstallJob<SandboxResults>(ctx, {
      channel: IPC.SANDBOX_INSTALL_PROGRESS,
      packages: list.map((p) => p.name),
      path: '/admin/sandbox/packages/jobs',
      body: { packages: list },
      what: `the install of ${list.map((p) => p.name).join(', ') || 'sandbox packages'}`,
      lost: (error) => ({ success: true, results: Object.fromEntries(list.map((p) => [p.name, { success: false, error }])) }),
      ends: (result) => list.map((p): InstallEnd => {
        const r = result.results[p.name]
        return r?.success ? { package: p.name, status: 'installed' } : { package: p.name, status: 'error', error: r?.error }
      }),
    })
  },

  [IPC.SANDBOX_LIST_INSTALLED]: async (ctx) => {
    const { packages } = await (await ctx.ready()).request<{ packages: unknown[] }>('GET', '/admin/sandbox/packages')
    return { packages }
  },

  // --- skill catalogs (the daemon fetches; the renderer's CSP forbids remote origins) ----

  [IPC.SKILLS_CATALOG_GET]: async (ctx, _event, args: { url?: string } | undefined) =>
    (await ctx.ready()).request('GET', '/catalog/skills', { query: { url: args?.url }, timeoutMs: CATALOG_TIMEOUT_MS }),

  [IPC.SKILLS_PACKAGE_GET]: async (ctx, _event, args: { url?: string } | undefined) =>
    (await ctx.ready()).request('GET', '/catalog/skills/package', { query: { url: args?.url }, timeoutMs: CATALOG_TIMEOUT_MS }),

  // --- agent registry ----------------------------------------------------------------

  [IPC.AGENT_REGISTRY_GET]: async (ctx) => (await ctx.ready()).request('GET', '/registry/agents', { timeoutMs: CATALOG_TIMEOUT_MS }),

  [IPC.AGENT_REGISTRY_REFRESH]: async (ctx) => (await ctx.ready()).request('POST', '/registry/agents/refresh', { timeoutMs: CATALOG_TIMEOUT_MS }),

  // The copy lands in the daemon's agents folder; the renderer opens the path it answers.
  [IPC.AGENT_REGISTRY_BRING_HOME]: async (ctx, _event, args: { id?: unknown } | undefined) => {
    if (typeof args?.id !== 'string' || args.id === '') return { success: false, error: 'Missing registry id' }
    const result = await (await ctx.ready()).request<{ success: boolean; filePath?: string; error?: string }>(
      'POST', `/registry/agents/${enc(args.id)}/bring-home`, { timeoutMs: CATALOG_TIMEOUT_MS })
    if (!result.success || !result.filePath) return result
    try {
      ctx.recordRecentFile(result.filePath)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    return result
  },

  /**
   * The model of an agent file that is neither open nor running (a fleet
   * card). Refusals in embedded's order and words: no such file, no model,
   * the open file, a running agent, a provider Settings does not have.
   */
  [IPC.AGENT_MODEL_SET_FOR_FILE]: async (ctx, _event, args: { filePath?: unknown; model?: { provider?: unknown; model_id?: unknown } } | undefined) => {
    const fp = args?.filePath
    const model = args?.model
    if (typeof fp !== 'string' || !fp.toLowerCase().endsWith('.adf')) return { success: false, error: 'No such file' }
    const client = await ctx.ready()
    let canonical: string
    try {
      canonical = (await client.request<{ filePath: string }>('GET', '/files/agent', { query: atPath(fp) })).filePath
    } catch (error) {
      if (error instanceof DaemonError && (error.status === 400 || error.status === 404)) return { success: false, error: 'No such file' }
      throw error
    }
    if (!model || typeof model.provider !== 'string' || typeof model.model_id !== 'string') return { success: false, error: 'Missing model' }
    if (samePath(canonical, ctx.session.filePath) || samePath(fp, ctx.session.filePath)) {
      return { success: false, error: 'This agent is open — save its config instead' }
    }
    try {
      await client.request('PUT', '/files/agent/model', { query: atPath(fp), body: { model: { provider: model.provider, model_id: model.model_id } } })
      return { success: true }
    } catch (error) {
      const code = errorCode(error)
      if (code === 'agent_running' || code === 'provider_unknown') return { success: false, error: (error as Error).message }
      if (code === 'not_found' || code === 'not_an_adf') return { success: false, error: 'No such file' }
      return { success: false, error: error instanceof DaemonError ? error.message : String(error) }
    }
  },
}
