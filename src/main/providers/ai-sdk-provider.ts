import { streamText, generateText, jsonSchema, type LanguageModel, type ToolSet } from 'ai'
import type { LLMProvider, CreateMessageOptions } from './provider.interface'
import type { LLMResponse, ContentBlock, LLMMessage } from '../../shared/types/provider.types'
import type { ToolProviderFormat } from '../../shared/types/tool.types'
import { getTokenCounterService } from '../services/token-counter.service'
import { logger } from '../utils/logger'

/** Extract a human-readable message from any thrown error shape. */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    try { return JSON.stringify(error) } catch { /* fall through */ }
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// Video bypass: The AI SDK doesn't support video content parts. We work around
// this by extracting video markers from CoreMessages before SDK validation,
// then wrapping the LanguageModel to inject raw OpenAI-format video_url parts
// into the HTTP request body at the provider level.
// ---------------------------------------------------------------------------

/**
 * Scan CoreMessages for __adf_video marker parts (injected by extractMediaParts).
 * Remove them so SDK validation passes; return the video URLs for later injection.
 */
function extractAndStripVideoFromMessages(messages: CoreMessage[]): string[] {
  const videoUrls: string[] = []
  for (const msg of messages as any[]) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const stripped: unknown[] = []
    for (const part of msg.content) {
      if (part?.type === '__adf_video') {
        videoUrls.push(part.url)
      } else {
        stripped.push(part)
      }
    }
    if (stripped.length !== msg.content.length) {
      msg.content = stripped.length > 0 ? stripped : [{ type: 'text', text: '[video attached]' }]
    }
  }
  return videoUrls
}

/**
 * Wrap a LanguageModel to inject raw video_url parts into the HTTP request body.
 * The AI SDK doesn't support video content natively (the openai-compatible
 * provider throws on video/* media types). This wrapper intercepts
 * doGenerate/doStream by patching the model's transformRequestBody to inject
 * raw OpenAI-format video_url parts into the last user message before the
 * request is sent. This works for any provider that supports the OpenAI
 * chat completions format (OpenRouter, Gemini, etc.).
 */
