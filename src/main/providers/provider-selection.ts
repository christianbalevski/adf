import type { AgentConfig } from '../../shared/types/adf-v02.types'

/**
 * Whether a config edit changes which provider a running agent should use:
 * the selected id, model, params, or the agent's own entry for that id (base
 * URL, type, delay...). Hosts rebuild the provider when this is true, so a
 * corrected base URL takes effect without a reload.
 */
export function providerSelectionChanged(previous: AgentConfig, next: AgentConfig): boolean {
  const entry = (c: AgentConfig) => c.providers?.find(p => p.id === c.model.provider)
  return previous.model.provider !== next.model.provider ||
    previous.model.model_id !== next.model.model_id ||
    JSON.stringify(previous.model.params) !== JSON.stringify(next.model.params) ||
    JSON.stringify(entry(previous)) !== JSON.stringify(entry(next))
}
