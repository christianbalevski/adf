// One loop's context usage (Studio's context breakdown modal; the terminal
// app's /context).
//
//   GET /agents/:id/context?loop=&items=
//
// The measurement is the loop executor's own getContextBreakdown() (system
// prompt and tool schemas via the provider tokenizer, cached per rebuild;
// messages and dynamic instructions estimated per read). This module adds what
// clients derive from it: the compact threshold that loop auto-compacts at and
// the breakdown split into non-overlapping categories with their biggest items.

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ContextBreakdown } from '../../shared/types/ipc.types'
import {
  contextCategories,
  contextTotal,
  resolveCompactThreshold,
  type CompactThresholdSource,
  type ContextCategory,
} from '../../shared/utils/context-breakdown'
import { RuntimeLoopError } from '../runtime/runtime-service'

/** Structural subset of RuntimeService these routes use. */
export interface ContextRouteRuntime {
  getAgent(agentId: string): unknown
  getAgentContextBreakdown(agentId: string, loop?: string): { agentId: string; loop: string; config: AgentConfig; breakdown: ContextBreakdown | null }
}

export interface AgentContextResult {
  agentId: string
  loop: string
  /** False when the loop has no live executor (disabled, never woken, idle-swept): nothing to measure. */
  available: boolean
  /** The model this loop thinks with (the loop's override, else the agent's). */
  model: { provider: string | null; modelId: string | null }
  /** The point this loop auto-compacts at, and where that number comes from. */
  compactThreshold: number
  compactThresholdSource: CompactThresholdSource
  /** The agent's (host loop's) threshold, for comparison with a loop override. */
  agentCompactThreshold: number
  /** What the next request would carry (sum of categories); null when unavailable. */
  totalTokens: number | null
  /** totalTokens / compactThreshold, rounded percent; null when unavailable. */
  percent: number | null
  /** Non-overlapping, biggest first, summing to totalTokens. */
  categories: ContextCategory[]
  /** The executor's raw figures (Studio's ContextBreakdown shape). */
  breakdown: ContextBreakdown | null
}

const DEFAULT_ITEMS = 12
const MAX_ITEMS = 200

export function buildAgentContext(
  input: { agentId: string; loop: string; config: AgentConfig; breakdown: ContextBreakdown | null },
  maxItems = DEFAULT_ITEMS,
): AgentContextResult {
  const { config, breakdown, loop } = input
  const threshold = resolveCompactThreshold(config, loop)
  const declared = loop === 'main' ? undefined : config.loops?.find(l => l.name === loop)
  const model = declared?.model ?? config.model
  const total = breakdown ? contextTotal(breakdown) : null
  return {
    agentId: input.agentId,
    loop,
    available: breakdown !== null,
    model: { provider: model?.provider ?? null, modelId: model?.model_id ?? null },
    compactThreshold: threshold.value,
    compactThresholdSource: threshold.source,
    agentCompactThreshold: resolveCompactThreshold(config).value,
    totalTokens: total,
    percent: total === null ? null : Math.round((total / Math.max(1, threshold.value)) * 100),
    categories: breakdown ? contextCategories(breakdown, maxItems) : [],
    breakdown,
  }
}

export function registerContextRoutes(server: FastifyInstance, runtime: ContextRouteRuntime): void {
  server.get<{ Params: { id: string }; Querystring: { loop?: string; items?: string } }>('/agents/:id/context', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return reply.code(404).send({ error: `Unknown agent "${request.params.id}"` })
    let items = DEFAULT_ITEMS
    if (request.query.items !== undefined) {
      const n = Number(request.query.items)
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'items must be a non-negative integer' })
      items = Math.min(n, MAX_ITEMS)
    }
    try {
      return buildAgentContext(runtime.getAgentContextBreakdown(request.params.id, request.query.loop || undefined), items)
    } catch (err) {
      return fail(reply, err)
    }
  })
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof RuntimeLoopError) return reply.code(err.statusCode).send({ error: err.message })
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
