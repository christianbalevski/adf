import { describe, it, expect } from 'vitest'
import {
  buildSlashCommands,
  completionText,
  composeSkillMessage,
  fallbackSkillMessage,
  filterSlashCommands,
  isSlashInput,
  matchSlashCommand,
  needsArgument,
  parseSkillInterface,
  skillInterfacePath,
  slashQuery,
  BUILTIN_COMMANDS
} from '../../../src/renderer/utils/slash-commands'
import type { RegistryEntry } from '../../../src/renderer/utils/skills-panel'

/**
 * The decisions behind the composer's `/` palette (design doc §5).
 *
 * The invariant every case here defends: a skill command composes TEXT. It
 * never runs anything, so the only way it can go wrong is by putting words in
 * the human's mouth — a template spliced badly, an unparsed YAML guessed at, or
 * a typed line silently swallowed by a command that did not match it.
 */

const entry = (over: Partial<RegistryEntry> & { name: string }): RegistryEntry => ({
  description: 'does a thing',
  path: `skills/${over.name}/SKILL.md`,
  enabled: true,
  ...over
})

const commands = buildSlashCommands([
  entry({ name: 'agent-memory', description: 'Remember things across sessions.' }),
  entry({ name: 'soul-creation', description: undefined, enabled: false })
])

describe('isSlashInput / slashQuery', () => {
  it('only a single line starting with a slash is a command line', () => {
    expect(isSlashInput('/comp')).toBe(true)
    expect(isSlashInput('/')).toBe(true)
    expect(isSlashInput('hello /comp')).toBe(false)
    expect(isSlashInput('')).toBe(false)
  })

  it('stops being a command line the moment it becomes prose', () => {
    expect(isSlashInput('/compact\nand then some')).toBe(false)
    expect(isSlashInput('/' + 'x'.repeat(5000))).toBe(false)
  })

  it('collapses the typed words into a filter query', () => {
    expect(slashQuery('/skills   disable  foo')).toBe('skills disable foo')
    expect(slashQuery('/')).toBe('')
  })
})

describe('matchSlashCommand', () => {
  it('prefers the longest command, so a sub-command is not read as an argument', () => {
    const match = matchSlashCommand('/skills disable agent-memory', commands)
    expect(match?.command.key).toBe('skills disable')
    expect(match?.args).toBe('agent-memory')
  })

  it('still resolves the short form of the same prefix', () => {
    expect(matchSlashCommand('/skills', commands)?.command.key).toBe('skills')
  })

  it('takes everything after the command words as arguments', () => {
    const match = matchSlashCommand('/agent-memory  what did we decide?', commands)
    expect(match?.command.kind).toBe('skill')
    expect(match?.args).toBe('what did we decide?')
  })

  it('returns null for anything it does not recognize, so the text is sent literally', () => {
    expect(matchSlashCommand('/not-a-command please', commands)).toBeNull()
    expect(matchSlashCommand('/', commands)).toBeNull()
    expect(matchSlashCommand('plain message', commands)).toBeNull()
    expect(matchSlashCommand('/compact\nsecond line', commands)).toBeNull()
  })

  it('agrees with the palette about what a command line is', () => {
    // The composer matches on the raw input for exactly this reason: a line the
    // palette never opened for must not run on Enter either.
    expect(isSlashInput(' /compact')).toBe(false)
    expect(matchSlashCommand(' /compact', commands)).toBeNull()
    expect(matchSlashCommand('/compact  ', commands)?.args).toBe('')
  })
})

describe('buildSlashCommands', () => {
  it('lists every built-in, then the skills alphabetically', () => {
    expect(commands.slice(0, BUILTIN_COMMANDS.length).map((c) => c.key))
      .toEqual(BUILTIN_COMMANDS.map((c) => c.key))
    expect(commands.slice(BUILTIN_COMMANDS.length).map((c) => c.key))
      .toEqual(['agent-memory', 'soul-creation'])
  })

  it('keeps a muted skill invocable but marks it and drops its description', () => {
    const muted = commands.find((c) => c.key === 'soul-creation')
    expect(muted?.muted).toBe(true)
    expect(muted?.description).toContain('muted')
  })

  it('drops a name that does not survive sanitizing — it could not be typed anyway', () => {
    const built = buildSlashCommands([
      entry({ name: 'ev‮ll' }),
      entry({ name: 'two words' }),
      entry({ name: '' })
    ])
    expect(built.map((c) => c.key)).toEqual(BUILTIN_COMMANDS.map((c) => c.key))
  })

  it('never lets a skill shadow a built-in', () => {
    const built = buildSlashCommands([entry({ name: 'skills', description: 'impostor' })])
    expect(built.filter((c) => c.key === 'skills')).toHaveLength(1)
    expect(built.find((c) => c.key === 'skills')?.kind).toBe('builtin')
  })
})

describe('filterSlashCommands', () => {
  it('shows everything before anything is typed', () => {
    expect(filterSlashCommands(commands, '')).toHaveLength(commands.length)
  })

  it('highlights the command that will actually run, not its shorter prefix', () => {
    // LIVE BUG this covers: with `/skills disable foo` typed, both `/skills`
    // and `/skills disable` are fully typed. Ranking the short one first put
    // the highlight on "open the panel" while Enter would disable a skill.
    expect(filterSlashCommands(commands, 'skills disable foo')[0].key).toBe('skills disable')
  })

  it('keeps the plain command on top while its own word is exactly typed', () => {
    expect(filterSlashCommands(commands, 'skills')[0].key).toBe('skills')
  })

  it('ranks a half-typed command by list order', () => {
    expect(filterSlashCommands(commands, 'comp')[0].key).toBe('compact')
    expect(filterSlashCommands(commands, 'agent')[0].key).toBe('agent-memory')
  })

  it('falls back to the description, so a skill is findable by what it does', () => {
    const found = filterSlashCommands(commands, 'across sessions')
    expect(found.map((c) => c.key)).toEqual(['agent-memory'])
  })

  it('returns nothing for a line that matches nothing', () => {
    expect(filterSlashCommands(commands, 'zzz-nothing')).toEqual([])
  })
})

