import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ADF_SKILLS_REGISTRY_URL } from '../../src/shared/constants/adf-defaults'
import { buildInstalled, initialStep, packageIdentity, parseAddTarget, settleOverrides, tokenLabel, urlFolderName } from '../../src/main/tui/skills/model'
import { installPackage, readLocalPackage, removeSkill, setSkillMuted } from '../../src/main/tui/skills/ops'
import { loadCatalogSources, readCatalogSources, setSkillsFetchSeams } from '../../src/main/tui/skills/catalog'
import type { DaemonClient } from '../../src/main/tui/api/client'
import type { FileListEntry } from '../../src/main/tui/api/types'

const skillMd = (name: string, description = `${name} does things`, body = '# Use it\n\nSteps.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const entry = (path: string, size: number): FileListEntry => ({ path, size, protection: 'none', authorized: false, created_at: '', updated_at: '' })

const registry = (skills: Array<{ name: string; enabled?: boolean; description?: string }>, rejected: Array<{ path: string; reason: string }> = []) => JSON.stringify({
  schema: 1,
  skills: Object.fromEntries(skills.map(s => [s.name, { name: s.name, description: s.description ?? `${s.name} desc`, path: `skills/${s.name}/SKILL.md`, enabled: s.enabled !== false }])),
  rejected,
})

/** In-memory stand-in for the daemon file routes. */
function fakeClient(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const deletes: string[] = []
  const client = {
    files: async () => ({ agentId: 'a', files: [...files.entries()].map(([path, c]) => entry(path, c.length)) }),
    file: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('File not found'), { status: 404 })
      return { encoding: 'utf-8', content: files.get(path) }
    },
    writeFile: async (_id: string, path: string, input: { content?: string; contentBase64?: string }) => {
      writes.push(path)
      files.set(path, input.content ?? Buffer.from(input.contentBase64 ?? '', 'base64').toString('utf-8'))
      return { success: true }
    },
    deleteFile: async (_id: string, path: string) => { deletes.push(path); return { success: files.delete(path) } },
  }
  return { client: client as unknown as DaemonClient, files, writes, deletes }
}

describe('skills model', () => {
  it('parses /skills add targets', () => {
    expect(parseAddTarget('')).toEqual({ kind: 'catalog', query: '' })
    expect(parseAddTarget('pdf')).toEqual({ kind: 'catalog', query: 'pdf' })
    expect(parseAddTarget('https://example.test/registry.json')).toEqual({ kind: 'catalog-url', url: 'https://example.test/registry.json' })
    expect(parseAddTarget('https://example.test/skills/pdf/SKILL.md')).toEqual({ kind: 'package-url', url: 'https://example.test/skills/pdf/SKILL.md' })
    expect(parseAddTarget('http://example.test/SKILL.md').kind).toBe('invalid')
    expect(parseAddTarget('./skills/pdf')).toEqual({ kind: 'local', path: './skills/pdf' })
    expect(parseAddTarget('C:\\work\\pdf\\SKILL.md').kind).toBe('local')
    expect(parseAddTarget('"~/my skills/pdf"')).toEqual({ kind: 'local', path: '~/my skills/pdf' })
    expect(initialStep({ add: 'pdf' }).step).toEqual({ kind: 'catalog', autoPreview: true })
    expect(initialStep({ add: 'https://example.test/c.json' }).extra).toEqual(['https://example.test/c.json'])
    expect(initialStep({ skill: 'pdf' }).step).toMatchObject({ kind: 'view', path: 'skills/pdf/SKILL.md' })
  })

  it('builds the installed list: muted, token estimates, problems, one empty state', () => {
    const files = [entry('skills/pdf/SKILL.md', 800), entry('skills/xlsx/SKILL.md', 4000), entry('skills/Bad_Name/SKILL.md', 10), entry('skills-registry.json', 1200)]
    const model = buildInstalled(files, registry([{ name: 'pdf' }, { name: 'xlsx', enabled: false }], [{ path: 'skills-state.json', reason: 'unparseable' }]))
    expect(model.skills.map(s => [s.name, s.enabled, s.tokens])).toEqual([['pdf', true, 200], ['xlsx', false, 1000]])
    expect(model.muted).toBe(1)
    expect(model.registryTokens).toBe(300)
    expect(model.problems.map(p => [p.label, p.isPackage, p.reason])).toEqual([['Bad_Name', true, null], ['skills-state.json', false, 'unparseable']])
    expect(model.status).toBe('ok')
    expect(buildInstalled(files, registry([{ name: 'pdf' }]), { pdf: false }).skills[0].enabled).toBe(false)

    expect(buildInstalled([], null).status).toBe('none')
    expect(buildInstalled([entry('skills/pdf/SKILL.md', 5)], null).status).toBe('not-generated')
    expect(buildInstalled([entry('skills-registry.json', 5)], '{nope').status).toBe('unreadable')
    expect(tokenLabel(200)).toBe('~200 tok')
    expect(tokenLabel(1500)).toBe('~1.5k tok')
  })

  it('retires optimistic toggles once the registry agrees', () => {
    const text = registry([{ name: 'pdf', enabled: false }, { name: 'xlsx' }])
    expect(settleOverrides({ pdf: false, xlsx: false, gone: true }, text)).toEqual({ xlsx: false })
    expect(settleOverrides({ pdf: true }, null)).toEqual({ pdf: true })
  })

  it('names a package from its frontmatter, else its folder, and warns before install', () => {
    expect(packageIdentity(skillMd('pdf'), 'whatever')).toMatchObject({ name: 'pdf', warnings: [] })
    const unnamed = packageIdentity('# just a body', 'notes')
    expect(unnamed).toMatchObject({ name: 'notes' })
    expect((unnamed as { warnings: string[] }).warnings.join(' ')).toMatch(/no `name:`/)
    expect(packageIdentity('# body', 'Not A Name')).toHaveProperty('error')
    expect(urlFolderName('https://h.test/repo/skills/pdf/SKILL.md')).toBe('pdf')
  })
})

