import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * W3-C parity scenarios: Settings → MCP, channel adapters, sandbox packages.
 * Each is the renderer's call sequence for its flow, written once and run
 * against both backends (mcp.test.ts). Nothing reaches the network: installs
 * use package names the installers refuse before npm runs and a sandbox
 * package already in the manifest; the remote MCP server is on loopback
 * (fake-mcp-server.ts); the Telegram adapter is attached to a stopped agent
 * with a fake bot token, so nothing connects to Telegram (the fence would
 * fail the run if anything tried).
 */

type Progress = { package?: string; status?: string }
const progress = (pkg: string, status: string) => (p: unknown) => (p as Progress)?.package === pkg && (p as Progress)?.status === status

/** A sandbox package "already installed": the manifest the sandbox service reads (no npm). */
function preinstallSandboxPackage(ctx: ScenarioContext, name: string, version: string): void {
  const dir = join(ctx.env.userDataDir, 'sandbox-packages')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sandbox-packages-manifest.json'), JSON.stringify({ packages: { [name]: { name, version, installedAt: 0, size_mb: 0.1 } } }, null, 2))
}

export const installProgressScenario: ParityScenario = {
  name: 'w3c-install-progress',
  description: 'Sandbox, MCP and adapter package installs: the install progress pushes and the answers, for an installed package and for names the installers refuse.',
  fixtures: [],
  quietMs: 500,
  async run(ctx) {
    preinstallSandboxPackage(ctx, 'left-pad', '1.3.0')
    await ctx.invoke(IPC.SANDBOX_LIST_INSTALLED)
    await ctx.invoke(IPC.SANDBOX_CHECK_MISSING, [{ name: 'left-pad', version: '1.3.0' }, { name: 'lodash', version: '4.17.21' }])
    await ctx.invoke(IPC.SANDBOX_INSTALL_PACKAGES, [{ name: 'left-pad', version: '1.3.0' }, { name: 'not a package!', version: '1.0.0' }])
    await ctx.waitForPush(IPC.SANDBOX_INSTALL_PROGRESS, 'left-pad installed', progress('left-pad', 'installed'))
    await ctx.waitForPush(IPC.SANDBOX_INSTALL_PROGRESS, 'the refused name failed', progress('not a package!', 'error'))

    await ctx.invoke(IPC.MCP_INSTALL_PACKAGE, { package: '', name: 'empty' })
    await ctx.invoke(IPC.MCP_INSTALL_PACKAGE, { package: 'not a package!', name: 'bad' })
    await ctx.waitForPush(IPC.MCP_INSTALL_PROGRESS, 'the refused npm name failed', progress('not a package!', 'error'))
    await ctx.invoke(IPC.MCP_LIST_INSTALLED)
    await ctx.invoke(IPC.MCP_UNINSTALL_PACKAGE, { package: '@acme/never-installed' })

    await ctx.invoke(IPC.ADAPTER_INSTALL_PACKAGE, { package: 'not a package!' })
    await ctx.waitForPush(IPC.ADAPTER_INSTALL_PROGRESS, 'the refused adapter name failed', progress('not a package!', 'error'))
    await ctx.invoke(IPC.ADAPTER_LIST_INSTALLED)
  },
}

export const mcpAttachCredentialsScenario: ParityScenario = {
  name: 'w3c-mcp-attach-credentials',
  description: 'Attach an npm MCP server to a stopped agent, store and read its credential, list the files using it, check sign-in state, then detach it.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 500,
  async run(ctx) {
    const agent = ctx.agent('agent-2')
    await ctx.invoke(IPC.SETTINGS_SET, { trackedDirectories: [ctx.env.agentsDir] })
    const serverConfig = { name: 'acme', type: 'npm', npmPackage: '@acme/server', envKeys: ['API_KEY'] }
    await ctx.invoke(IPC.MCP_ATTACH_SERVER, { filePath: agent.filePath, serverConfig })
    await ctx.invoke(IPC.MCP_ATTACH_SERVER, { filePath: agent.filePath, serverConfig })
    await ctx.invoke(IPC.MCP_ATTACH_SERVER, { filePath: agent.filePath, serverConfig: { name: '' } })
    await ctx.invoke(IPC.MCP_CREDENTIAL_SET, { filePath: agent.filePath, npmPackage: '@acme/server', envKey: 'API_KEY', value: 'parity-mcp-secret' })
    await ctx.invoke(IPC.MCP_CREDENTIAL_GET, { filePath: agent.filePath, npmPackage: '@acme/server' })
    await ctx.invoke(IPC.MCP_CREDENTIAL_LIST_FILES, { mcpServerName: 'acme', npmPackage: '@acme/server' })
    await ctx.invoke(IPC.MCP_OAUTH_STATUS, { url: 'https://mcp.example.test/mcp' })
    await ctx.invoke(IPC.MCP_OAUTH_SIGNOUT, { url: 'https://mcp.example.test/mcp' })
    await ctx.invoke(IPC.MCP_GET_SERVER_STATUS)
    await ctx.invoke(IPC.MCP_RESTART_SERVER, { name: 'acme' })
    await ctx.invoke(IPC.MCP_DETACH_SERVER, { filePath: agent.filePath, serverName: 'acme', credentialNamespace: '@acme/server' })
    await ctx.invoke(IPC.MCP_CREDENTIAL_GET, { filePath: agent.filePath, npmPackage: '@acme/server' })
    await ctx.invoke(IPC.MCP_CREDENTIAL_LIST_FILES, { mcpServerName: 'acme', npmPackage: '@acme/server' })
  },
}

