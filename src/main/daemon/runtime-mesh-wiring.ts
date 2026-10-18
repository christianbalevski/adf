/**
 * Keeps the daemon's mesh registrations in step with RuntimeService, as
 * Studio's hosts do by hand:
 *
 * - `agent-loaded`: register.
 * - `agent_stopping`: unregister before the teardown, so no new message
 *   arrives while the agent stops (Studio's handleAgentOff unregisters first).
 * - `agent-unloaded`: unregister (a no-op after agent_stopping).
 * - `agent-path-changed`: the registration is keyed by file path, so it moves
 *   to the new path (rekeyAgentPath).
 */
import type { RuntimeAgentLoadedEvent, RuntimeService } from '../runtime/runtime-service'

export interface MeshRegistrar {
  register(event: RuntimeAgentLoadedEvent): void
  unregister(filePath: string): void
}

export interface RuntimeMeshWiring {
  /** The loaded agents, as their latest 'agent-loaded' (or path change) described them. */
  loaded(): RuntimeAgentLoadedEvent[]
}

export function wireRuntimeToMesh(runtime: RuntimeService, mesh: MeshRegistrar): RuntimeMeshWiring {
  const loaded = new Map<string, RuntimeAgentLoadedEvent>()
  const unregister = (filePath: string | null): void => {
    if (!filePath) return
    try { mesh.unregister(filePath) } catch (err) { console.error(`[ADF Daemon] Mesh unregister of ${filePath} failed:`, err) }
  }

  runtime.on('agent-loaded', (event) => {
    loaded.set(event.agentId, event)
    mesh.register(event)
  })
  runtime.on('agent-lifecycle', (event) => {
    if (event.type === 'agent_stopping') unregister(event.filePath)
  })
  runtime.on('agent-unloaded', ({ agentId, filePath }) => {
    loaded.delete(agentId)
    unregister(filePath)
  })
  runtime.on('agent-path-changed', ({ agentId, oldFilePath, filePath }) => {
    const previous = loaded.get(agentId)
    unregister(oldFilePath)
    if (!previous) return
    const ref = runtime.getAgent(agentId) ?? { ...previous.ref, filePath }
    const moved: RuntimeAgentLoadedEvent = { ...previous, filePath, ref }
    loaded.set(agentId, moved)
    console.log(`[ADF Daemon] Mesh registration of ${ref.config.name} moved to ${filePath}`)
    mesh.register(moved)
  })

  return { loaded: () => [...loaded.values()] }
}
