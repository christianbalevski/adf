// Owner-driven (re)connect of one MCP server of a running agent, the same
// path the agent's own mcp_install / mcp_restart tools take (routing to host
// or container, credentials, tool discovery and sync). The daemon runtime
// builder registers it per agent, keyed by the agent's MCP manager, so the
// runtime service can reach it without threading a closure through assembly.

import type { McpConnectOutcome } from '../tools/built-in/mcp-install.tool'

export type McpConnector = (serverName: string, reason?: string) => Promise<McpConnectOutcome>

const connectors = new WeakMap<object, McpConnector>()

export function registerMcpConnector(manager: object, connector: McpConnector): void {
  connectors.set(manager, connector)
}

export function mcpConnectorFor(manager: object | null | undefined): McpConnector | undefined {
  return manager ? connectors.get(manager) : undefined
}