export const adapterTelegramScenario: ParityScenario = {
  name: 'w3c-adapter-telegram',
  description: 'Connect Telegram to a stopped agent with a fake bot token (no network), read it back, attach again, restart and logs while stopped, then detach.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 500,
  async run(ctx) {
    const agent = ctx.agent('agent-2')
    await ctx.invoke(IPC.SETTINGS_SET, { trackedDirectories: [ctx.env.agentsDir] })
    const config = { enabled: true, policy: { dm: 'allowlist', allow_from: ['424242'] } }
    await ctx.invoke(IPC.ADAPTER_ATTACH, { filePath: agent.filePath, adapterType: 'telegram', config })
    await ctx.invoke(IPC.ADAPTER_CREDENTIAL_SET, { filePath: agent.filePath, adapterType: 'telegram', envKey: 'TELEGRAM_BOT_TOKEN', value: '123456:parity-fake-token' })
    await ctx.invoke(IPC.ADAPTER_CREDENTIAL_GET, { filePath: agent.filePath, adapterType: 'telegram' })
    await ctx.invoke(IPC.ADAPTER_CREDENTIAL_LIST_FILES, { adapterType: 'telegram' })
    await ctx.invoke(IPC.ADAPTER_ATTACH, { filePath: agent.filePath, adapterType: 'telegram', config: { enabled: true } })
    await ctx.invoke(IPC.ADAPTER_GET_STATUS)
    await ctx.invoke(IPC.ADAPTER_GET_LOGS, { type: 'telegram', filePath: agent.filePath })
    await ctx.invoke(IPC.ADAPTER_RESTART, { type: 'telegram', filePath: agent.filePath })
    await ctx.invoke(IPC.ADAPTER_RESTART, { type: 'telegram' })
    await ctx.invoke(IPC.ADAPTER_DETACH, { filePath: agent.filePath, adapterType: 'telegram' })
    await ctx.invoke(IPC.ADAPTER_CREDENTIAL_GET, { filePath: agent.filePath, adapterType: 'telegram' })
    // A second connect after the detach: the agent has no Telegram entry, the given config is written.
    await ctx.invoke(IPC.ADAPTER_ATTACH, { filePath: agent.filePath, adapterType: 'telegram', config: { enabled: false } })
  },
}

/** The connect test and the probe against a remote MCP server on loopback; its URL is given when the test registers it. */
export function connectTestScenario(serverUrl: () => string): ParityScenario {
  return {
    name: 'w3c-mcp-connect-test',
    description: 'Settings → MCP "Connect" (the registration test, a job in daemon mode) and the probe against a remote MCP server on loopback, then its logs.',
    fixtures: [],
    quietMs: 500,
    async run(ctx) {
      const url = serverUrl()
      await ctx.invoke(IPC.MCP_REGISTRATION_TEST, { registration: { id: 'fake', name: 'fake', type: 'http', url } })
      await ctx.invoke(IPC.MCP_PROBE_SERVER, { name: 'fake', transport: 'http', url })
      await ctx.invoke(IPC.MCP_PROBE_SERVER, { name: 'fake', transport: 'http' })
      await ctx.invoke(IPC.MCP_REGISTRATION_TEST, { registration: { name: '' } })
    },
  }
}

/**
 * Settings → MCP "Sign in & Connect" on an OAuth remote: the authorization
 * page opens in the browser without a click (embedded: its OAuth IO; daemon
 * mode: the job's open_url step), the sign-in lands in the app-level token
 * store, and sign-out clears it. The browser is mcp.test.ts's
 * (completeFakeAuthorization).
 */
export function oauthConnectScenario(serverUrl: () => string): ParityScenario {
  return {
    name: 'w3c-mcp-oauth-connect',
    description: 'Sign in to an OAuth MCP server from Settings → MCP: the authorization page opens without a click, the token is stored app-wide, sign-out clears it.',
    fixtures: [],
    quietMs: 500,
    async run(ctx) {
      const url = serverUrl()
      await ctx.invoke(IPC.MCP_OAUTH_STATUS, { url })
      await ctx.invoke(IPC.MCP_REGISTRATION_TEST, { registration: { id: 'fake-oauth', name: 'fake-oauth', type: 'http', url, oauth: true } })
      await ctx.invoke(IPC.MCP_OAUTH_STATUS, { url })
      await ctx.invoke(IPC.MCP_OAUTH_SIGNOUT, { url })
      await ctx.invoke(IPC.MCP_OAUTH_STATUS, { url })
    },
  }
}
