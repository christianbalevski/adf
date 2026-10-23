import { describe, it, expect } from 'vitest'
import { parseLambdaRef, parseAuthorizeToken, validateAgentCommands, RESERVED_COMMAND_NAMES } from '../../../src/shared/utils/agent-commands'
const command = (name: string) => ({ name, description: 'Test', lambda: 'lib/a.b.ts:run' })
describe('agent command shared rules', () => {
  it('accepts valid names and rejects malformed names', () => {
    for (const name of ['a', 'weather', 'deploy-prod']) expect(validateAgentCommands([command(name)])).toEqual([])
    for (const name of ['A', '9x', 'x-', 'a'.repeat(33), '/x', 'two words']) expect(validateAgentCommands([command(name)]).some(i => i.field === 'name')).toBe(true)
  })
  it('reserves builtins and rejects case-insensitive duplicates', () => {
    for (const name of RESERVED_COMMAND_NAMES) expect(validateAgentCommands([command(name)])[0].message).toContain('built-in command')
    expect(validateAgentCommands([command('x'), command('X')]).some(i => i.message.includes('duplicated'))).toBe(true)
  })
  it('requires explicit safe function and file extension', () => {
    for (const ref of ['lib/a.ts', 'a.ts:x-y', 'a.ts:x;y', 'a.txt:run']) expect(parseLambdaRef(ref)).toHaveProperty('error')
    expect(parseLambdaRef('lib/a.b.ts:run')).toEqual({ file: 'lib/a.b.ts', fn: 'run' })
  })
  it('extracts every standalone authorization token and unescapes literals', () => {
    expect(parseAuthorizeToken('!authorize x !authorize y !authorize')).toEqual({ args: 'x y', authorize: true })
    expect(parseAuthorizeToken('\\!authorize !authorized x!authorize')).toEqual({ args: '!authorize !authorized x!authorize', authorize: false })
  })
})

it.each([null, {}, 'commands'])('reports non-array commands without throwing: %j', value => {
  expect(validateAgentCommands(value)[0]).toMatchObject({ field: 'commands' })
})
