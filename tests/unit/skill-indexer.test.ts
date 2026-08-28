import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REGISTRY_BYTES,
  MAX_REGISTRY_REJECTED,
  MAX_SKILLS,
  MAX_SKILL_FILE_BYTES,
  SKILLS_REGISTRY_PATH,
  SkillIndexer,
  applySkillsConfigChange,
  buildSkillRegistry,
  isSkillIndexPath,
  parseDisabledSkills,
  parseSkillFrontmatter,
  readSkillsState,
  type SkillIndexerHost,
  type SkillSource,
} from '../../src/main/adf/skill-indexer'
import type { FileProtectionLevel } from '../../src/shared/types/adf-v02.types'

function manifest(name: string, description = `The ${name} skill.`, extra = ''): SkillSource {
  const content = `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`
  return { path: `skills/${name}/SKILL.md`, size: Buffer.byteLength(content), content }
}

/** In-memory stand-in for the AdfWorkspace slice the indexer uses. */
function createHost(files: Map<string, string>, protections = new Map<string, FileProtectionLevel>()): SkillIndexerHost & {
  files: Map<string, string>
  protections: Map<string, FileProtectionLevel>
} {
  return {
    files,
    protections,
    listFiles: () => [...files].map(([path, content]) => ({ path, size: Buffer.byteLength(content) })),
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content, protection) => {
      const isNew = !files.has(path)
      files.set(path, content)
      if (isNew) protections.set(path, protection ?? 'none')
    },
    getFileMeta: (path) => (files.has(path) ? { protection: protections.get(path) ?? 'none' } : null),
    setFileProtection: (path, protection) => {
      if (!files.has(path)) return false
      protections.set(path, protection)
      return true
    },
  }
}

describe('skill frontmatter parsing', () => {
  it('accepts the required pair and ignores unrecognized keys', () => {
    const source = '---\nname: alpha\ndescription: Does alpha things.\nadf: ">=0.2"\nrequires:\n  tools: [fs_read]\n---\n'
    expect(parseSkillFrontmatter(source)).toEqual({ name: 'alpha', description: 'Does alpha things.' })
  })

  it('decodes quoted scalars', () => {
    expect(parseSkillFrontmatter('---\nname: "alpha"\ndescription: \'It\'\'s fine.\'\n---\n'))
      .toEqual({ name: 'alpha', description: "It's fine." })
  })

  it('rejects missing frontmatter, bad names, and oversized descriptions', () => {
    expect(parseSkillFrontmatter('no frontmatter')).toEqual({ error: 'missing YAML frontmatter' })
    expect(parseSkillFrontmatter('---\nname: Alpha\ndescription: x\n---\n')).toEqual({ error: 'invalid skill name' })
    expect(parseSkillFrontmatter('---\nname: alpha\n---\n'))
      .toEqual({ error: 'description must be one line and at most 500 characters' })
    expect(parseSkillFrontmatter(`---\nname: alpha\ndescription: ${'x'.repeat(501)}\n---\n`))
      .toEqual({ error: 'description must be one line and at most 500 characters' })
    expect(parseSkillFrontmatter('---\nname: alpha\nname: beta\ndescription: x\n---\n'))
      .toEqual({ error: 'duplicate name' })
  })

  it('normalizes CRLF so a Windows-authored package still parses', () => {
    expect(parseSkillFrontmatter('---\r\nname: alpha\r\ndescription: Windows.\r\n---\r\n'))
      .toEqual({ name: 'alpha', description: 'Windows.' })
  })

  // Hyphenated keys are the standard Claude skill format. Rejecting the whole
  // package over `allowed-tools:` made the indexer useless for the packages
  // people actually have.
  it('accepts a real-world Claude-style SKILL.md frontmatter', () => {
    const source = [
      '---',
      'name: pdf-processing',
      'description: Extract text and tables from PDF files, fill forms, merge documents.',
      'allowed-tools: Read, Write, Bash(python3:*)',
      'license-key: Apache-2.0',
      'metadata:',
      '  version: 1.2.0',
      '  tags:',
      '    - documents',
      '    - extraction',
      '---',
      '',
      '# PDF processing',
      '',
    ].join('\n')
    expect(parseSkillFrontmatter(source)).toEqual({
      name: 'pdf-processing',
      description: 'Extract text and tables from PDF files, fill forms, merge documents.',
    })
  })

  it('skips content it does not model instead of failing the package', () => {
    const source = [
      '---',
      '- a stray top-level list item',
      'Weird Capitalized Line With No Colon',
      'name: alpha',
      '"quoted-key": ignored',
      'description: Still found.',
      '---',
    ].join('\n')
    expect(parseSkillFrontmatter(source)).toEqual({ name: 'alpha', description: 'Still found.' })
  })

  it('still refuses a block scalar where a one-line description belongs', () => {
    expect(parseSkillFrontmatter('---\nname: alpha\ndescription: |\n  two\n  lines\n---\n'))
      .toEqual({ error: 'description must be a single-line scalar' })
  })
})

