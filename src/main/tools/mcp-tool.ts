import { z } from 'zod'
import type { Tool, ToolCategory } from './tool.interface'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../shared/types/tool.types'
import type { McpClientManager } from '../services/mcp-client-manager'
import type { McpToolInfo } from '../../shared/types/adf-v02.types'

/**
 * Wraps an MCP tool so it's indistinguishable from built-in tools.
 * Name format: mcp_{serverName}_{originalToolName}
 */
export class McpTool implements Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema = z.record(z.unknown())
  readonly category: ToolCategory = 'external'

  private readonly serverName: string
  private readonly mcpToolName: string
  private readonly mcpInputSchema: Record<string, unknown>
  private readonly mcpManager: McpClientManager

  constructor(
    serverName: string,
    toolInfo: McpToolInfo,
    mcpManager: McpClientManager
  ) {
    this.serverName = serverName
    this.mcpToolName = toolInfo.name
    this.name = `mcp_${serverName}_${toolInfo.name}`
    this.description = toolInfo.description ?? `MCP tool: ${toolInfo.name} (via ${serverName})`
    this.mcpInputSchema = toolInfo.input_schema
    this.mcpManager = mcpManager
  }

  getServerName(): string { return this.serverName }
  getMcpToolName(): string { return this.mcpToolName }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const raw = (input ?? {}) as Record<string, unknown>
    // Strip internal metadata fields before forwarding to MCP server
    const { _reason: _, _async: __, ...args } = raw
    return this.mcpManager.callTool(this.serverName, this.mcpToolName, args)
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.mcpInputSchema
    }
  }
}
