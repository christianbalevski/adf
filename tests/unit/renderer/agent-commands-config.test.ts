import { describe, expect, it } from 'vitest'
import { AGENT_COMMANDS_SECTION_LOCK, agentCommandsSaveError, agentCommandsDraftFromConfig, agentCommandsConfigFromDraft, validateAgentCommandsDraft } from '../../../src/renderer/components/agent/agent-commands-config'
import { validateAgentCommands } from '../../../src/shared/utils/agent-commands'
import { configNavGroupOf } from '../../../src/renderer/components/agent/config-nav-model'
const command = { name: 'weather', description: 'Forecast', usage: '<city>', lambda: 'lib/weather.ts:run', locked: true }
describe('commands config editor model', () => {
  it('round-trips optional fields and locks without mutating the source', () => {
    const draft = agentCommandsDraftFromConfig([command])
    expect(agentCommandsConfigFromDraft(draft)).toEqual([command])
    draft[0].name = 'new-name'
    expect(command.name).toBe('weather')
    expect(agentCommandsDraftFromConfig()).toEqual([])
  })
  it('uses the shared messages and blocks saves on validation errors', () => {
    const draft = [{ ...command, name: 'stop', lambda: 'lib/weather.ts' }]
    const result = validateAgentCommandsDraft(draft)
    expect(result.errors).toEqual(validateAgentCommands(draft))
    expect(result.canSave).toBe(false)
    expect(result.commands).toBeUndefined()
  })
  it('missing files warn without preventing save', () => {
    const result = validateAgentCommandsDraft([command], [])
    expect(result.canSave).toBe(true)
    expect(result.commands).toEqual([command])
    expect(result.errors).toEqual([])
    expect(result.warnings[0].message).toContain('create it later')
    expect(validateAgentCommandsDraft([command], ['lib/weather.ts']).warnings).toEqual([])
    expect(validateAgentCommandsDraft([command]).warnings).toEqual([])
  })
  it('guards every config save and allows missing-file warnings', () => {
    expect(agentCommandsSaveError([{ ...command, name: 'stop' }])).toContain('built-in command')
    expect(agentCommandsSaveError([command])).toBeNull()
    expect(agentCommandsSaveError()).toBeNull()
  })
  it('uses the commands section lock and Automation navigation group', () => {
    expect(AGENT_COMMANDS_SECTION_LOCK).toBe('commands')
    expect(configNavGroupOf('Commands')).toBe('Automation')
  })
})

it.each([null, command, { secret: 'retain me' }, [null, { name: {} }]])('retains malformed data visibly and blocks accidental saves: %j', commands => {
  const draft = agentCommandsDraftFromConfig(commands)
  expect(draft.length).toBeGreaterThan(0)
  expect(draft.every(row => typeof row.malformed === 'string')).toBe(true)
  expect(validateAgentCommandsDraft(draft).canSave).toBe(false)
  expect(validateAgentCommandsDraft(draft).commands).toBeUndefined()
  expect(agentCommandsSaveError(commands)).not.toBeNull()
  expect(validateAgentCommandsDraft([]).canSave).toBe(true)
})
