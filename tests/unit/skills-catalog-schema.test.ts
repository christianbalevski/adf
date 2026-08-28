import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseSkillsCatalogDocument } from '../../src/shared/schemas/skills-catalog.schema'

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'soul-creation',
    description: 'Give an agent a distinct voice.',
    path: 'skills/soul-creation/SKILL.md',
    raw_url: 'https://example.test/skills/soul-creation/SKILL.md',
    ...overrides
  }
}

function doc(skills: unknown[], overrides: Record<string, unknown> = {}) {
  return { schema: 1, skills, ...overrides }
}

describe('parseSkillsCatalogDocument', () => {
  it('parses a well-formed catalog', () => {
    const parsed = parseSkillsCatalogDocument(doc([entry()], { publisher: 'adf' }))
    expect(parsed).not.toBeNull()
    expect(parsed!.entries).toHaveLength(1)
    expect(parsed!.entries[0].name).toBe('soul-creation')
    expect(parsed!.publisher).toBe('adf')
    expect(parsed!.dropped).toBe(0)
  })

  it('parses the first-party catalog shipped in this repo', () => {
    const raw = readFileSync(join(__dirname, '../../skills/registry.json'), 'utf8')
    const parsed = parseSkillsCatalogDocument(JSON.parse(raw))
    expect(parsed).not.toBeNull()
    expect(parsed!.dropped).toBe(0)
    expect(parsed!.entries.length).toBeGreaterThan(0)
    for (const skill of parsed!.entries) {
      expect(skill.raw_url).toMatch(/^https:\/\//)
    }
  })

  it('rejects documents it cannot trust as a whole', () => {
    expect(parseSkillsCatalogDocument(null)).toBeNull()
    expect(parseSkillsCatalogDocument([entry()])).toBeNull()
    expect(parseSkillsCatalogDocument(doc([], { schema: 2 }))).toBeNull()
    expect(parseSkillsCatalogDocument(doc([], { schema: 0 }))).toBeNull()
    expect(parseSkillsCatalogDocument(doc([], { schema: '1' }))).toBeNull()
    expect(parseSkillsCatalogDocument({ schema: 1 })).toBeNull()
  })

  // The Studio browser and skill_install must agree on which catalogs are
  // usable: a document one accepts and the other refuses is a bug report
  // waiting to happen. Both read "schema absent" as schema 1.
  it('accepts a document with no schema field, exactly as skill_install does', () => {
    const parsed = parseSkillsCatalogDocument({ skills: [entry()] })
    expect(parsed).not.toBeNull()
    expect(parsed!.entries.map((e) => e.name)).toEqual(['soul-creation'])
  })

  it('drops an entry carrying control or bidi-override characters', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry(),
      // U+202E right-to-left override: renders "…nur" as "run…" in the panel.
      entry({ name: 'bidi-name', description: 'Safe looking\u202E gnihtemos esle' }),
      entry({ name: 'control-desc', description: 'line one\r\nline two' }),
      entry({ name: 'bidi-path', path: 'skills/\u202Eevil/SKILL.md' }),
    ]))
    expect(parsed!.entries.map((e) => e.name)).toEqual(['soul-creation'])
    expect(parsed!.dropped).toBe(3)
  })

  it('drops individual bad entries instead of failing the document', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry(),
      entry({ name: 'Not Kebab' }),
      entry({ name: 'no-url', raw_url: 'not a url' }),
      entry({ name: 'no-description', description: '' }),
      { nonsense: true }
    ]))
    expect(parsed!.entries.map((e) => e.name)).toEqual(['soul-creation'])
    expect(parsed!.dropped).toBe(4)
  })

  it('collapses duplicate names to the first occurrence', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry({ description: 'first' }),
      entry({ description: 'second' })
    ]))
    expect(parsed!.entries).toHaveLength(1)
    expect(parsed!.entries[0].description).toBe('first')
    expect(parsed!.dropped).toBe(1)
  })

  it('keeps entries carrying fields this build does not know', () => {
    const parsed = parseSkillsCatalogDocument(doc([entry({ future_field: { a: 1 } })]))
    expect(parsed!.entries).toHaveLength(1)
    expect(parsed!.dropped).toBe(0)
  })

  it('treats path as optional', () => {
    const parsed = parseSkillsCatalogDocument(doc([{
      name: 'minimal',
      description: 'A minimal entry.',
      raw_url: 'https://example.test/minimal/SKILL.md'
    }]))
    expect(parsed!.entries).toHaveLength(1)
    expect(parsed!.entries[0].path).toBeUndefined()
  })
})
