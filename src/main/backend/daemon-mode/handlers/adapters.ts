import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AdapterInstanceConfig, AdapterRegistration } from '../../../../shared/types/channel-adapter.types'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import { enc, isNotFound, type DaemonHandlerTable } from '../context'
import { atPath, errorText, refusalText, revealValues, runInstallJob, singleInstallEnds, type CredentialMeta, type InstallAnswer } from '../mcp/common'
import {
  AdapterAttachArgs,
  AdapterCredentialGetArgs,
  AdapterCredentialSetArgs,
  AdapterDetachArgs,
  AdapterListFilesArgs,
  AdapterPackageArgs,
  AdapterTypeArgs,
} from '../mcp/schemas'

/**
 * Daemon-mode handlers for channel adapters (tracker W3-C): packages, the
 * fleet's adapter status, restarts and logs of a running agent's adapters,
 * and the per-file credential, attach and detach actions. Answers have the
 * embedded handlers' shapes (src/main/ipc/index.ts "Channel Adapters");
 * arguments are parsed as embedded parses them, so a bad argument rejects
 * the invoke the same way.
 *
 * ADAPTER_CREDENTIAL_GET reads the values through the daemon's reveal route
 * in local mode; a remote daemon sends none, and the channel setup dialog
 * shows each stored key as "stored", as it does for a key embedded cannot
 * decrypt.
 */

const NOT_RUNNING_RESTART = 'That agent is not running, so its channel has nothing to restart. Start the agent instead.'
const NO_AGENT_RESTART = 'No agent is open, so there is no channel to restart.'

export const ADAPTER_HANDLERS: DaemonHandlerTable = {
  [IPC.ADAPTER_INSTALL_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const { package: pkg } = AdapterPackageArgs.parse(rawArgs)
    return runInstallJob<InstallAnswer>(ctx, {
      channel: IPC.ADAPTER_INSTALL_PROGRESS,
      packages: [pkg],
      path: '/admin/adapters/packages/jobs',
      body: { package: pkg },
      what: `the install of ${pkg}`,
      lost: (error) => ({ success: false, error }),
      ends: singleInstallEnds(pkg),
    })
  },

  // The registration leaves settings.adapters too, as embedded removes it.
  [IPC.ADAPTER_UNINSTALL_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const { package: pkg } = AdapterPackageArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      await client.request('DELETE', '/admin/adapters/packages', { query: { package: pkg } })
      const { settings } = await client.request<{ settings: Record<string, unknown> | null }>('GET', '/settings')
      const current = (settings?.adapters as AdapterRegistration[] | undefined) ?? []
      await client.request('PATCH', '/settings', { body: { adapters: current.filter((a) => a.npmPackage !== pkg) } })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  [IPC.ADAPTER_LIST_INSTALLED]: async (ctx) => {
    const { packages } = await (await ctx.ready()).request<{ packages: unknown[] }>('GET', '/admin/adapters/packages')
    return { packages }
  },

  [IPC.ADAPTER_GET_STATUS]: async (ctx) => (await ctx.ready()).request('GET', '/fleet/adapters'),

  // No path: the open agent's channel, as embedded.
  [IPC.ADAPTER_RESTART]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterTypeArgs.parse(rawArgs)
    const filePath = args.filePath ?? ctx.session.filePath ?? undefined
    const answer = await (await ctx.ready()).request<{ success: boolean; error?: string }>('POST', '/fleet/adapters/restart', { body: { type: args.type, ...(filePath ? { filePath } : {}) }, timeoutMs: 60_000 })
    if (!args.filePath && !answer.success && answer.error === NOT_RUNNING_RESTART) return { success: false, error: NO_AGENT_RESTART }
    return answer
  },

  [IPC.ADAPTER_GET_LOGS]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterTypeArgs.parse(rawArgs)
    const filePath = args.filePath ?? ctx.session.filePath
    if (!filePath) return { logs: [], running: false }
    const agentId = await ctx.runningAgentAt(filePath)
    if (!agentId) return { logs: [], running: false }
    try {
      const diagnostics = await (await ctx.ready()).request<{ states: Array<{ type: string; logs?: unknown[] }> }>('GET', `/agents/${enc(agentId)}/runtime/adapters`)
      return { logs: diagnostics.states.find((s) => s.type === args.type)?.logs ?? [], running: true }
    } catch (err) {
      if (isNotFound(err)) return { logs: [], running: false }
      throw err
    }
  },

  [IPC.ADAPTER_CREDENTIAL_SET]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterCredentialSetArgs.parse(rawArgs)
    try {
      await (await ctx.ready()).request('PUT', '/files/agent/adapters/credentials', {
        query: atPath(args.filePath),
        body: { adapterType: args.adapterType, envKey: args.envKey, value: args.value },
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: refusalText(error) }
    }
  },

  /**
   * `storedKeys` names every stored key, readable or not (embedded lists the
   * rows). `credentials`: in local mode the readable values (reveal route,
   * as MCP_CREDENTIAL_GET); a remote daemon sends none, and the channel
   * dialog shows each stored key as "stored".
   */
  [IPC.ADAPTER_CREDENTIAL_GET]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterCredentialGetArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      const noValues: Record<string, string> = {}
      const [answer, values] = await Promise.all([
        client.request<{ credentials: Record<string, CredentialMeta> }>('GET', '/files/agent/adapters/credentials', { query: atPath(args.filePath, { adapterType: args.adapterType }) }),
        ctx.mode === 'local' ? revealValues(client, args.filePath, `adapter:${args.adapterType}:`) : Promise.resolve(noValues),
      ])
      const credentials: Record<string, string> = {}
      for (const [key, value] of Object.entries(values)) if (value) credentials[key] = value
      return { credentials, storedKeys: Object.entries(answer.credentials ?? {}).filter(([, meta]) => meta.present).map(([key]) => key) }
    } catch (error) {
      return { credentials: {}, storedKeys: [], error: errorText(error) }
    }
  },

  [IPC.ADAPTER_CREDENTIAL_LIST_FILES]: async (ctx, _event, rawArgs: unknown) => {
    const { adapterType } = AdapterListFilesArgs.parse(rawArgs)
    return (await ctx.ready()).request('GET', '/credentials/adapters/files', { query: { adapterType } })
  },

  /**
   * Embedded semantics: an adapter the agent already has and has on is left
   * as it is; one it has turned off is turned on, its policy and limits kept;
   * a new one gets the config given.
   */
  [IPC.ADAPTER_ATTACH]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterAttachArgs.parse(rawArgs)
    try {
      const client = await ctx.ready()
      const { config } = await client.request<{ config: AgentConfig }>('GET', '/files/agent/config', { query: atPath(args.filePath) })
      const existing = config.adapters?.[args.adapterType] as AdapterInstanceConfig | undefined
      if (existing?.enabled === true) return { success: true, alreadyAttached: true, enabled: true }
      const next = existing ? { ...existing, enabled: true } : args.config
      await client.request('POST', '/files/agent/adapters', { query: atPath(args.filePath), body: { adapterType: args.adapterType, config: next } })
      return existing ? { success: true, alreadyAttached: true, enabled: true } : { success: true, enabled: args.config.enabled }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  [IPC.ADAPTER_DETACH]: async (ctx, _event, rawArgs: unknown) => {
    const args = AdapterDetachArgs.parse(rawArgs)
    try {
      await (await ctx.ready()).request('DELETE', `/files/agent/adapters/${enc(args.adapterType)}`, { query: atPath(args.filePath) })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },
}
