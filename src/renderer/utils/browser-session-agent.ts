import type { AgentConfig } from '../../shared/types/adf-v02.types'

/** Identity used by the runtime to resolve the isolated browser container. */
export function browserSessionAgent(config: AgentConfig): { agentId: string; agentName: string } {
  // eslint-disable-next-line no-restricted-syntax -- isolatedContainerName uses the config name, including during a deferred rename.
  return { agentId: config.id, agentName: config.name }
}
