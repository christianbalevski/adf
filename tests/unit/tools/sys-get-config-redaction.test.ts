import { describe, it, expect } from 'vitest'
import { SysGetConfigTool, redactAgentConfig, REDACTED_MARKER } from '../../../src/main/tools/built-in/sys-get-config.tool'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from '../../../src/shared/types/adf-v02.types'

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'test-agent',
    name: 'Test',
    description: 'test',
    state: 'active',
    autonomous: false,
    instructions: 'x',
    model: { ...AGENT_DEFAULTS.model, provider: 'anthropic', model_id: 'test' },
    context: {},
    tools: [...DEFAULT_TOOLS],
    triggers: JSON.parse(JSON.stringify(AGENT_DEFAULTS.triggers)),
    security: { ...AGENT_DEFAULTS.security },
    limits: { ...AGENT_DEFAULTS.limits },
    messaging: { ...AGENT_DEFAULTS.messaging },
    metadata: { created_at: '', updated_at: '' },
    ...overrides
  } as AgentConfig
}

const secretConfig = () => makeConfig({
  mcp: {
    servers: [{
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_realsecret', NODE_ENV: 'production' },
      headers: { Authorization: 'Bearer realsecret' }
    }]
  },
  providers: [
    { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-realsecret' }
  ]
} as unknown as Partial<AgentConfig>)

describe('sys_get_config redaction', () => {
  it('redacts MCP env and header VALUES but keeps the keys', () => {
    const redacted = redactAgentConfig(secretConfig()) as Record<string, never>
    const server = (redacted.mcp as unknown as { servers: Record<string, Record<string, string>>[] }).servers[0]
    expect(server.env).toEqual({ GITHUB_TOKEN: REDACTED_MARKER, NODE_ENV: REDACTED_MARKER })
    expect(server.headers).toEqual({ Authorization: REDACTED_MARKER })
    expect(JSON.stringify(redacted)).not.toContain('realsecret')
  })

  it('redacts provider credential fields', () => {
    const redacted = redactAgentConfig(secretConfig()) as unknown as { providers: Record<string, string>[] }
    expect(redacted.providers[0].apiKey).toBe(REDACTED_MARKER)
    expect(redacted.providers[0].baseUrl).toBe('https://api.anthropic.com')
  })

  it('leaves non-secret config fully visible and does not mutate the source', () => {
    const config = secretConfig()
    const redacted = redactAgentConfig(config) as unknown as AgentConfig
    expect(redacted.name).toBe('Test')
    expect(redacted.limits).toEqual(config.limits)
    expect(config.mcp!.servers[0].env!.GITHUB_TOKEN).toBe('ghp_realsecret')
  })

  it('never emits secrets through the config section', async () => {
    const config = secretConfig()
    const ws = { getAgentConfig: () => config } as unknown as AdfWorkspace
    const result = await new SysGetConfigTool().execute({ section: 'config' }, ws)
    expect(result.isError).toBe(false)
    expect(result.content).not.toContain('realsecret')
    expect(result.content).toContain('GITHUB_TOKEN')
  })

  it('serves the limits section the base prompt asks for', async () => {
    const config = makeConfig()
    const ws = { getAgentConfig: () => config } as unknown as AdfWorkspace
    const result = await new SysGetConfigTool().execute({ section: 'limits' }, ws)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content).limits).toEqual(config.limits)
  })
})
