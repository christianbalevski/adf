import { describe, it, expect, beforeEach } from 'vitest'
import { SysUpdateConfigTool } from '../../../src/main/tools/built-in/sys-update-config.tool'
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

describe('sys_update_config (path-based)', () => {
  let tool: SysUpdateConfigTool

  beforeEach(() => {
    tool = new SysUpdateConfigTool()
  })

  // =========================================================================
  // Self-protection: path segments cannot be "locked" or "locked_fields"
  // =========================================================================

  describe('self-protection', () => {
    it('rejects path targeting locked property', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'triggers.on_chat.locked', value: true }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Cannot modify locking configuration')
    })

    it('rejects path targeting locked_fields', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'locked_fields', value: [] }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Cannot modify locking configuration')
    })

    it('rejects nested locked path segment', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'triggers.on_inbox.targets.0.locked', value: true }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Cannot modify locking configuration')
    })

    it('allows values containing the word "locked"', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'description', value: 'This agent manages locked doors' }, ws)
      expect(result.isError).toBe(false)
      expect(config.description).toBe('This agent manages locked doors')
    })
  })

  // =========================================================================
  // Deny list: immutable fields
  // =========================================================================

  describe('deny list', () => {
    it('rejects adf_version', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'adf_version', value: '0.3' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'adf_version' cannot be modified")
    })

    it('rejects id', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'id', value: 'new-id' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'id' cannot be modified")
    })

    it('rejects metadata', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'metadata.created_at', value: '2025-01-01' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'metadata' cannot be modified")
    })

    it('rejects providers', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'providers', value: [] }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'providers' cannot be modified")
    })

    it('allows non-denied fields', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'description', value: 'new desc' }, ws)
      expect(result.isError).toBe(false)
      expect(config.description).toBe('new desc')
    })
  })

  // =========================================================================
  // locked_fields — section lock
  // =========================================================================

  describe('locked_fields (section lock)', () => {
    it('rejects field update to section in locked_fields', async () => {
      const config = makeConfig({ locked_fields: ['model'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'model.temperature', value: 0.5 }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'model' is locked")
    })

    it('rejects field update to primitive in locked_fields', async () => {
      const config = makeConfig({ locked_fields: ['description'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'description', value: 'new desc' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'description' is locked")
    })

    it('allows field update to unlocked section', async () => {
      const config = makeConfig({ locked_fields: ['security'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'model.temperature', value: 0.5 }, ws)
      expect(result.isError).toBe(false)
      expect(config.model.temperature).toBe(0.5)
    })

    it('rejects trigger path when triggers is locked', async () => {
      const config = makeConfig({ locked_fields: ['triggers'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_chat.targets',
        action: 'append',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'triggers' is locked")
    })

    it('rejects trigger enable/disable when triggers is locked', async () => {
      const config = makeConfig({ locked_fields: ['triggers'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'triggers.on_chat.enabled', value: false }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'triggers' is locked")
    })

    it('rejects serving field when serving is locked', async () => {
      const config = makeConfig({ locked_fields: ['serving'] })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'serving.shared.enabled', value: true }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("'serving' is locked")
    })

    it('lets authorized code update locked table protections', async () => {
      const config = makeConfig({
        locked_fields: ['security.table_protections'],
        security: {
          ...AGENT_DEFAULTS.security,
          table_protections: { local_votes: 'append_only' }
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'security.table_protections.local_votes',
        value: 'authorized',
        _authorized: true
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.security.table_protections?.local_votes).toBe('authorized')
    })
  })

  // =========================================================================
  // Trigger-level lock
  // =========================================================================

  describe('trigger-level lock', () => {
    it('rejects enable/disable of locked trigger', async () => {
      const config = makeConfig()
      config.triggers.on_chat = { enabled: true, locked: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'triggers.on_chat.enabled', value: false }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('rejects appending target to locked trigger', async () => {
      const config = makeConfig()
      config.triggers.on_chat = { enabled: true, locked: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_chat.targets',
        action: 'append',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('allows action on unlocked trigger', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [{ scope: 'agent', interval_ms: 30000 }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(2)
    })
  })

  // =========================================================================
  // Target-level lock
  // =========================================================================

  describe('target-level lock', () => {
    it('rejects removing a locked target', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [
          { scope: 'system', lambda: 'lib/router.ts:onMessage', locked: true },
          { scope: 'agent' }
        ]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'remove',
        index: 0
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('allows removing an unlocked target when others are locked', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [
          { scope: 'system', lambda: 'lib/router.ts:onMessage', locked: true },
          { scope: 'agent' }
        ]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'remove',
        index: 1
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(1)
    })

    it('rejects replacing targets array when locked targets exist', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [{ scope: 'system', lambda: 'lib/router.ts:onMessage', locked: true }]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        value: [{ scope: 'agent' }]
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked element')
    })

    it('allows appending target when locked targets exist', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [{ scope: 'system', lambda: 'lib/router.ts:onMessage', locked: true }]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(2)
    })

    it('rejects setting a locked target by index', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [
          { scope: 'system', lambda: 'lib/router.ts:onMessage', locked: true },
          { scope: 'agent' }
        ]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets.0',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })
  })

  // =========================================================================
  // Route-level lock
  // =========================================================================

  describe('route-level lock', () => {
    it('rejects removing a locked route', async () => {
      const config = makeConfig({
        serving: {
          api: [
            { method: 'GET', path: '/api/inbox', lambda: 'lib/api.ts:listInbox', locked: true },
            { method: 'GET', path: '/api/stats', lambda: 'lib/api.ts:getStats' }
          ]
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'serving.api', action: 'remove', index: 0 }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('allows removing an unlocked route when others are locked', async () => {
      const config = makeConfig({
        serving: {
          api: [
            { method: 'GET', path: '/api/inbox', lambda: 'lib/api.ts:listInbox', locked: true },
            { method: 'GET', path: '/api/stats', lambda: 'lib/api.ts:getStats' }
          ]
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'serving.api', action: 'remove', index: 1 }, ws)
      expect(result.isError).toBe(false)
      expect(config.serving!.api).toHaveLength(1)
    })

    it('rejects replacing routes array when locked routes exist', async () => {
      const config = makeConfig({
        serving: {
          api: [{ method: 'GET', path: '/api/inbox', lambda: 'lib/api.ts:listInbox', locked: true }]
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        value: [{ method: 'GET', path: '/api/new', lambda: 'lib/api.ts:newRoute' }]
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked element')
    })

    it('allows appending route when locked routes exist', async () => {
      const config = makeConfig({
        serving: {
          api: [{ method: 'GET', path: '/api/inbox', lambda: 'lib/api.ts:listInbox', locked: true }]
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        action: 'append',
        value: { method: 'GET', path: '/api/stats', lambda: 'lib/api.ts:getStats' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.serving!.api).toHaveLength(2)
    })
  })

  // =========================================================================
  // Tool-level lock
  // =========================================================================

  describe('tool-level lock', () => {
    it('rejects setting a locked tool by index', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true, locked: true },
        { name: 'fs_write', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'tools.0',
        value: { name: 'fs_read', enabled: false, visible: false }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('rejects removing a locked tool', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true, locked: true },
        { name: 'fs_write', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools', action: 'remove', index: 0 }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('allows appending a tool', async () => {
      const config = makeConfig()
      const initialLen = config.tools.length
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'tools',
        action: 'append',
        value: { name: 'sys_fetch', enabled: true, visible: true }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.tools).toHaveLength(initialLen + 1)
      expect(config.tools[config.tools.length - 1].name).toBe('sys_fetch')
    })
  })

  // =========================================================================
  // Field validations
  // =========================================================================

  describe('field validations', () => {
    it('validates state against UPDATABLE_STATES', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'state', value: 'suspended' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('state must be one of')
    })

    it('allows valid state', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'state', value: 'idle' }, ws)
      expect(result.isError).toBe(false)
      expect(config.state).toBe('idle')
    })

    it('validates model.temperature range', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'model.temperature', value: 5 }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('model.temperature must be a number between 0 and 2')
    })

    it('validates route path format', async () => {
      const config = makeConfig({ serving: {} })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        action: 'append',
        value: { method: 'GET', path: 'no-slash', lambda: 'lib/api.ts:handler' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Route path must start with "/"')
    })

    it('validates route path not /messages', async () => {
      const config = makeConfig({ serving: {} })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        action: 'append',
        value: { method: 'GET', path: '/messages', lambda: 'lib/api.ts:handler' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('reserved "messages" prefix')
    })

    it('validates lambda format', async () => {
      const config = makeConfig({ serving: {} })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        action: 'append',
        value: { method: 'GET', path: '/test', lambda: 'missingcolon' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Lambda must be in format')
    })

    it('validates trigger target timing exclusivity', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: { scope: 'agent', debounce_ms: 1000, interval_ms: 5000 }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Only one timing modifier')
    })

    it('validates lambda only on system scope targets', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: { scope: 'agent', lambda: 'lib/router.ts:onMessage' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('lambda and warm only allowed on system scope')
    })

    it('validates logging.default_level', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'logging.default_level', value: 'verbose' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('logging.default_level must be one of')
    })

    it('validates shared patterns not starting with messages', async () => {
      const config = makeConfig({ serving: { shared: { enabled: true } } })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.shared.patterns',
        value: ['output/*.json', 'messages/private']
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('must not start with "messages"')
    })
  })

  // =========================================================================
  // Action semantics
  // =========================================================================

  describe('action semantics', () => {
    it('set on primitive field', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'description', value: 'updated' }, ws)
      expect(result.isError).toBe(false)
      expect(config.description).toBe('updated')
    })

    it('set on nested path auto-creates intermediates', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'serving.shared.enabled', value: true }, ws)
      expect(result.isError).toBe(false)
      expect(config.serving?.shared?.enabled).toBe(true)
    })

    it('set on deeply nested path', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'model.temperature', value: 1.5 }, ws)
      expect(result.isError).toBe(false)
      expect(config.model.temperature).toBe(1.5)
    })

    it('append pushes to existing array', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: { scope: 'system', lambda: 'lib/router.ts:handle' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(2)
    })

    it('append creates array when undefined', async () => {
      const config = makeConfig({ serving: {} })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api',
        action: 'append',
        value: { method: 'GET', path: '/status', lambda: 'lib/api.ts:getStatus' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.serving!.api).toHaveLength(1)
    })

    it('append errors on non-array', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'model',
        action: 'append',
        value: 'something'
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('not an array')
    })

    it('remove splices correctly', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = {
        enabled: true,
        targets: [{ scope: 'agent' }, { scope: 'system', lambda: 'lib/router.ts:handle' }]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'remove',
        index: 0
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(1)
      expect(config.triggers.on_inbox!.targets[0].scope).toBe('system')
    })

    it('remove requires index', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'remove'
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('requires index')
    })

    it('remove errors on out-of-bounds index', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'remove',
        index: 5
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('out of bounds')
    })
  })

  // =========================================================================
  // Numeric path indexing
  // =========================================================================

  describe('numeric path indexing', () => {
    it('updates specific target by index', async () => {
      const config = makeConfig()
      config.triggers.on_task_complete = {
        enabled: true,
        targets: [
          { scope: 'agent' },
          { scope: 'agent' },
          { scope: 'agent' }
        ]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_task_complete.targets.2',
        value: { scope: 'system', lambda: 'lib/task.ts:onComplete' }
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_task_complete!.targets[2].scope).toBe('system')
      expect(config.triggers.on_task_complete!.targets[2].lambda).toBe('lib/task.ts:onComplete')
    })

    it('updates a field on a specific target', async () => {
      const config = makeConfig()
      config.triggers.on_task_complete = {
        enabled: true,
        targets: [
          { scope: 'agent' },
          { scope: 'agent' },
          { scope: 'agent', filter: { status: 'pending' } }
        ]
      }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_task_complete.targets.2.filter.status',
        value: 'approved'
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_task_complete!.targets[2].filter!.status).toBe('approved')
    })

    it('updates a specific route field', async () => {
      const config = makeConfig({
        serving: {
          api: [
            { method: 'GET', path: '/api/status', lambda: 'lib/api.ts:getStatus' }
          ]
        }
      })
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'serving.api.0.warm',
        value: true
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.serving!.api![0].warm).toBe(true)
    })

    it('errors on out-of-bounds array index in path', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [{ scope: 'agent' }] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets.5',
        value: { scope: 'agent' }
      }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('out of bounds')
    })
  })

  // =========================================================================
  // New capabilities (previously blocked by whitelist)
  // =========================================================================

  describe('expanded config access', () => {
    it('updates model.model_id', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'model.model_id', value: 'claude-sonnet-4-20250514' }, ws)
      expect(result.isError).toBe(false)
      expect(config.model.model_id).toBe('claude-sonnet-4-20250514')
    })

    it('updates instructions', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'instructions', value: 'New instructions' }, ws)
      expect(result.isError).toBe(false)
      expect(config.instructions).toBe('New instructions')
    })

    it('updates security fields', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'security.allow_unsigned', value: false }, ws)
      expect(result.isError).toBe(false)
      expect(config.security.allow_unsigned).toBe(false)
    })

    it('updates limits fields', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'limits.max_active_turns', value: 10 }, ws)
      expect(result.isError).toBe(false)
      expect(config.limits.max_active_turns).toBe(10)
    })

    it('updates messaging fields', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'messaging.receive', value: true }, ws)
      expect(result.isError).toBe(false)
      expect(config.messaging.receive).toBe(true)
    })

    it('updates name', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'name', value: 'New Name' }, ws)
      expect(result.isError).toBe(false)
      expect(config.name).toBe('New Name')
    })

    it('updates autonomous', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'autonomous', value: true }, ws)
      expect(result.isError).toBe(false)
      expect(config.autonomous).toBe(true)
    })
  })

  // =========================================================================
  // LLM coercion
  // =========================================================================

  describe('LLM value coercion', () => {
    it('coerces string "true" to boolean', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'autonomous', value: 'true' }, ws)
      expect(result.isError).toBe(false)
      expect(config.autonomous).toBe(true)
    })

    it('coerces string "false" to boolean', async () => {
      const config = makeConfig({ autonomous: true } as Partial<AgentConfig>)
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'autonomous', value: 'false' }, ws)
      expect(result.isError).toBe(false)
      expect(config.autonomous).toBe(false)
    })

    it('coerces JSON string objects', async () => {
      const config = makeConfig()
      config.triggers.on_inbox = { enabled: true, targets: [] }
      const ws = mockWorkspace(config)
      const result = await tool.execute({
        path: 'triggers.on_inbox.targets',
        action: 'append',
        value: '{"scope":"agent"}'
      }, ws)
      expect(result.isError).toBe(false)
      expect(config.triggers.on_inbox!.targets).toHaveLength(1)
      expect(config.triggers.on_inbox!.targets[0].scope).toBe('agent')
    })
  })

  // =========================================================================
  // Name-based array indexing
  // =========================================================================

  describe('name-based array indexing', () => {
    it('resolves tool by name instead of index', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'fs_write', enabled: true, visible: true },
        { name: 'sys_code', enabled: false, visible: false }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.sys_code.enabled', value: true }, ws)
      expect(result.isError).toBe(false)
      expect(config.tools[2].enabled).toBe(true)
    })

    it('updates tool visibility by name', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: false }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.fs_read.visible', value: true }, ws)
      expect(result.isError).toBe(false)
      expect(config.tools[0].visible).toBe(true)
    })

    it('errors on non-existent name', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.nonexistent.enabled', value: true }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain("No element named 'nonexistent'")
    })

    it('still works with numeric index', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'fs_write', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.1.enabled', value: false }, ws)
      expect(result.isError).toBe(false)
      expect(config.tools[1].enabled).toBe(false)
    })

    it('respects locked: true when accessed by name', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true, locked: true },
        { name: 'fs_write', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.fs_read.enabled', value: false }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('locked')
    })

    it('rejects setting restricted by tool name (self-protection)', async () => {
      const config = makeConfig()
      config.tools = [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'sys_code', enabled: true, visible: true }
      ]
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'tools.sys_code.restricted', value: true }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('restriction')
    })
  })

  // =========================================================================
  // Error messages include hint
  // =========================================================================

  describe('error messages', () => {
    it('includes sys_get_config hint on error', async () => {
      const config = makeConfig()
      const ws = mockWorkspace(config)
      const result = await tool.execute({ path: 'adf_version', value: '0.3' }, ws)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('sys_get_config')
    })
  })
})
