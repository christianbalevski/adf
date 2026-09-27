import { describe, expect, it } from 'vitest'
import { buildEffectiveRuntime } from '../../../src/main/runtime/effective-runtime'
import { createProvider } from '../../../src/main/providers/provider-factory'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_DYNAMIC_PROMPTS } from '../../../src/shared/constants/adf-defaults'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const APP_PROVIDER: ProviderConfig = {
  id: 'custom:abc',
  type: 'openai-compatible',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'app-secret',
  defaultModel: 'app-model',
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: { provider: 'custom:abc', model_id: '' },
    tools: [],
    mcp: {
      servers: [
        { name: 'github', transport: 'stdio', command: 'evil', env: { GITHUB_TOKEN: 'agent-secret' } },
        { name: 'local-only', transport: 'http', url: 'https://user:pw@mcp.example/x?token=s3cret', env_keys: ['API_KEY'], source: 'http:https://mcp.example/x' },
        { name: 'orphan', transport: 'stdio', command: 'node' },
      ],
    },
    adapters: { telegram: { enabled: true }, discord: { enabled: false }, slack: {}, nosuch: { enabled: true } },
    ...overrides,
  } as unknown as AgentConfig
}

function settings(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
    getProvider: (id: string) => ((values.providers as ProviderConfig[] | undefined) ?? []).find(p => p.id === id),
  }
}

const baseSettings = {
  providers: [APP_PROVIDER],
  compute: { hostAccessEnabled: true, hostApproved: ['github'], executionTargets: [{ id: 'dev-box' }], containerPackages: ['git'] },
  mcpServers: [{ id: 'r1', name: 'github', type: 'npm', npmPackage: '@mcp/github', env: [{ key: 'GH_HOST', value: 'x' }] }],
  sandboxPackages: [{ name: 'lodash', version: '4.17.21' }],
  meshLan: true,
}

const toolPrompts = { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS }

describe('buildEffectiveRuntime', () => {
  it('records app-inherited values and never secret values', () => {
    const s = settings(baseSettings)
    const snap = buildEffectiveRuntime({
      host: 'daemon',
      config: config(),
      provider: createProvider(config(), s),
      basePrompt: DEFAULT_BASE_PROMPT,
      toolPrompts,
      sources: { settings: s },
      sandboxModules: ['lodash'],
      now: new Date('2026-09-27T00:00:00Z'),
    })

    expect(snap.provider).toMatchObject({
      id: 'custom:abc', source: 'app', base_url: 'http://localhost:1234/v1', model: 'app-model', api_key_source: 'app',
    })
    expect(snap.prompts.base_prompt).toMatchObject({ applied: true, is_default: true })
    expect(snap.prompts.tool_prompts.overridden).toEqual([])
    expect(snap.compute).toMatchObject({ host_access_enabled: true, host_approved: ['github'], execution_targets: ['dev-box'] })
    // Registration pins the executable identity; the file's `command: evil` is not what runs.
    expect(snap.mcp_servers[0]).toMatchObject({ name: 'github', pinned_to_app_registration: true, package: '@mcp/github' })
    expect(snap.mcp_servers[0].command).toBeUndefined()
    expect(snap.mcp_servers[0].env_names).toEqual(['GH_HOST', 'GITHUB_TOKEN'])
    expect(snap.mcp_servers[1]).toMatchObject({ pinned_to_app_registration: false, url: 'https://mcp.example/x', env_names: ['API_KEY'] })
    // Unregistered + no source is skipped at start by every host, so not listed.
    expect(snap.mcp_servers.map(m => m.name)).toEqual(['github', 'local-only'])
    expect(snap.adapters).toEqual(['telegram'])
    expect(snap.sandbox_packages).toEqual(['lodash'])
    expect(snap.mesh).toEqual({ enabled: true, lan: true, port: 7295, forces_messaging_receive: false })

    const json = JSON.stringify(snap)
    expect(json).not.toContain('app-secret')
    expect(json).not.toContain('agent-secret')
    expect(json).not.toContain('s3cret')
    expect(json).not.toContain('pw@')
  })

  it('omits the base URL for fixed-endpoint types and reports subscription auth', () => {
    const s = settings({ providers: [{ id: 'anthropic', type: 'anthropic', name: 'A', baseUrl: 'https://ignored.example', apiKey: 'k' }] })
    const cfg = config({ model: { provider: 'anthropic', model_id: 'claude' } } as Partial<AgentConfig>)
    const snap = buildEffectiveRuntime({
      host: 'daemon', config: cfg, provider: createProvider(cfg, s),
      basePrompt: '', toolPrompts: {}, sources: { settings: s },
    })
    expect(snap.provider.base_url).toBeUndefined()
    expect(snap.provider.api_key_source).toBe('app')
  })

  it("prefers the agent's own provider copy and reports whose key it uses", () => {
    const own = { ...APP_PROVIDER, baseUrl: 'https://own.example/v1', apiKey: 'own-key' }
    const s = settings(baseSettings)
    const cfg = config({ include_base_prompt: false } as Partial<AgentConfig>)
    const snap = buildEffectiveRuntime({
      host: 'studioForeground',
      config: cfg,
      provider: createProvider(cfg, s, own),
      basePrompt: 'custom base',
      toolPrompts: { ...toolPrompts, dyn_extra: 'x' },
      sources: { settings: s },
    })
    expect(snap.provider).toMatchObject({ source: 'agent', base_url: 'https://own.example/v1', api_key_source: 'agent' })
    expect(snap.prompts.base_prompt).toMatchObject({ applied: false, is_default: false })
    expect(snap.prompts.tool_prompts.overridden).toEqual(['dyn_extra'])
    expect(snap.sandbox_packages).toEqual([])
    expect(JSON.stringify(snap)).not.toContain('own-key')

    // A key-less agent copy is filled with the app key by the host: borrowed.
    const borrowed = buildEffectiveRuntime({
      host: 'studioBackground',
      config: config(),
      provider: createProvider(config(), s, { ...own, apiKey: 'app-secret' }),
      basePrompt: DEFAULT_BASE_PROMPT,
      toolPrompts,
      sources: { settings: s },
    })
    expect(borrowed.provider.api_key_source).toBe('app')
  })

  it('reports a provider it did not build (mock / embedder-supplied) as unknown, not as a guess', () => {
    const snap = buildEffectiveRuntime({
      host: 'daemon',
      config: config({ providers: [{ ...APP_PROVIDER }] } as unknown as Partial<AgentConfig>),
      provider: new MockLLMProvider(),
      basePrompt: '',
      toolPrompts: {},
      sources: { settings: settings(baseSettings) },
    })
    expect(snap.provider).toMatchObject({ source: 'unknown', params_source: 'unknown', api_key_source: 'unknown' })
    expect(snap.provider.base_url).toBeUndefined()
  })
})
