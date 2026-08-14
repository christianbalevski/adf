import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

// OAuth access tokens are accepted by the normal xAI API (api:access scope) —
// same base URL as API-key usage. Never send the OAuth bearer anywhere else.
const BASE_URL = 'https://api.x.ai/v1'

export function createGrokSubscriptionProvider(authManager: {
  getValidAccessToken: () => Promise<string>
}, extraParams?: Record<string, unknown>) {
  const customFetch: typeof globalThis.fetch = async (input, init) => {
    let token: string
    try {
      token = await authManager.getValidAccessToken()
    } catch (err) {
      console.error(`[Grok Fetch] Failed to get access token:`, err)
      throw err
    }

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)

    // Inject user-defined extra params (e.g. reasoning_effort) — null deletes a key.
    let patchedInit = init
    if (extraParams && init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        for (const [k, v] of Object.entries(extraParams)) {
          if (v === null) {
            delete body[k]
          } else {
            body[k] = v
          }
        }
        patchedInit = { ...init, body: JSON.stringify(body) }
      } catch { /* not JSON, pass through */ }
    }

    const response = await globalThis.fetch(input, { ...patchedInit, headers })

    if (!response.ok) {
      try {
        const errBody = await response.clone().text()
        console.error(`[Grok Subscription] ${response.status}: ${errBody.slice(0, 500)}`)
      } catch { /* ignore */ }
    }

    return response
  }

  // openai-compatible (named 'xai') rather than @ai-sdk/openai: it parses the
  // reasoning_content / reasoning fields some Grok models return over chat
  // completions, so traces are displayed instead of silently dropped (No
  // Secrets). Its providerOptions key is the name — reasoningStyle 'xai' emits
  // reasoningEffort under providerOptions.xai, which becomes reasoning_effort.
  const provider = createOpenAICompatible({
    name: 'xai',
    baseURL: BASE_URL,
    apiKey: 'grok-subscription', // placeholder, overridden by customFetch
    // stream_options.include_usage — without it xAI streams carry no usage
    // chunk and every turn falls back to a char-based token estimate.
    includeUsage: true,
    fetch: customFetch
  })

  return { provider }
}

/** Known subscription models — fallback when the live /models fetch fails. */
export const GROK_SUBSCRIPTION_MODELS = [
  'grok-4.5',
  'grok-4.3',
  'grok-build-0.1',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning'
]

/**
 * List models with the OAuth token via the live /models endpoint, falling back
 * to the hardcoded catalog when unauthenticated or the request fails.
 */
export async function listGrokSubscriptionModels(authManager: {
  getValidAccessToken: () => Promise<string>
}): Promise<string[]> {
  try {
    const token = await authManager.getValidAccessToken()
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) return [...GROK_SUBSCRIPTION_MODELS]
    const json = await response.json() as { data?: { id?: string }[] }
    const models = (json.data ?? []).map(m => m.id).filter((id): id is string => !!id)
    return models.length > 0 ? models : [...GROK_SUBSCRIPTION_MODELS]
  } catch {
    return [...GROK_SUBSCRIPTION_MODELS]
  }
}
