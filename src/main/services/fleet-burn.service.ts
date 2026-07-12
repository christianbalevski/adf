import type { FleetBurnEntry, FleetBurnResult } from '../../shared/types/ipc.types'

/** Rolling window for tokens-per-minute normalization. */
const WINDOW_MS = 5 * 60 * 1000
const WINDOW_MINUTES = 5

interface BurnSample {
  t: number
  tokens: number
}

interface AgentBurn {
  samples: BurnSample[]
  totalTokens: number
}

/**
 * In-memory per-agent token burn tracker for the fleet map resource bar.
 * Keyed by the agent's .adf absolute file path (the same string used as
 * node id in the mesh). Samples older than the rolling window are pruned
 * lazily on record and on read — no timers, no persistence.
 */
export class FleetBurnService {
  private agents = new Map<string, AgentBurn>()

  record(filePath: string, tokens: number): void {
    if (!filePath || !Number.isFinite(tokens) || tokens <= 0) return
    const now = Date.now()
    let entry = this.agents.get(filePath)
    if (!entry) {
      entry = { samples: [], totalTokens: 0 }
      this.agents.set(filePath, entry)
    }
    this.prune(entry, now)
    entry.samples.push({ t: now, tokens })
    entry.totalTokens += tokens
  }

  getBurn(): FleetBurnResult {
    const now = Date.now()
    const perAgent: Record<string, FleetBurnEntry> = {}
    const fleet: FleetBurnEntry = { tokensPerMin: 0, totalTokens: 0 }

    for (const [filePath, entry] of this.agents) {
      this.prune(entry, now)
      const windowTokens = entry.samples.reduce((sum, s) => sum + s.tokens, 0)
      const burn: FleetBurnEntry = {
        tokensPerMin: windowTokens / WINDOW_MINUTES,
        totalTokens: entry.totalTokens
      }
      perAgent[filePath] = burn
      fleet.tokensPerMin += burn.tokensPerMin
      fleet.totalTokens += burn.totalTokens
    }

    return { perAgent, fleet }
  }

  private prune(entry: AgentBurn, now: number): void {
    const cutoff = now - WINDOW_MS
    let drop = 0
    while (drop < entry.samples.length && entry.samples[drop].t < cutoff) drop++
    if (drop > 0) entry.samples.splice(0, drop)
  }
}

// Singleton instance
let instance: FleetBurnService | null = null

export function getFleetBurnService(): FleetBurnService {
  if (!instance) {
    instance = new FleetBurnService()
  }
  return instance
}
