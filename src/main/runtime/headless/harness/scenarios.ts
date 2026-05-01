import type { MockProviderConfig } from '../mock-provider'

export interface ScenarioConfig {
  name: string
  agents: number
  /** Target turns per agent per minute. The driver enforces this via poisson-style jitter. */
  turnsPerAgentPerMin: number
  /** Total duration in ms. */
  durationMs: number
  /** Provider latency profile. */
  provider: MockProviderConfig
  /** Maximum concurrent turns in flight globally. null = unbounded (current behavior). */
  maxConcurrentTurns?: number | null
  /** Run agents in autonomous mode. Defaults to false so each text response ends a turn. */
  autonomous?: boolean
}

export const scenarios: Record<string, ScenarioConfig> = {
  idle: {
    name: 'idle',
    agents: 50,
    turnsPerAgentPerMin: 0.2,
    durationMs: 60_000,
    provider: { latencyMs: 800, tokensPerResponse: 60 },
  },
  mixed: {
    name: 'mixed',
    agents: 20,
    turnsPerAgentPerMin: 2,
    durationMs: 60_000,
    provider: {
      latencyMs: 1200,
      tokensPerResponse: 200,
      toolCallProbability: 0.4,
      toolCallNames: ['fs_list'],
      maxToolCallStreak: 2,
    },
  },
  heavy: {
    name: 'heavy',
    agents: 10,
    turnsPerAgentPerMin: 6,
    durationMs: 60_000,
    provider: {
      latencyMs: 1500,
      tokensPerResponse: 400,
      toolCallProbability: 0.8,
      toolCallNames: ['fs_list'],
      maxToolCallStreak: 3,
    },
  },
  burst: {
    name: 'burst',
    agents: 30,
    turnsPerAgentPerMin: 120, // everyone fires aggressively for the short duration
    durationMs: 15_000,
    provider: { latencyMs: 800, tokensPerResponse: 100 },
  },
  /** Zero-latency: measures pure runtime overhead, not concurrency. */
  overhead: {
    name: 'overhead',
    agents: 10,
    turnsPerAgentPerMin: 600, // as fast as possible
    durationMs: 10_000,
    provider: { latencyMs: 0, tokensPerResponse: 120 },
  },
}
