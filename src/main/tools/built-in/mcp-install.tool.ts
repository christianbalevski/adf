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
import { isSensitiveMcpHeader } from '../../../shared/utils/mcp-config'

const InputSchema = z.object({
  package: z.string().optional().describe('Package name (npm/pypi) or command path (custom). E.g. "@modelcontextprotocol/server-github", "garmin-mcp", "node"'),
  type: z.enum(['npm', 'pypi', 'custom', 'http']).default('npm').describe('Package type: npm, pypi, custom, or http'),
  url: z.string().url().optional().describe('Streamable HTTP MCP URL. Required when type=http.'),
  name: z.string().optional().describe('Server name. Auto-derived from package if not provided. Required for custom type.'),
  args: z.array(z.string()).optional().describe('Command arguments (mainly for custom type)'),
  host: z.boolean().optional().describe('Run on host instead of container. Default false. Requires host_access enabled.'),
  env_keys: z.array(z.string()).optional().describe('Environment variable names the server needs (e.g. ["GITHUB_PERSONAL_ACCESS_TOKEN"])'),
  env: z.record(z.string()).optional().describe('Credential values to store in agent identity (e.g. { "API_KEY": "sk-..." }). Stored as mcp:<name>:<key>.'),
  headers: z.record(z.string()).optional().describe('Static HTTP headers for type=http. Do not include secret values unless they should be stored in agent config.'),
  header_env: z.array(z.object({ header: z.string(), env: z.string() })).optional().describe('HTTP headers populated from credential env keys, e.g. [{ "header": "X-API-Key", "env": "API_KEY" }].'),
  bearer_token_env_var: z.string().optional().describe('Env key whose value should be sent as Authorization: Bearer <value> for type=http.'),
  auth: z.boolean().optional().describe('Run the server once for interactive auth (OAuth, etc.) before connecting. Opens a browser for the user to authorize, then prompts them to confirm completion.'),
  auth_args: z.array(z.string()).optional().describe('Extra arguments to pass to the server during the auth preflight (e.g. ["auth"] for servers that have a dedicated auth subcommand).'),
})

/** Derive a short server name from a package string. */
function deriveName(pkg: string, type: string): string {
  if (type === 'custom') return pkg.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
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
    'Provide package (name or command) for npm/pypi/custom, or url for type=http. ' +
    'Optionally pass env with credential values to store in agent identity. ' +
    'Set host=true to run on host (requires host_access). ' +
    'Tools are discovered immediately when possible; use mcp_restart to reconnect if discovery is delayed.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  constructor(private onServerInstalled?: (name: string, options?: { auth?: boolean; authArgs?: string[] }) => Promise<void> | void) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const { type, args, host, env_keys, env, auth, auth_args, headers, header_env, bearer_token_env_var } = parsed
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

    const serverName = parsed.name ?? deriveName(pkg, type)
    const config = workspace.getAgentConfig()

    // Check if already installed
    if (!config.mcp) config.mcp = { servers: [] }
    if (config.mcp.servers.some((s) => s.name === serverName)) {
      return { content: JSON.stringify({ success: true, already_installed: true, name: serverName }), isError: false }
    }

    // Validate host access
    if (type !== 'http' && host && !config.compute?.host_access) {
      return { content: JSON.stringify({ success: false, error: 'Host access not enabled. Set compute.host_access to true or install without host=true.' }), isError: true }
    }

    // Build McpServerConfig
    const serverConfig: McpServerConfig = {
      name: serverName,
      transport: type === 'http' ? 'http' : 'stdio',
      run_location: host ? 'host' : undefined,
    }

    switch (type) {
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

    if (allDeclaredEnvKeys.size) {
      serverConfig.env_schema = buildEnvSchemaFromKeys(serverConfig, [...allDeclaredEnvKeys], 'agent')
      serverConfig.env_keys = env_keys
    }

    // Store credential values in agent identity if provided
    if (env) {
      const allKeys = new Set(allDeclaredEnvKeys)
      for (const [key, value] of Object.entries(env)) {
        workspace.setIdentity(`mcp:${serverName}:${key}`, value)
        allKeys.add(key)
      }
      // Ensure env_keys includes all keys with stored values
      serverConfig.env_keys = [...allKeys]
      serverConfig.env_schema = buildEnvSchemaFromKeys(serverConfig, [...allKeys], 'agent')
    }

    // Append to config
    config.mcp.servers.push(serverConfig)
    workspace.setAgentConfig(config)

    // Connect the server and discover tools (awaited so tools are ready when we return)
    let discoveredTools = 0
    try {
      await this.onServerInstalled?.(serverName, { auth, authArgs: auth_args })
      // Re-read config to get discovered tools count
      const updated = workspace.getAgentConfig()
      const srv = updated.mcp?.servers?.find((s) => s.name === serverName)
      discoveredTools = srv?.available_tools?.length ?? 0
    } catch { /* connection failed — tools will be empty but server is configured */ }

    const location = type === 'http' ? 'remote http' : host ? 'host' : (config.compute?.enabled ? 'isolated container' : 'shared container')
    return {
      content: JSON.stringify({
        success: true,
        name: serverName,
        type,
        source: serverConfig.source,
        location,
        tools_discovered: discoveredTools,
        env_keys: serverConfig.env_keys,
        message: discoveredTools > 0
          ? `Server "${serverName}" installed (${location}). ${discoveredTools} tools discovered. Enable the specific MCP tools in agent config before use.`
          : `Server "${serverName}" configured (${location}) but no tools discovered. The server may need correct args, credentials, or a restart to connect.`,
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
