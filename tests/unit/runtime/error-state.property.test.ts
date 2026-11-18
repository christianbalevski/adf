// `error` means the executor itself broke. A provider that is rate limited,
// overloaded, unreachable or drops the stream leaves the agent idle (timers
// keep running, the next trigger retries) with a provider_error log; only bad
// credentials put it in `error`, as 'auth'. Generated provider failures in
// every shape the classifier reads (status, code, error name, cause chain,
// message) run through a real turn.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'

type Shape = { kind: 'transient' | 'auth'; build: () => Error; label: string }

const withProps = (message: string, props: Record<string, unknown>, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), props)

const noise = fc.constantFrom('', 'upstream said no', 'request id abc123', 'try again later', 'model: claude')

const transient: fc.Arbitrary<Shape> = fc.oneof(
  fc.tuple(fc.constantFrom(408, 429, 500, 502, 503, 504, 529), noise).map(([status, msg]) => ({
    kind: 'transient' as const, label: `status ${status}`, build: () => withProps(`HTTP ${status} ${msg}`, { status }),
  })),
  fc.tuple(fc.constantFrom('ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'), fc.boolean()).map(([code, inCause]) => ({
    kind: 'transient' as const, label: `${code}${inCause ? ' (in cause)' : ''}`,
    build: () => inCause ? new TypeError('fetch failed', { cause: withProps('socket', { code }) }) : withProps(`connect ${code}`, { code }),
  })),
  fc.constantFrom('AI_RateLimitError', 'AI_RetryError').map((name) => ({
    kind: 'transient' as const, label: name, build: () => withProps('provider busy', { name }),
  })),
  fc.constantFrom('terminated', 'socket hang up', 'Overloaded', 'rate limit exceeded', 'Service Unavailable', 'stream closed').map((msg) => ({
    kind: 'transient' as const, label: `"${msg}"`, build: () => new Error(msg),
  })),
)

const auth: fc.Arbitrary<Shape> = fc.tuple(fc.constantFrom(401, 403), noise).map(([status, msg]) => ({
  kind: 'auth' as const, label: `status ${status}`, build: () => withProps(`HTTP ${status} invalid x-api-key ${msg}`, { status }),
}))

class FailingProvider implements LLMProvider {
  readonly name = 'failing'
  readonly modelId = 'failing-v1'
  constructor(private readonly fail: () => Error) {}
  async createMessage(): Promise<never> { throw this.fail() }
  async validateConfig() { return { valid: true } }
}

function chat(text: string) {
  return createDispatch(createEvent({
    type: 'chat',
    source: 'error-state-property',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
  }), { scope: 'agent' })
}

describe('error state semantics (property)', () => {
  it('a transient provider failure leaves the agent idle with a provider_error log; bad credentials are error/auth', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(transient, auth), fc.boolean(), async (shape, autoRetry) => {
        const agent = createHeadlessAgent({
          provider: new FailingProvider(shape.build),
          createOptions: { start_in_state: 'idle' },
        })
        try {
          const config = agent.workspace.getAgentConfig()
          agent.workspace.setAgentConfig({ ...config, recovery: { ...(config.recovery ?? {}), auto_retry: autoRetry } })
          await agent.dispatch(chat('hello'))
          const state = agent.executor.getState()
          const events = agent.workspace.getLogs(50).map((l) => l.event)
          if (shape.kind === 'transient') {
            expect(state, `${shape.label} put the agent in ${state}`).toBe('idle')
            expect(events, `${shape.label} left no provider_error log`).toContain('provider_error')
          } else {
            expect(state, `${shape.label}`).toBe('error')
            expect(agent.executor.getErrorReason()).toBe('auth')
          }
        } finally {
          agent.dispose()
        }
      }),
      { numRuns: 80 },
    )
  }, 60_000)
})
