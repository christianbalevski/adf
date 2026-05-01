import { nanoid } from 'nanoid'
import type { LLMProvider, CreateMessageOptions } from '../../providers/provider.interface'
import type { LLMResponse, ContentBlock } from '../../../shared/types/provider.types'

export interface MockProviderConfig {
  /** Fixed latency in ms, or a function that returns latency per call (e.g. for p50/p99 distributions). */
  latencyMs?: number | (() => number)
  /** Approximate output token count. Drives history growth rate. */
  tokensPerResponse?: number
  /** 0.0-1.0 probability that a given response includes a tool_use block. */
  toolCallProbability?: number
  /** Names of tools to invoke when tool-calling. Filtered against the tools actually available to the turn. */
  toolCallNames?: string[]
  /** If true, emit onTextDelta callbacks to simulate streaming. */
  streamDeltas?: boolean
  /** Max consecutive tool-use turns before we force an end_turn response. Prevents infinite loops. */
  maxToolCallStreak?: number
}

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock'
  readonly modelId = 'mock-v1'
  private cfg: Required<MockProviderConfig>
  private callCount = 0
  private toolCallStreak = 0

  constructor(cfg: MockProviderConfig = {}) {
    this.cfg = {
      latencyMs: cfg.latencyMs ?? 0,
      tokensPerResponse: cfg.tokensPerResponse ?? 100,
      toolCallProbability: cfg.toolCallProbability ?? 0,
      toolCallNames: cfg.toolCallNames ?? [],
      streamDeltas: cfg.streamDeltas ?? false,
      maxToolCallStreak: cfg.maxToolCallStreak ?? 3,
    }
  }

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.callCount++
    const latency = typeof this.cfg.latencyMs === 'function' ? this.cfg.latencyMs() : this.cfg.latencyMs

    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, latency)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('mock-provider aborted'))
        }, { once: true })
      })
    }

    const availableTools = new Set((opts.tools ?? []).map(t => t.name))
    const candidateTool = this.cfg.toolCallNames.find(n => availableTools.has(n))
    const rollToolCall = this.cfg.toolCallProbability > 0 && candidateTool != null && Math.random() < this.cfg.toolCallProbability
    const willToolCall = rollToolCall && this.toolCallStreak < this.cfg.maxToolCallStreak

    if (willToolCall && candidateTool) {
      this.toolCallStreak++
      const block: ContentBlock = {
        type: 'tool_use',
        id: `mock-tu-${this.callCount}-${nanoid(6)}`,
        name: candidateTool,
        input: { _reason: 'mock tool call' }
      }
      return {
        id: `mock-msg-${this.callCount}-${nanoid(6)}`,
        content: [block],
        stop_reason: 'tool_use',
        usage: { input_tokens: Math.floor(this.cfg.tokensPerResponse / 2), output_tokens: 20 }
      }
    }

    this.toolCallStreak = 0
    const words = Math.max(1, Math.floor(this.cfg.tokensPerResponse / 1.3))
    const text = `mock-${this.callCount} `.repeat(words).trim()

    if (this.cfg.streamDeltas && opts.onTextDelta) {
      const chunkSize = Math.max(1, Math.ceil(text.length / 8))
      for (let i = 0; i < text.length; i += chunkSize) {
        opts.onTextDelta(text.slice(i, i + chunkSize))
      }
    }

    return {
      id: `mock-msg-${this.callCount}-${nanoid(6)}`,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: this.cfg.tokensPerResponse, output_tokens: this.cfg.tokensPerResponse }
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }

  getCallCount(): number {
    return this.callCount
  }

  reset(): void {
    this.callCount = 0
    this.toolCallStreak = 0
  }
}
