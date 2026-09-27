import type { AgentConfig } from '../../shared/types/adf-v02.types'

/** Add the inbox and stream-binding tool declarations every host expects. Returns whether any were added. */
export function addCoreToolDeclarations(config: AgentConfig): boolean {
  const toolNames = new Set(config.tools.map((t) => t.name))
  const before = config.tools.length
  for (const toolName of ['msg_list', 'msg_read', 'msg_update']) {
    if (!toolNames.has(toolName)) config.tools.push({ name: toolName, enabled: true, visible: true })
  }
  for (const toolName of ['stream_bind', 'stream_unbind', 'stream_bindings']) {
    if (!toolNames.has(toolName)) config.tools.push({ name: toolName, enabled: false } as AgentConfig['tools'][number])
  }
  return config.tools.length !== before
}

/**
 * Add the core declarations to the running config AND the file, so the config
 * the owner inspects is the one the agent runs with. Read-modify-write against
 * a fresh read, so unrelated concurrent edits survive. Best-effort: a failed
 * write never blocks a start. `onPersisted` lets a host refresh an open editor.
 */
export function ensureCoreToolDeclarations(
  config: AgentConfig,
  workspace: { getAgentConfig(): AgentConfig; setAgentConfig(config: AgentConfig): void },
  label: string,
  onPersisted?: (fresh: AgentConfig) => void,
): void {
  if (!addCoreToolDeclarations(config)) return
  try {
    const fresh = workspace.getAgentConfig()
    if (addCoreToolDeclarations(fresh)) {
      workspace.setAgentConfig(fresh)
      onPersisted?.(fresh)
    }
  } catch (err) {
    console.warn(`[CoreTools] Failed to persist core tool declarations for ${label}:`, err)
  }
}
