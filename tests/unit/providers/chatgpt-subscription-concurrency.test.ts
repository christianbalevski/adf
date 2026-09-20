import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createChatGPTSubscriptionProvider,
  INSTRUCTIONS_ID_HEADER,
} from '../../../src/main/providers/chatgpt-subscription'
import { AiSdkProvider } from '../../../src/main/providers/ai-sdk-provider'
import type { LanguageModel } from 'ai'

/**
 * A chatgpt-subscription provider instance is SHARED: the main turn, every side
 * loop, `model_invoke` from sandboxed agent code and system-scope lambda
 * handlers all hold the same object, and none of those paths are serialized
 * against each other. Instructions therefore have to be bound to the individual
 * request, not to the provider.
 */

const AUTH = {
  getValidAccessToken: async () => 'test-token',
  getAccountId: () => 'test-account',
}

/**
 * A fetch stub whose requests are settled by hand, either with an error (the
 * instructions tests only need the outgoing body) or with a real Response whose
 * x-codex-* headers the provider reads back as that request's metadata.
 */
function deferredResponseFetch() {
  const calls: Array<{ body: string; headers: Headers }> = []
  const resolve: Array<(res: Response) => void> = []
  const fetchStub = vi.fn((_url: unknown, init?: RequestInit) => {
    calls.push({ body: String(init?.body), headers: new Headers(init?.headers) })
    return new Promise<Response>((res) => { resolve.push(res) })
  })
  vi.stubGlobal('fetch', fetchStub)
  return { calls, resolve }
}

/** An SSE-shaped response carrying the given x-codex-* rate limit headers. */
function codexResponse(plan: string, usedPercent: number): Response {
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-codex-plan-type': plan,
      'x-codex-primary-used-percent': String(usedPercent),
    },
  })
}

/** A fetch stub that records each request and hands back a manual completion. */
function deferredFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined; body: string; headers: Headers }> = []
  const settle: Array<(err: Error) => void> = []
  const fetchStub = vi.fn((url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init,
      body: String(init?.body),
      headers: new Headers(init?.headers),
    })
    return new Promise<Response>((_resolve, reject) => { settle.push(reject) })
  })
  vi.stubGlobal('fetch', fetchStub)
  return { calls, settle }
}

/** Spin the event loop until `predicate` holds (the fetch wrapper awaits a token first). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
  expect(predicate()).toBe(true)
}

function startRequest(
  provider: ReturnType<typeof createChatGPTSubscriptionProvider>['provider'],
  headers: Record<string, string>,
  text: string
): Promise<unknown> {
  return provider.responses('gpt-5.4').doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
    headers,
  })
}

describe('per-request instructions on a shared provider instance', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps two overlapping requests on their OWN instructions (fetches settling out of order)', async () => {
    const { calls, settle } = deferredFetch()
    const { provider, beginRequest } = createChatGPTSubscriptionProvider(AUTH)

    // Both calls announce their instructions BEFORE either request leaves —
    // exactly the interleaving the old provider-wide `pendingInstructions`
    // closure could not survive (B's value clobbered A's before A's fetch ran).
    const scopeA = beginRequest('SYSTEM-A')
    const scopeB = beginRequest('SYSTEM-B')

    const a = startRequest(provider, scopeA.headers, 'a').catch((e) => e)
    await until(() => calls.length === 1)
    const b = startRequest(provider, scopeB.headers, 'b').catch((e) => e)
    await until(() => calls.length === 2)

    // Settle out of order: B first, then A.
    settle[1](new Error('captured B'))
    settle[0](new Error('captured A'))
    await Promise.all([a, b])
    scopeA.release()
    scopeB.release()

    const bodyA = JSON.parse(calls[0].body)
    const bodyB = JSON.parse(calls[1].body)
    expect(bodyA.instructions).toBe('SYSTEM-A')
    expect(bodyB.instructions).toBe('SYSTEM-B')
    // Sanity: the bodies really are the two distinct requests.
    expect(JSON.stringify(bodyA.input)).toContain('"a"')
    expect(JSON.stringify(bodyB.input)).toContain('"b"')
  })

  it('carries the instructions on every attempt of a retried request', async () => {
    const { calls, settle } = deferredFetch()
    const { provider, beginRequest } = createChatGPTSubscriptionProvider(AUTH)

    // One logical call, two fetch attempts with the SAME id — what the AI SDK's
    // internal retry does. The old code consumed-and-cleared after attempt 1.
    const scope = beginRequest('SYSTEM-RETRY')

    const attempt1 = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 1)
    settle[0](new Error('attempt 1 failed'))
    await attempt1

    const attempt2 = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 2)
    settle[1](new Error('attempt 2 failed'))
    await attempt2

    scope.release()

    expect(JSON.parse(calls[0].body).instructions).toBe('SYSTEM-RETRY')
    expect(JSON.parse(calls[1].body).instructions).toBe('SYSTEM-RETRY')
  })

  it('never lets the private id header reach the network', async () => {
    const { calls, settle } = deferredFetch()
    const { provider, beginRequest } = createChatGPTSubscriptionProvider(AUTH)
    const scope = beginRequest('SYSTEM')

    const done = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 1)
    settle[0](new Error('captured'))
    await done
    scope.release()

    expect(calls[0].headers.get(INSTRUCTIONS_ID_HEADER)).toBeNull()
    // Also absent from the raw init object, whatever shape the SDK used.
    expect(JSON.stringify(calls[0].init?.headers ?? {}).toLowerCase())
      .not.toContain(INSTRUCTIONS_ID_HEADER)
    expect(calls[0].body).not.toContain(INSTRUCTIONS_ID_HEADER)
    // The real headers still go out untouched.
    expect(calls[0].headers.get('originator')).toBe('codex_cli_rs')
  })

  it('releases the entry once the call is done — a reused id resolves to nothing', async () => {
    const { calls, settle } = deferredFetch()
    const { provider, beginRequest } = createChatGPTSubscriptionProvider(AUTH)
    const scope = beginRequest('SYSTEM-ONCE')

    const first = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 1)
    settle[0](new Error('captured'))
    await first
    scope.release()

    // Same header id after release: nothing to resolve, so the body falls back
    // to the default instructions instead of resurrecting a stale prompt.
    const second = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 2)
    settle[1](new Error('captured'))
    await second

    expect(JSON.parse(calls[0].body).instructions).toBe('SYSTEM-ONCE')
    expect(JSON.parse(calls[1].body).instructions).toBe('You are a helpful assistant.')
  })

  it('setInstructions still works for callers with no request id', async () => {
    const { calls, settle } = deferredFetch()
    const { provider, setInstructions } = createChatGPTSubscriptionProvider(AUTH)
    setInstructions('LEGACY-SYSTEM')

    const done = provider.responses('gpt-5.4').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }).catch((e) => e)
    await until(() => calls.length === 1)
    settle[0](new Error('captured'))
    await done

    expect(JSON.parse(calls[0].body).instructions).toBe('LEGACY-SYSTEM')
  })
})

/**
 * The same sharing argument applies in the OTHER direction: the x-codex-*
 * rate-limit headers of a response must reach the call that made it. A
 * provider-wide "last response" slot handed whichever call read first the
 * metadata of whichever response landed last.
 */
