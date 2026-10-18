import { z } from 'zod'
import { buildMcpServerConfigFromRegistration } from '../../shared/utils/mcp-config'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'

/**
 * The argument schemas of Studio's MCP and adapter IPC handlers, shared by
 * the embedded handlers (ipc/index.ts) and the daemon-mode ones, so both
 * refuse exactly the same arguments with the same message (design §3.2,
 * rule E1). tests/unit/ipc/mcp-adapter-args.test.ts pins them.
 */

// --- MCP: validated with validateMcpArgs (a refusal is an `{ error }` answer) ---

export const McpPackageArgs = z.object({ package: z.string().min(1), name: z.string().min(1) })
export const McpUninstallArgs = z.object({ package: z.string().min(1) })
export const McpNameArgs = z.object({ name: z.string().min(1) })
export const McpCredentialSetArgs = z.object({
  filePath: z.string().min(1),
  npmPackage: z.string().min(1),
  envKey: z.string().min(1),
  value: z.string()
})
export const McpCredentialGetArgs = z.object({
  filePath: z.string().min(1),
  npmPackage: z.string().min(1)
})
export const McpCredentialListArgs = z.object({
  mcpServerName: z.string().min(1),
  npmPackage: z.string().min(1)
})
export const McpAttachArgs = z.object({
  filePath: z.string().min(1),
  serverConfig: z.object({
    name: z.string().min(1),
    type: z.enum(['npm', 'uvx', 'pip', 'custom', 'http']).optional(),
    npmPackage: z.string().optional(),
    pypiPackage: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    envKeys: z.array(z.string()).optional(),
    headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    bearerTokenEnvVar: z.string().optional(),
    credentialStorage: z.enum(['app', 'agent']).optional(),
    runLocation: z.enum(['host', 'shared']).optional(),
    // OAuth remote flags — see McpRegistrationTestArgs: Zod strips unlisted
    // keys, which would drop oauth on agent attach too. Keep in sync with
    // McpServerRegistration / McpServerConfig.
    oauth: z.boolean().optional(),
    oauthClientId: z.string().optional(),
    oauthScopes: z.array(z.string()).optional()
  })
})
export const McpDetachArgs = z.object({
  filePath: z.string().min(1),
  serverName: z.string().min(1),
  credentialNamespace: z.string().min(1)
})

/** Validate IPC args against a Zod schema, returning parsed data or an error response. */
export function validateMcpArgs<T>(schema: z.ZodType<T>, args: unknown): { data: T } | { error: string } {
  const result = schema.safeParse(args)
  if (!result.success) return { error: `Invalid arguments: ${result.error.issues.map((i) => i.message).join(', ')}` }
  return { data: result.data }
}

// --- Adapters: parsed with `.parse` (a bad argument rejects the invoke with the ZodError) ---

export const AdapterPackageArgs = z.object({ package: z.string() })
export const AdapterTypeArgs = z.object({ type: z.string(), filePath: z.string().optional() })
export const AdapterCredentialSetArgs = z.object({
  filePath: z.string(),
  adapterType: z.string(),
  envKey: z.string(),
  value: z.string()
})
export const AdapterCredentialGetArgs = z.object({
  filePath: z.string(),
  adapterType: z.string()
})
export const AdapterListFilesArgs = z.object({ adapterType: z.string() })
export const AdapterAttachArgs = z.object({
  filePath: z.string(),
  adapterType: z.string(),
  config: z.object({
    enabled: z.boolean(),
    policy: z.object({
      dm: z.enum(['all', 'allowlist', 'none']).optional(),
      groups: z.enum(['all', 'mention', 'none']).optional(),
      allow_from: z.array(z.string()).optional()
    }).optional(),
    limits: z.object({
      max_attachment_size: z.number().int().positive().optional()
    }).optional()
  })
})
export const AdapterDetachArgs = z.object({
  filePath: z.string(),
  adapterType: z.string()
})

/**
 * The adf_config.mcp.servers[] entry MCP_ATTACH_SERVER writes, built from its
 * validated `serverConfig`. Shared by the embedded handler and the daemon-mode
 * one (rule E1), so both modes write the same entry.
 */
export function mcpAttachEntry(serverConfig: z.infer<typeof McpAttachArgs>['serverConfig']): McpServerConfig {
  return buildMcpServerConfigFromRegistration({
    id: `mcp:${serverConfig.name}`,
    name: serverConfig.name,
    type: serverConfig.type,
    npmPackage: serverConfig.npmPackage,
    pypiPackage: serverConfig.pypiPackage,
    command: serverConfig.command,
    args: serverConfig.args,
    url: serverConfig.url,
    // E3: the .adf records that the server signs in with OAuth (oauth wins over the
    // bearer variable, as for a Settings install), so another runtime does not
    // connect without it. Client id and scopes stay on the registration.
    oauth: serverConfig.oauth,
    env: serverConfig.envKeys?.map((key) => ({ key, value: '' })),
    headers: serverConfig.headers,
    headerEnv: serverConfig.headerEnv,
    bearerTokenEnvVar: serverConfig.bearerTokenEnvVar,
    credentialStorage: serverConfig.credentialStorage,
    runLocation: serverConfig.runLocation
  })
}
