// The assembled handle of every agent a RuntimeService has loaded, for gap
// routes that need a part RuntimeService does not expose (an agent's adapter
// manager, its MCP manager's log stream). Built from the service's own
// 'agent-loaded' / 'agent-unloaded' events.
//
// One index per RuntimeService. It starts when the first route module asks
// for it, which createDaemonHttpApi does before the daemon autostarts or
// loads anything, so every agent the HTTP API can reach is in it.

import type { RuntimeAgentLoadedEvent, RuntimeService } from '../../runtime/runtime-service'

type RuntimeAgentHandle = RuntimeAgentLoadedEvent['agent']

export interface LoadedAgentEntry {
  agentId: string
  filePath: string | null
  agent: RuntimeAgentHandle
  /** The legacy-password derived key while the file is unlocked (read live from RuntimeService). */
  readonly derivedKey: Buffer | null
}

export interface LoadedAgentIndex {
  get(agentId: string): LoadedAgentEntry | undefined
  list(): LoadedAgentEntry[]
  /** Called with every agent loaded from now on. */
  onLoaded(listener: (entry: LoadedAgentEntry) => void): void
}

const indexes = new WeakMap<RuntimeService, LoadedAgentIndex>()

export function loadedAgentIndex(runtime: RuntimeService): LoadedAgentIndex {
  const existing = indexes.get(runtime)
  if (existing) return existing
  const entries = new Map<string, LoadedAgentEntry>()
  const listeners: Array<(entry: LoadedAgentEntry) => void> = []
  runtime.on('agent-loaded', (event) => {
    const entry: LoadedAgentEntry = {
      agentId: event.agentId,
      filePath: event.filePath,
      agent: event.agent,
      get derivedKey() { return runtime.getLoadedAgent(event.agentId)?.derivedKey ?? null },
    }
    entries.set(event.agentId, entry)
    for (const listener of listeners) {
      try { listener(entry) } catch (err) { console.error('[ADF Daemon] Loaded-agent listener failed:', err) }
    }
  })
  runtime.on('agent-unloaded', ({ agentId }) => { entries.delete(agentId) })
  const index: LoadedAgentIndex = {
    get: (agentId) => entries.get(agentId),
    list: () => [...entries.values()],
    onLoaded: (listener) => { listeners.push(listener) },
  }
  indexes.set(runtime, index)
  return index
}
