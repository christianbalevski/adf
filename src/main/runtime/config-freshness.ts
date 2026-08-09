import type { AgentConfig } from '@shared/types/adf-v02.types'

/**
 * Pick the authoritative config at the end of an async agent-start sequence.
 *
 * AGENT_START captures the workspace config once, then awaits for seconds
 * (provider validation, MCP connects, adapter setup) before the executor
 * exists. Any config write that lands during that window (a UI toggle via
 * DOC_SET_AGENT_CONFIG finds `agentExecutor === null`, so its fan-out has no
 * executor to update) persists to the workspace but would be silently dropped
 * from the freshly assembled executor — leaving the UI showing a tool as
 * enabled while the shell gate (reading through the executor) still sees the
 * pre-start snapshot and exits 126 "disabled".
 *
 * Every workspace write bumps `metadata.updated_at` (AdfDatabase.setConfig),
 * while in-memory mutations of the captured snapshot do not — so a differing
 * timestamp means the workspace has writes the snapshot missed and the
 * workspace copy wins. Identical timestamps keep the captured object (it may
 * carry deliberate in-memory additions that were never meant to persist).
 */
export function pickFresherConfig(captured: AgentConfig, workspaceConfig: AgentConfig): AgentConfig {
  const capturedAt = captured.metadata?.updated_at ?? ''
  const workspaceAt = workspaceConfig.metadata?.updated_at ?? ''
  return workspaceAt !== capturedAt ? workspaceConfig : captured
}
