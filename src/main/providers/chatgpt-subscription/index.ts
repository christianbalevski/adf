import { createOpenAI } from '@ai-sdk/openai'
import { repairStringsDeep } from '../../../shared/utils/well-formed'

// ChatGPT subscription users hit this backend, NOT api.openai.com
const BASE_URL = 'https://chatgpt.com/backend-api/codex'

/**
 * Cheap pre-scan for anything `repairStringsDeep` could possibly fix, run over
 * a SERIALIZED body before it is parsed. Matches either a raw lone surrogate
 * code unit, or the `\udXXX` escape that `JSON.stringify` emits for one
 * (ES2019 well-formed stringify escapes unpaired surrogates and only those).
 *
 * Deliberately over-matches — an escaped but well-formed pair also trips it,
 * which just falls back to the deep walk. One linear regex pass over the body
 * replaces a full recursive walk of every string on every turn.
 */
const REPAIRABLE_RE = /\\u[dD][89a-fA-F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** True when `text` may contain a lone UTF-16 surrogate (raw or escaped). */
function mayNeedSurrogateRepair(text: string | undefined): boolean {
  return text !== undefined && REPAIRABLE_RE.test(text)
}

/**
 * Rate limit and usage info extracted from x-codex-* response headers.
 * A type alias, not an interface: it is handed to consumers typed as
 * `Record<string, unknown>` (provider metadata), which only an alias's implicit
 * index signature satisfies.
 */
export type ChatGPTResponseMeta = {
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
 * 1. `pendingInstructions` — the per-request instructions resolved from the
 *    private request-id header, a safety net for SDK versions whose Responses
 *    model drops the `system` call setting.
 * 2. A `role: "system"` item in `body.input` — the current AI SDK includes it.
 * Both carry the same text, so they must be DEDUPED, not concatenated —
 * blindly merging them sent the full system prompt twice on every request
 * (~2x system-prompt input tokens).
 */
export function patchCodexRequestBody(
  body: Record<string, unknown>,
  pendingInstructions: string | undefined,
  extraParams?: Record<string, unknown>,
  options?: { repairStrings?: boolean }
): { repairedStrings: number } {
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

  // The backend's JSON parser rejects lone UTF-16 surrogates (an emoji cut in
  // half by a fixed-offset truncation, serialized as a bare `\ud83d` escape)
  // with an opaque 400 {"detail":"Bad Request"}. Repair every string in the
  // body — instructions, input text, tool results — before it goes out.
  //
  // `repairStrings: false` is only ever passed by a caller that already
  // pre-scanned every string entering this body and found none repairable.
  if (options?.repairStrings === false) return { repairedStrings: 0 }
  const repairedStrings = repairStringsDeep(body)
  return { repairedStrings }
}

/**
 * One-line shape summary of an outgoing request, appended to opaque 400s so
 * the error that lands in adf_logs says what was sent, not just "Bad Request".
 */
export function describeCodexRequest(body: Record<string, unknown>, bodyChars: number): string {
  const input = Array.isArray(body.input) ? body.input : []
  const instructions = typeof body.instructions === 'string' ? body.instructions.length : 0
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  const keys = Object.keys(body).filter(k => body[k] !== undefined).join(',')
  return `model=${String(body.model)} input_items=${input.length} instructions_chars=${instructions} tools=${tools} body_chars=${bodyChars} keys=[${keys}]`
}

/**
 * Private, request-scoped header carrying the id of this call's instructions.
 * The AI SDK forwards per-call `headers` verbatim to the custom fetch (and
 * re-sends them on every internal retry of the same call), which makes it the
 * only channel that survives both concurrency and retries. It is DELETED in the
 * fetch wrapper and must never reach the wire.
 */
export const INSTRUCTIONS_ID_HEADER = 'x-adf-instructions-id'

/**
 * Safety net: a leaked entry (a call whose `release()` never ran, e.g. a hard
 * crash between begin and finally) must not grow the map without bound. Far
 * above any plausible in-flight count for one provider instance.
 */
const MAX_TRACKED_REQUESTS = 256

/** Everything bound to ONE logical request (all of its SDK retry attempts). */
interface RequestEntry {
  /** System prompt for this call, injected into the body as `instructions`. */
  instructions: string | undefined
  /** x-codex-* metadata of this call's LAST response attempt. */
  meta?: ChatGPTResponseMeta
}

export function createChatGPTSubscriptionProvider(authManager: {
  getValidAccessToken: () => Promise<string>
  getAccountId: () => string | undefined
}, extraParams?: Record<string, unknown>) {
  // Per-request state (instructions in, response metadata out), keyed by the id
  // on INSTRUCTIONS_ID_HEADER. Provider instances are SHARED (main turn, side
  // loops, model_invoke, lambda handlers all hold the same object), so single
  // closure variables raced in BOTH directions: the second call's instructions
  // clobbered the first before its fetch ran, and the second response's
  // x-codex-* headers were handed to whichever call read them first.
  // The entry lives until the call completes, so SDK-level retries of the same
  // call still resolve their instructions and still overwrite their own meta.
  const requestsById = new Map<string, RequestEntry>()

  // Compatibility slot for callers that still use setInstructions() without a
  // request id (tests, any legacy call site). Deliberately NOT cleared after a
  // request: clearing is what broke retries. Never consulted when a request
  // carries an id, so it cannot contaminate the real path.
  let legacyInstructions: string | undefined

  // Response metadata of the last UNSCOPED response (a request that arrived
  // without the private id header, or whose entry was already released). The
  // scoped path never reads it — see beginRequest().getResponseMeta.
  let lastResponseMeta: ChatGPTResponseMeta | undefined

  // extraParams is fixed for the life of the provider — scan it once, not per turn.
  const extraParamsMayNeedRepair = extraParams !== undefined && mayNeedSurrogateRepair(JSON.stringify(extraParams))

  const customFetch: typeof globalThis.fetch = async (input, init) => {
    let token: string
    try {
      token = await authManager.getValidAccessToken()
    } catch (err) {
      console.error(`[ChatGPT Fetch] Failed to get access token:`, err)
      throw err
    }

    const headers = new Headers(init?.headers)
    // Resolve this request's instructions from its private id header, then
    // strip the header — it is internal routing, never wire bytes.
    const requestId = headers.get(INSTRUCTIONS_ID_HEADER)
    if (requestId !== null) headers.delete(INSTRUCTIONS_ID_HEADER)
    const pendingInstructions = requestId !== null
      ? requestsById.get(requestId)?.instructions
      : legacyInstructions

    headers.set('Authorization', `Bearer ${token}`)
    const accountId = authManager.getAccountId()
    if (accountId) {
      headers.set('ChatGPT-Account-ID', accountId)
    }
    // Subscription models require the Codex client identity and a compatible
    // `version` header. Verified with gpt-6-astra on 2026-09-04: 0.144.0 returns
    // 400 "requires a newer version of Codex"; 0.153.0 completes successfully.
    headers.set('originator', 'codex_cli_rs')
    headers.set('version', '0.153.0')

    // Patch the request body (see patchCodexRequestBody for the rules,
    // including system-prompt dedupe between `instructions` and `input`).
    let patchedInit = init
    let requestSummary: string | undefined
    if (init?.body && typeof init.body === 'string') {
      try {
        // Every string that can end up in the patched body comes from one of
        // these three; if none of them can hold a lone surrogate, the deep
        // walk has nothing to find and is skipped.
        const repairStrings =
          extraParamsMayNeedRepair ||
          mayNeedSurrogateRepair(init.body) ||
          mayNeedSurrogateRepair(pendingInstructions)
        const body = JSON.parse(init.body)
        const { repairedStrings } = patchCodexRequestBody(body, pendingInstructions, extraParams, { repairStrings })
        if (repairedStrings > 0) {
          console.warn(`[ChatGPT Subscription] Repaired ${repairedStrings} string(s) with lone UTF-16 surrogates before send (would have been a 400 Bad Request)`)
        }
        const serialized = JSON.stringify(body)
        requestSummary = describeCodexRequest(body, serialized.length)
        patchedInit = { ...init, body: serialized }
      } catch { /* not JSON, pass through */ }
    }

    const response = await globalThis.fetch(input, { ...patchedInit, headers })

    // Capture x-codex-* headers from every response (success or error) and file
    // them under THIS request's id, so a concurrent call can't read them as its
    // own. Re-resolve the entry here rather than reusing the one read above: it
    // may have been released while the request was in flight. On an SDK retry
    // the same id is written again, so the last attempt's meta is what the call
    // reads. Requests with no live entry fall back to the legacy slot.
    const responseMeta = extractCodexHeaders(response.headers)
    const entry = requestId !== null ? requestsById.get(requestId) : undefined
    if (entry) entry.meta = responseMeta
    else lastResponseMeta = responseMeta

    if (!response.ok) {
      // Detect usage_limit_reached and fail fast — return 403 so the AI SDK
      // doesn't retry (it only retries 429/5xx). The error body is preserved.
      if (response.status === 429) {
        try {
          const errBody = await response.clone().text()
          const parsed = JSON.parse(errBody)
          if (parsed?.error?.type === 'usage_limit_reached') {
            const resetMin = Math.ceil((parsed.error.resets_in_seconds ?? 0) / 60)
            console.error(`[ChatGPT Subscription] Usage limit reached (${responseMeta.planType} plan). Resets in ${resetMin} minutes.`)
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
        console.error(`[ChatGPT Subscription] ${response.status}: ${errBody.slice(0, 500)}${requestSummary ? ` (request: ${requestSummary})` : ''}`)
        // The codex backend's 400 is a bare {"detail":"Bad Request"} — no
        // field, no reason. Fold the request shape into the body so the
        // message the executor logs and shows the agent is actionable.
        if (response.status === 400 && requestSummary) {
          const headers = new Headers(response.headers)
          headers.delete('content-length')
          return new Response(`${errBody.trim()} (request: ${requestSummary})`, {
            status: response.status,
            statusText: response.statusText,
            headers
          })
        }
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
    /**
     * Bind a system prompt to ONE request. Returns the per-call headers to hand
     * the SDK, a reader for THIS call's response metadata, and a `release` the
     * caller must run in a `finally` once the call (including the SDK's own
     * retries) is done. `release` drops the instructions and the metadata
     * together — a reader called after it sees nothing rather than a stale or
     * foreign response's rate limits.
     */
    beginRequest(system: string | undefined): {
      headers: Record<string, string>
      getResponseMeta: () => ChatGPTResponseMeta | undefined
      release: () => void
    } {
      const id = crypto.randomUUID()
      // Bound the map before inserting: evict the oldest entries (Map iterates
      // in insertion order) so a leaked id can never grow it without limit.
      while (requestsById.size >= MAX_TRACKED_REQUESTS) {
        const oldest = requestsById.keys().next()
        if (oldest.done) break
        requestsById.delete(oldest.value)
      }
      requestsById.set(id, { instructions: system })
      return {
        headers: { [INSTRUCTIONS_ID_HEADER]: id },
        getResponseMeta: () => requestsById.get(id)?.meta,
        release: () => { requestsById.delete(id) }
      }
    },
    /**
     * Compatibility shim for callers with no request id (tests, legacy call
     * sites). Applies only to requests that arrive WITHOUT the private header;
     * the production path goes through beginRequest.
     */
    setInstructions(system: string | undefined) {
      legacyInstructions = system
    },
    /**
     * Rate limit metadata from the last UNSCOPED response. Scoped callers read
     * their own via the object beginRequest() returned; this is the fallback
     * for requests that arrive without the private id header (legacy/tests).
     */
    getResponseMeta(): ChatGPTResponseMeta | undefined {
      return lastResponseMeta
    }
  }
}

/** Known subscription models — returned by the hardcoded model list. */
export const CHATGPT_SUBSCRIPTION_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark'
]
