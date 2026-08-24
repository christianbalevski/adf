/**
 * mcp_install — Install an MCP server package or attach a custom server.
 *
 * Pulls double duty:
 * - Package-based: provide package + type ('npm' or 'pypi')
 * - Custom: provide package (command) + type 'custom' + args
 *
 * Optionally stores credentials in the agent's identity keystore
 * so they're available at connection time via resolveMcpEnvVars.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { McpServerConfig } from '../../../shared/types/adf-v02.types'
import { buildEnvSchemaFromKeys, buildHeaderEnvSchemaFromEntries } from '../../services/mcp-spawn-utils'
import { isSensitiveMcpHeader, buildMcpServerConfigFromRegistration, isRegistrationAgentVisible } from '../../../shared/utils/mcp-config'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import { DOCS_GUIDES_URL } from '../../../shared/constants/adf-defaults'
import { captureCredentialFile } from '../../services/mcp-credential-files'

/** Result of a connect attempt, reported back by the runtime's connect callback. */
export interface McpConnectOutcome {
  toolsDiscovered: number
  /** Where the server actually ran: 'host' | 'shared container' | 'isolated container' | 'remote http' */
  location?: string
  /** Why host was requested but the server was containerized anyway */
  hostDenied?: string
  /** Last connection error from the MCP manager */
  error?: string
  /** Recent stderr lines from the server process */
  stderrTail?: string[]
}

const InputSchema = z.object({
  package: z.string().optional().describe('Package name (npm/pypi) or command path (custom). E.g. "@modelcontextprotocol/server-github", "garmin-mcp", "node"'),
  type: z.enum(['npm', 'pypi', 'custom', 'http']).default('npm').describe('Package type: npm, pypi, custom, or http'),
  url: z.string().url().optional().describe('Streamable HTTP MCP URL. Required when type=http.'),
  name: z.string().optional().describe('Server name. Auto-derived from package if not provided. Required for custom type.'),
  args: z.array(z.string()).optional().describe('Command arguments (mainly for custom type)'),
  host: z.boolean().optional().describe('Run on host instead of container. Default false. Requires agent compute.host_access AND the app-wide "Enable host access" toggle (ADF Studio → Settings → Compute).'),
  env_keys: z.array(z.string()).optional().describe('Environment variable names the server needs (e.g. ["GITHUB_PERSONAL_ACCESS_TOKEN"])'),
  env: z.record(z.string()).optional().describe('Credential values to store in agent identity (e.g. { "API_KEY": "sk-..." }). Stored as mcp:<name>:<key>.'),
  headers: z.record(z.string()).optional().describe('Static HTTP headers for type=http. Do not include secret values unless they should be stored in agent config.'),
  header_env: z.array(z.object({ header: z.string(), env: z.string() })).optional().describe('HTTP headers populated from credential env keys, e.g. [{ "header": "X-API-Key", "env": "API_KEY" }].'),
  bearer_token_env_var: z.string().optional().describe('Env key whose value should be sent as Authorization: Bearer <value> for type=http.'),
  auth: z.boolean().optional().describe('Run the server once for interactive auth (OAuth, etc.) before connecting. The auth command runs in the same container the server will run in (or on the host for host-routed servers), so stored tokens persist where the server reads them; OAuth loopback callback ports are auto-forwarded from the host browser into the container. Opens a browser for the user to authorize. Interactive runtimes (Studio) prompt the user to confirm completion; headless runtimes wait for the auth command to exit on its own.'),
  auth_args: z.array(z.string()).optional().describe('Extra arguments to pass to the server during the auth preflight (e.g. ["auth"] for servers that have a dedicated auth subcommand).'),
  auth_port: z.number().int().min(1).max(65535).optional().describe('Host loopback port to forward into the container during the auth preflight (for OAuth callbacks with a fixed redirect port). Usually unnecessary — the port is auto-detected from the auth URL redirect_uri.'),
  credential_files: z.array(z.object({
    path: z.string().min(1).describe('Path in the server\'s runtime filesystem, e.g. "~/.config/google-drive-mcp/gcp-oauth.keys.json". ~ expands to the server\'s home (agent-scoped in containers).'),
    required: z.boolean().optional().describe('Connect fails plainly when the keystore has no copy. Default false.'),
    write_back: z.boolean().optional().describe('Capture the file into the identity keystore after a successful auth preflight (tokens). Default true.'),
    content: z.string().optional().describe('Optional file content to store NOW in the identity keystore (sealed). Plain text, or base64 with encoding="base64". Never persisted in config.'),
    encoding: z.enum(['utf8', 'base64']).optional().describe('How to decode `content`. Default utf8.'),
  })).optional().describe('File-shaped credentials (OAuth client keys, token stores). Content lives sealed in the identity keystore, is materialized into the server\'s filesystem before every spawn, and token files are captured back after auth — so grants survive container rebuilds and travel with the .adf.'),
})

