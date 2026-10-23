import { describe, it, expect } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { AgentCommandSchema, AgentCommandsSchema, AgentConfigSchema } from '../../../src/main/adf/adf-schema'
import { mergeTemplateWithOverrides } from '../../../src/main/adf/adf-template'
import { AGENT_DEFAULTS } from '../../../src/shared/types/adf-v02.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
const command = { name: 'weather', description: 'Forecast', lambda: 'lib/a.ts:run' }
describe('commands schema and templates', () => {
  it('keeps config object shape and JSON schema constraints', () => {
    expect(AgentConfigSchema.shape.commands).toBeDefined()
    const schema = zodToJsonSchema(AgentCommandSchema) as any
    expect(schema.properties.name.pattern).toBeDefined()
    expect(schema.properties.name.description).toContain('compact')
    expect(AgentCommandsSchema.safeParse([{ ...command, name: 'stop' }]).success).toBe(false)
    expect(AgentCommandsSchema.safeParse([command, command]).success).toBe(false)
  })
  it('carries locked commands forward and refuses overriding them', () => {
    const config = { ...AGENT_DEFAULTS, name: 'Test', commands: [{ ...command, locked: true }] } as AgentConfig
    const merged = mergeTemplateWithOverrides(config, { commands: [] })
    expect(merged.ok && merged.options.commands).toEqual(config.commands)
    expect(mergeTemplateWithOverrides(config, { commands: [command] }).ok).toBe(false)
    config.locked_fields = ['commands']
    expect(mergeTemplateWithOverrides(config, { commands: [] }).ok).toBe(false)
  })
})
