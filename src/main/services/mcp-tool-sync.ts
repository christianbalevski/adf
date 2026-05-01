import type { AgentConfig, McpServerConfig, McpToolInfo, ToolDeclaration } from '../../shared/types/adf-v02.types'
import { McpTool } from '../tools/mcp-tool'
import type { ToolRegistry } from '../tools/tool-registry'
import type { McpClientManager } from './mcp-client-manager'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

export function hashMcpToolInfo(tool: McpToolInfo): string {
  return stableStringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.input_schema ?? {}
  })
}

function markToolDeclarationForDiscoveredTool(declaration: ToolDeclaration | undefined, hash: string): { changed: boolean; declaration: ToolDeclaration } {
  if (!declaration) {
    return {
      changed: true,
      declaration: {
        name: '',
        enabled: false,
        visible: false,
        mcp_tool_hash: hash,
        mcp_tool_status: 'new'
      }
    }
  }

  if (declaration.mcp_tool_hash && declaration.mcp_tool_hash !== hash) {
    return {
      changed: true,
      declaration: {
        ...declaration,
        enabled: false,
        visible: false,
        mcp_tool_hash: hash,
        mcp_tool_status: 'changed'
      }
    }
  }

  if (declaration.mcp_tool_status === 'removed') {
    return {
      changed: true,
      declaration: {
        ...declaration,
        enabled: false,
        visible: false,
        mcp_tool_hash: hash,
        mcp_tool_status: 'new'
      }
    }
  }

  if (!declaration.mcp_tool_hash) {
    return {
      changed: true,
      declaration: {
        ...declaration,
        mcp_tool_hash: hash,
      }
    }
  }

  return { changed: false, declaration }
}

export function syncDiscoveredMcpTools(
  config: AgentConfig,
  serverCfg: McpServerConfig,
  tools: McpToolInfo[],
  registry: ToolRegistry,
  manager: McpClientManager
): boolean {
  let configChanged = false
  const toolPrefix = `mcp_${serverCfg.name}_`
  const discoveredNames = new Set<string>()
  const previousToolsHash = stableStringify(serverCfg.available_tools ?? [])
  const nextToolsHash = stableStringify(tools)

  serverCfg.available_tools = tools
  if (previousToolsHash !== nextToolsHash) configChanged = true

  for (const toolInfo of tools) {
    const mcpTool = new McpTool(serverCfg.name, toolInfo, manager)
    registry.register(mcpTool)
    discoveredNames.add(mcpTool.name)

    const hash = hashMcpToolInfo(toolInfo)
    const existingIndex = config.tools.findIndex((t) => t.name === mcpTool.name)
    const existing = existingIndex >= 0 ? config.tools[existingIndex] : undefined
    const result = markToolDeclarationForDiscoveredTool(existing, hash)
    result.declaration.name = mcpTool.name

    if (existingIndex >= 0) {
      if (result.changed) {
        config.tools[existingIndex] = result.declaration
        configChanged = true
      }
    } else {
      config.tools.push(result.declaration)
      configChanged = true
    }
  }

  for (let i = 0; i < config.tools.length; i++) {
    const declaration = config.tools[i]
    if (!declaration.name.startsWith(toolPrefix)) continue
    if (discoveredNames.has(declaration.name)) continue
    if (declaration.mcp_tool_status === 'removed' && !declaration.enabled && !declaration.visible) continue
    config.tools[i] = {
      ...declaration,
      enabled: false,
      visible: false,
      mcp_tool_status: 'removed'
    }
    configChanged = true
  }

  return configChanged
}
