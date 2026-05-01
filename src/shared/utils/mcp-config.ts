import type { McpEnvKeySchema, McpHeaderEnvSchema, McpServerConfig } from '../types/adf-v02.types'
import type { McpServerRegistration } from '../types/ipc.types'

type McpCredentialSource = Pick<McpServerConfig, 'name' | 'npm_package' | 'pypi_package'> | {
  name: string
  npmPackage?: string
  pypiPackage?: string
}

function sourcePackage(source: McpCredentialSource): string | undefined {
  return 'npm_package' in source
    ? source.npm_package ?? source.pypi_package
    : source.npmPackage ?? source.pypiPackage
}

export function mcpCredentialNamespace(source: McpCredentialSource): string {
  return sourcePackage(source) ?? source.name
}

export function mcpCredentialRef(source: McpCredentialSource, key: string): string {
  return `mcp:${mcpCredentialNamespace(source)}:${key}`
}

export function isSensitiveMcpHeader(header: string): boolean {
  const normalized = header.trim().toLowerCase()
  return normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'api-key' ||
    normalized === 'apikey' ||
    normalized === 'x-auth-token' ||
    normalized === 'x-access-token' ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('credential')
}

export function buildEnvSchemaFromKeys(
  source: McpCredentialSource,
  keys: string[],
  scope: 'agent' | 'app',
  requiredKeys: string[] = keys
): McpEnvKeySchema[] {
  const required = new Set(requiredKeys)
  return [...new Set(keys.filter(Boolean))].map((key) => ({
    key,
    scope,
    required: required.has(key) || undefined,
    credential_ref: scope === 'app' ? mcpCredentialRef(source, key) : undefined,
  }))
}

export function buildHeaderEnvSchemaFromEntries(
  source: McpCredentialSource,
  entries: Array<{ header: string; env: string }>,
  appScoped = true
): McpHeaderEnvSchema[] {
  return entries
    .filter((entry) => entry.header && entry.env)
    .map((entry) => ({
      header: entry.header,
      env: entry.env,
      required: true,
      credential_ref: appScoped ? mcpCredentialRef(source, entry.env) : undefined,
    }))
}

export function getMcpRegistrationEnvKeys(registration: McpServerRegistration): string[] {
  return [...new Set([
    ...(registration.env ?? []).map((entry) => entry.key).filter(Boolean),
    ...(registration.bearerTokenEnvVar ? [registration.bearerTokenEnvVar] : []),
    ...(registration.headerEnv ?? []).map((entry) => entry.value).filter(Boolean),
  ])]
}

export function buildMcpServerConfigFromRegistration(registration: McpServerRegistration): McpServerConfig {
  const isHttp = registration.type === 'http' || !!registration.url
  const serverCfg: McpServerConfig = {
    name: registration.name,
    transport: isHttp ? 'http' : 'stdio',
  }

  if (isHttp) {
    serverCfg.url = registration.url
    serverCfg.source = registration.url ? `http:${registration.url}` : 'http'
    const staticHeaders: Record<string, string> = {}
    for (const { key, value } of registration.headers ?? []) {
      if (key && value && !isSensitiveMcpHeader(key)) staticHeaders[key] = value
    }
    if (Object.keys(staticHeaders).length) serverCfg.headers = staticHeaders
    if (registration.headerEnv?.length) {
      serverCfg.header_env = buildHeaderEnvSchemaFromEntries(
        registration,
        registration.headerEnv.map(({ key, value }) => ({ header: key, env: value })),
        (registration.credentialStorage ?? 'app') !== 'agent'
      )
    }
    if (registration.bearerTokenEnvVar) {
      serverCfg.bearer_token_env_var = registration.bearerTokenEnvVar
    }
  } else if (registration.npmPackage) {
    serverCfg.source = `npm:${registration.npmPackage}`
    serverCfg.npm_package = registration.npmPackage
  } else if (registration.pypiPackage) {
    serverCfg.source = `uvx:${registration.pypiPackage}`
    serverCfg.pypi_package = registration.pypiPackage
  } else {
    serverCfg.source = 'custom'
    serverCfg.command = registration.command
    serverCfg.args = registration.args
  }

  if (!isHttp) {
    if (registration.command) serverCfg.command = registration.command
    if (registration.args?.length) serverCfg.args = registration.args
  }

  const envKeys = getMcpRegistrationEnvKeys(registration)
  if (envKeys.length) {
    const scope = (registration.credentialStorage ?? 'app') === 'agent' ? 'agent' : 'app'
    if (scope === 'agent') serverCfg.env_keys = envKeys
    serverCfg.env_schema = buildEnvSchemaFromKeys(registration, envKeys, scope)
  }

  if (registration.toolCallTimeout) {
    serverCfg.tool_call_timeout_ms = registration.toolCallTimeout * 1000
  }

  return serverCfg
}
