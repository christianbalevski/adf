// POST /agents/:id/start?preflight=1: Studio's AGENT_START provider gate for
// client-initiated starts. Without the flag the route is unchanged.
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService, type RuntimeProviderFactory } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../src/shared/types/ipc.types'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function setup() {
  const dir = realpathSync.native(mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'sp-')))
  const filePath = join(dir, 'agent-1.adf')
  const created = createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() })
  created.workspace.setAgentConfig({ ...created.workspace.getAgentConfig(), model: { provider: 'anthropic', model_id: 'claude-x' } as AgentConfig['model'] })
  created.dispose()
  const state = { providers: [] as ProviderConfig[], valid: false }
  const factory: RuntimeProviderFactory = (config) => {
    if (!state.providers.some((p) => p.id === config.model.provider)) throw new Error(`Provider "${config.model.provider}" is not configured`)
    const provider = new MockLLMProvider()
    provider.validateConfig = async () => (state.valid ? { valid: true } : { valid: false, error: 'HTTP 401 from the provider' })
    return provider
  }
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: factory, settings: { get: (k) => (k === 'providers' ? state.providers : undefined) } })
  const server = createDaemonHttpApi(runtime, {})
  cleanups.push(() => server.close())
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }) })
  return { url: `/agents/${encodeURIComponent(filePath)}/start`, runtime, server, state }
}

describe('POST /agents/:id/start?preflight=1', () => {
  it('answers 409 with the provider codes and loads nothing; starts once the provider checks out', async () => {
    const { url, runtime, server, state } = setup()

    const missing = await server.inject({ method: 'POST', url: `${url}?preflight=1` })
    expect(missing.statusCode).toBe(409)
    expect(missing.json()).toEqual({ error: 'Provider "anthropic" is not configured', code: 'provider_missing' })

    state.providers = [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: '' }]
    const unconfigured = await server.inject({ method: 'POST', url: `${url}?preflight=true` })
    expect(unconfigured.json()).toEqual({ error: 'HTTP 401 from the provider', code: 'provider_unconfigured' })

    state.providers = [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-test' }]
    const failing = await server.inject({ method: 'POST', url: `${url}?preflight=1` })
    expect(failing.json()).toEqual({ error: 'HTTP 401 from the provider', code: 'provider_check_failed' })
    expect(runtime.listAgents()).toEqual([])

    state.valid = true
    const started = await server.inject({ method: 'POST', url: `${url}?preflight=1` })
    expect(started.statusCode).toBe(200)
    expect(started.json()).toMatchObject({ success: true, loaded: true })
  })

  it('without the flag the start is unchecked, as before', async () => {
    const { url, server, state } = setup()
    state.providers = [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-test' }]
    const started = await server.inject({ method: 'POST', url })
    expect(started.statusCode).toBe(200)
    expect(started.json()).toMatchObject({ success: true, loaded: true })
  })
})

describe('POST /agents/:id/start?preflight=1 and the review gate', () => {
  it('answers 403 for an unreviewed file before its provider is called', async () => {
    const dir = realpathSync.native(mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'spr-')))
    const filePath = join(dir, 'agent-1.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    let calls = 0
    const runtime = new RuntimeService({ providerFactory: () => { calls++; return new MockLLMProvider() }, settings: { get: () => undefined } })
    const server = createDaemonHttpApi(runtime, {})
    cleanups.push(() => server.close())
    const res = await server.inject({ method: 'POST', url: `/agents/${encodeURIComponent(filePath)}/start?preflight=1` })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'AGENT_REVIEW_REQUIRED' })
    expect(calls).toBe(0)
  })
})
