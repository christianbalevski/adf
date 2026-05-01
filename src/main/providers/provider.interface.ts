import type { LLMMessage, LLMResponse } from '../../shared/types/provider.types'
import type { ToolProviderFormat } from '../../shared/types/tool.types'

export interface CreateMessageOptions {
  system: string
  messages: LLMMessage[]
  tools?: ToolProviderFormat[]
  maxTokens?: number
  temperature?: number
  topP?: number
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onThinkingDelta?: (delta: string) => void
  thinkingBudget?: number
  /** Per-turn dynamic instructions injected as a trailing user message.
   *  Kept separate from `system` so the system prompt remains stable for prompt caching. */
  dynamicInstructions?: string
  /** Provider-specific options forwarded as providerOptions to the AI SDK. */
  providerParams?: Record<string, unknown>
}

/**
 * Abstract interface that all LLM providers must implement.
 */
export interface LLMProvider {
  readonly name: string
  readonly providerId?: string
  readonly modelId: string

  createMessage(options: CreateMessageOptions): Promise<LLMResponse>
  validateConfig(): Promise<{ valid: boolean; error?: string }>
}
