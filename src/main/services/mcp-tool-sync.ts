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

/**
 * Diff two agent configs by MCP server NAME.
 *
 * Pure helper (no side effects) so it can be unit-tested in isolation. Drives
 * the live foreground reconcile: `added` servers get connected, `removed`
 * servers get disconnected; servers present in both are left untouched (no
 * needless reconnect). Executable-identity changes on an unchanged name are out
 * of scope — this only reports set membership by name.
 */
export function diffMcpServerNames(
  previous: AgentConfig,
  next: AgentConfig
): { added: string[]; removed: string[] } {
  const prevNames = new Set((previous.mcp?.servers ?? []).map((s) => s.name))
  const nextNames = new Set((next.mcp?.servers ?? []).map((s) => s.name))
  const added = [...nextNames].filter((name) => !prevNames.has(name))
  const removed = [...prevNames].filter((name) => !nextNames.has(name))
  return { added, removed }
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
        enabled: true,
        visible: true,
        restricted: true,
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
        restricted: true,
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
        enabled: true,
        visible: true,
        restricted: true,
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

/**
 * Handle a `tools-discovered` event for a long-lived listener.
 *
 * CRITICAL: reads the config through `getFreshConfig` AT EVENT TIME. These
 * listeners are attached once at agent start and live for the whole agent
 * lifetime; syncing into a config object captured at start would write that
 * start-time snapshot back over the workspace on any MCP reconnect — silently
 * reverting every config change made since start (UI toggles, sys_update_config,
 * "Always approve"). The UI would then show a tool as enabled while the
 * executor/shell gate sees the clobbered (disabled) declaration.
 *
 * When the server is not declared in config, the tools are registered so they
 * are callable, but nothing is persisted (parity with the previous behavior).
 */
export function resyncServerTools(opts: {
  getFreshConfig: () => AgentConfig
  serverName: string
  tools: McpToolInfo[]
  registry: ToolRegistry
  manager: McpClientManager
  persist: (config: AgentConfig) => void
  fanOut: (config: AgentConfig) => void
}): void {
  const config = opts.getFreshConfig()
  const serverCfg = config.mcp?.servers?.find((server) => server.name === opts.serverName)
  if (!serverCfg) {
    for (const toolInfo of opts.tools) {
      opts.registry.register(new McpTool(opts.serverName, toolInfo, opts.manager))
    }
    return
  }
  if (syncDiscoveredMcpTools(config, serverCfg, opts.tools, opts.registry, opts.manager)) {
    opts.persist(config)
    opts.fanOut(config)
  }
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
