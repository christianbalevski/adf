/** Reasoning/thinking effort levels, normalized across providers (OpenAI-style). */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Provider-agnostic reasoning ("thinking") configuration. Normalized by the
 * provider layer into each provider's native shape (Anthropic budgetTokens,
 * OpenRouter `reasoning`, OpenAI reasoningEffort).
 */
export interface ReasoningConfig {
  /** Enable reasoning. Inferred true when effort/max_tokens is set. */
  enabled?: boolean
  /** Effort level. Used directly by OpenAI/OpenRouter; mapped to a budget for Anthropic. */
  effort?: ReasoningEffort
  /** Explicit reasoning token budget (Anthropic/Gemini-style). Takes precedence over effort. */
  max_tokens?: number
  /** Use reasoning internally but exclude the trace from the response. */
  exclude?: boolean
  /** Round-trip reasoning_details (incl. encrypted/signature blocks) across tool-call turns. */
  preserve?: boolean
}

/** Which native reasoning mapping a provider uses. Set by the provider factory. */
export type ReasoningStyle = 'anthropic' | 'openrouter' | 'openai' | 'none'

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image_url' | 'input_audio' | 'video_url'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
  is_error?: boolean
  /**
   * Structured reasoning detail objects (OpenRouter `reasoning_details` shape:
   * reasoning.text/summary/encrypted with format/signature/data). Persisted on
   * the thinking block so it can be round-tripped to the provider on the next
   * tool-call turn. See [[project_openrouter_first_class]].
   */
  reasoning_details?: unknown[]
  // Multimodal: image data as data URI (OpenAI-compatible format)
  image_url?: { url: string }
  // Multimodal: audio data with format hint (OpenAI-compatible format)
  input_audio?: { data: string; format: string }
  // Multimodal: video data as data URI (OpenAI-compatible format)
  video_url?: { url: string }
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  created_at?: number
}

export interface LLMResponse {
  id: string
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: {
    input_tokens: number
    output_tokens: number
  }
  /** Provider-specific metadata (e.g. rate limit headers from ChatGPT subscription). */
  providerMetadata?: Record<string, unknown>
}