describe('skills-state.json parsing', () => {
  it('reads a well-formed disable list and de-duplicates it', () => {
    expect(parseDisabledSkills('{"schema":1,"disabled":["a","a","b"]}')).toEqual(['a', 'b'])
  })

  it('mutes nothing on absent, corrupt, wrong-schema, or invalid-name state', () => {
    expect(parseDisabledSkills(null)).toEqual([])
    expect(parseDisabledSkills('{oops')).toEqual([])
    expect(parseDisabledSkills('{"schema":2,"disabled":["a"]}')).toEqual([])
    expect(parseDisabledSkills('{"schema":1,"disabled":"a"}')).toEqual([])
    expect(parseDisabledSkills('{"schema":1,"disabled":["Bad Name",7,"ok"]}')).toEqual(['ok'])
  })

  // Fail-open, but never silently: the agent has to be able to see that its
  // mute list stopped applying.
  it('names the reason when state exists but cannot be read', () => {
    expect(readSkillsState(null)).toEqual({ disabled: [] })
    expect(readSkillsState('   ')).toEqual({ disabled: [] })
    expect(readSkillsState('{oops')).toEqual({
      disabled: [],
      error: 'unparseable — all skills treated as enabled',
    })
    expect(readSkillsState('[1,2]').error).toMatch(/unparseable/)
    expect(readSkillsState('{"schema":2,"disabled":["a"]}').error).toMatch(/expected \{"schema": 1/)
    expect(readSkillsState('{"schema":1,"disabled":["a"]}')).toEqual({ disabled: ['a'] })
  })
})

describe('registry construction', () => {
  it('emits the schema-1 shape with a generated-file note', () => {
    const { registry, json, rejected, skillCount } = buildSkillRegistry([manifest('alpha')], null)
    expect(rejected).toEqual([])
    expect(skillCount).toBe(1)
    expect(registry.schema).toBe(1)
    expect(registry.$notes).toContain('Generated by the ADF runtime')
    expect(registry.skills.alpha).toEqual({
      name: 'alpha',
      description: 'The alpha skill.',
      path: 'skills/alpha/SKILL.md',
      enabled: true,
    })
    expect(json.endsWith('\n')).toBe(true)
    expect(JSON.parse(json)).toEqual(registry)
  })

  it('is deterministic regardless of listing order', () => {
    const a = buildSkillRegistry([manifest('alpha'), manifest('beta')], null)
    const b = buildSkillRegistry([manifest('beta'), manifest('alpha')], null)
    expect(a.json).toBe(b.json)
  })

  it('keeps a disabled skill as a bare name with no description', () => {
    const { registry } = buildSkillRegistry([manifest('alpha')], '{"schema":1,"disabled":["alpha"]}')
    expect(registry.skills.alpha).toEqual({
      name: 'alpha',
      path: 'skills/alpha/SKILL.md',
      enabled: false,
    })
    expect('description' in registry.skills.alpha).toBe(false)
  })

  it('ignores rows that are not skill manifests', () => {
    const { skillCount } = buildSkillRegistry([
      manifest('alpha'),
      { path: 'skills/alpha/references/notes.md', size: 4, content: 'note' },
      { path: 'skills/SKILL.md', size: 4, content: 'note' },
      { path: 'skills/alpha/nested/SKILL.md', size: 4, content: 'note' },
      { path: 'README.md', size: 4, content: 'note' },
    ], null)
    expect(skillCount).toBe(1)
  })

  it('rejects a manifest whose name disagrees with its directory', () => {
    const source = manifest('alpha')
    source.path = 'skills/beta/SKILL.md'
    const { rejected, skillCount } = buildSkillRegistry([source], null)
    expect(skillCount).toBe(0)
    expect(rejected).toEqual([{ path: 'skills/beta/SKILL.md', reason: 'frontmatter name must match directory' }])
  })

  it('rejects a manifest that disappeared between listing and reading', () => {
    const { rejected } = buildSkillRegistry([{ path: 'skills/alpha/SKILL.md', size: 10, content: null }], null)
    expect(rejected).toEqual([{ path: 'skills/alpha/SKILL.md', reason: 'file disappeared while indexing' }])
  })

  it('rejects an oversized manifest without reading it', () => {
    const source = { ...manifest('alpha'), size: MAX_SKILL_FILE_BYTES + 1 }
    const { rejected, skillCount } = buildSkillRegistry([source], null)
    expect(skillCount).toBe(0)
    expect(rejected).toEqual([{ path: 'skills/alpha/SKILL.md', reason: `exceeds ${MAX_SKILL_FILE_BYTES} bytes` }])
  })

  it('caps the catalog at MAX_SKILLS and reports the overflow', () => {
    const sources = Array.from({ length: MAX_SKILLS + 2 }, (_, i) => manifest(`skill-${String(i).padStart(3, '0')}`))
    const { skillCount, rejected } = buildSkillRegistry(sources, null)
    expect(skillCount).toBe(MAX_SKILLS)
    expect(rejected).toHaveLength(2)
    expect(rejected[0].reason).toBe(`catalog is limited to ${MAX_SKILLS} skills`)
  })

  it('persists rejections into the registry itself, omitting the key when there are none', () => {
    const clean = buildSkillRegistry([manifest('alpha')], null)
    expect(clean.registry.rejected).toBeUndefined()
    expect('rejected' in JSON.parse(clean.json)).toBe(false)

    const bad = manifest('alpha')
    bad.path = 'skills/beta/SKILL.md'
    const dirty = buildSkillRegistry([bad], null)
    expect(dirty.registry.rejected).toEqual([
      { path: 'skills/beta/SKILL.md', reason: 'frontmatter name must match directory' },
    ])
    expect(JSON.parse(dirty.json).rejected).toEqual(dirty.registry.rejected)
  })

  // The file's own comment promised a reason for every package that never
  // appears; a bare `continue` broke that promise for the commonest typo.
  it('reports an invalid directory name rather than dropping it silently', () => {
    const source = manifest('alpha')
    source.path = 'skills/My Skill/SKILL.md'
    const { rejected, skillCount, registry } = buildSkillRegistry([source], null)
    expect(skillCount).toBe(0)
    expect(rejected).toEqual([
      { path: 'skills/My Skill/SKILL.md', reason: 'directory name must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' },
    ])
    expect(registry.rejected).toEqual(rejected)
  })

  it('reports an unreadable skills-state.json and treats every skill as enabled', () => {
    const { registry, rejected } = buildSkillRegistry([manifest('alpha')], '{oops')
    expect(rejected).toContainEqual({
      path: 'skills-state.json',
      reason: 'unparseable — all skills treated as enabled',
    })
    expect(registry.skills.alpha.enabled).toBe(true)
    expect(registry.rejected).toEqual(rejected)
  })

  it('sorts byte-wise so cap eviction does not depend on the host locale', () => {
    // localeCompare orders "a-b" before "ab" in most locales; byte order does
    // not. Which one wins matters as soon as the caps start evicting.
    const sources = [manifest('ab'), manifest('a-b')]
    const { registry } = buildSkillRegistry(sources, null)
    expect(Object.keys(registry.skills)).toEqual(['a-b', 'ab'])
  })

  it('bounds the persisted rejection list so diagnostics cannot evict a real skill', () => {
    const broken = Array.from({ length: MAX_REGISTRY_REJECTED + 5 }, (_, i) => ({
      path: `skills/broken-${String(i).padStart(3, '0')}/SKILL.md`,
      size: 20,
      content: 'no frontmatter here',
    }))
    const { registry, rejected, skillCount } = buildSkillRegistry([...broken, manifest('alpha')], null)

    // Callers still see everything…
    expect(rejected).toHaveLength(MAX_REGISTRY_REJECTED + 5)
    // …the FILE carries a capped copy plus a line naming what was left out.
    expect(registry.rejected).toHaveLength(MAX_REGISTRY_REJECTED + 1)
    expect(registry.rejected!.at(-1)!.reason).toBe('5 further rejection(s) omitted')
    // And the valid package is still advertised.
    expect(skillCount).toBe(1)
    expect(registry.skills.alpha).toBeDefined()
  })

  it('keeps the whole file under the byte cap even when rejections are plentiful', () => {
    const longReason = Array.from({ length: 200 }, (_, i) => ({
      path: `skills/${'x'.repeat(60)}-${String(i).padStart(3, '0')}/SKILL.md`,
      size: MAX_SKILL_FILE_BYTES + 1,
      content: null,
    }))
    const { json } = buildSkillRegistry([...longReason, manifest('alpha')], null)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_REGISTRY_BYTES)
    expect(JSON.parse(json).skills.alpha).toBeDefined()
  })

  it('caps the serialized registry size and reports the overflow', () => {
    // Worst case that still fits under MAX_SKILLS: 63-char names and
    // 500-char descriptions overflow the 32 KB registry before the 48th entry.
    const long = 'x'.repeat(500)
    const sources = Array.from({ length: MAX_SKILLS }, (_, i) => {
      const prefix = `skill-${String(i).padStart(3, '0')}-`
      return manifest(prefix + 'x'.repeat(63 - prefix.length), long)
    })
    const { rejected, json } = buildSkillRegistry(sources, null)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_REGISTRY_BYTES)
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[rejected.length - 1].reason).toBe(`catalog exceeds ${MAX_REGISTRY_BYTES} bytes`)
  })
})

