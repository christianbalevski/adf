import { describe, it, expect } from 'vitest'
import { SysUpdateConfigTool } from '../../../src/main/tools/built-in/sys-update-config.tool'
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from '../../../src/shared/types/adf-v02.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
const command = { name: 'weather', description: 'Forecast', lambda: 'lib/a.ts:run' }
function setup(commands?: AgentConfig['commands']) {
  const config = { ...structuredClone(AGENT_DEFAULTS), tools: structuredClone(DEFAULT_TOOLS), adf_version: '0.2', id: 'test', name: 'Test', state: 'active', metadata: { created_at: '', updated_at: '' }, commands: commands ? structuredClone(commands) : undefined } as AgentConfig
  const workspace = { getAgentConfig: () => config, setAgentConfig: (next: AgentConfig) => Object.assign(config, next), readFile: (file: string) => file === 'lib/a.ts' ? 'export function run() {}' : null } as unknown as AdfWorkspace
  const tool = new SysUpdateConfigTool()
  return { config, run: (input: unknown) => tool.execute(input, workspace) }
}
describe('sys_update_config commands', () => {
  it('appends, resolves by name, refuses missing files and duplicates', async () => {
    const { config, run } = setup()
    expect((await run({ path: 'commands', action: 'append', value: command })).isError).toBe(false)
    expect((await run({ path: 'commands.weather.lambda', value: 'lib/a.ts:other' })).isError).toBe(false)
    expect(config.commands?.[0].lambda).toBe('lib/a.ts:other')
    expect((await run({ path: 'commands.weather.lambda', value: 'lib/missing.ts:run' })).content).toContain('Write it first, then register the command.')
    expect((await run({ path: 'commands', action: 'append', value: command })).isError).toBe(true)
  })
  it('prevents changing, removing and unlocking owner locked commands', async () => {
    for (const input of [{ path: 'commands.weather.description', value: 'Changed' }, { path: 'commands', action: 'remove', index: 0 }, { path: 'commands.weather.locked', value: false }, { path: 'commands', value: [] }]) {
      const { config, run } = setup([{ ...command, locked: true }])
      expect((await run(input)).isError).toBe(true)
      expect(config.commands).toEqual([{ ...command, locked: true }])
    }
  })
  it('only permits authorized callers to set owner locks through every write shape', async () => {
    for (const input of [{ path: 'commands', action: 'append', value: { ...command, locked: true } }, { path: 'commands.0', value: { ...command, locked: true } }, { path: 'commands.weather.locked', value: true }]) {
      const { run } = setup(input.action === 'append' ? [] : [command])
      expect((await run(input)).content).toContain('Only the owner can lock a command.')
      expect((await run({ ...input, _authorized: true })).isError).toBe(false)
    }
  })
  it('enforces the commands section lock and allows authorized owner lock edits', async () => {
    const { config, run } = setup([command])
    config.locked_fields = ['commands']
    expect((await run({ path: 'commands.weather.description', value: 'Changed' })).isError).toBe(true)
    expect((await run({ path: 'commands.weather.description', value: 'Changed', _authorized: true })).isError).toBe(false)
    expect((await run({ path: 'commands.weather.locked', value: true, _authorized: true })).isError).toBe(false)
    expect((await run({ path: 'commands.weather.locked', value: false, _authorized: true })).isError).toBe(false)
  })
  it('accepts valid array replacements while preventing owner lock fabrication through protection override', async () => {
    const { config, run } = setup([command])
    expect((await run({ path: 'commands', value: [{ ...command, description: 'Changed' }] })).isError).toBe(false)
    expect(config.commands?.[0].description).toBe('Changed')
    expect((await run({ path: 'commands', value: [{ ...command, locked: true }], _protection_override: true })).content).toContain('Only the owner can lock a command.')
    expect(config.commands?.[0].locked).toBeUndefined()
  })
  it('keeps unrelated edits possible with existing invalid commands', async () => {
    const { run } = setup([{ ...command, name: 'stop' }])
    expect((await run({ path: 'description', value: 'Updated' })).isError).toBe(false)
  })
})
