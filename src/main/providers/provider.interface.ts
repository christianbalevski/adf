import type { LLMMessage, LLMResponse, ReasoningConfig } from '../../shared/types/provider.types'
import type { ToolProviderFormat } from '../../shared/types/tool.types'
import type { ProviderType } from '../../shared/constants/adf-defaults'

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
  /** @deprecated Use `reasoning.max_tokens`. Still honored as a legacy Anthropic budget. */
  thinkingBudget?: number
  /** Provider-agnostic reasoning config; normalized per provider via reasoningStyle. */
  reasoning?: ReasoningConfig
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
  /** Settings key of the provider entry (opaque, e.g. `custom:abc123`). */
  readonly providerId?: string
  /** Which factory family built this provider — the only reliable way to
   *  branch on provider semantics, since providerId is an opaque key. */
  readonly providerType?: ProviderType
  readonly modelId: string

  createMessage(options: CreateMessageOptions): Promise<LLMResponse>
  validateConfig(): Promise<{ valid: boolean; error?: string }>
}