function wrapModelWithVideo(model: LanguageModel, videoUrls: string[]): LanguageModel {
  const patchBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const messages = body.messages as Array<Record<string, unknown>> | undefined
    if (!messages) return body
    // Find the last user message and inject video parts
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const msg = messages[i]
        if (!Array.isArray(msg.content)) {
          msg.content = [{ type: 'text', text: msg.content as string }]
        }
        for (const url of videoUrls) {
          ;(msg.content as unknown[]).push({ type: 'video_url', video_url: { url } })
        }
        break
      }
    }
    return body
  }

  return new Proxy(model as any, {
    get(target: any, prop, receiver) {
      if (prop === 'doGenerate' || prop === 'doStream') {
        const original = Reflect.get(target, prop, receiver) as Function
        return async function(this: unknown, options: any) {
          const origTransform = target.transformRequestBody
          target.transformRequestBody = (body: Record<string, unknown>) => {
            const transformed = origTransform ? origTransform.call(target, body) : body
            return patchBody(transformed as Record<string, unknown>)
          }
          try {
            return await original.call(target, options)
          } finally {
            target.transformRequestBody = origTransform
          }
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as LanguageModel
}

export interface AiSdkProviderOptions {
  /** Stable config provider id, distinct from the user-facing display name. */
  providerId?: string
  /** Merged into providerOptions on every call (e.g. { openai: { store: false } }) */
  defaultProviderOptions?: Record<string, Record<string, unknown>>
  /** If set, merges CreateMessageOptions.providerParams into providerOptions[key] */
  forwardProviderParams?: string
  /** Called before each request with the system prompt — used by providers
   *  whose fetch wrapper needs to inject it into the request body. */
  onBeforeRequest?: (system: string | undefined) => void
  /** Skip validateConfig preflight (provider only supports streaming). */
  streamOnly?: boolean
  /** Called after each request to retrieve provider-specific metadata (e.g. rate limit headers). */
  getResponseMeta?: () => Record<string, unknown> | undefined
}

/**
 * Single LLM provider adapter that wraps any Vercel AI SDK LanguageModel.
 * Implements the ADF LLMProvider interface so all call sites (agent-executor,
 * background-agent-manager, ipc/index) remain unchanged.
 */
export class AiSdkProvider implements LLMProvider {
  readonly name: string
  readonly providerId?: string
  readonly modelId: string

  private model: LanguageModel
  private requestDelayMs: number
  private options?: AiSdkProviderOptions

  constructor(model: LanguageModel, name: string, modelId: string, requestDelayMs = 0, options?: AiSdkProviderOptions) {
    this.model = model
    this.name = name
    this.providerId = options?.providerId ?? name
    this.modelId = modelId
    this.requestDelayMs = requestDelayMs
    this.options = options
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    let messages = convertMessages(options.messages)
    // Append dynamic instructions as a trailing user message so the system
    // prompt stays stable and provider-side prompt caching is preserved.
    if (options.dynamicInstructions) {
      messages = [...messages, { role: 'user', content: options.dynamicInstructions } as CoreMessage]
    }
    const tools = options.tools?.length ? convertTools(options.tools) : undefined

    const useThinking = options.thinkingBudget && options.thinkingBudget > 0

    // Extract pending video parts from messages (AI SDK doesn't support video)
    // and use a model wrapper to inject them as raw OpenAI-format parts.
    const videoParts = extractAndStripVideoFromMessages(messages)
    const model = videoParts.length > 0 ? wrapModelWithVideo(this.model, videoParts) : this.model

    // Build common call settings
    const callSettings: Record<string, unknown> = {
      model,
      system: options.system || undefined,
      messages,
      maxRetries: 3
    }
    if (options.maxTokens && options.maxTokens > 0) {
      callSettings.maxTokens = options.maxTokens
    }
    if (tools) callSettings.tools = tools
    if (options.signal) callSettings.abortSignal = options.signal

    // Temperature / topP — omitted when thinking is enabled (Anthropic requirement)
    // and when the provider is stream-only (reasoning models like gpt-5.4-mini)
    if (!useThinking && !this.options?.streamOnly) {
      if (options.temperature !== undefined) callSettings.temperature = options.temperature
      if (options.topP !== undefined) callSettings.topP = options.topP
    }

    // Anthropic extended thinking
    if (useThinking) {
      callSettings.providerOptions = {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: options.thinkingBudget }
        }
      }
    }

    // Merge default provider options (e.g. store: false for chatgpt-subscription)
    if (this.options?.defaultProviderOptions) {
      const existing = (callSettings.providerOptions ?? {}) as Record<string, Record<string, unknown>>
      for (const [ns, opts] of Object.entries(this.options.defaultProviderOptions)) {
        existing[ns] = { ...opts, ...(existing[ns] ?? {}) }
      }
      callSettings.providerOptions = existing
    }

    // Forward provider_params to providerOptions namespace
    if (this.options?.forwardProviderParams && options.providerParams) {
      const ns = this.options.forwardProviderParams
      const existing = (callSettings.providerOptions ?? {}) as Record<string, Record<string, unknown>>
      existing[ns] = { ...options.providerParams, ...(existing[ns] ?? {}) }
      callSettings.providerOptions = existing
    }

    // Notify the fetch wrapper (e.g. chatgpt-subscription) of the system prompt
    // before making the request, since the AI SDK's Responses model drops `system`.
    if (this.options?.onBeforeRequest) {
      this.options.onBeforeRequest(options.system)
    }

    // Stream-only providers (e.g. chatgpt-subscription) force `stream: true` in
    // the request body, so the backend always returns SSE.  We must use streamText
    // even when the caller didn't provide an onTextDelta callback (e.g. compaction).
    const mustStream = !!options.onTextDelta || !!this.options?.streamOnly

    logger.info(`[AiSdkProvider] createMessage: model=${this.modelId}, streaming=${mustStream}, maxTokens=${callSettings.maxTokens ?? 'unset'}, temp=${callSettings.temperature ?? 'unset'}, tools=${options.tools?.length ?? 0}`, { category: 'Provider' })

    if (mustStream) {
      return this.streamingRequest(callSettings, options, useThinking)
    }
    return this.nonStreamingRequest(callSettings, options)
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    // Providers that only support streaming (e.g. chatgpt-subscription) can't
    // be validated with a generateText call — skip the preflight check.
    if (this.options?.streamOnly) {
      return { valid: true }
    }
    try {
      await generateText({
        model: this.model,
        prompt: 'hi',
        maxTokens: 1
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: extractErrorMessage(error) }
    }
  }

  // --- Streaming ---

  private async streamingRequest(
    callSettings: Record<string, unknown>,
    options: CreateMessageOptions,
    useThinking: boolean | 0 | undefined
  ): Promise<LLMResponse> {
    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs))
    }
    logger.info(`[AiSdkProvider] Starting streamText for ${this.modelId}`, { category: 'Provider' })
    const result = streamText(callSettings as Parameters<typeof streamText>[0])

    // Forward deltas as they arrive
    let partCount = 0
    for await (const part of result.fullStream) {
      partCount++
      if (part.type === 'text-delta') {
        options.onTextDelta?.(part.text)
      } else if (part.type === 'reasoning-delta' && options.onThinkingDelta) {
        options.onThinkingDelta((part as any).text ?? (part as any).delta)
      } else if (part.type === 'error') {
        logger.error(`[AiSdkProvider] Stream error: ${extractErrorMessage(part.error)}`, { category: 'Provider' })
        // Surface streaming errors with a readable message
        throw new Error(extractErrorMessage(part.error))
      }
    }
    logger.info(`[AiSdkProvider] Stream complete: ${partCount} parts`, { category: 'Provider' })

    // Collect final values (already resolved after fullStream is consumed)
    const [text, reasoning, toolCalls, finishReason, usage, providerMetadata] = await Promise.all([
      result.text,
      result.reasoning,
      result.toolCalls,
      result.finishReason,
      result.usage,
      result.providerMetadata,
    ])


    const resp = buildResponse(text, reasoning, toolCalls, finishReason, usage, options, this.name, this.modelId)
    resp.providerMetadata = mergeProviderMetadata(
      resp.providerMetadata,
      providerMetadata as Record<string, unknown> | undefined,
      this.options?.getResponseMeta?.() as Record<string, unknown> | undefined,
    )
    return resp
  }

  // --- Non-streaming ---

  private async nonStreamingRequest(
    callSettings: Record<string, unknown>,
    options: CreateMessageOptions
  ): Promise<LLMResponse> {
    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs))
    }
    const result = await generateText(callSettings as Parameters<typeof generateText>[0])

    const resp = buildResponse(
      result.text,
      result.reasoning,
      result.toolCalls,
      result.finishReason,
      result.usage,
      options,
      this.name,
      this.modelId
    )
    resp.providerMetadata = mergeProviderMetadata(
      resp.providerMetadata,
      result.providerMetadata as Record<string, unknown> | undefined,
      this.options?.getResponseMeta?.() as Record<string, unknown> | undefined,
    )
    return resp
  }
}

