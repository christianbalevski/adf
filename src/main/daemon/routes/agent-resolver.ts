// One resolver from a route's `:id` (or a file path) to the agent workspace
// the per-agent gap routes act on, and the derived key of a
// password-protected file when the daemon holds one.
//
// Today it reaches loaded (running) agents only. W2-A extends it to open,
// not-running documents (D4); every per-agent W1-D route goes through here,
// so that is one change.

import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { RuntimeService } from '../../runtime/runtime-service'
import { canonicalizePath } from '../../utils/tracked-paths'

export interface ResolvedAgentWorkspace {
  agentId: string
  filePath: string
  workspace: AdfWorkspace
  /**
   * The file's derived key when it is password-protected and unlocked
   * (RuntimeService.getLoadedAgent); null while it is locked.
   */
  derivedKey: Buffer | null
}

export type AgentResolution =
  | { ok: true; agent: ResolvedAgentWorkspace }
  | { ok: false; reason: 'unknown' | 'no_file'; message: string }

function canon(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}

/** By id, handle or name, as every /agents/:id route. */
export function resolveAgentWorkspace(runtime: RuntimeService, id: string): AgentResolution {
  const loaded = runtime.getLoadedAgent(id)
  if (!loaded) return { ok: false, reason: 'unknown', message: `Unknown agent "${id}"` }
  if (!loaded.filePath) return { ok: false, reason: 'no_file', message: `Agent "${id}" has no .adf file` }
  return { ok: true, agent: { agentId: loaded.agentId, filePath: loaded.filePath, workspace: loaded.workspace, derivedKey: loaded.derivedKey } }
}

/** The agent holding `filePath` open (canonical compare), if any. */
export function resolveAgentWorkspaceByPath(runtime: RuntimeService, filePath: string): ResolvedAgentWorkspace | null {
  const key = canon(filePath)
  const live = runtime.listLiveAgents().find((a) => canon(a.filePath) === key)
  if (!live) return null
  const derivedKey = runtime.getLoadedAgent(live.agentId)?.derivedKey ?? null
  return { agentId: live.agentId, filePath: live.filePath, workspace: live.workspace, derivedKey }
}
