import { describe, it, expect } from 'vitest'
import {
  isCatalogUrl,
  mergeDisabledList,
  parseSkillsRegistry,
  sanitizeDisplayText
} from '../../../src/renderer/utils/skills-panel'

/**
 * The decisions the Skills panel depends on.
 *
 * LIVE BUG these cover: the panel rewrote skills-state.json as a whole document
 * (`{schema, disabled}`), so any other key in the file — a newer schema field,
 * an agent's own annotation — was destroyed by a human clicking a mute
 * checkbox.
 */

describe('mergeDisabledList', () => {
  it('preserves keys it does not understand', () => {
    const existing = JSON.stringify({ schema: 1, note: 'hand-written', disabled: ['alpha'], extra: { a: 1 } })
    const merged = JSON.parse(mergeDisabledList(existing, 'beta', false))
    expect(merged.note).toBe('hand-written')
    expect(merged.extra).toEqual({ a: 1 })
    expect(merged.disabled).toEqual(['alpha', 'beta'])
    expect(merged.schema).toBe(1)
  })

  it('unmuting removes only the named skill', () => {
    const existing = JSON.stringify({ schema: 1, disabled: ['alpha', 'beta'] })
    expect(JSON.parse(mergeDisabledList(existing, 'alpha', true)).disabled).toEqual(['beta'])
  })

  it('is idempotent and keeps the list sorted and deduplicated', () => {
    const once = mergeDisabledList(JSON.stringify({ schema: 1, disabled: ['zeta', 'alpha', 'alpha'] }), 'mid', false)
    expect(JSON.parse(once).disabled).toEqual(['alpha', 'mid', 'zeta'])
    expect(mergeDisabledList(once, 'mid', false)).toBe(once)
  })

  it('starts a fresh document when the state file is absent or corrupt', () => {
    expect(JSON.parse(mergeDisabledList(null, 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
    expect(JSON.parse(mergeDisabledList('{ not json', 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
    expect(JSON.parse(mergeDisabledList('[1,2,3]', 'alpha', false))).toEqual({ schema: 1, disabled: ['alpha'] })
  })

  it('drops non-string entries rather than writing them back', () => {
    const existing = JSON.stringify({ schema: 1, disabled: ['alpha', 7, null] })
    expect(JSON.parse(mergeDisabledList(existing, 'beta', false)).disabled).toEqual(['alpha', 'beta'])
  })

  it('writes a trailing newline, like every other generated file', () => {
    expect(mergeDisabledList(null, 'alpha', false).endsWith('\n')).toBe(true)
  })
})

describe('parseSkillsRegistry', () => {
  const registry = (extra: Record<string, unknown> = {}) => JSON.stringify({
    schema: 1,
    skills: {
      beta: { name: 'beta', description: 'second', path: 'skills/beta/SKILL.md', enabled: true },
      alpha: { name: 'alpha', path: 'skills/alpha/SKILL.md', enabled: false }
    },
    ...extra
  })

  it('sorts entries and treats a missing description as muted-or-undescribed', () => {
    const parsed = parseSkillsRegistry(registry())
    expect(parsed?.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(parsed?.entries[0]).toMatchObject({ enabled: false, description: undefined })
    expect(parsed?.rejected).toEqual([])
  })

  it('reads the indexer rejection list and derives the package name from the path', () => {
    const parsed = parseSkillsRegistry(registry({
      rejected: [
        { path: 'skills/Broken Name/SKILL.md', reason: 'invalid skill name' },
        { path: 'skills/huge/SKILL.md', reason: 'exceeds 262144 bytes' },
        { path: 'skills/nested/deep/SKILL.md', reason: 'not a package manifest' },
        { path: 'skills/bad/SKILL.md' },
        'nonsense'
      ]
    }))
    expect(parsed?.rejected).toEqual([
      { path: 'skills/Broken Name/SKILL.md', reason: 'invalid skill name', name: 'Broken Name' },
      { path: 'skills/huge/SKILL.md', reason: 'exceeds 262144 bytes', name: 'huge' },
      { path: 'skills/nested/deep/SKILL.md', reason: 'not a package manifest', name: null }
    ])
  })

  it('treats an unreadable or newer registry as absent', () => {
    expect(parseSkillsRegistry(null)).toBeNull()
    expect(parseSkillsRegistry('{ not json')).toBeNull()
    expect(parseSkillsRegistry(JSON.stringify({ schema: 2, skills: {} }))).toBeNull()
    expect(parseSkillsRegistry(JSON.stringify({ schema: 1 }))).toBeNull()
  })
})

describe('sanitizeDisplayText', () => {
  it('strips the bidi overrides that let a name lie about itself', () => {
    expect(sanitizeDisplayText('evil-\u202Egnp.dm')).toBe('evil- gnp.dm')
    expect(sanitizeDisplayText('a\u2066b\u2069c')).toBe('a b c')
  })

  it('collapses control characters and newlines into a single line', () => {
    expect(sanitizeDisplayText('one\r\ntwo\u0000three')).toBe('one two three')
  })

  it('passes ordinary text through untouched', () => {
    expect(sanitizeDisplayText('Draft a weekly report')).toBe('Draft a weekly report')
    expect(sanitizeDisplayText(undefined)).toBe('')
  })
})

describe('catalog URLs', () => {
  // The catalog browser's URL box is the only place a catalog is named now;
  // guarded-fetch refuses everything but https, so the box says so first.
  it('accepts only https URLs', () => {
    expect(isCatalogUrl('https://example.com/registry.json')).toBe(true)
    expect(isCatalogUrl('http://example.com/registry.json')).toBe(false)
    expect(isCatalogUrl('file:///etc/passwd')).toBe(false)
    expect(isCatalogUrl('example.com')).toBe(false)
    expect(isCatalogUrl('   ')).toBe(false)
  })
})