// ---------------------------------------------------------------------------
// Message conversion: LLMMessage[] → AI SDK ModelMessage[]
// ---------------------------------------------------------------------------

type CoreMessage = Parameters<typeof generateText>[0] extends { messages?: infer M } ? NonNullable<M> extends Array<infer T> ? T : never : never

function formatUtcTimestamp(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  return `[${y}-${mo}-${da} ${h}:${mi}:${s} UTC]`
}

// Cache for converted messages — keyed by the messages array reference.
// Auto-invalidates when the session's array is replaced (e.g. restoreMessages, pruneHistory).
const convertedCacheMap = new WeakMap<LLMMessage[], { length: number; result: CoreMessage[]; toolNameMap: Map<string, string> }>()

/**
 * The AI SDK's OpenAI-compatible provider only allows audio/wav and audio/mpeg
 * through its file part validator. Coerce unsupported audio MIME types to wav
 * so the SDK doesn't reject them at schema validation time. The actual API
 * provider handles codec negotiation.
 */
const SDK_AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg',
}
function toSdkAudioMime(format: string): string {
  return SDK_AUDIO_MIME[format] ?? 'audio/wav'
}

/**
 * Extract multimodal content blocks as AI SDK parts.
 * Video blocks are included as a marker type that will be extracted and
 * injected as raw OpenAI-format parts via the model wrapper (see wrapModelWithVideo).
 */
