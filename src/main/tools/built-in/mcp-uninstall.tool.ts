/**
 * mcp_uninstall — Remove an MCP server from this agent's configuration.
 *
 * Removes the server entry from config.mcp.servers and cleans up
 * associated tool declarations (mcp_{name}_*) from config.tools.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  name: z.string().describe('Name of the MCP server to uninstall'),
})

export class McpUninstallTool implements Tool {
  readonly name = 'mcp_uninstall'
  readonly description =
    'Remove an MCP server from this agent. ' +
    'Removes the server configuration and all associated tool declarations.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  constructor(private onServerUninstalled?: (name: string) => void) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { name: serverName } = input as z.infer<typeof InputSchema>

    const config = workspace.getAgentConfig()

    // Find the server
    const servers = config.mcp?.servers ?? []
    const idx = servers.findIndex((s) => s.name === serverName)
    if (idx === -1) {
      return { content: JSON.stringify({ success: false, error: `Server "${serverName}" not found.` }), isError: true }
    }

    // Remove server
    servers.splice(idx, 1)
    if (config.mcp) config.mcp.servers = servers

    // Remove associated tool declarations (mcp_{serverName}_*)
    const toolPrefix = `mcp_${serverName}_`
    config.tools = config.tools.filter((t) => !t.name.startsWith(toolPrefix))

    // Save
    workspace.setAgentConfig(config)

    // Notify IPC to disconnect
    this.onServerUninstalled?.(serverName)

    return {
      content: JSON.stringify({
        success: true,
        name: serverName,
        message: `Server "${serverName}" removed.`,
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
