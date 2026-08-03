import { describe, it, expect, beforeEach } from 'vitest'
import { SysUpdateConfigTool } from '../../../src/main/tools/built-in/sys-update-config.tool'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from '../../../src/shared/types/adf-v02.types'

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'test-agent',
    name: 'agent-1',
    description: 'test',
    state: 'active',
    autonomous: false,
    instructions: '',
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

function mockWorkspace(config: AgentConfig): AdfWorkspace {
  return {
    getAgentConfig: () => config,
    setAgentConfig: (c: AgentConfig) => { Object.assign(config, c) }
  } as unknown as AdfWorkspace
}

// The .adf file is renamed to follow the agent name, so names must be valid
// file names on all platforms.
describe('sys_update_config name validation', () => {
  let tool: SysUpdateConfigTool

  beforeEach(() => {
    tool = new SysUpdateConfigTool()
  })

  it('accepts a plain new name and fires onConfigChanged', async () => {
    const config = makeConfig()
    const ws = mockWorkspace(config)
    let notified: AgentConfig | null = null
    tool.onConfigChanged = (c) => { notified = c }
    const result = await tool.execute({ path: 'name', value: 'agent-2' }, ws)
    expect(result.isError).toBe(false)
    expect(config.name).toBe('agent-2')
    expect(notified?.name).toBe('agent-2')
  })

  it('accepts names with spaces and dots', async () => {
    const config = makeConfig()
    const ws = mockWorkspace(config)
    const result = await tool.execute({ path: 'name', value: 'agent v2.1' }, ws)
    expect(result.isError).toBe(false)
    expect(config.name).toBe('agent v2.1')
  })

  it('rejects an empty name', async () => {
    const config = makeConfig()
    const ws = mockWorkspace(config)
    const result = await tool.execute({ path: 'name', value: '   ' }, ws)
    expect(result.isError).toBe(true)
    expect(config.name).toBe('agent-1')
  })

  it.each(['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b'])(
    'rejects name with path-invalid character: %s',
    async (value) => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'name', value }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('not allowed in file names')
      expect(config.name).toBe('agent-1')
    }
  )

  it('rejects a name ending in a dot', async () => {
    const config = makeConfig()
    const ws = mockWorkspace(config)
    const result = await tool.execute({ path: 'name', value: 'agent.' }, ws)
    expect(result.isError).toBe(true)
    expect(config.name).toBe('agent-1')
  })

  it('rejects a non-string name', async () => {
    const config = makeConfig()
    const ws = mockWorkspace(config)
    const result = await tool.execute({ path: 'name', value: 42 }, ws)
    expect(result.isError).toBe(true)
    expect(config.name).toBe('agent-1')
  })
})
