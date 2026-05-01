import type { LLMProvider, CreateMessageOptions } from '../providers/provider.interface'
import type { LLMResponse } from '../../shared/types/provider.types'
import type { LlmCallEventData, LlmCallMetadata } from '../../shared/types/adf-event.types'
import type { LoopTokenUsage } from '../../shared/types/adf-v02.types'
import { estimateLlmCallCostUsd } from './llm-pricing'

export interface LlmCallResult {
  response: LLMResponse
  metadata: LlmCallMetadata
}

export async function callLlmWithMetadata(
  provider: LLMProvider,
  options: CreateMessageOptions,
): Promise<LlmCallResult> {
  const startMs = Date.now()
  try {
    const response = await provider.createMessage(options)
    const durationMs = Date.now() - startMs
    return {
      response,
      metadata: buildLlmCallMetadata(provider, response, durationMs),
    }
  } catch (error) {
    const durationMs = Date.now() - startMs
    const metadata: LlmCallMetadata = {
      provider: provider.providerId ?? provider.name,
      model: provider.modelId,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: durationMs,
      stop_reason: 'error',
    }
    attachLlmCallMetadata(error, metadata)
    throw error
  }
}

export function getAttachedLlmCallMetadata(error: unknown): LlmCallMetadata | undefined {
  if (!error || typeof error !== 'object') return undefined
  return (error as { llmCallMetadata?: LlmCallMetadata }).llmCallMetadata
}

export function toLlmCallEventData(
  metadata: LlmCallMetadata,
  source: LlmCallEventData['source'],
  extra?: Pick<LlmCallEventData, 'turn_id'>,
): LlmCallEventData {
  const cost = estimateLlmCallCostUsd(metadata)
  return {
    ...metadata,
    source,
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    ...(extra?.turn_id ? { turn_id: extra.turn_id } : {}),
  }
}

export function loopTokensFromLlmMetadata(metadata: LlmCallMetadata): LoopTokenUsage {
  return {
    input: metadata.input_tokens,
    output: metadata.output_tokens,
    ...(metadata.cache_read_tokens !== undefined ? { cache_read: metadata.cache_read_tokens } : {}),
    ...(metadata.cache_write_tokens !== undefined ? { cache_write: metadata.cache_write_tokens } : {}),
    ...(metadata.reasoning_tokens !== undefined ? { reasoning: metadata.reasoning_tokens } : {}),
  }
}

export function buildLlmCallMetadata(
  provider: LLMProvider,
  response: LLMResponse,
  durationMs: number,
): LlmCallMetadata {
  const providerMetadata = response.providerMetadata
  return {
    provider: provider.providerId ?? provider.name,
    model: provider.modelId,
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_read_tokens: extractCacheRead(providerMetadata),
    cache_write_tokens: extractCacheWrite(providerMetadata),
    reasoning_tokens: extractReasoning(providerMetadata),
    duration_ms: durationMs,
    stop_reason: normalizeFinishReason(response.stop_reason),
  }
}

export function extractCacheRead(providerMetadata?: Record<string, unknown>): number | undefined {
  return firstNumber(
    readPath(providerMetadata, ['adf', 'cacheReadTokens']),
    readPath(providerMetadata, ['anthropic', 'cacheReadInputTokens']),
    readPath(providerMetadata, ['openai', 'cachedPromptTokens']),
    readPath(providerMetadata, ['openai', 'cachedInputTokens']),
  )
}

export function extractCacheWrite(providerMetadata?: Record<string, unknown>): number | undefined {
  return firstNumber(
    readPath(providerMetadata, ['adf', 'cacheWriteTokens']),
    readPath(providerMetadata, ['anthropic', 'cacheCreationInputTokens']),
  )
}

export function extractReasoning(providerMetadata?: Record<string, unknown>): number | undefined {
  return firstNumber(
    readPath(providerMetadata, ['adf', 'reasoningTokens']),
    readPath(providerMetadata, ['openai', 'reasoningTokens']),
  )
}

export function normalizeFinishReason(reason: string | undefined): LlmCallMetadata['stop_reason'] {
  switch (reason) {
    case 'tool-calls':
    case 'tool_use':
      return 'tool_use'
    case 'length':
    case 'max_tokens':
      return 'max_tokens'
    case 'error':
      return 'error'
    case 'stop':
    case 'stop_sequence':
    case 'end_turn':
    default:
      return 'end_turn'
  }
}

function attachLlmCallMetadata(error: unknown, metadata: LlmCallMetadata): void {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, 'llmCallMetadata', {
        value: metadata,
        configurable: true,
      })
    } catch { /* non-fatal */ }
  }
}

function readPath(root: unknown, path: string[]): unknown {
  let current = root
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}
