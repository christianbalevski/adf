import { app } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError, type AgentToolsResult, type DaemonClient } from '../../../../shared/daemon-client'
import type { NotificationsSnapshot } from '../../../../shared/types/ipc.types'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { mergeSettingsViews, splitSettingsPatch } from '../settings'
import { editedPlaceholderRefusal, isEditedPlaceholder } from '../mcp/common'
import { REDACTED_API_KEY } from './providers'

/**
 * Daemon-mode handlers owned by W2-C outside the core flow: the settings
 * split (§4.2), approvals, the tool catalog, and the Electron-local channels
 * that read no backend state.
 */

/**
 * Replace each `__redacted__` provider key in `settings` (in place) with the
 * stored key: POST /settings/providers/keys/reveal, local callers with the
 * local proof only. A key the daemon does not answer keeps the placeholder
 * (logged); the rest of the settings answer is unaffected.
 */
async function revealProviderKeys(ctx: DaemonModeContext, client: DaemonClient, settings: Record<string, unknown>): Promise<void> {
  const providers = settings.providers
  if (!Array.isArray(providers)) return
  const ids = (providers as Array<{ id?: unknown; apiKey?: unknown }>)
    .filter((p) => p?.apiKey === REDACTED_API_KEY && typeof p.id === 'string')
    .map((p) => p.id as string)
  if (ids.length === 0) return
  let keys: Record<string, string> = {}
  try {
    keys = (await client.request<{ keys: Record<string, string> }>('POST', '/settings/providers/keys/reveal', { body: { ids } })).keys ?? {}
  } catch (err) {
    if (err instanceof DaemonError && err.unreachable) throw err
    ctx.log.warn(`[Settings] The app provider keys stay hidden in Settings → Providers: the ADF daemon did not reveal them (${err instanceof Error ? err.message : String(err)})`)
    return
  }
  settings.providers = (providers as Array<Record<string, unknown>>).map((p) =>
    p?.apiKey === REDACTED_API_KEY && typeof p.id === 'string' && typeof keys[p.id] === 'string' ? { ...p, apiKey: keys[p.id] } : p)
}

