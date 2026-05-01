import type { ToolRegistry } from '../tool-registry'

// Filesystem tools
import { FsReadTool } from './fs-read.tool'
import { FsWriteTool } from './fs-write.tool'
import { FsListTool } from './fs-list.tool'
import { FsDeleteTool } from './fs-delete.tool'

// Config tools
import { SysGetConfigTool } from './sys-get-config.tool'
import { SysUpdateConfigTool } from './sys-update-config.tool'

// Meta tools
import { SysGetMetaTool } from './sys-get-meta.tool'
import { SysSetMetaTool } from './sys-set-meta.tool'
import { SysDeleteMetaTool } from './sys-delete-meta.tool'

// Timer tools
import { SetTimerTool } from './sys-set-timer.tool'
import { GetTimersTool } from './sys-list-timers.tool'
import { DeleteTimerTool } from './sys-delete-timer.tool'

// Execution tools
import { CreateAdfTool } from './sys-create-adf.tool'

// Inbox tools
import { InboxCheckTool } from './msg-list.tool'
import { InboxReadTool } from './msg-read.tool'
import { InboxUpdateTool } from './msg-update.tool'

// Database tools
import { DbQueryTool } from './db-query.tool'
import { DbExecuteTool } from './db-execute.tool'
import { LoopCompactTool } from './loop-compact.tool'
import { LoopClearTool } from './loop-clear.tool'
import { MsgDeleteTool } from './msg-delete.tool'

// Network tools
import { SysFetchTool } from './sys-fetch.tool'

// Turn tools
import { SysSetStateTool } from './sys-set-state.tool'
import { SayTool } from './say.tool'
import { AskTool } from './ask.tool'

/**
 * Register all built-in tools with the registry.
 *
 * Note: SendMessageTool and AgentDiscoverTool are registered per-agent
 * by MeshManager with bound callbacks, not here in the global registry.
 *
 * This module is intentionally headless-safe: it only imports the core built-ins
 * needed for baseline registry construction, and avoids Electron-bound optional
 * tools so unit tests can import it directly under plain Vitest/Node.
 */
export function registerBuiltInTools(registry: ToolRegistry): void {
  registry.register(new FsReadTool())
  registry.register(new FsWriteTool())
  registry.register(new FsListTool())
  registry.register(new FsDeleteTool())

  registry.register(new SysGetConfigTool())
  registry.register(new SysUpdateConfigTool())

  registry.register(new SysGetMetaTool())
  registry.register(new SysSetMetaTool())
  registry.register(new SysDeleteMetaTool())

  registry.register(new SetTimerTool())
  registry.register(new GetTimersTool())
  registry.register(new DeleteTimerTool())

  registry.register(new CreateAdfTool())

  registry.register(new InboxCheckTool())
  registry.register(new InboxReadTool())
  registry.register(new InboxUpdateTool())

  registry.register(new DbQueryTool())
  registry.register(new DbExecuteTool())
  registry.register(new LoopCompactTool())
  registry.register(new LoopClearTool())
  registry.register(new MsgDeleteTool())

  registry.register(new SysFetchTool())

  registry.register(new SysSetStateTool())
  registry.register(new SayTool())
  registry.register(new AskTool())
}
