import { createOpenAI } from '@ai-sdk/openai'

// ChatGPT subscription users hit this backend, NOT api.openai.com
const BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Rate limit and usage info extracted from x-codex-* response headers. */
export interface ChatGPTResponseMeta {
  planType?: string
  primaryUsedPercent?: number
  primaryWindowMinutes?: number
  primaryResetAt?: number
  primaryResetAfterSeconds?: number
  secondaryUsedPercent?: number
  secondaryWindowMinutes?: number
  secondaryResetAt?: number
  creditsBalance?: number
  creditsHasCredits?: boolean
  activeLimit?: string
}

function extractCodexHeaders(headers: Headers): ChatGPTResponseMeta {
  const meta: ChatGPTResponseMeta = {}
  const planType = headers.get('x-codex-plan-type')
  if (planType) meta.planType = planType
  const primaryUsed = headers.get('x-codex-primary-used-percent')
  if (primaryUsed) meta.primaryUsedPercent = Number(primaryUsed)
  const primaryWindow = headers.get('x-codex-primary-window-minutes')
  if (primaryWindow) meta.primaryWindowMinutes = Number(primaryWindow)
  const primaryResetAt = headers.get('x-codex-primary-reset-at')
  if (primaryResetAt) meta.primaryResetAt = Number(primaryResetAt)
  const primaryResetAfter = headers.get('x-codex-primary-reset-after-seconds')
  if (primaryResetAfter) meta.primaryResetAfterSeconds = Number(primaryResetAfter)
  const secondaryUsed = headers.get('x-codex-secondary-used-percent')
  if (secondaryUsed) meta.secondaryUsedPercent = Number(secondaryUsed)
  const secondaryWindow = headers.get('x-codex-secondary-window-minutes')
  if (secondaryWindow) meta.secondaryWindowMinutes = Number(secondaryWindow)
  const secondaryResetAt = headers.get('x-codex-secondary-reset-at')
  if (secondaryResetAt) meta.secondaryResetAt = Number(secondaryResetAt)
  const credits = headers.get('x-codex-credits-balance')
  if (credits) meta.creditsBalance = Number(credits)
  const hasCredits = headers.get('x-codex-credits-has-credits')
  if (hasCredits) meta.creditsHasCredits = hasCredits === 'True'
  const activeLimit = headers.get('x-codex-active-limit')
  if (activeLimit) meta.activeLimit = activeLimit
  return meta
}

/**
 * Patch an outgoing Responses-API request body for the ChatGPT subscription
 * backend. Exported for unit testing.
 *
 * The system prompt reaches this function through TWO channels at once:
 * 1. `pendingInstructions` — set via onBeforeRequest as a safety net for SDK
 *    versions whose Responses model drops the `system` call setting.
 * 2. A `role: "system"` item in `body.input` — the current AI SDK includes it.
 * Both carry the same text, so they must be DEDUPED, not concatenated —
 * blindly merging them sent the full system prompt twice on every request
 * (~2x system-prompt input tokens).
 */
export function patchCodexRequestBody(
  body: Record<string, unknown>,
  pendingInstructions: string | undefined,
  extraParams?: Record<string, unknown>
): void {
  // ChatGPT subscription backend requires both of these
  body.store = false
  body.stream = true

  // The codex backend rejects `max_output_tokens` (400 Unsupported parameter).
  // The AI SDK always emits it from maxOutputTokens; strip it for this provider.
  delete body.max_output_tokens

  // Inject instructions from the system prompt passed via onBeforeRequest
  if (pendingInstructions) {
    body.instructions = pendingInstructions
  }

  // Extract any system messages the SDK put in input. The backend wants the
  // system prompt in `instructions`, not as an input item. NOTE: for reasoning
  // models (gpt-5.x) the AI SDK emits the system prompt as role "developer"
  // (systemMessageMode default), so both roles must be caught — matching only
  // "system" let the developer-role copy through and doubled the prompt.
  if (Array.isArray(body.input)) {
    const systemParts: string[] = []
    const filteredInput: unknown[] = []
    for (const item of body.input) {
      const role = item && typeof item === 'object' ? (item as { role?: string }).role : undefined
      if (role === 'system' || role === 'developer') {
        const content = (item as { content?: unknown }).content
        if (typeof content === 'string') {
          systemParts.push(content)
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'input_text' && part.text) systemParts.push(part.text)
            else if (part?.type === 'text' && part.text) systemParts.push(part.text)
          }
        }
      } else {
        filteredInput.push(item)
      }
    }
    if (systemParts.length > 0) {
      body.input = filteredInput
      const sysText = systemParts.join('\n\n')
      const existing = typeof body.instructions === 'string' ? body.instructions : undefined
      if (!existing) {
        body.instructions = sysText
      } else if (existing !== sysText && !existing.includes(sysText)) {
        // Genuinely different content (e.g. a mid-conversation system notice) —
        // append. Identical/contained content is the duplicate path: skip it.
        body.instructions = existing + '\n\n' + sysText
      }
    }
  }

  // Inject user-defined extra params (e.g. reasoning, max_completion_tokens)
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      if (v === null) {
        delete body[k]
      } else {
        body[k] = v
      }
    }
  }

  // Fallback — instructions is required by the backend
  if (!body.instructions) {
    body.instructions = 'You are a helpful assistant.'
  }
}

