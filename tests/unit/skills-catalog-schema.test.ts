import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  MAX_PACKAGE_FILES,
  parseSkillsCatalogDocument,
  resolvePackageFilePath
} from '../../src/shared/schemas/skills-catalog.schema'

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

  // Catalogs in the wild omit `schema`. Refusing them would make the Studio
  // browser show nothing for a document an agent reading the same URL with
  // sys_fetch would parse fine.
  it('accepts a document with no schema field', () => {
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

/**
 * `files` is the package manifest: every path in it becomes a VFS write under
 * `skills/<name>/` when a human clicks Install, so it is validated with the same
 * confinement the deleted `skill_install` tool enforced. The rule these cover is
 * that a catalog can name what it ships and nothing else — one path that escapes
 * the package costs the publisher the whole entry.
 */
describe('resolvePackageFilePath', () => {
  it('normalizes both the relative and the fully-qualified form', () => {
    expect(resolvePackageFilePath('soul-creation', 'references/example.md')).toBe('references/example.md')
    expect(resolvePackageFilePath('soul-creation', 'skills/soul-creation/references/example.md'))
      .toBe('references/example.md')
    expect(resolvePackageFilePath('soul-creation', './scripts/run.js')).toBe('scripts/run.js')
    expect(resolvePackageFilePath('soul-creation', '  agents/openai.yaml  ')).toBe('agents/openai.yaml')
  })

  it('refuses anything that leaves the package', () => {
    for (const escape of [
      '../evil.md',
      'scripts/../../evil.md',
      '/etc/passwd',
      'skills/other/SKILL.md/../../../mind.md',
      '..',
      './',
      '',
      '   ',
      'scripts/./run.js'
    ]) {
      expect(resolvePackageFilePath('soul-creation', escape), escape).toBeNull()
    }
  })

  it('refuses backslash smuggling and odd segment characters', () => {
    expect(resolvePackageFilePath('soul-creation', 'scripts\\..\\..\\evil.md')).toBeNull()
    expect(resolvePackageFilePath('soul-creation', 'scripts/run script.js')).toBeNull()
    expect(resolvePackageFilePath('soul-creation', 'scripts/run;rm.js')).toBeNull()
  })

  // The manifest is fetched from raw_url and written LAST, by the installer. A
  // resource claiming to be it would land out of order and index a half package.
  it('refuses the manifest itself', () => {
    expect(resolvePackageFilePath('soul-creation', 'SKILL.md')).toBeNull()
    expect(resolvePackageFilePath('soul-creation', 'skills/soul-creation/SKILL.md')).toBeNull()
  })

  it('is null for a non-string', () => {
    expect(resolvePackageFilePath('soul-creation', undefined)).toBeNull()
    expect(resolvePackageFilePath('soul-creation', 42)).toBeNull()
  })
})

describe('catalog entries carrying files', () => {
  const withFiles = (files: unknown) => entry({ files })

  it('keeps a package that lists resources, normalized to package-relative', () => {
    const parsed = parseSkillsCatalogDocument(doc([withFiles([
      { path: 'skills/soul-creation/references/example-souls.md', raw_url: 'https://example.test/a.md' },
      { path: './agents/openai.yaml', raw_url: 'https://example.test/b.yaml' }
    ])]))
    expect(parsed!.dropped).toBe(0)
    expect(parsed!.entries[0].files).toEqual([
      { path: 'references/example-souls.md', raw_url: 'https://example.test/a.md' },
      { path: 'agents/openai.yaml', raw_url: 'https://example.test/b.yaml' }
    ])
  })

  it('leaves files undefined for the schema-1 entries every older catalog ships', () => {
    expect(parseSkillsCatalogDocument(doc([entry()]))!.entries[0].files).toBeUndefined()
  })

  it('drops an entry whose file path escapes the package', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry({ name: 'good' }),
      entry({ name: 'traversal', files: [{ path: '../../mind.md', raw_url: 'https://example.test/a.md' }] }),
      entry({ name: 'absolute', files: [{ path: '/etc/passwd', raw_url: 'https://example.test/a.md' }] }),
      entry({ name: 'manifest', files: [{ path: 'SKILL.md', raw_url: 'https://example.test/a.md' }] })
    ]))
    expect(parsed!.entries.map((e) => e.name)).toEqual(['good'])
    expect(parsed!.dropped).toBe(3)
  })

  it('drops an entry listing the same resolved path twice', () => {
    const parsed = parseSkillsCatalogDocument(doc([withFiles([
      { path: 'scripts/run.js', raw_url: 'https://example.test/a.js' },
      { path: 'skills/soul-creation/scripts/run.js', raw_url: 'https://example.test/b.js' }
    ])]))
    expect(parsed!.entries).toHaveLength(0)
    expect(parsed!.dropped).toBe(1)
  })

  it('drops an entry whose file has no usable raw_url, or a bidi path', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry({ name: 'no-url', files: [{ path: 'scripts/run.js' }] }),
      entry({ name: 'bad-url', files: [{ path: 'scripts/run.js', raw_url: 'not a url' }] }),
      entry({ name: 'bidi', files: [{ path: 'scripts/\u202Erun.js', raw_url: 'https://example.test/a.js' }] })
    ]))
    expect(parsed!.entries).toHaveLength(0)
    expect(parsed!.dropped).toBe(3)
  })

  it('drops an entry with more resources than a skill can be', () => {
    const files = Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, i) => ({
      path: `references/r${i}.md`,
      raw_url: `https://example.test/${i}.md`
    }))
    expect(parseSkillsCatalogDocument(doc([withFiles(files)]))!.dropped).toBe(1)
    expect(parseSkillsCatalogDocument(doc([withFiles(files.slice(1))]))!.entries).toHaveLength(1)
  })

  it('drops an entry whose files is not an array of file objects', () => {
    const parsed = parseSkillsCatalogDocument(doc([
      entry({ name: 'string-files', files: 'scripts/run.js' }),
      entry({ name: 'bare-strings', files: ['scripts/run.js'] })
    ]))
    expect(parsed!.entries).toHaveLength(0)
    expect(parsed!.dropped).toBe(2)
  })

  it('keeps the first-party catalog’s own resource lists intact', () => {
    const raw = readFileSync(join(__dirname, '../../skills/registry.json'), 'utf8')
    const parsed = parseSkillsCatalogDocument(JSON.parse(raw))
    const withResources = parsed!.entries.filter((skill) => (skill.files?.length ?? 0) > 0)
    expect(withResources.length).toBeGreaterThan(0)
    for (const skill of withResources) {
      for (const file of skill.files!) {
        expect(file.path).not.toMatch(/^\/|\.\./)
        expect(file.raw_url).toMatch(/^https:\/\//)
        // The raw URL has to actually name the file it claims to install.
        expect(file.raw_url.endsWith(`/skills/${skill.name}/${file.path}`)).toBe(true)
      }
    }
  })
})
