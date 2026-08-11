import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import type { ToolRegistry } from '../tool-registry'

const InputSchema = z.object({
  section: z
    .enum(['config', 'card', 'provider_status', 'tools', 'limits'])
    .optional()
    .describe('What to retrieve. "config" (default) returns the full agent configuration with secret values redacted. "card" returns your signed agent card as served on the mesh. "provider_status" returns rate limit and usage metadata from the LLM provider (e.g. ChatGPT subscription usage percentages and reset times). "tools" returns full tool discovery metadata, including hidden and disabled tools. "limits" returns just the limits section (timeouts, truncation and size caps).')
})

// Same placeholder the daemon HTTP API uses for redacted secrets
// (src/main/daemon/http-api.ts REDACTED_API_KEY) so both surfaces agree.
export const REDACTED_MARKER = '__redacted__'

/** Config keys whose VALUE is credential material, wherever they appear. */
const SECRET_KEY_PATTERN = /(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|^token$|secret|password|passwd|^authorization$|private[-_]?key|credential(?!_ref$)|bearer|session[-_]?id|cookie)/i

function redactRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) out[key] = REDACTED_MARKER
  return out
}

/** Redact `{ key, value }` param pairs whose key names a secret. */
function redactParamPairs(params: unknown): unknown {
  if (!Array.isArray(params)) return params
  return params.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const pair = entry as Record<string, unknown>
    if (typeof pair.key === 'string' && SECRET_KEY_PATTERN.test(pair.key) && pair.value !== undefined) {
      return { ...pair, value: REDACTED_MARKER }
    }
    return pair
  })
}

/**
 * Return a copy of the config with secret-bearing VALUES replaced by
 * REDACTED_MARKER. Keys stay visible so the agent can still see which
 * credentials exist and reason about them — it just never reads the material.
 * Covers: mcp.servers[].env / .headers, providers[] credential fields and
 * params pairs, and model.params / model.provider_params secret entries.
 */
export function redactAgentConfig(config: AgentConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>

  const mcp = clone.mcp as { servers?: Record<string, unknown>[] } | undefined
  for (const server of mcp?.servers ?? []) {
    if (server.env) server.env = redactRecord(server.env)
    if (server.headers) server.headers = redactRecord(server.headers)
  }

  const providers = clone.providers
  if (Array.isArray(providers)) {
    clone.providers = providers.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const provider = { ...(entry as Record<string, unknown>) }
      for (const key of Object.keys(provider)) {
        if (SECRET_KEY_PATTERN.test(key) && provider[key] !== undefined && provider[key] !== null) {
          provider[key] = REDACTED_MARKER
        }
      }
      if (provider.params) provider.params = redactParamPairs(provider.params)
      return provider
    })
  }

  const model = clone.model as Record<string, unknown> | undefined
  if (model) {
    if (model.params) model.params = redactParamPairs(model.params)
    const providerParams = model.provider_params as Record<string, unknown> | undefined
    if (providerParams && typeof providerParams === 'object') {
      for (const key of Object.keys(providerParams)) {
        if (SECRET_KEY_PATTERN.test(key)) providerParams[key] = REDACTED_MARKER
      }
    }
  }

  return clone
}

export interface ToolDiscoveryEntry {
  name: string
  enabled: boolean
  visible: boolean
  restricted: boolean
  locked: boolean
  source: 'builtin' | `mcp:${string}`
  description: string
  schema: Record<string, unknown>
  restrictions: {
    restricted: boolean
    locked: boolean
  }
}

type ToolDiscoveryProvider = (workspace: AdfWorkspace) => ToolDiscoveryEntry[]

export class SysGetConfigTool implements Tool {
  readonly name = 'sys_get_config'
  readonly description =
    'Get your agent configuration, signed agent card, provider status, limits, or tool discovery metadata. Use section="tools" to inspect enabled/visible state and schemas for available tools. Secret values (MCP env/headers, provider credentials) are returned as "__redacted__" — the keys are visible, the material is not.'
  readonly inputSchema = InputSchema
  readonly category = 'self' as const

  private toolDiscoveryProvider?: ToolDiscoveryProvider

  setToolDiscoveryProvider(provider: ToolDiscoveryProvider): void {
    this.toolDiscoveryProvider = provider
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const section = parsed.section ?? 'config'

    if (section === 'card') {
      const card = workspace._cardBuilder?.()
      if (!card) {
        return { content: 'Agent card not available. The agent must be served on the mesh to have a card.', isError: true }
      }
      return { content: JSON.stringify(card, null, 2), isError: false }
    }

    if (section === 'provider_status') {
      const meta = workspace._providerMeta
      if (!meta || Object.keys(meta).length === 0) {
        return { content: 'No provider status available. This is populated after the first LLM request for providers that expose metadata (e.g. ChatGPT Subscription).', isError: false }
      }
      return { content: JSON.stringify(meta, null, 2), isError: false }
    }

    if (section === 'tools') {
      const tools = this.toolDiscoveryProvider?.(workspace) ?? buildToolDiscovery(workspace.getAgentConfig(), null)
      return { content: JSON.stringify({ tools }, null, 2), isError: false }
    }

    if (section === 'limits') {
      const limits = workspace.getAgentConfig().limits ?? {}
      return { content: JSON.stringify({ limits }, null, 2), isError: false }
    }

    // Secret VALUES (MCP env/headers, provider credentials) are replaced with
    // the redaction marker; every key stays visible.
    return {
      content: JSON.stringify(redactAgentConfig(workspace.getAgentConfig()), null, 2),
      isError: false
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

export function buildToolDiscovery(config: AgentConfig, registry: ToolRegistry | null): ToolDiscoveryEntry[] {
  const declarations = new Map(config.tools.map((decl) => [decl.name, decl]))
  const entries = new Map<string, ToolDiscoveryEntry>()

  const upsert = (
    name: string,
    source: ToolDiscoveryEntry['source'],
    description = '',
    schema: Record<string, unknown> = {},
  ) => {
    const decl = declarations.get(name)
    const existing = entries.get(name)
    const enabled = decl?.enabled ?? false
    const visible = decl?.visible ?? false
    const restricted = decl?.restricted ?? false
    const locked = decl?.locked ?? false
    entries.set(name, {
      name,
      enabled,
      visible,
      restricted,
      locked,
      source,
      description: description || existing?.description || '',
      schema: Object.keys(schema).length > 0 ? schema : existing?.schema ?? {},
      restrictions: { restricted, locked },
    })
  }

  for (const tool of registry?.getAll() ?? []) {
    const providerFormat = tool.toProviderFormat()
    upsert(
      tool.name,
      inferToolSource(tool.name, config),
      providerFormat.description,
      providerFormat.input_schema,
    )
  }

  for (const server of config.mcp?.servers ?? []) {
    for (const toolInfo of server.available_tools ?? []) {
      upsert(
        `mcp_${server.name}_${toolInfo.name}`,
        `mcp:${server.name}`,
        toolInfo.description ?? `MCP tool: ${toolInfo.name} (via ${server.name})`,
        toolInfo.input_schema,
      )
    }
  }

  for (const decl of config.tools) {
    if (!entries.has(decl.name)) {
      upsert(decl.name, inferToolSource(decl.name, config))
    }
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function inferToolSource(name: string, config: AgentConfig): ToolDiscoveryEntry['source'] {
  if (!name.startsWith('mcp_')) return 'builtin'
  const server = config.mcp?.servers?.find((srv) => name.startsWith(`mcp_${srv.name}_`))
  return server ? `mcp:${server.name}` : 'mcp:unknown'
}