function extractMediaParts(content: ContentBlock[]): unknown[] {
  const parts: unknown[] = []
  for (const b of content) {
    if (b.type === 'image_url' && b.image_url) {
      const match = b.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match) parts.push({ type: 'image', image: match[2], mediaType: match[1] })
    } else if (b.type === 'input_audio' && b.input_audio) {
      parts.push({ type: 'file', data: b.input_audio.data, mediaType: toSdkAudioMime(b.input_audio.format) })
    } else if (b.type === 'video_url' && b.video_url) {
      // Marker: will be extracted by extractAndStripVideoFromMessages before SDK validation
      parts.push({ type: '__adf_video', url: b.video_url.url })
    }
  }
  return parts
}

function convertSingleMessage(msg: LLMMessage, toolNameMap: Map<string, string>): CoreMessage | CoreMessage[] | null {
  const ts = msg.created_at ? formatUtcTimestamp(msg.created_at) : ''

  if (typeof msg.content === 'string') {
    const text = ts ? `${ts} ${msg.content}` : msg.content
    return { role: msg.role, content: text } as CoreMessage
  }

  if (!Array.isArray(msg.content)) return null

  if (msg.role === 'assistant') {
    const parts: unknown[] = []
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        if (block.id && block.name) toolNameMap.set(block.id, block.name)
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input ?? {}
        })
      }
    }
    if (parts.length > 0) {
      return { role: 'assistant', content: parts } as CoreMessage
    }
  } else if (msg.role === 'user') {
    const toolResults = msg.content.filter((b) => b.type === 'tool_result')
    if (toolResults.length > 0) {
      const parts: unknown[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const outputType = block.is_error ? 'error-text' : 'text'
          parts.push({
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            toolName: toolNameMap.get(block.tool_use_id!) ?? '',
            output: { type: outputType, value: block.content ?? '' }
          })
        }
      }
      const toolMessage = { role: 'tool', content: parts } as CoreMessage

      // Multimodal: split media blocks into a single separate user message
      const mediaParts = extractMediaParts(msg.content)
      if (mediaParts.length > 0) {
        const userMediaMessage = { role: 'user', content: mediaParts } as CoreMessage
        return [toolMessage, userMediaMessage]
      }

      return toolMessage
    } else {
      // Check for multimodal blocks (image/audio)
      const mediaParts = extractMediaParts(msg.content)
      if (mediaParts.length > 0) {
        const parts: unknown[] = []
        const textParts = msg.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
        const text = textParts.join('\n') || ''
        if (text) {
          parts.push({ type: 'text', text: ts ? `${ts} ${text}` : text })
        }
        parts.push(...mediaParts)
        return { role: 'user', content: parts } as CoreMessage
      }

      const textParts = msg.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
      const text = textParts.join('\n') || ''
      return { role: 'user', content: ts ? `${ts} ${text}` : text } as CoreMessage
    }
  }

  return null
}

function convertMessages(messages: LLMMessage[]): CoreMessage[] {
  // Check if we can reuse the cache (only new messages appended)
  const cached = convertedCacheMap.get(messages)
  if (cached && cached.length <= messages.length) {
    const result = [...cached.result]
    const toolNameMap = new Map(cached.toolNameMap)

    for (let i = cached.length; i < messages.length; i++) {
      const converted = convertSingleMessage(messages[i], toolNameMap)
      if (converted) {
        if (Array.isArray(converted)) {
          result.push(...converted)
        } else {
          result.push(converted)
        }
      }
    }

    convertedCacheMap.set(messages, { length: messages.length, result, toolNameMap })
    return result
  }

  // Full conversion (first call or after session reset)
  const result: CoreMessage[] = []
  const toolNameMap = new Map<string, string>()

  for (const msg of messages) {
    const converted = convertSingleMessage(msg, toolNameMap)
    if (converted) {
      if (Array.isArray(converted)) {
        result.push(...converted)
      } else {
        result.push(converted)
      }
    }
  }

  convertedCacheMap.set(messages, { length: messages.length, result, toolNameMap })
  return result
}

// ---------------------------------------------------------------------------
// Tool conversion: ToolProviderFormat[] → AI SDK ToolSet
// ---------------------------------------------------------------------------

