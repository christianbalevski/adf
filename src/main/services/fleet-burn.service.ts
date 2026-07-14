import type { FleetBurnEntry, FleetBurnResult } from '../../shared/types/ipc.types'

/** Rolling window for tokens-per-minute normalization. */
const WINDOW_MS = 5 * 60 * 1000
const WINDOW_MINUTES = 5

interface BurnSample {
  t: number
  input: number
  output: number
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
 *
 * Input and output are tracked separately: input/min reflects context size ×
 * call frequency (a bloat signal), output/min the actual generation rate (the
 * cost-heavy direction). tokensPerMin stays their sum for ranking.
 */
export class FleetBurnService {
  private agents = new Map<string, AgentBurn>()

  record(filePath: string, input: number, output: number): void {
    if (!filePath) return
    const inTok = Number.isFinite(input) && input > 0 ? input : 0
    const outTok = Number.isFinite(output) && output > 0 ? output : 0
    if (inTok + outTok <= 0) return
    const now = Date.now()
    let entry = this.agents.get(filePath)
    if (!entry) {
      entry = { samples: [], totalTokens: 0 }
      this.agents.set(filePath, entry)
    }
    this.prune(entry, now)
    entry.samples.push({ t: now, input: inTok, output: outTok })
    entry.totalTokens += inTok + outTok
  }

  getBurn(): FleetBurnResult {
    const now = Date.now()
    const perAgent: Record<string, FleetBurnEntry> = {}
    const fleet: FleetBurnEntry = { tokensPerMin: 0, inPerMin: 0, outPerMin: 0, totalTokens: 0 }

    for (const [filePath, entry] of this.agents) {
      this.prune(entry, now)
      let windowIn = 0
      let windowOut = 0
      for (const s of entry.samples) {
        windowIn += s.input
        windowOut += s.output
      }
      const burn: FleetBurnEntry = {
        tokensPerMin: (windowIn + windowOut) / WINDOW_MINUTES,
        inPerMin: windowIn / WINDOW_MINUTES,
        outPerMin: windowOut / WINDOW_MINUTES,
        totalTokens: entry.totalTokens
      }
      perAgent[filePath] = burn
      fleet.tokensPerMin += burn.tokensPerMin
      fleet.inPerMin += burn.inPerMin
      fleet.outPerMin += burn.outPerMin
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
