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
