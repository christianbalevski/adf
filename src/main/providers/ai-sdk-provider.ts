import { streamText, generateText, jsonSchema, type LanguageModel, type ToolSet } from 'ai'
import type { LLMProvider, CreateMessageOptions } from './provider.interface'
import type { LLMResponse, ContentBlock, LLMMessage, ReasoningConfig, ReasoningStyle, ReasoningEffort } from '../../shared/types/provider.types'
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
// Reasoning normalization: map the provider-agnostic ReasoningConfig onto each
// provider's native shape based on the configured reasoningStyle.
// ---------------------------------------------------------------------------

/** Fraction of max_tokens allocated to reasoning per effort level (OpenRouter convention). */
const EFFORT_RATIO: Record<ReasoningEffort, number> = {
  xhigh: 0.95, high: 0.8, medium: 0.5, low: 0.2, minimal: 0.1,
}
const ANTHROPIC_MIN_BUDGET = 1024
const ANTHROPIC_MAX_BUDGET = 128_000

interface ReasoningPlan {
  /** providerOptions fragment to merge into the request (namespaced by provider). */
  providerOptions?: Record<string, Record<string, unknown>>
  /** Omit temperature/topP (Anthropic rejects them while extended thinking is on). */
  omitTempParams: boolean
}

/**
 * Resolve the effective reasoning request from CreateMessageOptions, honoring the
 * legacy `thinkingBudget` field, then map it to the provider's native options.
 */
export function planReasoning(
  style: ReasoningStyle | undefined,
  options: CreateMessageOptions,
  requestMaxTokens?: number,
): ReasoningPlan | null {
  const r = options.reasoning
  const legacyBudget = options.thinkingBudget && options.thinkingBudget > 0 ? options.thinkingBudget : undefined
  const explicitlyOff = r?.enabled === false
  const reasoningOn =
    !explicitlyOff && (r?.enabled === true || !!r?.effort || r?.max_tokens != null || legacyBudget != null)
  if (!reasoningOn) {
    // Reasoning is off (explicitly disabled, or unset). Many OpenRouter thinking
    // models reason by DEFAULT, so omitting the field isn't enough to actually
    // turn it off — send an explicit `enabled:false`. Some endpoints (e.g.
    // kimi-k2.7-code) mandate reasoning and 400 on this; the provider catches
    // that error, learns the model is mandatory, and retries WITHOUT the disable
    // so the (unavoidable) reasoning is produced and DISPLAYED — never hidden
    // (No Secrets). Anthropic doesn't think unless enabled; OpenAI's effort:'none'
    // is only valid on select models — so we only send this for OpenRouter.
    if (style === 'openrouter') {
      return { providerOptions: { openrouter: { reasoning: { enabled: false } } }, omitTempParams: false }
    }
    return null
  }

  const maxTokens = r?.max_tokens ?? legacyBudget
  const effort = r?.effort
  const exclude = r?.exclude

  switch (style) {
    case 'anthropic': {
      const budget = anthropicBudget(maxTokens, effort, requestMaxTokens)
      return {
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } },
        omitTempParams: true,
      }
    }
    case 'openrouter': {
      const reasoning: Record<string, unknown> = {}
      if (maxTokens != null) reasoning.max_tokens = maxTokens
      else if (effort) reasoning.effort = effort
      else reasoning.enabled = true
      if (exclude) reasoning.exclude = true
      return { providerOptions: { openrouter: { reasoning } }, omitTempParams: false }
    }
    case 'openai': {
      // OpenAI takes an effort level; derive one from max_tokens if only a budget is given.
      const eff = effort ?? (maxTokens != null ? effortFromBudget(maxTokens, requestMaxTokens) : 'medium')
      // The Responses API only returns a visible reasoning trace when a summary is
      // requested; default to 'auto' so reasoning isn't billed-but-invisible. The
      // AI SDK maps reasoningEffort/reasoningSummary → request `reasoning: {effort, summary}`.
      const openai: Record<string, unknown> = { reasoningEffort: eff, reasoningSummary: r?.summary ?? 'auto' }
      return { providerOptions: { openai }, omitTempParams: false }
    }
    default:
      // 'none' / unknown: leave reasoning to the existing provider_params path.
      return null
  }
}

