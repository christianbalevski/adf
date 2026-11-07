import type { AdfWorkspace } from '../adf/adf-workspace'

/**
 * The agent's limits.execution_timeout_ms, read live for the tools that build
 * their schema from it (sys_code, sys_lambda, compute_exec). Those read it on
 * every schema/description access, so the config is re-read only when its
 * stamp moved — a write through this connection (configWriteCount) or a commit
 * by another (data_version) — like RuntimeService.syncManagedConfig. A closed
 * workspace keeps the last value.
 */
export function liveExecutionTimeout(workspace: AdfWorkspace): () => number | undefined {
  let seen: { writes: number; dataVersion: number } | null = null
  let value: number | undefined
  return () => {
    try {
      const writes = workspace.configWriteCount()
      const dataVersion = workspace.dataVersion()
      if (seen?.writes === writes && seen.dataVersion === dataVersion) return value
      value = workspace.getAgentConfig().limits?.execution_timeout_ms
      // Counted after the read, as syncManagedConfig does: a write the read made is in `value`.
      seen = { writes: workspace.configWriteCount(), dataVersion }
    } catch { /* workspace closed: keep the last known limit */ }
    return value
  }
}
