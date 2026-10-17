import { IPC } from '../../../shared/constants/ipc-channels'
import type { MappedChannel } from '../channel-map'

/**
 * Channels whose daemon-mode handler is not written yet, and who writes it.
 * Each is registered with a handler that throws
 * `DaemonModeUnavailableError` naming that workstream, so the renderer shows
 * the gap instead of a missing-handler error, and nothing falls back to
 * embedded state.
 *
 * The domain split is the tracker's Wave 3 (docs/design/daemon-backend-tracker.md
 * §4): W3-A files, documents, agent runtime, review, templates, tracked and
 * bulk directories; W3-B settings, providers, models, subscription auth,
 * identity, credentials; W3-C MCP, adapters, sandbox packages, skills,
 * registries; W3-D mesh, fleet, dashboard, tools, token usage, compute,
 * emergency stop. A W3 workstream adds its handlers to the table in
 * handlers/index.ts and the channel leaves this list
 * (tests/backend/daemon-mode-handlers.test.ts keeps the two exclusive).
 */

const KEY_OF: ReadonlyMap<string, string> = new Map(Object.entries(IPC).map(([key, value]) => [value, key]))

/** The Wave 3 workstream that owns a channel's daemon-mode handler. */
export function pendingWorkstream(channel: MappedChannel): string {
  const key = KEY_OF.get(channel) ?? channel
  if (/^(MCP_|ADAPTER_|SANDBOX_|SKILLS_|AGENT_REGISTRY_)/.test(key) || key === 'AGENT_MODEL_SET_FOR_FILE') return 'W3-C'
  if (/^(MESH_|DASHBOARD_|TOKEN_|COMPUTE_)/.test(key) || ['CONTEXT_BREAKDOWN_GET', 'EMERGENCY_STOP', 'AGENT_VITALS', 'AGENT_ACTIVITY'].includes(key)) return 'W3-D'
  if (/^(MODELS_|PROVIDER_|CHATGPT_|GROK_|CLAUDE_|SETTINGS_)/.test(key)) return 'W3-B'
  if (/^IDENTITY_/.test(key) && !/^IDENTITY_DRAFT_/.test(key)) return 'W3-B'
  return 'W3-A'
}

/** `adf:file:open` → `FILE_OPEN`, for messages. */
export function channelKey(channel: string): string {
  return KEY_OF.get(channel) ?? channel
}