function anthropicBudget(maxTokens?: number, effort?: ReasoningEffort, requestMaxTokens?: number): number {
  let budget: number
  if (maxTokens != null) {
    budget = maxTokens
  } else {
    const base = requestMaxTokens && requestMaxTokens > 0 ? requestMaxTokens : 16_000
    budget = Math.floor(base * (effort ? EFFORT_RATIO[effort] : EFFORT_RATIO.medium))
  }
  return Math.max(Math.min(budget, ANTHROPIC_MAX_BUDGET), ANTHROPIC_MIN_BUDGET)
}

/** Pick the nearest effort level for a reasoning budget relative to the request max_tokens. */
function effortFromBudget(maxTokens: number, requestMaxTokens?: number): ReasoningEffort {
  const base = requestMaxTokens && requestMaxTokens > 0 ? requestMaxTokens : maxTokens / 0.5
  const ratio = base > 0 ? maxTokens / base : 0.5
  if (ratio >= 0.875) return 'xhigh'
  if (ratio >= 0.65) return 'high'
  if (ratio >= 0.35) return 'medium'
  if (ratio >= 0.15) return 'low'
  return 'minimal'
}

/**
 * OpenRouter model ids known to mandate reasoning (they 400 on `enabled:false`).
 * Learned at runtime so we stop sending the disable after the first rejection,
 * and persisted across sessions so a given model fails at most once, ever.
 */
const mandatoryReasoningModels = new Set<string>()
let onMandatoryReasoningLearned: ((modelId: string) => void) | undefined

/** Seed the known-mandatory set from persisted storage (called once at startup). */
export function seedMandatoryReasoningModels(ids: readonly string[]): void {
  for (const id of ids) mandatoryReasoningModels.add(id)
}

/** Register a callback invoked when a *new* mandatory-reasoning model is learned. */
export function setMandatoryReasoningPersister(fn: (modelId: string) => void): void {
  onMandatoryReasoningLearned = fn
}

/** Record a model as mandatory-reasoning, firing the persister only on first learn. */
function rememberMandatoryReasoningModel(modelId: string): void {
  if (mandatoryReasoningModels.has(modelId)) return
  mandatoryReasoningModels.add(modelId)
  try { onMandatoryReasoningLearned?.(modelId) } catch { /* persistence is best-effort */ }
}

/** True if an error is OpenRouter's "reasoning is mandatory / cannot be disabled" 400. */
function isReasoningMandatoryError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return msg.includes('reasoning is mandatory') || (msg.includes('reasoning') && msg.includes('cannot be disabled'))
}

/**
 * Remove an OpenRouter reasoning *disable* (`{ enabled: false }`) from call
 * settings. Used both proactively (known-mandatory models) and on retry after a
 * mandatory-reasoning 400. Returns true if it removed one. Leaves effort/other
 * reasoning requests untouched.
 */
function dropOpenrouterReasoningDisable(callSettings: Record<string, unknown>): boolean {
  const po = callSettings.providerOptions as Record<string, { reasoning?: { enabled?: boolean } }> | undefined
  const reasoning = po?.openrouter?.reasoning
  if (reasoning && reasoning.enabled === false) {
    delete po!.openrouter.reasoning
    return true
  }
  return false
}

/**
 * Codex "experimental" reasoning summaries (gpt-5.6 family) ship each summary
 * section as "**Headline**\n\n<!-- -->" — the body is an empty HTML comment
 * placeholder the backend never fills. Strip the placeholders so the visible
 * trace reads as headlines instead of leaking "<!-- -->" into the UI.
 */