describe('skills ops', () => {
  it('mutes by merging skills-state.json, serialized per agent', async () => {
    const { client, files } = fakeClient({ 'skills-state.json': JSON.stringify({ schema: 1, disabled: ['old'], note: 'keep' }) })
    const results = await Promise.all([
      setSkillMuted(client, 'a', 'pdf', false),
      setSkillMuted(client, 'a', 'xlsx', false),
      setSkillMuted(client, 'a', 'old', true),
    ])
    expect(results).toEqual([null, null, null])
    expect(JSON.parse(files.get('skills-state.json')!)).toEqual({ schema: 1, disabled: ['pdf', 'xlsx'], note: 'keep' })
  })

  it('installs resources first and SKILL.md last; a failed resource is a warning', async () => {
    setSkillsFetchSeams({ text: async url => (url.endsWith('bad.js') ? { ok: false, error: 'HTTP 404' } : { ok: true, content: `// ${url}` }) })
    try {
      const { client, writes } = fakeClient()
      const outcome = await installPackage(client, 'a', {
        name: 'pdf', description: 'd', source: 'catalog', origin: 'https://h.test/pdf/SKILL.md', label: 'h', warnings: [],
        manifest: skillMd('pdf'),
        resources: [{ path: 'scripts/run.js', rawUrl: 'https://h.test/run.js' }, { path: 'scripts/bad.js', rawUrl: 'https://h.test/bad.js' }, { path: 'ref.md', content: '# ref' }],
      })
      expect(outcome.error).toBeNull()
      expect(outcome.warnings).toEqual(['scripts/bad.js: HTTP 404'])
      expect(writes).toEqual(['skills/pdf/scripts/run.js', 'skills/pdf/ref.md', 'skills/pdf/SKILL.md'])
    } finally {
      setSkillsFetchSeams(null)
    }
  })

  it('refuses an oversized SKILL.md before writing anything', async () => {
    const { client, writes } = fakeClient()
    const outcome = await installPackage(client, 'a', { name: 'big', description: '', source: 'disk', origin: '/x', label: 'local', warnings: [], resources: [], manifest: skillMd('big', 'd', 'x'.repeat(300 * 1024)) })
    expect(outcome.error).toMatch(/over 256 KB/)
    expect(writes).toEqual([])
  })

  it('removes SKILL.md first, then the rest of the package', async () => {
    const { client, deletes, files } = fakeClient({ 'skills/pdf/a.txt': 'a', 'skills/pdf/SKILL.md': skillMd('pdf'), 'skills/pdf-extra/SKILL.md': 'x', 'skills/pdf/z/y.md': 'y' })
    expect(await removeSkill(client, 'a', 'pdf')).toEqual({ deleted: 3, failed: [] })
    expect(deletes).toEqual(['skills/pdf/SKILL.md', 'skills/pdf/a.txt', 'skills/pdf/z/y.md'])
    expect([...files.keys()]).toEqual(['skills/pdf-extra/SKILL.md'])
  })
})