/** Derive a short server name from a package string. */
function deriveName(pkg: string, type: string): string {
  if (type === 'custom') return pkg.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  if (/^@playwright\/mcp(?:@[^/]+)?$/.test(pkg)) return 'playwright'
  // npm: @modelcontextprotocol/server-github → github
  const base = type === 'http'
    ? (() => { try { return new URL(pkg).hostname } catch { return pkg } })()
    : pkg.includes('/') ? pkg.split('/').pop()! : pkg
  return base
    .replace(/^(mcp-server-|server-|mcp-)/, '')
    .replace(/(-mcp|-server)$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
}

export class McpInstallTool implements Tool {
  readonly name = 'mcp_install'
  readonly description =
    'Install an MCP server package, attach a custom server, or connect a Streamable HTTP MCP server. ' +
    'FIRST check mcp_available: if the server is already configured in ADF Studio Settings and available to agents, ' +
    'this tool ATTACHES that registration instead of installing a fresh copy — the user\'s configuration, credentials, and authorization come along. ' +
    'Provide package (name or command) for npm/pypi/custom, or url for type=http. ' +
    'Optionally pass env with credential values to store in agent identity, and credential_files for file-shaped credentials (OAuth keys/token stores) that are kept sealed in the keystore and materialized where the server runs. ' +
    'Set host=true to run on host (requires host_access). ' +
    'For the agent\'s visible persistent browser, prefer the maintained @playwright/mcp package; it attaches to ADF-owned Chromium. ' +
    'New tools are discovered immediately, enabled and visible, and protected by human approval. ' +
    'Use mcp_restart to reconnect if discovery is delayed.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  constructor(
    private onServerInstalled?: (name: string, options?: { auth?: boolean; authArgs?: string[]; authPort?: number }) => Promise<McpConnectOutcome | void> | McpConnectOutcome | void,
    /** Settings registrations for attach mode; absent = attach unavailable in this runtime. */
    private getRegistrations?: () => McpServerRegistration[],
  ) {}

  /** Find the Settings registration this install request matches, if any. */
  private findMatchingRegistration(parsed: z.infer<typeof InputSchema>, derivedName: string): McpServerRegistration | undefined {
    const regs = this.getRegistrations?.() ?? []
    return regs.find((r) => r.name && (
      (parsed.package !== undefined && (r.npmPackage === parsed.package || r.pypiPackage === parsed.package)) ||
      (parsed.url !== undefined && r.url === parsed.url) ||
      r.name === derivedName
    ))
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const { type, args, host, env_keys, env, auth, auth_args, auth_port, headers, header_env, bearer_token_env_var } = parsed
    const pkg = parsed.package ?? parsed.url ?? ''

    // Custom type requires a name
    if (type === 'custom' && !parsed.name) {
      return { content: JSON.stringify({ success: false, error: 'Custom servers require a name.' }), isError: true }
    }
    if (type !== 'http' && !parsed.package) {
      return { content: JSON.stringify({ success: false, error: 'Package is required for npm, pypi, and custom servers.' }), isError: true }
    }
    if (type === 'http' && !parsed.url) {
      return { content: JSON.stringify({ success: false, error: 'HTTP servers require a url.' }), isError: true }
    }
    const sensitiveStaticHeaders = Object.keys(headers ?? {}).filter(isSensitiveMcpHeader)
    if (sensitiveStaticHeaders.length) {
      return {
        content: JSON.stringify({
          success: false,
          error: `Secret-bearing HTTP headers must use header_env or bearer_token_env_var: ${sensitiveStaticHeaders.join(', ')}`
        }),
        isError: true
      }
    }

    let serverName = parsed.name ?? deriveName(pkg, type)
    const config = workspace.getAgentConfig()

    // --- Attach mode: prefer a Settings registration over a fresh install ---
    // A server the user already configured (env, auth, run location) is the
    // better artifact than a fresh npm copy with none of that.
    const attachReg = this.findMatchingRegistration(parsed, serverName)
    if (attachReg && !isRegistrationAgentVisible(attachReg)) {
      return { content: JSON.stringify({
        success: false,
        error: `"${attachReg.name}" is registered in ADF Studio Settings but not made available to agents — ` +
          'ask your principal to enable "Available to agents" on it (Settings → MCP Servers), then retry. ' +
          'Installing a separate copy would duplicate the user\'s configured server without its credentials.',
      }), isError: true }
    }
    if (attachReg) serverName = attachReg.name

    // The visible browser is per-agent by design. Installing its MCP server
    // therefore opts the agent into an isolated browser-enabled container so
    // the CDP endpoint never accidentally targets the shared compute runtime.
    const effectivePkg = attachReg ? (attachReg.npmPackage ?? attachReg.pypiPackage ?? pkg) : pkg
    const browserMcp = (attachReg ? !!attachReg.npmPackage : type === 'npm') && (
      effectivePkg === '@modelcontextprotocol/server-puppeteer'
      || /^@playwright\/mcp(?:@[^/]+)?$/.test(effectivePkg)
    )
    if (browserMcp && !host && !(attachReg?.runLocation === 'host')) {
      config.compute = { ...config.compute, enabled: true, browser: true }
    }

    // Check if already installed
    if (!config.mcp) config.mcp = { servers: [] }
    const existing = config.mcp.servers.find((s) => s.name === serverName)
    if (existing) {
      // Already installed: a bare re-install is a no-op, but a re-install that
      // supplies `env` values is the documented way to (re)store credentials —
      // apply them to the existing server rather than dropping them, so the
      // locked-then-unlocked recovery path the error text advertises works.
      if (env && Object.keys(env).length) {
        const envelopeState = workspace.getEnvelopeState('credentials')
        if (envelopeState === 'locked' || envelopeState === 'foreign') {
          return { content: JSON.stringify({
            success: false, already_installed: true, name: serverName, configured: true,
            error: `Credentials envelope is ${envelopeState} in this runtime — refusing to store env credential(s) ` +
              `${Object.keys(env).join(', ')} in plaintext. Open the agent in ADF Studio once ` +
              `(or provision this daemon's runtime key via trustedDaemonEncKeys), then retry.`,
          }), isError: true }
        }
        const storedKeys: string[] = []
        for (const [key, value] of Object.entries(env)) {
          workspace.setIdentity(`mcp:${serverName}:${key}`, value)
          storedKeys.push(key)
        }
        const merged = new Set([...(existing.env_keys ?? []), ...storedKeys])
        existing.env_keys = [...merged]
        const agentSchema = buildEnvSchemaFromKeys(existing, [...merged], 'agent')
        existing.env_schema = [...(existing.env_schema ?? []).filter((e) => !merged.has(e.key)), ...agentSchema]
        workspace.setAgentConfig(config)
        return { content: JSON.stringify({ success: true, already_installed: true, credentials_updated: true, name: serverName, stored_keys: storedKeys }), isError: false }
      }
      return { content: JSON.stringify({ success: true, already_installed: true, name: serverName }), isError: false }
    }

    // Validate host access — attach mode is exempt: the registration's host
    // location is the USER's Settings trust decision (name+source approved),
    // not an agent-requested host grant.
    if (!attachReg && type !== 'http' && host && !config.compute?.host_access) {
      return { content: JSON.stringify({
        success: false,
        error: 'Host access not enabled for this agent (compute.host_access is false). ' +
          'Options: (a) install without host=true — the server runs in the compute container instead; ' +
          '(b) grant yourself host access via sys_update_config by setting compute.host_access to true (your principal will see an approval prompt). ' +
          'Host execution additionally requires the app-wide "Enable host access" toggle in ADF Studio → Settings → Compute, which only your principal can turn on. ' +
          `Compute guide: ${DOCS_GUIDES_URL}/compute.md`,
      }), isError: true }
    }

    // Build McpServerConfig — attach mode derives it from the registration
    // (env schema, headers, run location, credential-file declarations all
    // come along); fresh installs build it from the call.
    const serverConfig: McpServerConfig = attachReg
      ? buildMcpServerConfigFromRegistration(attachReg)
      : {
          name: serverName,
          transport: type === 'http' ? 'http' : 'stdio',
          run_location: host ? 'host' : undefined,
        }

    if (!attachReg) switch (type) {
      case 'npm':
        serverConfig.npm_package = pkg
        serverConfig.source = `npm:${pkg}`
        break
      case 'pypi':
        serverConfig.pypi_package = pkg
        serverConfig.source = `uvx:${pkg}`
        serverConfig.command = 'uvx'
        serverConfig.args = args ?? [pkg]
        break
      case 'custom':
        serverConfig.command = pkg
        serverConfig.args = args
        serverConfig.source = 'custom'
        break
      case 'http':
        serverConfig.url = parsed.url
        serverConfig.source = `http:${parsed.url}`
        serverConfig.headers = headers
        serverConfig.header_env = header_env?.length
          ? buildHeaderEnvSchemaFromEntries(serverConfig, header_env, false)
          : undefined
        serverConfig.bearer_token_env_var = bearer_token_env_var
        break
    }

    const allDeclaredEnvKeys = new Set(env_keys ?? [])
    for (const entry of header_env ?? []) {
      if (entry.env) allDeclaredEnvKeys.add(entry.env)
    }
    if (bearer_token_env_var) allDeclaredEnvKeys.add(bearer_token_env_var)

    if (!attachReg && allDeclaredEnvKeys.size) {
      serverConfig.env_schema = buildEnvSchemaFromKeys(serverConfig, [...allDeclaredEnvKeys], 'agent')
      serverConfig.env_keys = env_keys
    }

    let credentialCaptureError: string | undefined

    // Store credential values in agent identity if provided. A credentials
    // envelope that exists but cannot be opened in this runtime (locked /
    // foreign) must NEVER degrade to plaintext writes — same discipline as
    // credential files (sealed-or-fail). 'absent' means a legacy pre-envelope
    // file: plaintext is that file's existing storage contract, keep it.
    if (env) {
      const envelopeState = workspace.getEnvelopeState('credentials')
      if (envelopeState === 'locked' || envelopeState === 'foreign') {
        credentialCaptureError =
          `Credentials envelope is ${envelopeState} in this runtime — refusing to store env credential(s) ` +
          `${Object.keys(env).join(', ')} in plaintext. Open the agent in ADF Studio once ` +
          `(or provision this daemon's runtime key via trustedDaemonEncKeys), then reinstall or use set_identity.`
      } else {
        const allKeys = new Set(allDeclaredEnvKeys)
        for (const [key, value] of Object.entries(env)) {
          workspace.setIdentity(`mcp:${serverName}:${key}`, value)
          allKeys.add(key)
        }
        // Ensure env_keys includes all keys with stored values. Attach mode
        // appends agent-scoped entries without discarding the registration's
        // (app-scoped) schema.
        const agentSchema = buildEnvSchemaFromKeys(serverConfig, [...allKeys], 'agent')
        serverConfig.env_keys = [...new Set([...(attachReg ? serverConfig.env_keys ?? [] : []), ...allKeys])]
        serverConfig.env_schema = attachReg
          ? [...(serverConfig.env_schema ?? []).filter((e) => !allKeys.has(e.key)), ...agentSchema]
          : agentSchema
      }
    }

    // Credential files: persist the DECLARATION (path/required/write_back only)
    // on the server config; inline `content` is sealed into the identity
    // keystore and never lands in config or tool results.
    if (parsed.credential_files?.length) {
      const declared = parsed.credential_files.map((f) => ({
        path: f.path,
        ...(f.required !== undefined ? { required: f.required } : {}),
        ...(f.write_back !== undefined ? { write_back: f.write_back } : {}),
      }))
      // Attach mode: merge with the registration's declarations by path.
      const existing = (serverConfig.credential_files ?? []).filter((e) => !declared.some((d) => d.path === e.path))
      serverConfig.credential_files = [...existing, ...declared]
      for (const f of parsed.credential_files) {
        if (f.content === undefined) continue
        try {
          const buf = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8')
          captureCredentialFile(
            { setIdentitySealed: (purpose, value) => workspace.setIdentitySealed(purpose, value) },
            serverConfig, f.path, buf, new Date().toISOString(),
          )
        } catch (err) {
          // Don't clobber an earlier env-credential refusal — first error wins.
          credentialCaptureError ??= err instanceof Error ? err.message : String(err)
          break
        }
      }
    }

    // Append to config
    config.mcp.servers.push(serverConfig)
    workspace.setAgentConfig(config)

    // Connect the server and discover tools (awaited so tools are ready when we return)
    let discoveredTools = 0
    let connectionError: string | undefined = credentialCaptureError
    let outcome: McpConnectOutcome | undefined
    try {
      // Attach mode inherits the registration's declared auth flow unless the
      // caller explicitly overrides it — an unauthorized server completes its
      // OAuth at attach time, in the same place it will run.
      if (!connectionError) outcome = (await this.onServerInstalled?.(serverName, {
        auth: auth ?? attachReg?.auth,
        authArgs: auth_args ?? attachReg?.authArgs,
        authPort: auth_port ?? attachReg?.authPort,
      })) ?? undefined
      // Re-read config to get discovered tools count
      const updated = workspace.getAgentConfig()
      const srv = updated.mcp?.servers?.find((s) => s.name === serverName)
      discoveredTools = outcome?.toolsDiscovered ?? srv?.available_tools?.length ?? 0
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error)
    }

    // Report where the server actually ran, not where the caller asked it to run
    const isHttpServer = serverConfig.transport === 'http'
    const wantsHost = attachReg ? serverConfig.run_location === 'host' : !!host
    const location = outcome?.location
      ?? (isHttpServer ? 'remote http' : wantsHost ? 'host' : (config.compute?.enabled ? 'isolated container' : 'shared container'))
    if (connectionError) {
      return {
        content: JSON.stringify({
          success: false,
          configured: true,
          name: serverName,
          type,
          source: serverConfig.source,
          location,
          tools_discovered: 0,
          error: connectionError,
          message: `Server "${serverName}" was saved but could not become ready. Fix the runtime error, then use mcp_restart to reconnect.`,
        }),
        isError: true,
      }
    }
    const failureDetail = [
      outcome?.hostDenied ? `Host execution was denied (${outcome.hostDenied}), so the command ran in the ${location} where host paths may not exist.` : '',
      outcome?.error ? `Last error: ${outcome.error}` : '',
    ].filter(Boolean).join(' ')
    return {
      content: JSON.stringify({
        success: true,
        name: serverName,
        type: attachReg ? attachReg.type ?? 'npm' : type,
        source: serverConfig.source,
        location,
        ...(attachReg ? { attached_existing: true } : {}),
        tools_discovered: discoveredTools,
        env_keys: serverConfig.env_keys,
        ...(outcome?.hostDenied ? { host_denied: outcome.hostDenied } : {}),
        ...(discoveredTools === 0 && outcome?.error ? { connection_error: outcome.error } : {}),
        ...(discoveredTools === 0 && outcome?.stderrTail?.length ? { stderr_tail: outcome.stderrTail } : {}),
        message: discoveredTools > 0
          ? attachReg
            ? `Attached existing server "${serverName}" configured in ADF Studio Settings (${location}). ${discoveredTools} tools discovered, enabled, and protected by human approval.`
            : `Server "${serverName}" installed (${location}). ${discoveredTools} tools discovered, enabled, and protected by human approval.`
          : `Server "${serverName}" ${attachReg ? 'attached from Settings' : 'configured'} (${location}) but no tools discovered. ${failureDetail || 'The server may need correct args, credentials, or a restart to connect.'}`,
      }),
      isError: false,
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
