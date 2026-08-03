/**
 * mcp_restart — Reconnect an MCP server and refresh discovered tools.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { McpConnectOutcome } from './mcp-install.tool'

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

  constructor(private onServerRestarted?: (name: string) => Promise<McpConnectOutcome | void> | McpConnectOutcome | void) {}

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
      const result = (await this.onServerRestarted?.(serverName)) ?? undefined
      const updated = workspace.getAgentConfig()
      const updatedServer = updated.mcp?.servers?.find((server) => server.name === serverName)
      const toolsDiscovered = result?.toolsDiscovered ?? updatedServer?.available_tools?.length ?? 0

      const failureDetail = [
        result?.hostDenied ? `Host execution was denied (${result.hostDenied}), so the command ran in the ${result.location ?? 'container'} where host paths may not exist.` : '',
        result?.error ? `Last error: ${result.error}` : '',
      ].filter(Boolean).join(' ')
      return {
        content: JSON.stringify({
          success: true,
          name: serverName,
          tools_discovered: toolsDiscovered,
          ...(result?.location ? { location: result.location } : {}),
          ...(result?.hostDenied ? { host_denied: result.hostDenied } : {}),
          ...(toolsDiscovered === 0 && result?.error ? { connection_error: result.error } : {}),
          ...(toolsDiscovered === 0 && result?.stderrTail?.length ? { stderr_tail: result.stderrTail } : {}),
          message: toolsDiscovered > 0
            ? `Server "${serverName}" reconnected. ${toolsDiscovered} tools discovered. Existing tool choices were preserved; new tools require human approval by default.`
            : `Server "${serverName}" reconnected but no tools were discovered. ${failureDetail || 'Check the URL, command, credentials, or server logs.'}`,
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