export function sanitizeReasoningText(text: string): string {
  return text
    .replace(/[ \t]*<!--\s*-->[ \t]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Streaming counterpart of sanitizeReasoningText. The "<!-- -->" placeholder
 * can be split across deltas (observed: "...<!--" then " -->"), so a possible
 * partial marker is held back until the next chunk resolves it.
 */
export function createReasoningDeltaSanitizer(): { push: (delta: string) => string; flush: () => string } {
  let held = ''
  const stripComplete = (s: string): string => s.replace(/[ \t]*<!--\s*-->[ \t]*/g, '')
  return {
    push(delta: string): string {
      let s = held + delta
      held = ''
      const partial = s.match(/(?:<!--[\s-]*|<!?-?)$/)
      if (partial) {
        held = partial[0]
        s = s.slice(0, s.length - partial[0].length)
      }
      return stripComplete(s)
    },
    flush(): string {
      const s = stripComplete(held)
      held = ''
      return s
    }
  }
}

/** Read OpenRouter's reasoning_details array off the merged provider metadata. */
function extractOpenRouterReasoningDetails(providerMetadata?: Record<string, unknown>): unknown[] | undefined {
  const or = providerMetadata?.openrouter as Record<string, unknown> | undefined
  const details = or?.reasoning_details
  return Array.isArray(details) && details.length > 0 ? details : undefined
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
  /** Which native reasoning mapping to use when normalizing CreateMessageOptions.reasoning. */
  reasoningStyle?: ReasoningStyle
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

    // Normalize reasoning config to this provider's native shape.
    const reasoningPlan = planReasoning(this.options?.reasoningStyle, options, options.maxTokens)

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
      // AI SDK v5+ renamed this call setting to `maxOutputTokens`; passing the old
      // `maxTokens` key is silently ignored, leaving the response uncapped.
      callSettings.maxOutputTokens = options.maxTokens
    }
    if (tools) callSettings.tools = tools
    if (options.signal) callSettings.abortSignal = options.signal

    // Temperature / topP — omitted when extended thinking is enabled (Anthropic
    // requirement) and when the provider is stream-only (reasoning models like gpt-5.4-mini)
    if (!reasoningPlan?.omitTempParams && !this.options?.streamOnly) {
      if (options.temperature !== undefined) callSettings.temperature = options.temperature
      if (options.topP !== undefined) callSettings.topP = options.topP
    }

    // Reasoning provider options (Anthropic thinking / OpenRouter reasoning / OpenAI effort)
    if (reasoningPlan?.providerOptions) {
      callSettings.providerOptions = reasoningPlan.providerOptions
      // If we've already learned this OpenRouter model mandates reasoning, don't
      // re-send the disable (it would 400 every turn) — let it reason and display.
      if (mandatoryReasoningModels.has(this.modelId)) {
        dropOpenrouterReasoningDisable(callSettings)
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

    logger.info(`[AiSdkProvider] createMessage: model=${this.modelId}, streaming=${mustStream}, maxOutputTokens=${callSettings.maxOutputTokens ?? 'unset'}, temp=${callSettings.temperature ?? 'unset'}, tools=${options.tools?.length ?? 0}`, { category: 'Provider' })

    if (mustStream) {
      return this.streamingRequest(callSettings, options)
    }
    return this.nonStreamingRequest(callSettings, options)
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    // Providers that only support streaming (e.g. chatgpt-subscription) can't
    // be validated with a generateText call — skip the preflight check.
    if (this.options?.streamOnly) {
      return { valid: true }
    }
    logger.info(`[AiSdkProvider] validateConfig preflight START: provider=${this.name} model=${this.modelId} style=${this.options?.reasoningStyle ?? 'none'}`, { category: 'Provider' })
    const t0 = Date.now()
    try {
      await generateText({
        model: this.model,
        prompt: 'hi',
        maxOutputTokens: 1,
        // Bound the preflight so a stalled provider can't hang agent startup
        // indefinitely (it runs before the agent enters the 'thinking' state).
        abortSignal: AbortSignal.timeout(30000)
      })
      logger.info(`[AiSdkProvider] validateConfig preflight OK (${Date.now() - t0}ms): ${this.modelId}`, { category: 'Provider' })
      return { valid: true }
    } catch (error) {
      logger.error(`[AiSdkProvider] validateConfig preflight FAILED (${Date.now() - t0}ms): ${this.modelId}: ${extractErrorMessage(error)}`, { category: 'Provider' })
      return { valid: false, error: extractErrorMessage(error) }
    }
  }

  // --- Streaming ---

  /**
   * Retry once if OpenRouter rejects a reasoning *disable* as mandatory: strip the
   * disable, record the model, and re-run so the (unavoidable) reasoning is produced
   * and displayed rather than failing the turn. See [[project_openrouter_first_class]].
   */
  private async withMandatoryReasoningRetry(
    callSettings: Record<string, unknown>,
    run: () => Promise<LLMResponse>
  ): Promise<LLMResponse> {
    try {
      return await run()
    } catch (err) {
      if (
        this.options?.reasoningStyle === 'openrouter' &&
        isReasoningMandatoryError(err) &&
        dropOpenrouterReasoningDisable(callSettings)
      ) {
        rememberMandatoryReasoningModel(this.modelId)
        logger.warn(`[AiSdkProvider] ${this.modelId} mandates reasoning — retrying without disable; reasoning will be shown`, { category: 'Provider' })
        return await run()
      }
      throw err
    }
  }

  private streamingRequest(callSettings: Record<string, unknown>, options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withMandatoryReasoningRetry(callSettings, () => this.streamOnce(callSettings, options))
  }

  private nonStreamingRequest(callSettings: Record<string, unknown>, options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withMandatoryReasoningRetry(callSettings, () => this.generateOnce(callSettings, options))
  }

  private async streamOnce(
    callSettings: Record<string, unknown>,
    options: CreateMessageOptions
  ): Promise<LLMResponse> {
    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs))
    }
    logger.info(`[AiSdkProvider] Starting streamText for ${this.modelId}`, { category: 'Provider' })
    const result = streamText(callSettings as Parameters<typeof streamText>[0])

    // Forward deltas as they arrive
    let partCount = 0
    const partTypes: Record<string, number> = {}
    // Reasoning arrives as one or more parts (e.g. one per codex summary
    // section); separate them with a blank line and strip "<!-- -->" body
    // placeholders (see sanitizeReasoningText).
    const reasoningSanitizer = createReasoningDeltaSanitizer()
    let lastReasoningId: string | undefined
    let reasoningEmitted = false
    for await (const part of result.fullStream) {
      partCount++
      partTypes[part.type] = (partTypes[part.type] ?? 0) + 1
      if (part.type === 'text-delta') {
        options.onTextDelta?.(part.text)
      } else if (part.type === 'reasoning-delta' && options.onThinkingDelta) {
        const partId = (part as any).id as string | undefined
        let prefix = ''
        if (partId !== lastReasoningId) {
          prefix = reasoningSanitizer.flush()
          if (reasoningEmitted) prefix += '\n\n'
          lastReasoningId = partId
        }
        const text = prefix + reasoningSanitizer.push((part as any).text ?? (part as any).delta ?? '')
        if (text) {
          options.onThinkingDelta(text)
          reasoningEmitted = true
        }
      } else if (part.type === 'error') {
        logger.error(`[AiSdkProvider] Stream error: ${extractErrorMessage(part.error)}`, { category: 'Provider' })
        // Surface streaming errors with a readable message
        throw new Error(extractErrorMessage(part.error))
      }
    }
    const reasoningTail = reasoningSanitizer.flush()
    if (reasoningTail && options.onThinkingDelta) options.onThinkingDelta(reasoningTail)
    logger.info(`[AiSdkProvider] Stream complete: ${partCount} parts ${JSON.stringify(partTypes)}`, { category: 'Provider' })

    // Collect final values (already resolved after fullStream is consumed)
    const [text, reasoning, toolCalls, finishReason, usage, providerMetadata] = await Promise.all([
      result.text,
      result.reasoning,
      result.toolCalls,
      result.finishReason,
      result.usage,
      result.providerMetadata,
    ])

    const reasoningDetails = extractOpenRouterReasoningDetails(providerMetadata as Record<string, unknown> | undefined)
    const resp = buildResponse(text, reasoning, toolCalls, finishReason, usage, options, this.name, this.modelId, reasoningDetails)
    resp.providerMetadata = mergeProviderMetadata(
      resp.providerMetadata,
      providerMetadata as Record<string, unknown> | undefined,
      this.options?.getResponseMeta?.() as Record<string, unknown> | undefined,
    )
    return resp
  }

  // --- Non-streaming ---

  private async generateOnce(
    callSettings: Record<string, unknown>,
    options: CreateMessageOptions
  ): Promise<LLMResponse> {
    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs))
    }
    const result = await generateText(callSettings as Parameters<typeof generateText>[0])

    const reasoningDetails = extractOpenRouterReasoningDetails(result.providerMetadata as Record<string, unknown> | undefined)
    const resp = buildResponse(
      result.text,
      result.reasoning,
      result.toolCalls,
      result.finishReason,
      result.usage,
      options,
      this.name,
      this.modelId,
      reasoningDetails
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
    const reasoningDetails: unknown[] = []
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
      } else if (block.type === 'thinking' && Array.isArray(block.reasoning_details) && block.reasoning_details.length > 0) {
        // Round-trip reasoning across tool-call turns. The OpenRouter provider reads
        // assistant message-level providerOptions.openrouter.reasoning_details first,
        // then signature-filters + dedups itself. Thinking blocks without details
        // (e.g. legacy Anthropic) are dropped, preserving prior behavior.
        // See [[project_openrouter_first_class]].
        reasoningDetails.push(...block.reasoning_details)
      }
    }
    if (parts.length > 0) {
      const assistantMsg: Record<string, unknown> = { role: 'assistant', content: parts }
      if (reasoningDetails.length > 0) {
        assistantMsg.providerOptions = { openrouter: { reasoning_details: reasoningDetails } }
      }
      return assistantMsg as CoreMessage
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

      // Text blocks riding alongside tool_results (mid-batch user interrupts,
      // system notices) must survive as a separate user message — the 'tool'
      // role only carries tool-result parts, so they'd otherwise be dropped
      // from the request entirely.
      const followupParts: unknown[] = msg.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => ({ type: 'text', text: b.text }))

      // Multimodal: split media blocks into the same separate user message
      followupParts.push(...extractMediaParts(msg.content))

      if (followupParts.length > 0) {
        const userFollowupMessage = { role: 'user', content: followupParts } as CoreMessage
        return [toolMessage, userFollowupMessage]
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
  modelId: string,
  reasoningDetails?: unknown[]
): LLMResponse {
  const content: ContentBlock[] = []

  // Thinking block. Carries the visible reasoning text and, when preservation is
  // enabled, the structured reasoning_details for round-tripping on the next
  // tool-call turn. Encrypted-only turns have empty text but still need the block
  // to carry the details — see [[project_openrouter_first_class]].
  // Parts are distinct reasoning segments (e.g. codex summary sections) — join
  // with a blank line so headlines don't run together, and strip placeholders.
  const thinkingText = reasoning?.length
    ? reasoning.map((r) => sanitizeReasoningText(r.text)).filter(Boolean).join('\n\n')
    : ''
  const preservedDetails = options.reasoning?.preserve ? reasoningDetails : undefined
  if (thinkingText || (preservedDetails && preservedDetails.length > 0)) {
    content.push({
      type: 'thinking',
      thinking: thinkingText,
      ...(preservedDetails && preservedDetails.length > 0 ? { reasoning_details: preservedDetails } : {}),
    })
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
