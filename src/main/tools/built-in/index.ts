// Re-exports for external use
export { registerBuiltInTools } from './register-built-in-tools'
export { SendMessageTool } from './msg-send.tool'
export { AgentDiscoverTool } from './agent-discover.tool'
export { SysGetConfigTool, buildToolDiscovery } from './sys-get-config.tool'
export { SysUpdateConfigTool } from './sys-update-config.tool'
export { SysCodeTool } from './sys-code.tool'
export { SetTimerTool } from './sys-set-timer.tool'
export { GetTimersTool } from './sys-list-timers.tool'
export { DeleteTimerTool } from './sys-delete-timer.tool'
export { CreateAdfTool } from './sys-create-adf.tool'
export { InboxCheckTool } from './msg-list.tool'
export { InboxReadTool } from './msg-read.tool'
export { InboxUpdateTool } from './msg-update.tool'
export { FsReadTool } from './fs-read.tool'
export { FsWriteTool } from './fs-write.tool'
export { FsListTool } from './fs-list.tool'
export { FsDeleteTool } from './fs-delete.tool'
export { DbQueryTool } from './db-query.tool'
export { DbExecuteTool } from './db-execute.tool'
export { LoopCompactTool } from './loop-compact.tool'
export { LoopClearTool } from './loop-clear.tool'
export { MsgDeleteTool } from './msg-delete.tool'

// Loop (facet) tools — pool-injected, deliberately NOT in registerBuiltInTools.
//
// loop_send/loop_list are essentials the runtime registers into EVERY loop
// executor's registry, unconditionally (they are structural machinery, never
// config-declared).
//
// loop_manage goes into MAIN's registry ONLY. Gate it on
// `loop === 'main' && <its declaration is enabled>` — do NOT copy the sys_code
// idiom of gating on declaration PRESENCE (`config.tools.some(t => t.name ===
// ...)`): the DEFAULT_TOOLS backfill writes a loop_manage declaration into
// every config, so a presence test is always true and would register the tool
// into every side loop's registry. Side-loop registries must never build it.
// (The tool also refuses a non-main caller at runtime, and deriveLoopConfig
// subtracts it from every derived toolset — but registration is the first of
// the three fences, not a redundant one.)
//
// See docs/design/agent-loops-mvp.md §7 and src/main/adf/loop-pool.types.ts for
// the injected contract.
export { LoopSendTool } from './loop-send.tool'
export { LoopListTool } from './loop-list.tool'
export { LoopManageTool } from './loop-manage.tool'
export { SysFetchTool } from './sys-fetch.tool'
export { SysSetStateTool } from './sys-set-state.tool'
export { SayTool } from './say.tool'
export { AskTool } from './ask.tool'
export { SysLambdaTool } from './sys-lambda.tool'
export { SysGetMetaTool } from './sys-get-meta.tool'
export { SysSetMetaTool } from './sys-set-meta.tool'
export { SysDeleteMetaTool } from './sys-delete-meta.tool'

// WebSocket tools
export { WsConnectTool } from './ws-connect.tool'
export { WsDisconnectTool } from './ws-disconnect.tool'
export { WsConnectionsTool } from './ws-connections.tool'
export { WsSendTool } from './ws-send.tool'

// Stream binding tools
export { StreamBindTool } from './stream-bind.tool'
export { StreamUnbindTool } from './stream-unbind.tool'
export { StreamBindingsTool } from './stream-bindings.tool'

// Package management tools (per-agent, not in registerBuiltInTools)
export { NpmInstallTool } from './npm-install.tool'
export { NpmUninstallTool } from './npm-uninstall.tool'

// Compute environment tools (per-agent, not in registerBuiltInTools)
export { FsTransferTool } from './fs-transfer.tool'
export { ComputeExecTool } from './compute-exec.tool'

// Chat metadata lookup (per-agent, closure-injected with the adapter manager)
export { ChatInfoTool, type ChatInfoFn } from './chat-info.tool'

// MCP management tools (per-agent, not in registerBuiltInTools)
export { McpInstallTool, type McpConnectOutcome } from './mcp-install.tool'
export { McpUninstallTool } from './mcp-uninstall.tool'
export { McpRestartTool } from './mcp-restart.tool'

// Shell tool
export { ShellTool } from '../shell/shell.tool'
export { isAbsorbedByShell } from '../shell/shell-absorption'