describe('per-request response metadata on a shared provider instance', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('gives two overlapping requests their OWN metadata (responses settling out of order)', async () => {
    const { calls, resolve } = deferredResponseFetch()
    const { provider, beginRequest, getResponseMeta } = createChatGPTSubscriptionProvider(AUTH)

    const scopeA = beginRequest('SYSTEM-A')
    const scopeB = beginRequest('SYSTEM-B')

    const a = startRequest(provider, scopeA.headers, 'a').catch((e) => e)
    await until(() => calls.length === 1)
    const b = startRequest(provider, scopeB.headers, 'b').catch((e) => e)
    await until(() => calls.length === 2)

    // B's response lands FIRST, A's second — the interleaving that made the
    // old provider-wide slot return B's limits for A and A's for B.
    resolve[1](codexResponse('pro', 42))
    resolve[0](codexResponse('plus', 7))
    await Promise.all([a, b])

    expect(scopeA.getResponseMeta()).toMatchObject({ planType: 'plus', primaryUsedPercent: 7 })
    expect(scopeB.getResponseMeta()).toMatchObject({ planType: 'pro', primaryUsedPercent: 42 })
    // Scoped responses never touch the legacy provider-wide slot.
    expect(getResponseMeta()).toBeUndefined()

    scopeA.release()
    scopeB.release()
  })

  it('keeps the LAST attempt of a retried request', async () => {
    const { calls, resolve } = deferredResponseFetch()
    const { provider, beginRequest } = createChatGPTSubscriptionProvider(AUTH)
    const scope = beginRequest('SYSTEM-RETRY')

    const attempt1 = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 1)
    resolve[0](codexResponse('plus', 10))
    await attempt1
    expect(scope.getResponseMeta()).toMatchObject({ primaryUsedPercent: 10 })

    const attempt2 = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 2)
    resolve[1](codexResponse('plus', 55))
    await attempt2

    expect(scope.getResponseMeta()).toMatchObject({ primaryUsedPercent: 55 })
    scope.release()
  })

  it('drops the metadata with the scope on release', async () => {
    const { calls, resolve } = deferredResponseFetch()
    const { provider, beginRequest, getResponseMeta } = createChatGPTSubscriptionProvider(AUTH)
    const scope = beginRequest('SYSTEM-ONCE')

    const done = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 1)
    resolve[0](codexResponse('pro', 99))
    await done

    expect(scope.getResponseMeta()).toMatchObject({ planType: 'pro' })
    scope.release()
    expect(scope.getResponseMeta()).toBeUndefined()

    // A late response on a released id has nowhere scoped to go — it lands in
    // the legacy slot instead of resurrecting the dead entry.
    const late = startRequest(provider, scope.headers, 'hi').catch((e) => e)
    await until(() => calls.length === 2)
    resolve[1](codexResponse('plus', 1))
    await late
    expect(scope.getResponseMeta()).toBeUndefined()
    expect(getResponseMeta()).toMatchObject({ planType: 'plus', primaryUsedPercent: 1 })
  })

  it('still exposes metadata on the unscoped legacy path', async () => {
    const { calls, resolve } = deferredResponseFetch()
    const { provider, setInstructions, getResponseMeta } = createChatGPTSubscriptionProvider(AUTH)
    setInstructions('LEGACY-SYSTEM')

    const done = provider.responses('gpt-5.4').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }).catch((e) => e)
    await until(() => calls.length === 1)
    resolve[0](codexResponse('business', 33))
    await done

    expect(getResponseMeta()).toMatchObject({ planType: 'business', primaryUsedPercent: 33 })
  })
})