export const APP_HANDLERS: DaemonHandlerTable = {
  // --- local -----------------------------------------------------------------
  [IPC.APP_GET_VERSION]: () => app.getVersion(),
  [IPC.APP_SET_BADGE_COUNT]: (_ctx, _event, count: unknown) => {
    app.setBadgeCount(Number.isInteger(count) && (count as number) > 0 ? (count as number) : 0)
  },
  // Chat is written by the runtime only; embedded is the same no-op.
  [IPC.DOC_SET_CHAT]: () => ({ success: true }),
  // A client key (§4.1); TEMPLATES_LIST drops `migrated` once it is set (W3-A).
  [IPC.TEMPLATES_MIGRATION_SEEN]: (ctx) => {
    ctx.clientSettings.set('templatesMigrationSeen', true)
  },
  [IPC.APPROVALS_GET_PENDING_REVEAL]: (ctx) => ctx.approvals.takePendingReveal(),
  // Deprecated whole-file password changes: the same refusals as embedded, no daemon call.
  [IPC.IDENTITY_PASSWORD_SET]: () => ({ success: false, error: 'Whole-file passwords are no longer supported — use a share password instead.' }),
  [IPC.IDENTITY_PASSWORD_CHANGE]: () => ({ success: false, error: 'Whole-file passwords are no longer supported — remove the password and use a share password instead.' }),

  // --- settings (§4.2) ---------------------------------------------------------
  // Local mode: the app provider keys GET /settings answers as the
  // placeholder come from the local-proof reveal route, so the key field
  // holds the stored key as in embedded (W5-D3). Remote mode keeps the
  // placeholder: a remote daemon never sends stored values.
  [IPC.SETTINGS_GET]: async (ctx) => {
    const client = await ctx.ready()
    const { settings } = await client.request<{ settings: Record<string, unknown> | null }>('GET', '/settings')
    if (ctx.mode === 'local' && settings) await revealProviderKeys(ctx, client, settings)
    return mergeSettingsViews(settings, ctx.clientSettings)
  },

  [IPC.SETTINGS_SET]: async (ctx, _event, newSettings: Record<string, unknown>) => {
    const { client: clientPart, backend, unclassified } = splitSettingsPatch(newSettings ?? {})
    if (unclassified.length) {
      ctx.log.warn(`[Settings] Keys in neither settings class go to the daemon: ${unclassified.join(', ')}`)
    }
    // App provider keys arrive as the placeholder the daemon answered (§4.2);
    // a value made from it (backspaced, edited) would be saved as the key.
    const providers = (backend as { providers?: unknown }).providers
    if (Array.isArray(providers)) {
      for (const p of providers as Array<{ id?: unknown; name?: unknown; apiKey?: unknown }>) {
        if (typeof p?.apiKey === 'string' && isEditedPlaceholder(p.apiKey)) {
          throw new Error(`The API key of ${String(p.name ?? p.id ?? 'a provider')} was shown as a placeholder (the ADF daemon never sends stored keys), so an edit of it cannot be saved. Clear the field and type the whole key.`)
        }
      }
    }
    // Settings → MCP: an app-wide env value made from a placeholder is refused as the per-agent forms refuse it.
    const servers = (backend as { mcpServers?: unknown }).mcpServers
    if (Array.isArray(servers)) {
      for (const server of servers as Array<{ env?: unknown }>) {
        for (const entry of Array.isArray(server?.env) ? server.env as Array<{ key?: unknown; value?: unknown }> : []) {
          const refusal = typeof entry?.value === 'string' ? editedPlaceholderRefusal(entry.value, String(entry.key ?? 'an environment variable')) : null
          if (refusal) throw new Error(refusal)
        }
      }
    }
    if (Object.keys(backend).length > 0) {
      const client = await ctx.ready()
      // Backend first: a refused backend write leaves the client file as it was.
      await client.request('PATCH', '/settings', { body: backend })
    }
    if (Object.keys(clientPart).length > 0) ctx.clientSettings.patch(clientPart)
    if ('menuBarEnabled' in clientPart) ctx.approvals.setMenuBarEnabled(clientPart.menuBarEnabled !== false)
    return { success: true }
  },

  // --- approvals (W1-D routes) ---------------------------------------------------
  [IPC.APPROVALS_LIST]: async (ctx) => {
    const client = await ctx.ready()
    return client.request<NotificationsSnapshot>('GET', '/approvals')
  },

  [IPC.APPROVALS_GET_INPUT]: async (ctx, _event, args: { filePath: string; approvalId: string }) => {
    if (!args?.filePath || !args?.approvalId) return undefined
    const client = await ctx.ready()
    const answer = await client.request<{ input?: unknown }>('GET', '/approvals/input', { query: { filePath: args.filePath, approvalId: args.approvalId } })
    return answer.input
  },

  [IPC.APPROVALS_RESOLVE]: async (ctx, _event, args: { filePath: string; approvalId: string; approved: boolean; feedback?: string }) => {
    if (!args?.filePath || !args?.approvalId) return { success: false, error: 'filePath and approvalId are required' }
    const client = await ctx.ready()
    return client.request('POST', '/approvals/resolve', { body: args })
  },

  // --- tool catalog ----------------------------------------------------------------
  /**
   * Built-in and stubbed runtime tools from the daemon, plus the open agent's
   * own tools (its MCP and adapter tools) in provider format, as embedded
   * folds `currentAgentToolRegistry` in. Built-ins win a name clash, as the
   * first registry does in buildToolDescriptions. A declared tool the agent
   * has not registered (no schema) is left out, as it is not in a registry.
   */
  [IPC.TOOLS_DESCRIPTIONS]: async (ctx) => {
    const client = await ctx.ready()
    const definitions = await client.request<Record<string, unknown>>('GET', '/runtime/tools/descriptions')
    const agentId = ctx.session.agentId
    if (!agentId) return definitions
    let own: AgentToolsResult
    try {
      own = await client.request<AgentToolsResult>('GET', `/agents/${enc(agentId)}/tools`)
    } catch (err) {
      if (isNotFound(err)) return definitions
      throw err
    }
    for (const tool of own.tools) {
      if (definitions[tool.name]) continue
      if (!tool.schema || Object.keys(tool.schema).length === 0) continue
      definitions[tool.name] = { name: tool.name, description: tool.description, input_schema: tool.schema }
    }
    return definitions
  },
}
