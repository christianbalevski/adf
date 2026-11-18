// `error` means the executor itself broke. A provider that is rate limited,
// overloaded, unreachable or drops the stream leaves the agent idle (timers
// keep running, the next trigger retries) with a provider_error log; only bad
// credentials put it in `error`, as 'auth'. Every failure shape the
// classifier reads (status, code, error name, cause chain, message) runs
// through a real turn, with auto_retry on and off.
import { describe, expect, it } from 'vitest'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'

type Shape = [label: string, kind: 'transient' | 'auth', build: () => Error]

const withProps = (message: string, props: Record<string, unknown>): Error => Object.assign(new Error(message), props)

const shapes: Shape[] = [
  ...[408, 429, 500, 502, 503, 504, 529].map((status): Shape => [`status ${status}`, 'transient', () => withProps(`HTTP ${status}`, { status })]),
  ...['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].flatMap((code): Shape[] => [
    [code, 'transient', () => withProps(`connect ${code}`, { code })],
    [`${code} in cause`, 'transient', () => new TypeError('fetch failed', { cause: withProps('socket', { code }) })],
  ]),
  ...['AI_RateLimitError', 'AI_RetryError'].map((name): Shape => [name, 'transient', () => withProps('provider busy', { name })]),
  ...['terminated', 'socket hang up', 'Overloaded', 'rate limit exceeded', 'Service Unavailable', 'stream closed']
    .map((msg): Shape => [`"${msg}"`, 'transient', () => new Error(msg)]),
  ...[401, 403].map((status): Shape => [`status ${status}`, 'auth', () => withProps(`HTTP ${status} invalid x-api-key`, { status })]),
]
const cases = shapes.flatMap(([label, kind, build]) => [true, false].map((autoRetry) => ({ label, kind, build, autoRetry })))

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

describe('error state semantics', () => {
  it.each(cases)('$label (auto_retry $autoRetry) → $kind', async ({ label, kind, build, autoRetry }) => {
    const agent = createHeadlessAgent({ provider: new FailingProvider(build), createOptions: { start_in_state: 'idle' } })
    try {
      const config = agent.workspace.getAgentConfig()
      agent.workspace.setAgentConfig({ ...config, recovery: { ...(config.recovery ?? {}), auto_retry: autoRetry } })
      await agent.dispatch(chat('hello'))
      const state = agent.executor.getState()
      if (kind === 'transient') {
        expect(state, `${label} put the agent in ${state}`).toBe('idle')
        expect(agent.workspace.getLogs(50).map((l) => l.event), `${label} left no provider_error log`).toContain('provider_error')
      } else {
        expect(state).toBe('error')
        expect(agent.executor.getErrorReason()).toBe('auth')
      }
    } finally {
      agent.dispose()
    }
  })
})
