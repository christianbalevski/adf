import { basename } from 'node:path'
import { dialog } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import { enc, isNotFound, type DaemonHandlerTable } from '../context'
import { DaemonModeUnavailableError } from '../errors'
import { atPath, errorText, isEditedPlaceholder, placeholderWrite, refusalText, REDACTED_VALUE, revealValues, runInstallJob, singleInstallEnds, type CredentialMeta, type InstallAnswer } from '../mcp/common'
import { awaitDaemonJob, startDaemonJob } from '../mcp/jobs'
import { runRegistrationTest } from '../mcp/registration-test'
import {
  McpAttachArgs,
  McpCredentialGetArgs,
  McpCredentialListArgs,
  McpCredentialSetArgs,
  McpDetachArgs,
  McpNameArgs,
  McpPackageArgs,
  McpUninstallArgs,
  mcpAttachEntry,
  validateMcpArgs,
} from '../mcp/schemas'

/**
 * Daemon-mode handlers for Settings → MCP and the per-agent MCP panels
 * (tracker W3-C). Each answers what the embedded handler in
 * src/main/ipc/index.ts answers, from the daemon routes in the channel map.
 *
 * Agent files are addressed by path through the path-addressed routes
 * (/files/agent/*, W1-E): the daemon applies a change to a running agent
 * or an open document the way its /agents/:id route does, and opens any
 * other file for the call, as embedded opens a temporary workspace.
 *
 * Credential values: in local mode Studio reads them through the daemon's
 * reveal route (local callers with the local proof only), as embedded reads
 * them from the file. A remote daemon never sends them: MCP_CREDENTIAL_GET
 * answers REDACTED_VALUE, and MCP_CREDENTIAL_SET keeps the stored value for
 * the untouched placeholder and refuses anything else made from it.
 *
 * Installs, the Python runtime and the connect test can take minutes: they
 * run as daemon jobs (mcp/jobs.ts), never as one long request.
 */

/** A connect can take two attempts and a tool listing; under undici's 300 s header limit. */
const CONNECT_TIMEOUT_MS = 280_000

const PYTHON_RUNTIME_DEADLINE_MS = 30 * 60_000

