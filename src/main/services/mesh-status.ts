/**
 * The mesh status / debug view the fleet map polls (MESH_STATUS, and the
 * debug slice of MESH_MAP_POLL). Shared by Studio's handler and the daemon's
 * GET /fleet/mesh so both hosts return one shape.
 *
 * `sinceSeq` is the message-log cursor: with it, only bus entries newer than
 * that sequence come back and `logSeq` names the newest one the bus holds, so
 * the 5s poll stops re-sending the whole 200-entry log (with its content) every
 * cycle. Callers that omit it get the full log.
 */

export interface MeshStatusSource {
  /** The mesh exists and is enabled. */
  isRunning(): boolean
  /** Mesh-registered agents with live executor states overlaid. */
  liveAgents(): unknown[]
  /** MeshManager.getDebugInfo(). */
  debugInfo(): { messageLog: Array<{ seq?: number }> } & Record<string, unknown>
}

export async function buildMeshStatus(
  src: MeshStatusSource,
  args?: { debug?: boolean; sinceSeq?: number },
): Promise<Record<string, unknown>> {
  if (!src.isRunning()) {
    if (args?.debug) {
      return {
        running: false,
        agents: [],
        busRegistrations: [],
        backgroundAgents: [],
        foregroundAgents: [],
        messageLog: []
      }
    }
    return { running: false, agents: [] }
  }

  const agents = src.liveAgents()

  const result: Record<string, unknown> = {
    running: true,
    agents
  }

  if (args?.debug) {
    try {
      const debugInfo = src.debugInfo()
      Object.assign(result, debugInfo)
      const fullLog = debugInfo.messageLog
      const newest = fullLog.length > 0 ? fullLog[fullLog.length - 1].seq ?? 0 : 0
      result.logSeq = newest
      if (typeof args.sinceSeq === 'number') {
        result.messageLog = fullLog.filter((e) => (e.seq ?? 0) > args.sinceSeq!)
        result.logIncremental = true
      }
    } catch (error) {
      console.error('[IPC] Mesh debug error:', error)
      result.busRegistrations = []
      result.backgroundAgents = []
      result.foregroundAgents = []
      result.messageLog = []
      result.error = String(error)
    }
  }

  return result
}