describe('needsArgument / completionText', () => {
  it('a row with a placeholder waits for its argument', () => {
    const disable = commands.find((c) => c.key === 'skills disable')!
    expect(needsArgument(disable, '')).toBe(true)
    expect(needsArgument(disable, ' alpha ')).toBe(false)
    expect(needsArgument(commands.find((c) => c.key === 'compact')!, '')).toBe(false)
  })

  it('completing a row leaves the cursor after a space', () => {
    expect(completionText(commands.find((c) => c.key === 'skills enable')!)).toBe('/skills enable ')
  })
})

describe('parseSkillInterface', () => {
  // The real shape, from skills/adf-skill-creator/agents/openai.yaml.
  const real = [
    'interface:',
    '  display_name: "Create ADF Skill"',
    '  short_description: "Create portable skills for ADF agents"',
    '  default_prompt: "Use $adf-skill-creator to create a portable skill for an ADF agent."',
    ''
  ].join('\n')

  it('reads the three fields the convention defines', () => {
    expect(parseSkillInterface(real)).toEqual({
      display_name: 'Create ADF Skill',
      short_description: 'Create portable skills for ADF agents',
      default_prompt: 'Use $adf-skill-creator to create a portable skill for an ADF agent.'
    })
  })

  it('accepts unquoted scalars, single quotes, and comments', () => {
    expect(parseSkillInterface([
      '# a package that comments its own metadata',
      'interface:  # the block Studio reads',
      "  display_name: 'Bob''s Skill'",
      '  default_prompt: Use $bob to do things   # trailing note',
      'other:',
      '  default_prompt: "not in the interface block"'
    ].join('\n'))).toEqual({
      display_name: "Bob's Skill",
      default_prompt: 'Use $bob to do things'
    })
  })

  it('ignores keys and structures it does not understand rather than guessing', () => {
    expect(parseSkillInterface([
      'interface:',
      '  display_name: "Kept"',
      '  tags: [a, b]',
      '  nested:',
      '    deep: value',
      '  default_prompt: |',
      '    a block scalar is not a one-line prompt'
    ].join('\n'))).toEqual({ display_name: 'Kept' })
  })

  it('treats an absent, empty, oversized, or interface-less document as absent', () => {
    expect(parseSkillInterface(null)).toBeNull()
    expect(parseSkillInterface('')).toBeNull()
    expect(parseSkillInterface('name: thing\ndescription: other')).toBeNull()
    expect(parseSkillInterface('interface:\n' + '  display_name: "x"\n'.repeat(2000))).toBeNull()
  })

  it('sanitizes the text it hands back — a package is remote data', () => {
    const parsed = parseSkillInterface('interface:\n  display_name: "we‮ird"')
    expect(parsed?.display_name).toBe('we ird')
  })

  it('names the file it reads', () => {
    expect(skillInterfacePath('agent-memory')).toBe('skills/agent-memory/agents/openai.yaml')
  })
})

describe('composeSkillMessage', () => {
  const iface = { default_prompt: 'Use $adf-skill-creator to create a portable skill for an ADF agent.' }

  it('expands the $name token into a plain reference when no task is typed', () => {
    expect(composeSkillMessage('adf-skill-creator', iface, ''))
      .toBe('Use the adf-skill-creator skill to create a portable skill for an ADF agent.')
  })

  it('replaces the template task with what the human typed', () => {
    expect(composeSkillMessage('adf-skill-creator', iface, 'wrap our deploy runbook'))
      .toBe('Use the adf-skill-creator skill to wrap our deploy runbook.')
  })

  it('does not double up punctuation the human already wrote', () => {
    expect(composeSkillMessage('adf-skill-creator', iface, 'what does it do?'))
      .toBe('Use the adf-skill-creator skill to what does it do?')
  })

  it('falls back to the generic wording with no usable template', () => {
    expect(composeSkillMessage('agent-memory', null, 'recall the decision'))
      .toBe('Use the agent-memory skill for: recall the decision')
    expect(composeSkillMessage('agent-memory', null, '')).toBe('Use the agent-memory skill.')
    expect(composeSkillMessage('agent-memory', { default_prompt: '   ' }, '')).toBe('Use the agent-memory skill.')
  })

  it('falls back rather than mangling a template it cannot splice a task into', () => {
    const odd = { default_prompt: '$agent-memory remembers things.' }
    expect(composeSkillMessage('agent-memory', odd, '')).toBe('the agent-memory skill remembers things.')
    expect(composeSkillMessage('agent-memory', odd, 'recall it'))
      .toBe('Use the agent-memory skill for: recall it')
  })

  it('splices at the template task, not at a " to " inside the skill reference', () => {
    const iffy = { default_prompt: 'Use $how-to-ship to ship a release.' }
    expect(composeSkillMessage('how-to-ship', iffy, 'cut 2.1'))
      .toBe('Use the how-to-ship skill to cut 2.1.')
  })

  it('sanitizes a template before it becomes a message', () => {
    const evil = { default_prompt: 'Use $x to do‮ things.' }
    expect(composeSkillMessage('x', evil, '')).toBe('Use the x skill to do things.')
  })

  it('matches the documented fallback wording exactly', () => {
    expect(fallbackSkillMessage('alpha', ' beta ')).toBe('Use the alpha skill for: beta')
    expect(fallbackSkillMessage('alpha', '')).toBe('Use the alpha skill.')
  })
})