function convertTools(tools: ToolProviderFormat[]): ToolSet {
  const toolSet: ToolSet = {}
  for (const tool of tools) {
    // Use inputSchema (not parameters) — the AI SDK's prepareToolsAndToolChoice
    // reads tool.inputSchema directly when building the provider request.
    toolSet[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.input_schema as any)
    } as any
  }
  return toolSet
}

// ---------------------------------------------------------------------------
// Response conversion: AI SDK result → LLMResponse
// ---------------------------------------------------------------------------

interface ToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

interface ReasoningPart {
  type: 'text'
  text: string
}

function buildResponse(
  text: string,
  reasoning: ReasoningPart[] | undefined,
  toolCalls: ToolCall[],
  finishReason: string,
  usage: FlexibleUsage | undefined,
  options: CreateMessageOptions,
  providerName: string,
  modelId: string
): LLMResponse {
  const content: ContentBlock[] = []

  // Thinking blocks (Anthropic extended thinking)
  if (reasoning?.length) {
    const thinkingText = reasoning.map((r) => r.text).join('')
    if (thinkingText) {
      content.push({ type: 'thinking', thinking: thinkingText })
    }
  }

  // Text
  if (text) {
    content.push({ type: 'text', text })
  }

  // Tool calls
  for (const tc of toolCalls) {
    let parsedInput: unknown = tc.input ?? {}
    // tc.input is already parsed by AI SDK, but may be a string if parsing failed
    if (typeof tc.input === 'string') {
      try {
        parsedInput = JSON.parse(tc.input)
      } catch (err) {
        const errMsg = String(err)
        let parseErrorMsg: string
        if (errMsg.includes('Unterminated') || errMsg.includes('Unexpected end')) {
          parseErrorMsg = `Tool "${tc.toolName}" hit token limit. Increase max_tokens or use shorter content.`
          logger.warn(parseErrorMsg, { category: 'Provider' })
        } else {
          parseErrorMsg = `Tool "${tc.toolName}" invalid JSON: ${errMsg}`
          logger.error(parseErrorMsg, { category: 'Provider' })
        }
        parsedInput = {
          _error: parseErrorMsg,
          _raw_arguments: String(tc.input).slice(0, 200) + '...'
        }
      }
    }

    content.push({
      type: 'tool_use',
      id: tc.toolCallId,
      name: tc.toolName,
      input: parsedInput
    })
  }

  // Map finish reason
  const stopReason = mapFinishReason(finishReason)

  // Token usage — fall back to client-side estimation when provider returns 0
  const usageData = usage ?? {}
  let inputTokens = usageData.promptTokens ?? usageData.inputTokens ?? 0
  let outputTokens = usageData.completionTokens ?? usageData.outputTokens ?? 0

  if (inputTokens === 0 && outputTokens === 0) {
    const tokenCounter = getTokenCounterService()

    if (options.system) {
      inputTokens += tokenCounter.countTokens(options.system, providerName, modelId)
    }
    inputTokens += tokenCounter.countMessagesTokens(options.messages, providerName, modelId)

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        outputTokens += tokenCounter.countTokens(block.text, providerName, modelId)
      } else if (block.type === 'tool_use') {
        outputTokens += tokenCounter.countTokens(JSON.stringify(block.input), providerName, modelId)
        outputTokens += tokenCounter.countTokens(block.name!, providerName, modelId)
      }
    }
  }

  const cacheReadTokens = usageData.inputTokenDetails?.cacheReadTokens ?? usageData.cachedInputTokens
  const cacheWriteTokens = usageData.inputTokenDetails?.cacheWriteTokens
  const reasoningTokens = usageData.outputTokenDetails?.reasoningTokens ?? usageData.reasoningTokens

  return {
    id: `${providerName}-${Date.now()}`,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    },
    providerMetadata: {
      adf: {
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      }
    },
  }
}

interface FlexibleUsage {
  promptTokens?: number
  completionTokens?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  inputTokenDetails?: {
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: {
    reasoningTokens?: number
  }
}

function mergeProviderMetadata(
  ...items: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {}
  for (const item of items) {
    if (!item) continue
    for (const [key, value] of Object.entries(item)) {
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])
      ) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) }
      } else {
        merged[key] = value
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mapFinishReason(reason: string): LLMResponse['stop_reason'] {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'stop':
    default:
      return 'end_turn'
  }
}
