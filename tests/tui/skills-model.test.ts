import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ADF_SKILLS_REGISTRY_URL } from '../../src/shared/constants/adf-defaults'
import { buildInstalled, initialStep, parseAddTarget, settleOverrides, tokenLabel } from '../../src/main/tui/skills/model'
import { installPackage, loadPackage, readLocalPackage, removeSkill, setSkillMuted } from '../../src/main/tui/skills/ops'
import { importSkillManifest } from '../../src/shared/utils/skill-import'
import { parseSkillFrontmatter } from '../../src/main/adf/skill-indexer'
import { loadCatalogSources, readCatalogSources, setSkillsFetchSeams } from '../../src/main/tui/skills/catalog'
import type { DaemonClient } from '../../src/main/tui/api/client'
import type { FileListEntry } from '../../src/main/tui/api/types'

const skillMd = (name: string, description = `${name} does things`, body = '# Use it\n\nSteps.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const b64 = (text: string) => Buffer.from(text).toString('base64')

const entry = (path: string, size: number): FileListEntry => ({ path, size, protection: 'none', authorized: false, created_at: '', updated_at: '' })

const registry = (skills: Array<{ name: string; enabled?: boolean; description?: string }>, rejected: Array<{ path: string; reason: string }> = []) => JSON.stringify({
  schema: 1,
  skills: Object.fromEntries(skills.map(s => [s.name, { name: s.name, description: s.description ?? `${s.name} desc`, path: `skills/${s.name}/SKILL.md`, enabled: s.enabled !== false }])),
  rejected,
})

const revisionOf = (text: string | undefined) => (text === undefined ? -1 : [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, text.length))

/** Install with the human's answer to the slot question (yes unless a test says otherwise). */
const install = (client: DaemonClient, id: string, pkg: Parameters<typeof installPackage>[2], confirm: Parameters<typeof installPackage>[3] = async () => true) => installPackage(client, id, pkg, confirm)

/** In-memory stand-in for the daemon file routes. */
function fakeClient(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const deletes: string[] = []
  const client = {
    files: async () => ({ agentId: 'a', files: [...files.entries()].map(([path, c]) => entry(path, c.length)) }),
    file: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('File not found'), { status: 404 })
      return { encoding: 'utf-8', content: files.get(path), revision: revisionOf(files.get(path)) }
    },
    writeFile: async (_id: string, path: string, input: { content?: string; contentBase64?: string }) => {
      writes.push(path)
      files.set(path, input.content ?? Buffer.from(input.contentBase64 ?? '', 'base64').toString('utf-8'))
      return { success: true }
    },
    deleteFile: async (_id: string, path: string) => { deletes.push(path); return { success: files.delete(path) } },
    withTimeout: () => client,
    writeFiles: async (_id: string, batch: Array<{ path: string; content?: string; contentBase64?: string; mustNotExist?: boolean; baseRevision?: number }>) => {
      for (const one of batch) {
        if (one.mustNotExist && files.has(one.path)) throw Object.assign(new Error(`"${one.path}" already exists`), { status: 409 })
        if (one.baseRevision !== undefined && one.baseRevision !== revisionOf(files.get(one.path))) throw Object.assign(new Error(`"${one.path}" changed`), { status: 409 })
      }
      for (const one of batch) {
        writes.push(one.path)
        files.set(one.path, one.content ?? Buffer.from(one.contentBase64 ?? '', 'base64').toString('utf-8'))
      }
      return { agentId: 'a', success: true, revisions: {} }
    },
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
  })

  // BI-F4: a GitHub page or raw GitHub SKILL.md/marketplace.json was fetched as one file (or its HTML).
  it('GitHub pages and marketplaces are Studio\'s; a raw SKILL.md URL installs as one file', () => {
    const studio = { kind: 'invalid', error: 'GitHub packages are browsed and installed in Studio.' }
    for (const url of [
      'https://github.com/o/r',
      'https://github.com/o/r/tree/main/skills',
      'https://github.com/o/r/blob/main/skills/pdf/SKILL.md',
      'https://raw.githubusercontent.com/o/r/main/.claude-plugin/marketplace.json',
    ]) expect(parseAddTarget(url)).toEqual(studio)
    // F4 (r4): a raw SKILL.md URL installs as one file again, as on base (import decision, plan, slot confirm).
    expect(parseAddTarget('https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md')).toEqual({ kind: 'package-url', url: 'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md' })
    // A catalog document on raw.githubusercontent.com is still a catalog.
    expect(parseAddTarget('https://raw.githubusercontent.com/o/r/main/registry.json')).toEqual({ kind: 'catalog-url', url: 'https://raw.githubusercontent.com/o/r/main/registry.json' })
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

  it('installs one batch, resources first and SKILL.md last, binary bytes exact', async () => {
    setSkillsFetchSeams({ bytes: async url => ({ ok: true, contentBase64: Buffer.from(`// ${url}`).toString('base64'), size: 10 }) })
    try {
      const { client, writes, files } = fakeClient({ 'skills/pdf/old-extra.md': 'kept' })
      const outcome = await install(client, 'a', {
        name: 'pdf', description: 'd', source: 'catalog', origin: 'https://h.test/pdf/SKILL.md', label: 'h', warnings: [],
        manifest: skillMd('pdf'),
        resources: [{ path: 'scripts/run.js', rawUrl: 'https://h.test/run.js' }, { path: 'ref.md', contentBase64: b64('# ref') }],
      })
      expect(outcome).toEqual({ error: null, written: 3 })
      expect(writes).toEqual(['skills/pdf/scripts/run.js', 'skills/pdf/ref.md', 'skills/pdf/SKILL.md'])
      expect(files.get('skills/pdf/scripts/run.js')).toBe('// https://h.test/run.js')
      expect(files.get('skills/pdf/old-extra.md')).toBe('kept')
    } finally {
      setSkillsFetchSeams(null)
    }
  })

  // Before this change a resource that failed to fetch was skipped with a
  // warning and the rest of the package (SKILL.md included) was written.
  it('a resource that fails to fetch writes nothing at all', async () => {
    setSkillsFetchSeams({ bytes: async url => (url.endsWith('bad.js') ? { ok: false, error: 'HTTP 404' } : { ok: true, contentBase64: 'eA==', size: 1 }) })
    try {
      const { client, writes } = fakeClient()
      const outcome = await install(client, 'a', {
        name: 'pdf', description: 'd', source: 'catalog', origin: 'https://h.test/pdf/SKILL.md', label: 'h', warnings: [],
        manifest: skillMd('pdf'),
        resources: [{ path: 'scripts/run.js', rawUrl: 'https://h.test/run.js' }, { path: 'scripts/bad.js', rawUrl: 'https://h.test/bad.js' }],
      })
      expect(outcome.error).toBe('scripts/bad.js: HTTP 404. Nothing was written.')
      expect(writes).toEqual([])
    } finally {
      setSkillsFetchSeams(null)
    }
  })

  it('reinstall goes over the revisions it read; a file changed meanwhile refuses the whole batch', async () => {
    const { client, writes, files } = fakeClient({ 'skills/pdf/SKILL.md': skillMd('pdf', 'old'), 'skills/pdf/ref.md': 'old ref' })
    const pkg = { name: 'pdf', description: 'd', source: 'disk' as const, origin: '/x', label: 'local', warnings: [], manifest: skillMd('pdf', 'new'), resources: [{ path: 'ref.md', contentBase64: b64('new ref') }] }
    expect((await install(client, 'a', pkg)).error).toBeNull()
    expect(files.get('skills/pdf/ref.md')).toBe('new ref')
    // Someone edits ref.md between the read and the write: nothing is written.
    const realFile = client.file.bind(client)
    ;(client as unknown as { file: typeof client.file }).file = async (id, path) => {
      const read = await realFile(id, path)
      if (path === 'skills/pdf/ref.md') files.set(path, 'edited by the agent')
      return read
    }
    writes.length = 0
    const outcome = await install(client, 'a', { ...pkg, manifest: skillMd('pdf', 'newer') })
    expect(outcome.error).toBe('\"skills/pdf/ref.md\" changed Nothing was written.')
    expect(writes).toEqual([])
    expect(files.get('skills/pdf/ref.md')).toBe('edited by the agent')
    expect(files.get('skills/pdf/SKILL.md')).toBe(skillMd('pdf', 'new'))
  })

  // BI-F1: an occupied skills/<name>/ was overwritten with no question asked.
  it('an occupied slot asks first, listing the files replaced and kept; declining writes nothing', async () => {
    const { client, writes, files } = fakeClient({ 'skills/pdf/SKILL.md': skillMd('pdf', 'theirs'), 'skills/pdf/notes.md': 'mine' })
    const pkg = { name: 'pdf', description: 'd', source: 'disk' as const, origin: '/x', label: 'local', warnings: [], manifest: skillMd('pdf', 'new'), resources: [{ path: 'ref.md', contentBase64: b64('r') }] }
    const asked: Array<{ replaces: string[]; keeps: string[] }> = []
    const outcome = await install(client, 'a', pkg, async (plan) => { asked.push({ replaces: plan.replaces, keeps: plan.keeps }); return false })
    expect(asked).toEqual([{ replaces: ['skills/pdf/SKILL.md'], keeps: ['skills/pdf/notes.md'] }])
    expect(outcome).toEqual({ error: null, written: 0, declined: true })
    expect(writes).toEqual([])
    expect(files.get('skills/pdf/SKILL.md')).toBe(skillMd('pdf', 'theirs'))
    // A slot holding only files the package does not ship still asks.
    const other = fakeClient({ 'skills/pdf/notes.md': 'mine' })
    let question = 0
    expect((await install(other.client, 'a', pkg, async () => { question++; return true })).error).toBeNull()
    expect(question).toBe(1)
    // An empty slot is not asked about.
    expect((await install(fakeClient().client, 'a', pkg, async () => { throw new Error('asked') })).error).toBeNull()
  })

  // Before: one catch wrapped the reads AND the write, and always said "Nothing was written."
  it('a write that times out after it was sent is reported as possibly written, never as nothing written', async () => {
    const { client, files } = fakeClient()
    ;(client as unknown as { writeFiles: unknown }).writeFiles = async (_id: string, batch: Array<{ path: string; content?: string }>) => {
      for (const one of batch) files.set(one.path, one.content ?? '')
      throw new Error('The request timed out after 15000ms.')
    }
    const outcome = await install(client, 'a', { name: 'demo', description: 'd', source: 'disk', origin: '/x', label: 'local', warnings: [], manifest: skillMd('demo'), resources: [{ path: 'a.txt', contentBase64: b64('a') }] })
    expect(outcome.error).toBe('The request timed out after 15000ms. The daemon may still have written the package; check skills/demo/ before retrying.')
    expect(outcome.error).not.toMatch(/Nothing was written/)
    expect([...files.keys()].sort()).toEqual(['skills/demo/SKILL.md', 'skills/demo/a.txt'])
  })

  it('a failed read before anything is sent says so, and that nothing was written', async () => {
    const { client, writes } = fakeClient()
    ;(client as unknown as { files: unknown }).files = async () => { throw new Error('connection refused') }
    const outcome = await install(client, 'a', { name: 'demo', description: 'd', source: 'disk', origin: '/x', label: 'local', warnings: [], manifest: skillMd('demo'), resources: [] })
    expect(outcome.error).toBe("Could not read the agent's files: connection refused. Nothing was written.")
    expect(writes).toEqual([])
  })

  it('the shared protocol refuses a read-only file before sending, and sends local resources as exact bytes (bounds are the daemon batch\'s)', async () => {
    const { client, writes, files } = fakeClient({ 'skills/demo/a.txt': 'locked' })
    ;(client as unknown as { files: unknown }).files = async () => ({ agentId: 'a', files: [{ ...entry('skills/demo/a.txt', 6), protection: 'read_only' }] })
    const pkg = { name: 'demo', description: 'd', source: 'disk' as const, origin: '/x', label: 'local', warnings: [], manifest: skillMd('demo') }
    expect((await install(client, 'a', { ...pkg, resources: [{ path: 'a.txt', contentBase64: b64('new') }] })).error).toBe('skills/demo/a.txt is read-only. Nothing was written.')
    expect(writes).toEqual([])
    ;(client as unknown as { files: unknown }).files = async () => ({ agentId: 'a', files: [] })
    files.clear()
    const bin = Buffer.from([0, 255, 1]).toString('base64')
    let sent: Array<{ path: string; contentBase64?: string; mustNotExist?: boolean }> = []
    ;(client as unknown as { writeFiles: unknown }).writeFiles = async (_id: string, batch: typeof sent) => { sent = batch; return { success: true, revisions: {} } }
    expect((await install(client, 'a', { ...pkg, resources: [{ path: 'b.bin', contentBase64: bin }] })).error).toBeNull()
    expect(sent[0]).toEqual({ path: 'skills/demo/b.bin', contentBase64: bin, mustNotExist: true })
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

  it('a single SKILL.md goes through the shared import decision: no frontmatter name is refused, not named after its folder', async () => {
    expect(await readLocalPackage(join(dir, 'loose', 'SKILL.md'))).toEqual({ ok: false, error: 'missing YAML frontmatter' })
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

/*
 * The import decision is the shared one (skill-import.ts), for every TUI source:
 * catalog, url and local. Before this, the terminal app named packages with its
 * own frontmatter reader and installed the source bytes under the catalog name.
 */
describe('the terminal app uses the shared import decision', () => {
  const BLOCK = '---\nname: other\ndescription: |\n  one\n  two\n---\n# Body\n'
  const decide = (content: string, url: string) => ({ ok: true as const, content, import: importSkillManifest(content, url, parseSkillFrontmatter) })
  afterEach(() => setSkillsFetchSeams(null))
  const catalogEntry = (name: string, raw_url: string) => ({ name, description: 'd', raw_url, sourceUrl: 'https://cat.test/c.json', sourceLabel: 'cat' })

  it('catalog: an entry whose SKILL.md names another skill is refused', async () => {
    setSkillsFetchSeams({ text: async (url) => decide(BLOCK, url) })
    expect(await loadPackage({ type: 'catalog', entry: catalogEntry('pdf', 'https://cat.test/pdf/SKILL.md') })).toEqual({ ok: false, error: 'The catalog lists "pdf" but its SKILL.md is named "other".' })
  })

  it('catalog and url: a block-scalar description installs adjusted, with the adjustment as a warning; an indexable file installs byte-for-byte', async () => {
    setSkillsFetchSeams({ text: async (url) => decide(url.endsWith('block/SKILL.md') ? BLOCK : skillMd('plain'), url) })
    const adjusted = await loadPackage({ type: 'catalog', entry: catalogEntry('other', 'https://cat.test/block/SKILL.md') })
    if (!adjusted.ok) throw new Error(adjusted.error)
    expect(parseSkillFrontmatter(adjusted.pkg.manifest)).toEqual({ name: 'other', description: 'one two' })
    expect(adjusted.pkg.warnings).toEqual(['description folded onto one line (YAML whitespace only)'])
    const plain = await loadPackage({ type: 'url', url: 'https://h.test/any/folder/SKILL.md' })
    if (!plain.ok) throw new Error(plain.error)
    expect(plain.pkg).toMatchObject({ name: 'plain', manifest: skillMd('plain'), warnings: [] })
  })

  describe('local folders', () => {
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'adf-skills-local-'))
      mkdirSync(join(dir, 'block'))
      writeFileSync(join(dir, 'block', 'SKILL.md'), BLOCK)
      mkdirSync(join(dir, 'many'))
      writeFileSync(join(dir, 'many', 'SKILL.md'), skillMd('many'))
      for (let i = 0; i < 256; i++) writeFileSync(join(dir, 'many', `r${String(i).padStart(3, '0')}.md`), 'x')
      mkdirSync(join(dir, 'big'))
      writeFileSync(join(dir, 'big', 'SKILL.md'), skillMd('big'))
      writeFileSync(join(dir, 'big', 'blob.bin'), Buffer.alloc(1024 * 1024 + 1))
      mkdirSync(join(dir, 'huge'))
      writeFileSync(join(dir, 'huge', 'SKILL.md'), skillMd('huge', 'd', 'x'.repeat(300 * 1024)))
      mkdirSync(join(dir, 'heavy'))
      writeFileSync(join(dir, 'heavy', 'SKILL.md'), skillMd('heavy'))
      writeFileSync(join(dir, 'heavy', 'a.bin'), '')
      truncateSync(join(dir, 'heavy', 'a.bin'), 4 * 1024 * 1024)
      writeFileSync(join(dir, 'heavy', 'b.bin'), '')
      truncateSync(join(dir, 'heavy', 'b.bin'), 4 * 1024 * 1024)
      mkdirSync(join(dir, 'latin'))
      writeFileSync(join(dir, 'latin', 'SKILL.md'), skillMd('latin'))
      writeFileSync(join(dir, 'latin', 'notes.txt'), Buffer.from([0xe9, 0x41]))
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('a folder is decided like any source: its frontmatter name, its adjusted bytes', async () => {
      const result = await readLocalPackage('block', dir)
      if (!result.ok) throw new Error(result.error)
      expect(result.pkg.name).toBe('other')
      expect(parseSkillFrontmatter(result.pkg.manifest)).toEqual({ name: 'other', description: 'one two' })
    })

    it('past the package bounds a local folder is refused, as a GitHub package is, never installed in part', async () => {
      expect(await readLocalPackage('many', dir)).toEqual({ ok: false, error: 'The package has more than 255 files beside SKILL.md; it cannot be installed.' })
    })

    // BI-F2/N-F2: one byte rule. No per-file cap: a resource over 1 MiB is read; the batch's 8 MiB total decides.
    it('a resource over 1 MiB is not refused on its own', async () => {
      const result = await readLocalPackage('big', dir)
      if (!result.ok) throw new Error(result.error)
      expect(result.pkg.resources.map((r) => r.path)).toEqual(['blob.bin'])
    })

    // N-F5: the SKILL.md size check is the import decision's, for every source.
    it('a SKILL.md past the index bound is refused by the import decision', async () => {
      expect(await readLocalPackage('huge', dir)).toEqual({ ok: false, error: 'SKILL.md is over 256 KB, the ADF index reads at most that' })
    })

    // Before: SKILL.md and every resource were read whole, whatever their size, before any bound applied.
    it('a SKILL.md past the index bound is refused by its size, without being read', async () => {
      const reads = vi.spyOn(fsPromises, 'readFile')
      try {
        expect(await readLocalPackage('huge', dir)).toEqual({ ok: false, error: 'SKILL.md is over 256 KB, the ADF index reads at most that' })
        expect(reads).not.toHaveBeenCalled()
      } finally {
        reads.mockRestore()
      }
    })

    it('a folder past the batch 8 MiB total is refused before the file that crosses it is read', async () => {
      const reads = vi.spyOn(fsPromises, 'readFile')
      try {
        const result = await readLocalPackage('heavy', dir)
        expect(result.ok).toBe(false)
        expect(!result.ok && result.error).toMatch(/^The package is past what one install writes: \d+ bytes in all \(at most 8388608\)\. It cannot be installed\.$/)
        expect(reads.mock.calls.map(([path]) => String(path).split(/[\\/]/).pop())).toEqual(['SKILL.md', 'a.bin'])
      } finally {
        reads.mockRestore()
      }
    })

    // Before: a resource without an early NUL was read as UTF-8 text, so Latin-1 bytes became U+FFFD.
    it('a non-UTF-8 resource reaches the planned batch byte-exactly', async () => {
      const result = await readLocalPackage('latin', dir)
      if (!result.ok) throw new Error(result.error)
      let sent: Array<{ path: string; contentBase64?: string }> = []
      const { client } = fakeClient()
      ;(client as unknown as { writeFiles: unknown }).writeFiles = async (_id: string, batch: typeof sent) => { sent = batch; return { success: true, revisions: {} } }
      expect((await install(client, 'a', result.pkg)).error).toBeNull()
      const notes = sent.find((f) => f.path === 'skills/latin/notes.txt')
      expect(Buffer.from(notes?.contentBase64 ?? '', 'base64').equals(Buffer.from([0xe9, 0x41]))).toBe(true)
    })
  })

  it('an older daemon without the batch route is said as version skew', async () => {
    const { client } = fakeClient()
    ;(client as unknown as { writeFiles: unknown }).writeFiles = async () => { throw Object.assign(new Error('Not Found'), { status: 404, body: { message: 'Route POST:/agents/a/files/batch not found', error: 'Not Found', code: 'not_found' } }) }
    const outcome = await install(client, 'a', { name: 'demo', description: 'd', source: 'disk', origin: '/x', label: 'local', warnings: [], manifest: skillMd('demo'), resources: [] })
    expect(outcome.error).toBe('This ADF runtime predates atomic skill installs; update it.')
  })
})
