import { encode as gptEncode } from 'gpt-tokenizer'
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer'

/**
 * Token counting service that supports multiple providers
 */
export class TokenCounterService {
  /**
   * Count tokens for a given text and provider
   */
  countTokens(text: string, provider: string, model?: string): number {
    if (!text) return 0

    try {
      if (provider === 'anthropic' || provider.startsWith('anthropic')) {
        // Use Anthropic's official tokenizer
        return anthropicCountTokens(text)
      } else if (provider === 'openai' || provider.startsWith('openai') || provider.includes('gpt')) {
        // Use GPT tokenizer
        const tokens = gptEncode(text)
        return tokens.length
      } else {
        // Fallback to GPT tokenizer for unknown providers
        const tokens = gptEncode(text)
        return tokens.length
      }
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
          }
        }
      }
    }
    // ~3.5 chars per token for English (conservative)
    return Math.ceil(totalChars / 3.5)
  }
}

/**
 * Estimate the character length of an object without JSON.stringify allocation.
 */
function estimateObjectChars(obj: unknown): number {
  if (obj == null) return 4
  if (typeof obj === 'string') return obj.length
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