describe('watched paths', () => {
  it('matches manifests and the state file only', () => {
    expect(isSkillIndexPath('skills/alpha/SKILL.md')).toBe(true)
    expect(isSkillIndexPath('skills-state.json')).toBe(true)
    expect(isSkillIndexPath(SKILLS_REGISTRY_PATH)).toBe(false)
    expect(isSkillIndexPath('skills/alpha/scripts/run.ts')).toBe(false)
    expect(isSkillIndexPath('lib/skill-indexer.ts')).toBe(false)
  })
})

describe('SkillIndexer', () => {
  it('writes the registry read_only and reports the change once', () => {
    const files = new Map([[manifest('alpha').path, manifest('alpha').content!]])
    const host = createHost(files)
    const onRegistryChanged = vi.fn()
    const indexer = new SkillIndexer(host, { isEnabled: () => true, onRegistryChanged })

    const first = indexer.refresh()
    expect(first?.changed).toBe(true)
    expect(host.protections.get(SKILLS_REGISTRY_PATH)).toBe('read_only')
    expect(onRegistryChanged).toHaveBeenCalledTimes(1)
    expect(JSON.parse(files.get(SKILLS_REGISTRY_PATH)!).skills.alpha.enabled).toBe(true)

    const second = indexer.refresh()
    expect(second?.changed).toBe(false)
    expect(onRegistryChanged).toHaveBeenCalledTimes(1)
    indexer.dispose()
  })

  it('adopts an agent-authored registry by flipping it to read_only', () => {
    const files = new Map([
      [manifest('alpha').path, manifest('alpha').content!],
      [SKILLS_REGISTRY_PATH, '{"schema":1,"skills":{}}'],
    ])
    const host = createHost(files, new Map<string, FileProtectionLevel>([[SKILLS_REGISTRY_PATH, 'none']]))
    new SkillIndexer(host, { isEnabled: () => true }).refresh()
    expect(host.protections.get(SKILLS_REGISTRY_PATH)).toBe('read_only')
  })

  it('does nothing at all when skills.enabled is false', () => {
    const files = new Map([[manifest('alpha').path, manifest('alpha').content!]])
    const host = createHost(files)
    const indexer = new SkillIndexer(host, { isEnabled: () => false })
    expect(indexer.refresh()).toBeNull()
    indexer.notifyPath('skills/alpha/SKILL.md')
    indexer.flush()
    expect(files.has(SKILLS_REGISTRY_PATH)).toBe(false)
  })

  it('coalesces a burst of writes into a single index', () => {
    const files = new Map([[manifest('alpha').path, manifest('alpha').content!]])
    const host = createHost(files)
    const listFiles = vi.spyOn(host, 'listFiles')
    const indexer = new SkillIndexer(host, { isEnabled: () => true })

    indexer.notifyPath('skills/alpha/SKILL.md')
    indexer.notifyPath('skills/beta/SKILL.md')
    indexer.notifyPath('skills-state.json')
    indexer.notifyPath('README.md')
    indexer.flush()

    expect(listFiles).toHaveBeenCalledTimes(1)
    indexer.dispose()
  })

  it('releases the registry back to the agent when the subsystem is turned off', () => {
    const files = new Map([[manifest('alpha').path, manifest('alpha').content!]])
    const host = createHost(files)
    const indexer = new SkillIndexer(host, { isEnabled: () => true })
    indexer.refresh()
    expect(host.protections.get(SKILLS_REGISTRY_PATH)).toBe('read_only')

    expect(indexer.releaseRegistry()).toBe(true)
    // The file survives — it may still be useful — but the agent can now
    // delete it. Nothing else in the runtime ever downgrades a protection.
    expect(files.has(SKILLS_REGISTRY_PATH)).toBe(true)
    expect(host.protections.get(SKILLS_REGISTRY_PATH)).toBe('none')

    // Idempotent, and a no-op when there is no registry at all.
    expect(indexer.releaseRegistry()).toBe(false)
    expect(new SkillIndexer(createHost(new Map()), { isEnabled: () => false }).releaseRegistry()).toBe(false)
    indexer.dispose()
  })

  it('never lets an index failure escape into the write path', () => {
    const host = createHost(new Map())
    host.listFiles = () => { throw new Error('db closed') }
    const onError = vi.fn()
    expect(new SkillIndexer(host, { isEnabled: () => true, onError }).refresh()).toBeNull()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('db closed'))
  })
})

