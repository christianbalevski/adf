import { MockLLMProvider } from '../mock-provider'
import { RuntimeService } from '../../runtime-service'
import { MetricsCollector, type MetricsReport } from './metrics'
import { LoadDriver } from './load-driver'
import type { ScenarioConfig } from './scenarios'

export interface HarnessResult {
  scenario: string
  config: ScenarioConfig
  metrics: MetricsReport
  providerCallCount: number
}

/**
 * Run a scenario end-to-end: spin up N headless agents, drive synthetic traffic,
 * collect metrics, tear down. Returns a structured report.
 */
export async function runHarness(scenario: ScenarioConfig): Promise<HarnessResult> {
  const collector = new MetricsCollector()
  const runtime = new RuntimeService({ enforceReviewGate: false })

  const agentIds: string[] = []
  const targets: Array<{ id: string; executeTurn: (dispatch: Parameters<RuntimeService['trigger']>[1]) => Promise<void> }> = []
  const providers: MockLLMProvider[] = []
  for (let i = 0; i < scenario.agents; i++) {
    const id = `bench-${i}`
    const provider = new MockLLMProvider(scenario.provider)
    const ref = runtime.createAgent({
      name: id,
      provider,
      createOptions: { autonomous: scenario.autonomous ?? false },
    })
    const target = {
      id,
      executeTurn: (dispatch: Parameters<RuntimeService['trigger']>[1]) => runtime.trigger(ref.id, dispatch),
    }
    collector.wrapExecutor(id, target)
    agentIds.push(ref.id)
    targets.push(target)
    providers.push(provider)
  }

  const driver = new LoadDriver(
    targets,
    {
      turnsPerAgentPerMin: scenario.turnsPerAgentPerMin,
      maxConcurrent: scenario.maxConcurrentTurns,
    },
  )

  collector.start()
  driver.start()

  await new Promise<void>(resolve => setTimeout(resolve, scenario.durationMs))

  await driver.stop()
  const metrics = collector.stop()

  await Promise.all(agentIds.map(id => runtime.unloadAgent(id)))

  return {
    scenario: scenario.name,
    config: scenario,
    metrics,
    providerCallCount: providers.reduce((sum, provider) => sum + provider.getCallCount(), 0),
  }
}

/** Compact single-line summary, suitable for CI logs or stdout. */
export function formatReport(result: HarnessResult): string {
  const m = result.metrics
  const ms = (ns: number) => Math.round(ns / 1_000_000)
  return [
    `[${result.scenario}] agents=${result.config.agents} dur=${m.durationMs}ms turns=${m.turns.completed}/${m.turns.total} (err=${m.turns.errored})`,
    `  turn p50/p95/p99/max: ${m.turns.p50Ms}/${m.turns.p95Ms}/${m.turns.p99Ms}/${m.turns.maxMs} ms`,
    `  evloop lag p50/p95/p99/max: ${ms(m.eventLoopLagNs.p50)}/${ms(m.eventLoopLagNs.p95)}/${ms(m.eventLoopLagNs.p99)}/${ms(m.eventLoopLagNs.max)} ms`,
    `  rss peak/avg: ${m.memory.rssPeakMb}/${m.memory.rssAvgMb} MB  heap peak/avg: ${m.memory.heapUsedPeakMb}/${m.memory.heapUsedAvgMb} MB`,
    `  timer handles peak: ${m.handles.activeTimeoutsPeak}  provider calls: ${result.providerCallCount}`,
  ].join('\n')
}
