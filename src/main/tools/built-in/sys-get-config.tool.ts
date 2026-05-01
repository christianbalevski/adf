import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import type { ToolRegistry } from '../tool-registry'

const InputSchema = z.object({
  section: z
    .enum(['config', 'card', 'provider_status', 'tools'])
    .optional()
    .describe('What to retrieve. "config" (default) returns the full agent configuration. "card" returns your signed agent card as served on the mesh. "provider_status" returns rate limit and usage metadata from the LLM provider (e.g. ChatGPT subscription usage percentages and reset times). "tools" returns full tool discovery metadata, including hidden and disabled tools.')
})

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
    'Get your agent configuration, signed agent card, provider status, or tool discovery metadata. Use section="tools" to inspect enabled/visible state and schemas for available tools.'
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

    const config = workspace.getAgentConfig()
    return {
      content: JSON.stringify(config, null, 2),
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