export function createChatGPTSubscriptionProvider(authManager: {
  getValidAccessToken: () => Promise<string>
  getAccountId: () => string | undefined
}, extraParams?: Record<string, unknown>) {
  // Closure variable: AiSdkProvider sets this via onBeforeRequest before each
  // request, because the AI SDK Responses model drops the `system` parameter.
  let pendingInstructions: string | undefined

  // Last response metadata — captured from every response for agent self-management
  let lastResponseMeta: ChatGPTResponseMeta | undefined

  const customFetch: typeof globalThis.fetch = async (input, init) => {
    let token: string
    try {
      token = await authManager.getValidAccessToken()
    } catch (err) {
      console.error(`[ChatGPT Fetch] Failed to get access token:`, err)
      throw err
    }

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const accountId = authManager.getAccountId()
    if (accountId) {
      headers.set('ChatGPT-Account-ID', accountId)
    }
    // The gpt-5.6 family is gated server-side by client identity: /responses
    // returns 404 "Model not found" (e.g. gpt-5.6-luna) unless originator is
    // codex_cli_rs AND a client version >= the model's minimal_client_version
    // (0.144.0) is sent via the `version` header.
    headers.set('originator', 'codex_cli_rs')
    headers.set('version', '0.144.0')

    // Patch the request body (see patchCodexRequestBody for the rules,
    // including system-prompt dedupe between `instructions` and `input`).
    let patchedInit = init
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        patchCodexRequestBody(body, pendingInstructions, extraParams)
        patchedInit = { ...init, body: JSON.stringify(body) }
      } catch { /* not JSON, pass through */ }
    }

    // Consume the pending instructions so they don't leak to the next request
    pendingInstructions = undefined

    const response = await globalThis.fetch(input, { ...patchedInit, headers })

    // Capture x-codex-* headers from every response (success or error)
    lastResponseMeta = extractCodexHeaders(response.headers)

    if (!response.ok) {
      // Detect usage_limit_reached and fail fast — return 403 so the AI SDK
      // doesn't retry (it only retries 429/5xx). The error body is preserved.
      if (response.status === 429) {
        try {
          const errBody = await response.clone().text()
          const parsed = JSON.parse(errBody)
          if (parsed?.error?.type === 'usage_limit_reached') {
            const resetMin = Math.ceil((parsed.error.resets_in_seconds ?? 0) / 60)
            console.error(`[ChatGPT Subscription] Usage limit reached (${lastResponseMeta.planType} plan). Resets in ${resetMin} minutes.`)
            // Return 403 — non-retryable
            return new Response(errBody, {
              status: 403,
              statusText: 'Usage Limit Reached',
              headers: response.headers
            })
          }
        } catch { /* parse failed — fall through to normal error handling */ }
      }

      const clone = response.clone()
      try {
        const errBody = await clone.text()
        console.error(`[ChatGPT Subscription] ${response.status}: ${errBody.slice(0, 500)}`)
      } catch { /* ignore */ }
    }

    // The ChatGPT backend may return a null/missing content-type for SSE streams.
    // The AI SDK needs text/event-stream to parse the response correctly.
    if (response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const fixedHeaders = new Headers(response.headers)
      fixedHeaders.set('content-type', 'text/event-stream')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: fixedHeaders
      })
    }

    return response
  }

  const provider = createOpenAI({
    baseURL: BASE_URL,
    apiKey: 'chatgpt-subscription', // placeholder, overridden by customFetch
    fetch: customFetch
  })

  return {
    provider,
    /** Set the system prompt to be injected as `instructions` in the next request. */
    setInstructions(system: string | undefined) {
      pendingInstructions = system
    },
    /** Get rate limit metadata from the last response. */
    getResponseMeta(): ChatGPTResponseMeta | undefined {
      return lastResponseMeta
    }
  }
}

/** Known subscription models — returned by the hardcoded model list. */
export const CHATGPT_SUBSCRIPTION_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark'
]
