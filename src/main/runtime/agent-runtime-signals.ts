/**
 * Per-agent runtime signals from the daemon's AgentRuntimeBuilder to the
 * services that hold their own copy of agent state (the mesh registration).
 *
 * Studio's hosts push these changes by hand: the foreground and background
 * `onConfigChanged` call `meshManager.updateAgentConfig`, and every unlock or
 * lock calls `syncDerivedKeyToMesh`. In the daemon the builder owns the
 * config-change choke point and the derived key, and the mesh registration
 * happens elsewhere (daemon/index.ts), so the two meet here instead of through
 * a reference the builder would have to hold.
 *
 * Keyed by the agent's workspace object: it is the one handle both sides
 * already have. Weakly held, so a disposed agent leaves nothing behind.
 */
import type { AgentConfig } from '../../shared/types/adf-v02.types'

export interface AgentRuntimeSignalListener {
  /** The running config changed (agent sys_update_config, API config write, MCP tool sync). */
  onConfigChanged?: (config: AgentConfig) => void
  /** The legacy-password derived key became available (Buffer) or was dropped (null). */
  onDerivedKeyChanged?: (derivedKey: Buffer | null) => void
}

const listeners = new WeakMap<object, Set<AgentRuntimeSignalListener>>()
const derivedKeys = new WeakMap<object, Buffer>()

/** Subscribe to one agent's signals. Returns the unsubscribe function. */
export function subscribeAgentRuntimeSignals(workspace: object, listener: AgentRuntimeSignalListener): () => void {
  let set = listeners.get(workspace)
  if (!set) {
    set = new Set()
    listeners.set(workspace, set)
  }
  set.add(listener)
  return () => { listeners.get(workspace)?.delete(listener) }
}

/** Announce a config change. A throwing listener is logged and never reaches the caller. */
export function emitAgentConfigChanged(workspace: object, config: AgentConfig): void {
  for (const listener of Array.from(listeners.get(workspace) ?? [])) {
    try { listener.onConfigChanged?.(config) } catch (err) {
      console.error('[AgentRuntimeSignals] config listener failed:', err)
    }
  }
}

/** Record and announce the agent's derived key (null clears it). */
export function emitAgentDerivedKeyChanged(workspace: object, derivedKey: Buffer | null): void {
  if (derivedKey) derivedKeys.set(workspace, derivedKey)
  else derivedKeys.delete(workspace)
  for (const listener of Array.from(listeners.get(workspace) ?? [])) {
    try { listener.onDerivedKeyChanged?.(derivedKey) } catch (err) {
      console.error('[AgentRuntimeSignals] derived-key listener failed:', err)
    }
  }
}

/** The derived key last announced for this agent, for a subscriber that arrives later. */
export function currentAgentDerivedKey(workspace: object): Buffer | null {
  return derivedKeys.get(workspace) ?? null
}
