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
   * The file's derived key when it is password-protected and unlocked.
   * TODO(W1-A): RuntimeService keeps it per agent (managed.derivedKey) with
   * no public accessor; until W1-A adds one this is always null, so a
   * password-protected file reads its password-encrypted rows as locked.
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
  const ref = runtime.getAgent(id)
  if (!ref) return { ok: false, reason: 'unknown', message: `Unknown agent "${id}"` }
  const live = runtime.listLiveAgents().find((a) => a.agentId === ref.id)
  if (!live) return { ok: false, reason: 'no_file', message: `Agent "${id}" has no .adf file` }
  return { ok: true, agent: { agentId: ref.id, filePath: live.filePath, workspace: live.workspace, derivedKey: null } }
}

/** The agent holding `filePath` open (canonical compare), if any. */
export function resolveAgentWorkspaceByPath(runtime: RuntimeService, filePath: string): ResolvedAgentWorkspace | null {
  const key = canon(filePath)
  const live = runtime.listLiveAgents().find((a) => canon(a.filePath) === key)
  return live ? { agentId: live.agentId, filePath: live.filePath, workspace: live.workspace, derivedKey: null } : null
}
