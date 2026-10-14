import { z } from 'zod'

/**
 * The argument schemas of the embedded MCP and adapter handlers
 * (src/main/ipc/index.ts, "MCP IPC Argument Schemas" and the inline
 * ADAPTER_* schemas), so a daemon-mode handler refuses exactly what the
 * embedded one refuses, with the same message. Copies: ipc/index.ts keeps
 * them inside registerAllIpcHandlers, and only W3-A may extract from it (E1).
 * tests/backend/daemon-mode-mcp.test.ts pins the messages.
 */

export const McpPackageArgs = z.object({ package: z.string().min(1), name: z.string().min(1) })
export const McpUninstallArgs = z.object({ package: z.string().min(1) })
export const McpNameArgs = z.object({ name: z.string().min(1) })
export const McpCredentialSetArgs = z.object({
  filePath: z.string().min(1),
  npmPackage: z.string().min(1),
  envKey: z.string().min(1),
  value: z.string(),
})
export const McpCredentialGetArgs = z.object({
  filePath: z.string().min(1),
  npmPackage: z.string().min(1),
})
export const McpCredentialListArgs = z.object({
  mcpServerName: z.string().min(1),
  npmPackage: z.string().min(1),
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
    oauth: z.boolean().optional(),
    oauthClientId: z.string().optional(),
    oauthScopes: z.array(z.string()).optional(),
  }),
})
export const McpDetachArgs = z.object({
  filePath: z.string().min(1),
  serverName: z.string().min(1),
  credentialNamespace: z.string().min(1),
})

/** Embedded validateMcpArgs: the parsed data, or the handler's `Invalid arguments: …` message. */
export function validateMcpArgs<T>(schema: z.ZodType<T>, args: unknown): { data: T } | { error: string } {
  const result = schema.safeParse(args)
  if (!result.success) return { error: `Invalid arguments: ${result.error.issues.map((i) => i.message).join(', ')}` }
  return { data: result.data }
}

// ADAPTER_* parse with `.parse` (a bad argument rejects the invoke with the ZodError), as embedded.
export const AdapterPackageArgs = z.object({ package: z.string() })
export const AdapterTypeArgs = z.object({ type: z.string(), filePath: z.string().optional() })
export const AdapterCredentialSetArgs = z.object({
  filePath: z.string(),
  adapterType: z.string(),
  envKey: z.string(),
  value: z.string(),
})
export const AdapterCredentialGetArgs = z.object({ filePath: z.string(), adapterType: z.string() })
export const AdapterListFilesArgs = z.object({ adapterType: z.string() })
export const AdapterAttachArgs = z.object({
  filePath: z.string(),
  adapterType: z.string(),
  config: z.object({
    enabled: z.boolean(),
    policy: z.object({
      dm: z.enum(['all', 'allowlist', 'none']).optional(),
      groups: z.enum(['all', 'mention', 'none']).optional(),
      allow_from: z.array(z.string()).optional(),
    }).optional(),
    limits: z.object({
      max_attachment_size: z.number().int().positive().optional(),
    }).optional(),
  }),
})
export const AdapterDetachArgs = z.object({ filePath: z.string(), adapterType: z.string() })
