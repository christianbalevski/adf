/**
 * mcp_restart — Reconnect an MCP server and refresh discovered tools.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const InputSchema = z.object({
  name: z.string().describe('Name of the MCP server to reconnect'),
})

export class McpRestartTool implements Tool {
  readonly name = 'mcp_restart'
  readonly description =
    'Reconnect an MCP server already configured on this agent and refresh its discovered tools. ' +
    'Use this after installing a server, changing credentials, or when tool discovery returned no tools.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  constructor(private onServerRestarted?: (name: string) => Promise<{ toolsDiscovered?: number } | void> | { toolsDiscovered?: number } | void) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { name: serverName } = input as z.infer<typeof InputSchema>
    const config = workspace.getAgentConfig()
    const serverCfg = config.mcp?.servers?.find((server) => server.name === serverName)

    if (!serverCfg) {
      return {
        content: JSON.stringify({ success: false, error: `Server "${serverName}" not found.` }),
        isError: true,
      }
    }

    try {
      const result = await this.onServerRestarted?.(serverName)
      const updated = workspace.getAgentConfig()
      const updatedServer = updated.mcp?.servers?.find((server) => server.name === serverName)
      const toolsDiscovered = result?.toolsDiscovered ?? updatedServer?.available_tools?.length ?? 0

      return {
        content: JSON.stringify({
          success: true,
          name: serverName,
          tools_discovered: toolsDiscovered,
          message: toolsDiscovered > 0
            ? `Server "${serverName}" reconnected. ${toolsDiscovered} tools discovered. Enable the specific MCP tools in agent config before use.`
            : `Server "${serverName}" reconnected but no tools were discovered. Check the URL, command, credentials, or server logs.`,
        }),
        isError: false,
      }
    } catch (error) {
      return {
        content: JSON.stringify({
          success: false,
          name: serverName,
          error: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
      }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>,
    }
  }
}
