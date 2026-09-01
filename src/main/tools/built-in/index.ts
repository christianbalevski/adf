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
// loop_send/loop_list/loop_manage are ordinary config-declared tools
// (enabled+visible in DEFAULT_TOOLS). The runtime registers each into MAIN's
// registry whenever its own declaration is enabled — like every other
// capability tool — and into a SIDE loop's registry only when that loop's
// allow-list names it (loop_manage is never grantable to a loop:
// LOOP_PROHIBITED_TOOLS). loop_send/loop_list are present regardless of loop
// count and return sensibly when there is nothing to act on (loop_list shows
// just `main`; loop_send errors on any target).
//
// Gate registration on `<its declaration is enabled>`, NOT the sys_code idiom
// of gating on declaration PRESENCE (`config.tools.some(t => t.name === ...)`):
// the DEFAULT_TOOLS backfill writes a declaration for all three into every
// config, so a presence test is always true. For loop_manage in particular a
// presence test would register it into every side loop's registry, which must
// never build it.
//
// Registration is NOT itself the first fence for loop_manage: main's registry
// (which holds it) is copied into each side loop's registry, so the instance
// can be present there before anything trims it. The three fences that actually
// keep it off a loop are:
//   1. LOOP_PROHIBITED_TOOLS at derive time — deriveLoopConfig subtracts it from
//      every derived toolset, and LoopConfigSchema rejects it in `loop.tools`;
//   2. `rebindBoundTools`' unconditional unregister in the loop registry — the
//      copied instance is removed regardless of what the derived config says;
//   3. the tool's own main-only runtime refusal — it errors for any caller whose
//      workspace loop name is not `main`.
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
