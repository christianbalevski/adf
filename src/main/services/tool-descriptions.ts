/**
 * The tool schema catalog the agent config editor shows (TOOLS_DESCRIPTIONS):
 * every tool name mapped to its provider-format declaration. Shared by
 * Studio's handler and the daemon's GET /runtime/tools/descriptions.
 *
 * Registries are read in order and the first declaration of a name wins:
 * the built-in registry, then (in Studio) the open agent's registry for the
 * tools it adds. Runtime tools that need per-agent dependencies are not in
 * the global registry, so stub instances supply their schemas (never
 * executed), followed by the code-execution-only method schemas.
 */

import type { CodeSandboxService } from '../runtime/code-sandbox'
import { AdfCallHandler } from '../runtime/adf-call-handler'
import {
  AgentDiscoverTool,
  ComputeExecTool,
  FsTransferTool,
  McpInstallTool,
  McpRestartTool,
  McpUninstallTool,
  NpmInstallTool,
  NpmUninstallTool,
  SendMessageTool,
  SysCodeTool,
  SysLambdaTool,
  WsConnectionsTool,
  WsConnectTool,
  WsDisconnectTool,
  WsSendTool,
} from '../tools/built-in'
import type { SandboxPackagesService } from './sandbox-packages.service'

export interface ToolDeclarationSource {
  getAll(): Array<{ name: string; toProviderFormat(): unknown }>
}

export interface ToolDescriptionDeps {
  codeSandboxService: CodeSandboxService
  sandboxPackagesService: SandboxPackagesService
}

/** Names the stub instances below fill in when no registry declared them. */
export const RUNTIME_STUB_TOOL_NAMES = [
  'sys_code', 'sys_lambda', 'msg_send', 'agent_discover', 'npm_install', 'npm_uninstall', 'fs_transfer',
  'mcp_install', 'mcp_uninstall', 'mcp_restart', 'compute_exec', 'ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send',
] as const

export function buildToolDescriptions(
  registries: Array<ToolDeclarationSource | null | undefined>,
  deps: ToolDescriptionDeps,
): Record<string, unknown> {
  const { codeSandboxService, sandboxPackagesService } = deps
  const definitions: Record<string, unknown> = {}
  for (const registry of registries) {
    if (!registry) continue
    for (const tool of registry.getAll()) {
      if (!definitions[tool.name]) {
        definitions[tool.name] = tool.toProviderFormat()
      }
    }
  }
  // Always ensure runtime-registered tools have definitions (they may not be in the
  // global registry since they require per-agent dependencies)
  if (!definitions['sys_code']) {
    const sysCodeTool = new SysCodeTool(codeSandboxService, '')
    definitions['sys_code'] = sysCodeTool.toProviderFormat()
  }
  if (!definitions['sys_lambda']) {
    // Stub SysLambdaTool for schema display — uses null handler (never executed)
    const sysLambdaTool = new SysLambdaTool(codeSandboxService, null as any, '')
    definitions['sys_lambda'] = sysLambdaTool.toProviderFormat()
  }
  if (!definitions['msg_send']) {
    const sendMessageTool = new SendMessageTool(
      async () => { throw new Error('Not available') },
      () => ({ sendMode: 'respond_only', isMessageTriggered: false })
    )
    definitions['msg_send'] = sendMessageTool.toProviderFormat()
  }
  if (!definitions['agent_discover']) {
    const discoverTool = new AgentDiscoverTool(() => [])
    definitions['agent_discover'] = discoverTool.toProviderFormat()
  }
  if (!definitions['npm_install']) {
    definitions['npm_install'] = new NpmInstallTool(sandboxPackagesService).toProviderFormat()
  }
  if (!definitions['npm_uninstall']) {
    definitions['npm_uninstall'] = new NpmUninstallTool().toProviderFormat()
  }
  if (!definitions['fs_transfer']) {
    const stubCaps = { hasIsolated: false, hasShared: false, hasHost: false, agentId: '' }
    definitions['fs_transfer'] = new FsTransferTool(null, stubCaps).toProviderFormat()
  }
  if (!definitions['mcp_install']) {
    definitions['mcp_install'] = new McpInstallTool().toProviderFormat()
  }
  if (!definitions['mcp_uninstall']) {
    definitions['mcp_uninstall'] = new McpUninstallTool().toProviderFormat()
  }
  if (!definitions['mcp_restart']) {
    definitions['mcp_restart'] = new McpRestartTool().toProviderFormat()
  }
  if (!definitions['compute_exec']) {
    const stubCaps = { hasIsolated: false, hasShared: false, hasHost: false, agentId: '' }
    definitions['compute_exec'] = new ComputeExecTool(null, stubCaps).toProviderFormat()
  }
  if (!definitions['ws_connect']) {
    definitions['ws_connect'] = new WsConnectTool(async () => ({ error: 'Not available' })).toProviderFormat()
  }
  if (!definitions['ws_disconnect']) {
    definitions['ws_disconnect'] = new WsDisconnectTool(async () => ({ success: false })).toProviderFormat()
  }
  if (!definitions['ws_connections']) {
    definitions['ws_connections'] = new WsConnectionsTool(() => []).toProviderFormat()
  }
  if (!definitions['ws_send']) {
    definitions['ws_send'] = new WsSendTool(async () => ({ success: false })).toProviderFormat()
  }
  // Include code-execution-only method schemas (model_invoke, task_resolve, etc.)
  const ceSchemas = AdfCallHandler.getCodeExecutionSchemas()
  for (const [name, schema] of Object.entries(ceSchemas)) {
    if (!definitions[name]) {
      definitions[name] = schema
    }
  }
  return definitions
}
