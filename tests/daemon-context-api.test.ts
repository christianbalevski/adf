import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-context-api-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-context-api-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { buildAgentContext } from '../src/main/daemon/context-routes'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'
import type { ContextBreakdown } from '../src/shared/types/ipc.types'

const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/** The mock with a realistic usage record: `promptTokens` as the input, cache fields present. */
class MeasuredMockProvider extends MockLLMProvider {
  promptTokens = 0
  async createMessage(options: Parameters<MockLLMProvider['createMessage']>[0]) {
    const response = await super.createMessage(options)
    return { ...response, usage: { ...response.usage, input_tokens: this.promptTokens }, providerMetadata: { adf: { cacheReadTokens: 0 } } }
  }
}

function setup(provider: MockLLMProvider = new MockLLMProvider({ tokensPerResponse: 40 })) {
  const runtime = new RuntimeService({ enforceReviewGate: false })
  const ref = runtime.createAgent({ name: 'agent-1', provider })
  const server = createDaemonHttpApi(runtime)
  servers.push(server)
  return { ref, server }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

describe('GET /agents/:id/context', () => {
  it('measures the main loop: categories sum to the total, threshold and percent', async () => {
    const { ref, server } = setup()
    const res = await server.inject({ method: 'GET', url: `/agents/${ref.id}/context` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual(expect.objectContaining({ agentId: ref.id, loop: 'main', available: true, compactThresholdSource: expect.any(String) }))
    expect(body.breakdown.system_prompt_tokens).toBeGreaterThan(0)
    expect(body.breakdown.tools_total_tokens).toBeGreaterThan(0)
    const sum = body.categories.reduce((n: number, c: { tokens: number }) => n + c.tokens, 0)
    expect(sum).toBe(body.totalTokens)
    expect(body.percent).toBe(Math.round((body.totalTokens / body.compactThreshold) * 100))
    const ids = body.categories.map((c: { id: string }) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['system', 'tools', 'dynamic', 'messages']))
    const tools = body.categories.find((c: { id: string }) => c.id === 'tools')
    expect(tools.count).toBeGreaterThan(0)
    expect(tools.items.length).toBeLessThanOrEqual(12)
  })

  it('grows with the conversation and honours items=', async () => {
    const { ref, server } = setup()
    const before = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/context` })).json()
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'hello there, please remember this long sentence about the weather in spring' } })
    for (let i = 0; i < 40; i++) {
      await settle()
      const status = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })).json()
      if (status.runtimeState === 'idle' && i > 2) break
    }
    const after = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/context?items=2` })).json()
    // The mock reports a 40-token input for a multi-thousand-token prompt:
    // far outside the calibration band, so this stays the uncalibrated
    // estimate, which must grow with the conversation.
    expect(after.breakdown.calibration).toBeUndefined()
    expect(after.breakdown.messages_tokens).toBeGreaterThan(before.breakdown.messages_tokens)
    for (const c of after.categories) expect(c.items.length).toBeLessThanOrEqual(2)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/context?items=-1` })).statusCode).toBe(400)
  })

  it('calibrates to the last call while the fixed parts match, and stops when they change', async () => {
    const provider = new MeasuredMockProvider({ tokensPerResponse: 40 })
    const { ref, server } = setup(provider)
    const context = async () => (await server.inject({ method: 'GET', url: `/agents/${ref.id}/context` })).json()
    provider.promptTokens = Math.round((await context()).totalTokens * 1.6)
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'hello' } })
    for (let i = 0; i < 40; i++) {
      await settle()
      const status = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })).json()
      if (status.runtimeState === 'idle' && i > 2) break
    }
    const after = await context()
    expect(after.breakdown.calibration.last_call_tokens).toBe(provider.promptTokens)
    expect(after.totalTokens).toBe(provider.promptTokens + after.breakdown.calibration.since_last_call_tokens)

    // New instructions: the system prompt measured now is not the one sent.
    const config = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })).json().config as AgentConfig
    const put = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/config`, payload: { ...config, instructions: `${config.instructions ?? ''}\nAlways answer in French.` } })
    expect(put.statusCode, put.body).toBe(200)
    expect((await context()).breakdown.calibration).toBeUndefined()
  })

  it('an inner loop reports its own threshold; unknown loops and agents are 404', async () => {
    const { ref, server } = setup()
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/loops`, payload: { name: 'critic', goal: 'Review drafts.', autostart: false, compact_threshold: 50_000 } })
    const res = await server.inject({ method: 'GET', url: `/agents/${ref.id}/context?loop=critic` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.loop).toBe('critic')
    expect(body.compactThreshold).toBe(50_000)
    expect(body.compactThresholdSource).toBe('loop')
    expect(body.agentCompactThreshold).toBe(100_000)
    if (!body.available) expect(body.categories).toEqual([])
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/context?loop=nope` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/agents/does-not-exist/context` })).statusCode).toBe(404)
  })

  it('without a live executor: available false, no categories, threshold still resolved', () => {
    const config = { model: { provider: 'p', model_id: 'm', compact_threshold: 70_000 } } as unknown as AgentConfig
    const out = buildAgentContext({ agentId: 'a', loop: 'main', config, breakdown: null })
    expect(out).toEqual(expect.objectContaining({ available: false, totalTokens: null, percent: null, categories: [], compactThreshold: 70_000, compactThresholdSource: 'model' }))
    const b: ContextBreakdown = {
      system_prompt_tokens: 1000, system_prompt_parts: { base_and_sections: 800, runtime_blocks: 100, instructions: 100 },
      injected_files: [], tool_groups: [], tools_total_tokens: 0, dynamic_instructions_tokens: 0, messages_tokens: 6000, overhead_tokens: 1000, computed_at: 1,
    }
    expect(buildAgentContext({ agentId: 'a', loop: 'main', config, breakdown: b }).percent).toBe(10)
  })
})
