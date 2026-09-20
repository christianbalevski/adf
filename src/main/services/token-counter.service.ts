import { createRequire } from 'node:module'
import { PROVIDER_TYPES, type ProviderType } from '../../shared/constants/adf-defaults'

export type TokenizerFamily = 'anthropic' | 'gpt'

const PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(PROVIDER_TYPES.map((p) => p.type))

// Both tokenizers load a multi-MB BPE table (and WASM) at import time — ~100ms
// on the main thread before the first window paints, for a service most
// sessions only reach after the first model call. Loaded on first use instead.
// countTokens is sync and called from hot paths, so this is a sync require
// rather than a dynamic import (main is bundled CJS with deps externalized).
const _require = createRequire(import.meta.url)

let gptEncodeFn: ((text: string) => unknown[]) | null = null
let anthropicCountFn: ((text: string) => number) | null = null

function gptEncode(text: string): unknown[] {
  if (!gptEncodeFn) {
    gptEncodeFn = (_require('gpt-tokenizer') as typeof import('gpt-tokenizer')).encode
  }
  return gptEncodeFn(text)
}

function anthropicCountTokens(text: string): number {
  if (!anthropicCountFn) {
    anthropicCountFn = (_require('@anthropic-ai/tokenizer') as typeof import('@anthropic-ai/tokenizer')).countTokens
  }
  return anthropicCountFn(text)
}

/**
 * Token counting service that supports multiple providers
 */
export class TokenCounterService {
  /** Settings key (or display name) → factory family, registered by provider-factory. */
  private providerTypesByKey = new Map<string, ProviderType>()

  /**
   * Teach the counter which family a provider settings key belongs to.
   * Settings keys are opaque (`custom:abc123`), so callers that only hold the
   * key can still get the right tokenizer once the provider has been built.
   */
  registerProviderType(key: string | undefined, type: ProviderType): void {
    if (key) this.providerTypesByKey.set(key, type)
  }

  /**
   * Pick the tokenizer for a provider. `provider` may be a ProviderType
   * literal, a registered settings key / display name, or anything else (then
   * the model name decides, defaulting to the GPT tokenizer).
   */
  resolveTokenizer(provider: string, model?: string): TokenizerFamily {
    const type: ProviderType | undefined =
      this.providerTypesByKey.get(provider) ??
      (PROVIDER_TYPE_SET.has(provider) ? (provider as ProviderType) : undefined)
    const modelLooksClaude = !!model && model.toLowerCase().includes('claude')
    switch (type) {
      case 'anthropic':
        return 'anthropic'
      case 'openai':
      case 'chatgpt-subscription':
      case 'grok-subscription':
        return 'gpt'
      case 'openrouter':
      case 'openai-compatible':
        // Aggregators serve every family; the model name is the only signal.
        return modelLooksClaude ? 'anthropic' : 'gpt'
      default:
        // Unknown key: legacy prefix heuristic, then model name, then GPT.
        if (provider.startsWith('anthropic') || modelLooksClaude) return 'anthropic'
        return 'gpt'
    }
  }

  /**
   * Count tokens for a given text. `provider` is a ProviderType, a provider
   * settings key, or a display name — see resolveTokenizer.
   */
  countTokens(text: string, provider: string, model?: string): number {
    if (!text) return 0

    try {
      if (this.resolveTokenizer(provider, model) === 'anthropic') {
        return anthropicCountTokens(text)
      }
      return gptEncode(text).length
    } catch (err) {
      console.warn(`[TokenCounter] Error counting tokens for provider ${provider}:`, err)
      // Fallback to rough estimate: ~4 characters per token
      return Math.ceil(text.length / 4)
    }
  }

