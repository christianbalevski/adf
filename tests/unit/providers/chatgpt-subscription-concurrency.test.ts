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
})