describe('applySkillsConfigChange', () => {
  function target() {
    return {
      refreshSkillIndex: vi.fn(() => null),
      releaseSkillRegistry: vi.fn(() => true),
    }
  }

  // The indexer is driven by FILE writes, so a config flip is invisible to it
  // unless a config write path says so. Every such path calls this.
  it('reindexes synchronously when skills.enabled goes false → true', () => {
    const ws = target()
    applySkillsConfigChange(ws, { skills: { enabled: false } }, { skills: { enabled: true } })
    expect(ws.refreshSkillIndex).toHaveBeenCalledTimes(1)
    expect(ws.releaseSkillRegistry).not.toHaveBeenCalled()
  })

  it('treats an absent skills section as off', () => {
    const ws = target()
    applySkillsConfigChange(ws, {}, { skills: { enabled: true } })
    expect(ws.refreshSkillIndex).toHaveBeenCalledTimes(1)
  })

  it('releases the registry when skills.enabled goes true → false', () => {
    const ws = target()
    applySkillsConfigChange(ws, { skills: { enabled: true } }, { skills: { enabled: false } })
    expect(ws.releaseSkillRegistry).toHaveBeenCalledTimes(1)
    expect(ws.refreshSkillIndex).not.toHaveBeenCalled()
  })

  it('does nothing when the flag did not move', () => {
    const ws = target()
    applySkillsConfigChange(ws, { skills: { enabled: true } }, { skills: { enabled: true, catalogs: ['x'] } })
    applySkillsConfigChange(ws, { skills: { enabled: false } }, {})
    expect(ws.refreshSkillIndex).not.toHaveBeenCalled()
    expect(ws.releaseSkillRegistry).not.toHaveBeenCalled()
  })

  it('never lets an indexing failure fail the config save', () => {
    const ws = target()
    ws.refreshSkillIndex.mockImplementation(() => { throw new Error('db closed') })
    expect(() => applySkillsConfigChange(ws, {}, { skills: { enabled: true } })).not.toThrow()
  })
})