  /**
   * Count tokens for a list of messages (chat history)
   */
  countMessagesTokens(messages: Array<{ role: string; content: any }>, provider: string, model?: string): number {
    let total = 0

    for (const msg of messages) {
      // Add role tokens (roughly 4 tokens per message for role formatting)
      total += 4

      // Count content tokens
      if (typeof msg.content === 'string') {
        total += this.countTokens(msg.content, provider, model)
      } else if (Array.isArray(msg.content)) {
        // Content blocks (like tool_use, tool_result, etc.)
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            total += this.countTokens(block.text, provider, model)
          } else if (block.type === 'tool_use') {
            total += this.countTokens(JSON.stringify(block.input), provider, model)
            total += this.countTokens(block.name, provider, model)
          } else if (block.type === 'tool_result') {
            total += this.countTokens(String(block.content), provider, model)
          }
        }
      }
    }

    return total
  }

  /**
   * Get the context limit for a model (in tokens)
   * Returns conservative estimates
   */
  getModelContextLimit(provider: string, model: string): number {
    // Anthropic models
    if (provider === 'anthropic') {
      if (model.includes('opus')) return 200000
      if (model.includes('sonnet')) return 200000
      if (model.includes('haiku')) return 200000
      return 200000 // Default for Anthropic
    }

    // OpenAI models
    if (provider === 'openai' || provider.includes('gpt')) {
      if (model.includes('gpt-4-turbo')) return 128000
      if (model.includes('gpt-4')) return 8192
      if (model.includes('gpt-3.5-turbo-16k')) return 16384
      if (model.includes('gpt-3.5')) return 4096
      return 8192 // Default
    }

    // Default fallback
    return 100000
  }

  /**
   * Calculate the recommended compaction threshold (80% of context limit)
   */
  getRecommendedCompactionThreshold(provider: string, model: string): number {
    const contextLimit = this.getModelContextLimit(provider, model)
    return Math.floor(contextLimit * 0.8)
  }

  /**
   * Fast token estimate using character length.
   * Accuracy: ±10% for English text, good enough for threshold checks.
   * Cost: O(n) string length reads, no WASM, no allocations.
   */
  estimateMessagesTokens(messages: Array<{ role: string; content: any }>): number {
    let totalChars = 0
    // Binary payloads (data URIs, base64 audio) are counted separately: they
    // are ~30× less token-dense than prose, so folding them into totalChars
    // would inflate a single 2MB image to ~570k tokens and make the
    // auto-compact gate fire forever. See MEDIA_CHARS_PER_TOKEN.
    let mediaChars = 0

    for (const msg of messages) {
      totalChars += 16 // role overhead ~4 tokens × ~4 chars
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            totalChars += block.text.length
          } else if (block.type === 'tool_use') {
            totalChars += (block.name?.length ?? 0)
            totalChars += estimateObjectChars(block.input)
          } else if (block.type === 'tool_result') {
            totalChars += String(block.content ?? '').length
          } else if (block.type === 'thinking') {
            // Reasoning text is real context on the next turn, and preserved
            // reasoning_details (encrypted blobs) are round-tripped verbatim.
            totalChars += (block.thinking?.length ?? 0)
            if (block.reasoning_details) {
              totalChars += estimateObjectChars(block.reasoning_details)
            }
          } else if (block.type === 'image_url') {
            mediaChars += (block.image_url?.url?.length ?? 0)
          } else if (block.type === 'input_audio') {
            mediaChars += (block.input_audio?.data?.length ?? 0)
            totalChars += (block.input_audio?.format?.length ?? 0)
          } else if (block.type === 'video_url') {
            mediaChars += (block.video_url?.url?.length ?? 0)
          }
        }
      }
    }
    // ~3.5 chars per token for English (conservative)
    return Math.ceil(totalChars / 3.5) + Math.ceil(mediaChars / MEDIA_CHARS_PER_TOKEN)
  }
}

/**
 * Chars of base64/data-URI payload per token. Multimodal models tokenize
 * images/audio by patches, not by characters: a ~1024×1024 JPEG is ~1-1.5k
 * tokens but ~140k base64 chars (~100 chars/token). Deliberately on the high
 * side of real cost — over-estimating compacts earlier, which is safe — while
 * staying far away from the pathological chars/3.5 figure that would treat one
 * pasted screenshot as an entire context window.
 */
const MEDIA_CHARS_PER_TOKEN = 100

/**
 * Estimate the character length of an object without JSON.stringify allocation.
 */
function estimateObjectChars(obj: unknown): number {
  if (obj == null) return 4
  // +2 for the surrounding JSON quotes; escape sequences add more, so this is
  // still a floor (deliberately — under-counting inputs is what we're fixing).
  if (typeof obj === 'string') return obj.length + 2
  if (typeof obj === 'number' || typeof obj === 'boolean') return 5
  if (Array.isArray(obj)) {
    let sum = 2
    for (const item of obj) sum += estimateObjectChars(item) + 1
    return sum
  }
  if (typeof obj === 'object') {
    let sum = 2
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      sum += key.length + estimateObjectChars((obj as Record<string, unknown>)[key]) + 2
    }
    return sum
  }
  return 10
}

// Singleton instance
let instance: TokenCounterService | null = null

export function getTokenCounterService(): TokenCounterService {
  if (!instance) {
    instance = new TokenCounterService()
  }
  return instance
}
