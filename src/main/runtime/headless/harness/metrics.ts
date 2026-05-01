import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { performance } from 'node:perf_hooks'

export interface TurnSample {
  agentId: string
  startedAt: number
  durationMs: number
  error?: string
}

export interface MetricsReport {
  durationMs: number
  turns: {
    total: number
    completed: number
    errored: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
  }
  eventLoopLagNs: {
    p50: number
    p95: number
    p99: number
    max: number
    mean: number
  }
  memory: {
    rssPeakMb: number
    rssAvgMb: number
    heapUsedPeakMb: number
    heapUsedAvgMb: number
    samples: number
  }
  handles: {
    activeIntervalsPeak: number
    activeTimeoutsPeak: number
  }
  timestamp: string
}

export class MetricsCollector {
  private turns: TurnSample[] = []
  private eloop: IntervalHistogram | null = null
  private memSamples: { rss: number; heapUsed: number }[] = []
  private memTimer: NodeJS.Timeout | null = null
  private handlesTimer: NodeJS.Timeout | null = null
  private activeIntervalsPeak = 0
  private activeTimeoutsPeak = 0
  private startedAt = 0

  start(memSampleMs = 1000): void {
    this.startedAt = performance.now()
    this.eloop = monitorEventLoopDelay({ resolution: 10 })
    this.eloop.enable()

    this.memTimer = setInterval(() => {
      const m = process.memoryUsage()
      this.memSamples.push({ rss: m.rss, heapUsed: m.heapUsed })
    }, memSampleMs)

    this.handlesTimer = setInterval(() => this.sampleHandles(), 500)
  }

  stop(): MetricsReport {
    this.eloop?.disable()
    if (this.memTimer) { clearInterval(this.memTimer); this.memTimer = null }
    if (this.handlesTimer) { clearInterval(this.handlesTimer); this.handlesTimer = null }

    const durationMs = performance.now() - this.startedAt
    return this.report(durationMs)
  }

  recordTurn(sample: TurnSample): void {
    this.turns.push(sample)
  }

  /** Instrument an executor's executeTurn to capture timing. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapExecutor(agentId: string, executor: any): void {
    const original = executor.executeTurn.bind(executor)
    const collector = this
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor.executeTurn = async function (...args: any[]) {
      const startedAt = performance.now()
      try {
        await original(...args)
        collector.recordTurn({ agentId, startedAt, durationMs: performance.now() - startedAt })
      } catch (err) {
        collector.recordTurn({
          agentId,
          startedAt,
          durationMs: performance.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private sampleHandles(): void {
    // _getActiveHandles / _getActiveResources are internal but widely used for diagnostics.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getHandles = (process as any)._getActiveHandles?.bind(process)
    if (!getHandles) return
    const handles = getHandles() as Array<{ constructor?: { name?: string } }>
    let intervals = 0
    let timeouts = 0
    for (const h of handles) {
      const n = h?.constructor?.name
      if (n === 'Timeout') timeouts++
      if (n === 'Immediate') continue
    }
    // Node's timer handles: setInterval and setTimeout both appear as "Timeout".
    // We can't easily distinguish them from the handle object alone without
    // reading _repeat, which is brittle. Report the combined count.
    if (timeouts > this.activeTimeoutsPeak) this.activeTimeoutsPeak = timeouts
    if (intervals > this.activeIntervalsPeak) this.activeIntervalsPeak = intervals
  }

  private report(durationMs: number): MetricsReport {
    const durations = this.turns.filter(t => !t.error).map(t => t.durationMs).sort((a, b) => a - b)
    const pct = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] : 0

    const rssSum = this.memSamples.reduce((s, m) => s + m.rss, 0)
    const heapSum = this.memSamples.reduce((s, m) => s + m.heapUsed, 0)
    const rssPeak = this.memSamples.reduce((m, s) => Math.max(m, s.rss), 0)
    const heapPeak = this.memSamples.reduce((m, s) => Math.max(m, s.heapUsed), 0)
    const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10

    const eh = this.eloop
    return {
      durationMs: Math.round(durationMs),
      turns: {
        total: this.turns.length,
        completed: durations.length,
        errored: this.turns.length - durations.length,
        p50Ms: Math.round(pct(0.5)),
        p95Ms: Math.round(pct(0.95)),
        p99Ms: Math.round(pct(0.99)),
        maxMs: Math.round(durations[durations.length - 1] ?? 0),
      },
      eventLoopLagNs: {
        p50: eh ? eh.percentile(50) : 0,
        p95: eh ? eh.percentile(95) : 0,
        p99: eh ? eh.percentile(99) : 0,
        max: eh ? eh.max : 0,
        mean: eh ? Math.round(eh.mean) : 0,
      },
      memory: {
        rssPeakMb: mb(rssPeak),
        rssAvgMb: this.memSamples.length ? mb(rssSum / this.memSamples.length) : 0,
        heapUsedPeakMb: mb(heapPeak),
        heapUsedAvgMb: this.memSamples.length ? mb(heapSum / this.memSamples.length) : 0,
        samples: this.memSamples.length,
      },
      handles: {
        activeIntervalsPeak: this.activeIntervalsPeak,
        activeTimeoutsPeak: this.activeTimeoutsPeak,
      },
      timestamp: new Date().toISOString(),
    }
  }
}