describe('AiSdkProvider request scoping', () => {
  /** Minimal LanguageModelV3 that records call headers and fails. */
  function recordingModel(seen: Array<Record<string, string> | undefined>): LanguageModel {
    const fail = async (options: { headers?: Record<string, string> }): Promise<never> => {
      seen.push(options.headers)
      throw new Error('model exploded')
    }
    return {
      specificationVersion: 'v3',
      provider: 'test-provider',
      modelId: 'test-model',
      supportedUrls: {},
      doGenerate: fail,
      doStream: fail,
    } as unknown as LanguageModel
  }

  it('passes the scope headers through and releases the scope even when the call throws', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const scopes: Array<{ system: string | undefined; released: boolean }> = []
    const aiProvider = new AiSdkProvider(recordingModel(seen), 'test', 'test-model', 0, {
      beginRequest: (system) => {
        const record = { system, released: false }
        scopes.push(record)
        const id = `id-${scopes.length}`
        return { headers: { [INSTRUCTIONS_ID_HEADER]: id }, release: () => { record.released = true } }
      },
    })

    await expect(aiProvider.createMessage({
      system: 'SYSTEM-X',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/model exploded/)

    expect(scopes).toHaveLength(1)
    expect(scopes[0].system).toBe('SYSTEM-X')
    expect(scopes[0].released).toBe(true)
    expect(seen[0]?.[INSTRUCTIONS_ID_HEADER]).toBe('id-1')
  })

  it('falls back to onBeforeRequest when the provider has no beginRequest', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const notified: Array<string | undefined> = []
    const aiProvider = new AiSdkProvider(recordingModel(seen), 'test', 'test-model', 0, {
      onBeforeRequest: (system) => { notified.push(system) },
    })

    await expect(aiProvider.createMessage({
      system: 'SYSTEM-Y',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/model exploded/)

    expect(notified).toEqual(['SYSTEM-Y'])
    expect(seen[0]?.[INSTRUCTIONS_ID_HEADER]).toBeUndefined()
  })

  /** Minimal LanguageModelV3 that answers with a fixed text response. */
  function answeringModel(): LanguageModel {
    return {
      specificationVersion: 'v3',
      provider: 'test-provider',
      modelId: 'test-model',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        warnings: [],
      }),
      doStream: async () => { throw new Error('not used') },
    } as unknown as LanguageModel
  }

  it('reads the response metadata of THIS call from its scope, not the provider-wide slot', async () => {
    const released: string[] = []
    const aiProvider = new AiSdkProvider(answeringModel(), 'test', 'test-model', 0, {
      beginRequest: () => ({
        headers: { [INSTRUCTIONS_ID_HEADER]: 'id-1' },
        getResponseMeta: () => ({ planType: 'scoped' }),
        release: () => { released.push('id-1') },
      }),
      getResponseMeta: () => ({ planType: 'provider-wide' }),
    })

    const response = await aiProvider.createMessage({
      system: 'SYSTEM-Z',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.providerMetadata?.planType).toBe('scoped')
    expect(released).toEqual(['id-1'])
  })

  it('falls back to the provider-wide metadata when the scope exposes none', async () => {
    const aiProvider = new AiSdkProvider(answeringModel(), 'test', 'test-model', 0, {
      beginRequest: () => ({ headers: { [INSTRUCTIONS_ID_HEADER]: 'id-1' }, release: () => {} }),
      getResponseMeta: () => ({ planType: 'provider-wide' }),
    })

    const response = await aiProvider.createMessage({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.providerMetadata?.planType).toBe('provider-wide')
  })

  it('still reads the provider-wide metadata with no scope at all', async () => {
    const aiProvider = new AiSdkProvider(answeringModel(), 'test', 'test-model', 0, {
      getResponseMeta: () => ({ planType: 'provider-wide' }),
    })

    const response = await aiProvider.createMessage({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.providerMetadata?.planType).toBe('provider-wide')
  })
})
