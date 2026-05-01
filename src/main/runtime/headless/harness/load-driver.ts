import { createDispatch, createEvent } from '../../../../shared/types/adf-event.types'
import type { AdfEventDispatch } from '../../../../shared/types/adf-event.types'

export interface LoadTarget {
  id: string
  executeTurn: (dispatch: AdfEventDispatch) => Promise<void>
}

export interface LoadDriverConfig {
  turnsPerAgentPerMin: number
  /** If set, cap total inflight turns across all agents. */
  maxConcurrent?: number | null
}

/**
 * Drives synthetic turns sequentially per agent: a given agent has at most one
 * turn in flight at any time. After each turn completes, the driver waits
 * ~(60000/turnsPerAgentPerMin) ms with +/-50% jitter before firing the next
 * turn. Different agents run independently (parallelism across agents).
 *
 * This mirrors how real agents behave (a turn finishes before the next trigger
 * arrives for that agent) and avoids pathological interrupt-storm behavior
 * when the trigger rate exceeds the turn completion rate.
 *
 * Use `maxConcurrent` to bound the global in-flight count across all agents.
 */
export class LoadDriver {
  private targets: LoadTarget[]
  private cfg: LoadDriverConfig
  private running = false
  private inflight = 0
  private agentLoops: Promise<void>[] = []
  private wakeSleepers = new Set<() => void>()

  constructor(targets: LoadTarget[], cfg: LoadDriverConfig) {
    this.targets = targets
    this.cfg = cfg
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.agentLoops = this.targets.map(t => this.runAgentLoop(t))
  }

  async stop(): Promise<void> {
    this.running = false
    for (const wake of this.wakeSleepers) wake()
    this.wakeSleepers.clear()
    await Promise.allSettled(this.agentLoops)
  }

  private async runAgentLoop(target: LoadTarget): Promise<void> {
    const meanMs = 60_000 / Math.max(0.001, this.cfg.turnsPerAgentPerMin)
    while (this.running) {
      // Global concurrency gate: if too many turns in flight, wait a bit.
      if (this.cfg.maxConcurrent != null) {
        while (this.running && this.inflight >= this.cfg.maxConcurrent) {
          await this.sleep(5)
        }
        if (!this.running) return
      }

      this.inflight++
      try {
        const dispatch = createDispatch(
          createEvent({
            type: 'chat' as const,
            source: 'system',
            data: {
              message: {
                seq: 0,
                role: 'user' as const,
                content_json: [{ type: 'text', text: `bench ${target.id} ${Date.now()}` }],
                created_at: Date.now(),
              },
            },
          }),
          { scope: 'agent' },
        )
        await target.executeTurn(dispatch).catch(() => { /* metrics layer records errors */ })
      } finally {
        this.inflight--
      }

      if (!this.running) return

      const jitter = (Math.random() * 2 - 1) * 0.5 // +/-50%
      const delay = Math.max(0, meanMs * (1 + jitter))
      if (delay > 0) await this.sleep(delay)
    }
  }

  getInflight(): number { return this.inflight }

  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise(resolve => {
      let wake: () => void
      const t = setTimeout(() => {
        this.wakeSleepers.delete(wake)
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(t)
        this.wakeSleepers.delete(wake)
        resolve()
      }
      this.wakeSleepers.add(wake)
    })
  }
}
