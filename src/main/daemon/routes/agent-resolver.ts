// One resolver from a route's `:id` (or a file path) to the agent workspace
// the per-agent gap routes act on, and the derived key of a
// password-protected file when the daemon holds one.
//
// It reaches running agents and open documents that are not running (D4,
// W2-A): every per-agent W1-D and W1-E route goes through here. A document
// and the runtime started on it share one workspace and one key, so the
// answer is the same object whichever of the two is open.

import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { RuntimeService } from '../../runtime/runtime-service'

export interface ResolvedAgentWorkspace {
  agentId: string
  filePath: string
  workspace: AdfWorkspace
  /**
   * The file's derived key when it is password-protected and unlocked
   * (RuntimeService.getAgentWorkspace); null while it is locked.
   */
  derivedKey: Buffer | null
  /** A runtime runs on it; false for an open document that is not running. */
  running: boolean
}

export type AgentResolution =
  | { ok: true; agent: ResolvedAgentWorkspace }
  | { ok: false; reason: 'unknown' | 'no_file'; message: string }

/** By id, handle or name, as every /agents/:id route. */
export function resolveAgentWorkspace(runtime: RuntimeService, id: string): AgentResolution {
  const found = runtime.getAgentWorkspace(id)
  if (!found) return { ok: false, reason: 'unknown', message: `Unknown agent "${id}"` }
  if (!found.filePath) return { ok: false, reason: 'no_file', message: `Agent "${id}" has no .adf file` }
  return { ok: true, agent: { agentId: found.agentId, filePath: found.filePath, workspace: found.workspace, derivedKey: found.derivedKey, running: found.running } }
}

/** The running agent or open document of `filePath` (canonical compare), if any. */
export function resolveAgentWorkspaceByPath(runtime: RuntimeService, filePath: string): ResolvedAgentWorkspace | null {
  const found = runtime.getAgentWorkspaceByPath(filePath)
  if (!found?.filePath) return null
  return { agentId: found.agentId, filePath: found.filePath, workspace: found.workspace, derivedKey: found.derivedKey, running: found.running }
}