export const MCP_HANDLERS: DaemonHandlerTable = {
  [IPC.MCP_PROBE_SERVER]: async (ctx, _event, rawArgs: unknown) => {
    const client = await ctx.ready()
    return client.request('POST', '/admin/mcp/probe', { body: rawArgs, timeoutMs: CONNECT_TIMEOUT_MS })
  },

  [IPC.MCP_REGISTRATION_TEST]: (ctx, _event, rawArgs: unknown) => runRegistrationTest(ctx, rawArgs),

  [IPC.MCP_OAUTH_SIGNOUT]: async (ctx, _event, rawArgs: unknown) => {
    const client = await ctx.ready()
    return client.request('POST', '/admin/mcp/oauth/signout', { body: rawArgs ?? {} })
  },

  [IPC.MCP_OAUTH_STATUS]: async (ctx, _event, rawArgs: unknown) => {
    const client = await ctx.ready()
    const url = (rawArgs as { url?: unknown } | null)?.url
    return client.request('GET', '/admin/mcp/oauth/status', { query: { url: typeof url === 'string' ? url : undefined } })
  },

  // --- packages ------------------------------------------------------------------

  [IPC.MCP_INSTALL_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpPackageArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const pkg = v.data.package
    return runInstallJob<InstallAnswer>(ctx, {
      channel: IPC.MCP_INSTALL_PROGRESS,
      packages: [pkg],
      path: '/admin/mcp/packages/npm/jobs',
      body: { package: pkg },
      what: `the install of ${pkg}`,
      lost: (error) => ({ success: false, error }),
      ends: singleInstallEnds(pkg),
    })
  },

  [IPC.MCP_UNINSTALL_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpUninstallArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    try {
      await (await ctx.ready()).request('DELETE', '/admin/mcp/packages/npm', { query: { package: v.data.package } })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  [IPC.MCP_LIST_INSTALLED]: async (ctx) => {
    const { packages } = await (await ctx.ready()).request<{ packages: unknown[] }>('GET', '/admin/mcp/packages')
    return { packages }
  },

  [IPC.MCP_INSTALL_PYTHON_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpPackageArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const pkg = v.data.package
    return runInstallJob<InstallAnswer>(ctx, {
      channel: IPC.MCP_INSTALL_PROGRESS,
      packages: [pkg],
      path: '/admin/mcp/packages/python/jobs',
      body: { package: pkg },
      what: `the install of ${pkg}`,
      lost: (error) => ({ success: false, error }),
      ends: singleInstallEnds(pkg),
    })
  },

  [IPC.MCP_UNINSTALL_PYTHON_PACKAGE]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpUninstallArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    try {
      await (await ctx.ready()).request('DELETE', '/admin/mcp/packages/python', { query: { package: v.data.package } })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  // uv and Python: a job the daemon shares between concurrent callers.
  [IPC.MCP_ENSURE_PYTHON_RUNTIME]: async (ctx) => {
    const lost = (error: string) => ({ success: false, error, uvAvailable: false, pythonAvailable: false })
    try {
      const { jobId } = await startDaemonJob(await ctx.ready(), '/admin/mcp/python-runtime')
      const outcome = await awaitDaemonJob(() => ctx.ready(), jobId, { what: 'the Python runtime install', deadlineMs: PYTHON_RUNTIME_DEADLINE_MS, log: ctx.log })
      if (outcome.kind === 'lost') return lost(outcome.reason)
      if (outcome.job.state === 'succeeded') return outcome.job.result
      return lost(outcome.job.error ?? `The Python runtime install ${outcome.job.state}`)
    } catch (error) {
      return lost(errorText(error))
    }
  },

  [IPC.MCP_REGISTRY_GET]: async (ctx) => (await ctx.ready()).request('GET', '/registry/mcp', { timeoutMs: 60_000 }),

  // --- the open agent's servers ---------------------------------------------------------

  [IPC.MCP_GET_SERVER_STATUS]: async (ctx) => {
    const agentId = ctx.session.agentId
    if (!agentId) return { servers: [] }
    try {
      const { states } = await (await ctx.ready()).request<{ states: unknown[] }>('GET', `/agents/${enc(agentId)}/runtime/mcp`)
      return { servers: states }
    } catch (err) {
      if (isNotFound(err)) return { servers: [] }
      throw err
    }
  },

  [IPC.MCP_RESTART_SERVER]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpNameArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const agentId = ctx.session.agentId
    if (!agentId) return { success: false, error: 'No MCP manager active' }
    try {
      const outcome = await (await ctx.ready()).request<{ error?: string }>('POST', `/agents/${enc(agentId)}/mcp/servers/${enc(v.data.name)}/restart`, { timeoutMs: CONNECT_TIMEOUT_MS })
      // Embedded: success when the restart connected (tools discovered or not).
      return { success: !outcome.error }
    } catch (error) {
      if (error instanceof DaemonError && error.status === 404 && /has no MCP server/.test(error.message)) return { success: false }
      if (error instanceof DaemonError && (error.status === 404 || error.status === 409)) return { success: false, error: 'No MCP manager active' }
      return { success: false, error: errorText(error) }
    }
  },

  // The open agent's live logs (agentId), else the ones the daemon kept from probe, test and agent runs.
  [IPC.MCP_GET_SERVER_LOGS]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpNameArgs, rawArgs)
    if ('error' in v) return { logs: [] }
    const client = await ctx.ready()
    return client.request('GET', `/admin/mcp/logs/${enc(v.data.name)}`, { query: { agentId: ctx.session.agentId ?? undefined } })
  },

  // --- agent files: credentials, attach, detach ----------------------------------------

  [IPC.MCP_CREDENTIAL_SET]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialSetArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const { filePath, npmPackage, envKey, value } = v.data
    try {
      const client = await ctx.ready()
      // Remote mode read placeholders, not values: see placeholderWrite.
      if (ctx.mode === 'remote' && (value === REDACTED_VALUE || isEditedPlaceholder(value))) {
        const meta = await client.request<{ credentials: Record<string, CredentialMeta> }>('GET', '/files/agent/mcp/credentials', { query: atPath(filePath, { npmPackage }) })
        const outcome = placeholderWrite(value, meta.credentials?.[envKey]?.present === true, envKey)
        if (outcome && 'keep' in outcome) return { success: true }
        if (outcome) return { success: false, error: outcome.error }
      }
      await client.request('PUT', '/files/agent/mcp/credentials', { query: atPath(filePath), body: { npmPackage, envKey, value } })
      return { success: true }
    } catch (error) {
      return { success: false, error: refusalText(error) }
    }
  },

  /**
   * Local mode: the values themselves, as embedded reads them (Studio's own
   * window on the daemon's machine, through the reveal route). Remote mode:
   * REDACTED_VALUE for each value the daemon can read; the password fields
   * show it as dots and MCP_CREDENTIAL_SET keeps the stored value for it.
   */
  [IPC.MCP_CREDENTIAL_GET]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialGetArgs, rawArgs)
    if ('error' in v) return { credentials: {} }
    const prefix = `mcp:${v.data.npmPackage}:`
    try {
      const client = await ctx.ready()
      if (ctx.mode === 'local') return { credentials: await revealValues(client, v.data.filePath, prefix) }
      const answer = await client.request<{ credentials: Record<string, CredentialMeta> }>(
        'GET', '/files/agent/mcp/credentials', { query: atPath(v.data.filePath, { npmPackage: v.data.npmPackage }) })
      const credentials: Record<string, string> = {}
      for (const [envKey, meta] of Object.entries(answer.credentials ?? {})) {
        if (meta.present && !meta.locked) credentials[envKey] = REDACTED_VALUE
      }
      return { credentials }
    } catch (error) {
      return { credentials: {}, error: errorText(error) }
    }
  },

  [IPC.MCP_CREDENTIAL_LIST_FILES]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpCredentialListArgs, rawArgs)
    if ('error' in v) return { files: [] }
    return (await ctx.ready()).request('GET', '/credentials/mcp/files', { query: { mcpServerName: v.data.mcpServerName, npmPackage: v.data.npmPackage } })
  },

  [IPC.MCP_ATTACH_SERVER]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpAttachArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const { filePath, serverConfig } = v.data
    // The entry embedded writes (rule E1).
    const server = mcpAttachEntry(serverConfig)
    try {
      const answer = await (await ctx.ready()).request<{ alreadyAttached: boolean }>('POST', '/files/agent/mcp/servers', { query: atPath(filePath), body: { server } })
      return { success: true, alreadyAttached: answer.alreadyAttached === true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  [IPC.MCP_DETACH_SERVER]: async (ctx, _event, rawArgs: unknown) => {
    const v = validateMcpArgs(McpDetachArgs, rawArgs)
    if ('error' in v) return { success: false, error: v.error }
    const { filePath, serverName, credentialNamespace } = v.data
    try {
      await (await ctx.ready()).request('DELETE', `/files/agent/mcp/servers/${enc(serverName)}`, { query: atPath(filePath, { credentialNamespace }) })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  },

  [IPC.MCP_PICK_ADF_FILE]: async (ctx) => {
    if (ctx.mode === 'remote') throw new DaemonModeUnavailableError('Picking an agent file in remote mode', 'W4-B', 'daemon-side picker')
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { filePath: null }
    return { filePath: result.filePaths[0], fileName: basename(result.filePaths[0]) }
  },
}
