import { IPC } from './ipc-channels'

/**
 * The push channels of scope `runtime` (docs/design/multi-runtime.md §4.2),
 * for preload: a push on one of these from a runtime other than the primary
 * carries its runtime tag, and a facade bound to a runtime delivers only its
 * own. Every other push (Studio and aggregate scope) is untagged and reaches
 * every facade. tests/backend/channel-map.test.ts keeps this list equal to
 * the channel map's.
 */
export const RUNTIME_PUSH_CHANNELS: readonly string[] = [
  IPC.FILE_RENAMED,
  IPC.DOC_AGENT_CONFIG_CHANGED,
  IPC.AGENT_EVENT,
  IPC.TEMPLATES_CHANGED,
  IPC.TRACKED_DIRS_CHANGED,
  IPC.MESH_EVENT,
  IPC.BACKGROUND_AGENT_EVENT_BATCH,
  IPC.INBOX_UPDATED,
  IPC.WORKSPACE_DATA_CHANGED,
  IPC.MCP_INSTALL_PROGRESS,
  IPC.MCP_SERVER_STATUS_CHANGED,
  IPC.COMPUTE_BROWSER_SESSION,
  IPC.COMPUTE_CONTAINER_PHASE,
  IPC.SANDBOX_INSTALL_PROGRESS,
  IPC.ADAPTER_INSTALL_PROGRESS,
  IPC.ADAPTER_STATUS_CHANGED,
  IPC.REMOTE_PICKER_REQUEST,
]