describe('local packages', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-skills-'))
    const pkg = join(dir, 'pdf-tools')
    mkdirSync(join(pkg, 'scripts'), { recursive: true })
    mkdirSync(join(pkg, '.git'), { recursive: true })
    mkdirSync(join(pkg, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(pkg, 'SKILL.md'), skillMd('pdf-tools'))
    writeFileSync(join(pkg, 'scripts', 'run.js'), 'console.log(1)')
    writeFileSync(join(pkg, 'scripts', 'bad name.js'), 'x')
    writeFileSync(join(pkg, '.git', 'HEAD'), 'ref')
    writeFileSync(join(pkg, 'node_modules', 'x', 'i.js'), 'x')
    writeFileSync(join(pkg, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
    mkdirSync(join(dir, 'loose'))
    writeFileSync(join(dir, 'loose', 'SKILL.md'), '# no frontmatter')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a folder: resources inside the package, dotfiles and node_modules skipped, binary as base64', async () => {
    const result = await readLocalPackage('pdf-tools', dir)
    if (!result.ok) throw new Error(result.error)
    expect(result.pkg.name).toBe('pdf-tools')
    expect(result.pkg.resources.map(r => r.path)).toEqual(['logo.bin', 'scripts/run.js'])
    expect(result.pkg.resources[0].contentBase64).toBe(Buffer.from([0, 1, 2, 3]).toString('base64'))
    expect(result.pkg.warnings).toEqual(['scripts/bad name.js: skipped (not a package path)'])
  })

  it('reads a single SKILL.md, named after its folder when the frontmatter says nothing', async () => {
    const result = await readLocalPackage(join(dir, 'loose', 'SKILL.md'))
    if (!result.ok) throw new Error(result.error)
    expect(result.pkg).toMatchObject({ name: 'loose', resources: [], source: 'disk' })
    expect(result.pkg.warnings.length).toBeGreaterThan(0)
    expect(await readLocalPackage(join(dir, 'missing'))).toMatchObject({ ok: false })
  })
})

describe('skills catalog', () => {
  afterEach(() => setSkillsFetchSeams(null))

  it('fetches every source; one failing costs only its own row', async () => {
    setSkillsFetchSeams({
      catalog: async url => (url.includes('down') ? { ok: false, error: 'HTTP 500' } : { ok: true, entries: [{ name: 'pdf', description: 'PDFs', raw_url: 'https://h.test/pdf/SKILL.md' }], dropped: 1 }),
    })
    const results = await loadCatalogSources(['https://up.test/c.json', 'https://down.test/c.json'])
    expect(results.map(r => [r.url, r.ok, r.error ?? null, r.dropped ?? null])).toEqual([['https://up.test/c.json', true, null, 1], ['https://down.test/c.json', false, 'HTTP 500', null]])
  })

  it('reads the source preference from the daemon, falling back to the default', async () => {
    const ok = { setting: async () => ({ key: 'skillCatalogSources', value: ['https://a.test/c.json', 'http://nope', 'https://a.test/c.json'] }) } as unknown as DaemonClient
    expect(await readCatalogSources(ok)).toEqual({ sources: ['https://a.test/c.json'] })
    const unset = { setting: async () => ({ key: 'skillCatalogSources', value: null }) } as unknown as DaemonClient
    expect((await readCatalogSources(unset)).sources).toEqual([ADF_SKILLS_REGISTRY_URL])
    const down = { setting: async () => { throw new Error('503') } } as unknown as DaemonClient
    const fallback = await readCatalogSources(down)
    expect(fallback.sources).toEqual([ADF_SKILLS_REGISTRY_URL])
    expect(fallback.note).toMatch(/503/)
  })
})
