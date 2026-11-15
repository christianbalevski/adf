import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guarded = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../../src/main/utils/guarded-fetch', async (orig) => ({ ...(await orig<object>()), guardedFetch: guarded.fn }))

import { fetchSkillPackage, fetchSkillPackageBytes, fetchSkillsCatalog } from '../../../src/main/services/skills-catalog-fetch'
import { clearGithubTreeCache, parseGithubUrl, pinnedRawUrl } from '../../../src/main/services/skills-github'
import {
  MAX_CATALOG_BYTES,
  MAX_DISCOVERED_PACKAGES,
  parseSkillsCatalogDocument,
  type DiscoveredSkillSource,
} from '../../../src/shared/schemas/skills-catalog.schema'
import { ADF_SKILLS_REGISTRY_URL } from '../../../src/shared/constants/adf-defaults'
import { FILE_BATCH_MAX_BYTES, FILE_BATCH_MAX_FILES } from '../../../src/shared/utils/file-batch'

const FIX = join(__dirname, '../../fixtures/skills-sources')
const read = (name: string) => readFileSync(join(FIX, name))
const ANTHROPIC_SHA = '1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064'
const OPENAI_SHA = 'd420d13051bffe4543ed39e30fa46b87148e47dd'
const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

type Answer = { bytes: Buffer; contentType?: string } | { error: string; status?: number; headers?: Record<string, string> }
/** `commits/HEAD` with Accept: application/vnd.github.sha answers the bare SHA. */
const sha = (value: string): Answer => ({ bytes: Buffer.from(value) })
const json = (value: unknown): Answer => ({ bytes: Buffer.from(JSON.stringify(value)), contentType: 'application/json' })
const notFound: Answer = { error: 'HTTP 404 Not Found', status: 404 }

/** A routed stand-in for guardedFetch: exact URL → answer, every call recorded. */
function serve(routes: Record<string, Answer | (() => Answer)>) {
  guarded.fn.mockImplementation(async (url: string) => {
    const answer = routes[url]
    if (!answer) return notFound
    return typeof answer === 'function' ? answer() : answer
  })
}
const calls = () => guarded.fn.mock.calls.map(([url, opts]) => ({ url: url as string, opts: opts as Record<string, unknown> }))
const apiCalls = () => calls().filter((c) => c.url.startsWith(API))

const anthropicRoutes = (): Record<string, Answer> => ({
  [`${API}/repos/anthropics/skills/commits/HEAD`]: sha(ANTHROPIC_SHA),
  [`${API}/repos/anthropics/skills/git/trees/${ANTHROPIC_SHA}?recursive=1`]: { bytes: read('anthropics-skills@1780c5e.tree.json') },
  [`${RAW}/anthropics/skills/${ANTHROPIC_SHA}/.claude-plugin/marketplace.json`]: { bytes: read('anthropics-skills@1780c5e.marketplace.json') },
})
const openaiRoutes = (): Record<string, Answer> => ({
  [`${API}/repos/openai/plugins/commits/HEAD`]: sha(OPENAI_SHA),
  [`${API}/repos/openai/plugins/git/trees/${OPENAI_SHA}?recursive=1`]: { bytes: read('openai-plugins@d420d13.tree.json') },
  [`${RAW}/openai/plugins/${OPENAI_SHA}/.agents/plugins/marketplace.json`]: { bytes: read('openai-plugins@d420d13.marketplace.json') },
})

async function discovered(url: string): Promise<DiscoveredSkillSource> {
  const result = await fetchSkillsCatalog(url)
  if (!result.ok) throw new Error(result.error)
  if (!result.discovered) throw new Error('not discovered')
  return result.discovered
}

beforeEach(() => {
  guarded.fn.mockReset()
  clearGithubTreeCache()
})

describe('dispatch: JSON catalogs are read exactly as before', () => {
  it('the default registry (raw.githubusercontent.com) is one request, no GitHub API call, entries identical', async () => {
    const body = readFileSync(join(__dirname, '../../../skills/registry.json'))
    serve({ [ADF_SKILLS_REGISTRY_URL]: { bytes: body } })
    const result = await fetchSkillsCatalog(ADF_SKILLS_REGISTRY_URL)
    const golden = parseSkillsCatalogDocument(JSON.parse(body.toString('utf8')))!
    expect(result).toEqual({ ok: true, entries: golden.entries, publisher: golden.publisher, dropped: golden.dropped })
    expect(golden.entries.length).toBeGreaterThan(10)
    expect(calls()).toEqual([{ url: ADF_SKILLS_REGISTRY_URL, opts: { maxBytes: MAX_CATALOG_BYTES, timeoutMs: 10_000 } }])
  })

  it('a third-party JSON catalog on any host is unchanged; HTML and junk keep their errors', async () => {
    serve({
      'https://cat.test/c.json': json({ skills: [{ name: 'pdf', description: 'PDFs', raw_url: 'https://cat.test/pdf/SKILL.md' }] }),
      'https://cat.test/page': { bytes: Buffer.from('<html>') },
      'https://cat.test/other.json': json({ what: 1 }),
    })
    expect(await fetchSkillsCatalog('https://cat.test/c.json')).toEqual({ ok: true, entries: [{ name: 'pdf', description: 'PDFs', raw_url: 'https://cat.test/pdf/SKILL.md' }], dropped: 0, publisher: undefined })
    expect(await fetchSkillsCatalog('https://cat.test/page')).toEqual({ ok: false, error: 'Catalog is not valid JSON' })
    expect(await fetchSkillsCatalog('https://cat.test/other.json')).toEqual({ ok: false, error: 'Unrecognized catalog schema' })
    expect(apiCalls()).toEqual([])
  })

  it('a JSON `plugins` document off GitHub, or a SKILL.md off GitHub, is not discovery', async () => {
    serve({
      'https://cat.test/.claude-plugin/marketplace.json': json({ plugins: [] }),
      'https://cat.test/x/SKILL.md': { bytes: Buffer.from('---\nname: x\n---\n') },
    })
    expect(await fetchSkillsCatalog('https://cat.test/.claude-plugin/marketplace.json')).toEqual({ ok: false, error: 'Unrecognized catalog schema' })
    expect(await fetchSkillsCatalog('https://cat.test/x/SKILL.md')).toEqual({ ok: false, error: 'Catalog is not valid JSON' })
    expect(apiCalls()).toEqual([])
  })
})

describe('GitHub discovery (fixtures at anthropics/skills@1780c5e and openai/plugins@d420d13)', () => {
  it('a repository root: one commit, one tree, every package listed, every URL pinned, no manifest fetched', async () => {
    serve(anthropicRoutes())
    const source = await discovered('https://github.com/anthropics/skills')
    expect(source).toMatchObject({ repository: 'anthropics/skills', sha: ANTHROPIC_SHA, ref: 'HEAD', scope: '' })
    expect(apiCalls()).toHaveLength(2)
    expect(source.packages).toHaveLength(20)
    expect(calls().map((c) => c.url)).toEqual([
      `${API}/repos/anthropics/skills/commits/HEAD`,
      `${API}/repos/anthropics/skills/git/trees/${ANTHROPIC_SHA}?recursive=1`,
    ])
    for (const pkg of source.packages) {
      expect(pkg.raw_url.startsWith(`${RAW}/anthropics/skills/${ANTHROPIC_SHA}/`)).toBe(true)
      for (const file of pkg.files) expect(file.raw_url.startsWith(`${RAW}/anthropics/skills/${ANTHROPIC_SHA}/`)).toBe(true)
    }
    const docx = source.packages.find((p) => p.dir === 'skills/docx')!
    expect(docx.id).toBe('https://github.com/anthropics/skills#skills/docx')
    expect(docx.files.map((f) => f.path)).toContain('LICENSE.txt')
    expect(docx.problem).toBeUndefined()
  })

  it('a root with 536 packages (> 64) lists all of them lazily, with distinct identities for duplicate folder names', async () => {
    serve(openaiRoutes())
    const source = await discovered('https://github.com/openai/plugins')
    expect(source.packages).toHaveLength(536)
    expect(new Set(source.packages.map((p) => p.id)).size).toBe(536)
    const react = source.packages.filter((p) => p.dir.endsWith('/react-best-practices')).map((p) => p.dir)
    expect(react).toEqual(['plugins/build-web-apps/skills/react-best-practices', 'plugins/vercel/skills/react-best-practices'])
    expect(calls().filter((c) => c.url.startsWith(RAW))).toEqual([])
    expect(apiCalls()).toHaveLength(2)
  })

  it('an ancestor license travels with the package under LICENSES/<folder>/', async () => {
    serve(openaiRoutes())
    const source = await discovered('https://github.com/openai/plugins')
    const figma = source.packages.find((p) => p.dir === 'plugins/figma/skills/figma-create-new-file')!
    expect(figma.files.filter((f) => f.license).map((f) => f.path)).toEqual(['LICENSES/plugins/figma/LICENSE.txt'])
    expect(figma.files.find((f) => f.license)).toEqual({ path: 'LICENSES/plugins/figma/LICENSE.txt', raw_url: pinnedRawUrl('openai', 'plugins', OPENAI_SHA, 'plugins/figma/LICENSE.txt'), size: expect.any(Number), license: true })
  })

  it('the tree of a commit is cached: a second look costs only the ref resolution', async () => {
    serve(anthropicRoutes())
    await discovered('https://github.com/anthropics/skills')
    guarded.fn.mockClear()
    await discovered('https://github.com/anthropics/skills')
    expect(apiCalls().map((c) => c.url)).toEqual([`${API}/repos/anthropics/skills/commits/HEAD`])
  })

  it('a folder (tree/<sha>/<path>) and a SKILL.md (blob/<sha>/…) scope the listing', async () => {
    serve(anthropicRoutes())
    const folder = await discovered(`https://github.com/anthropics/skills/tree/${ANTHROPIC_SHA}/skills/docx`)
    expect(folder.packages.map((p) => p.dir)).toEqual(['skills/docx'])
    expect(apiCalls().some((c) => c.url.includes('/commits/'))).toBe(false)
    const one = await discovered(`https://github.com/anthropics/skills/blob/${ANTHROPIC_SHA}/skills/pdf/SKILL.md`)
    expect(one.packages.map((p) => p.dir)).toEqual(['skills/pdf'])
    expect((await fetchSkillsCatalog(`https://github.com/anthropics/skills/blob/${ANTHROPIC_SHA}/skills/nope/SKILL.md`))).toEqual({ ok: false, error: `skills/nope/SKILL.md does not exist at ${ANTHROPIC_SHA.slice(0, 7)}.` })
    expect((await fetchSkillsCatalog(`https://github.com/anthropics/skills/tree/${ANTHROPIC_SHA}/no/such/folder`))).toEqual({ ok: false, error: 'no/such/folder is not a folder at this commit.' })
  })

  it('a Claude marketplace (raw URL on a moving branch) is re-read at the pinned commit; its member list decides', async () => {
    const routes = anthropicRoutes()
    // The moving branch answers a DIFFERENT document than the pinned commit has.
    routes[`${RAW}/anthropics/skills/main/.claude-plugin/marketplace.json`] = json({ plugins: [{ name: 'moved', source: './elsewhere' }] })
    routes[`${API}/repos/anthropics/skills/git/matching-refs/heads/main`] = json([{ ref: 'refs/heads/main', object: { type: 'commit', sha: ANTHROPIC_SHA } }])
    routes[`${API}/repos/anthropics/skills/git/matching-refs/tags/main`] = json([])
    serve(routes)
    const source = await discovered(`${RAW}/anthropics/skills/main/.claude-plugin/marketplace.json`)
    expect(source.scope).toBe('.claude-plugin/marketplace.json')
    expect(source.problems.join('\n')).not.toMatch(/moved/)
    expect(calls().map((c) => c.url)).toContain(`${RAW}/anthropics/skills/${ANTHROPIC_SHA}/.claude-plugin/marketplace.json`)
    const marketplace = JSON.parse(read('anthropics-skills@1780c5e.marketplace.json').toString()) as { plugins: Array<{ skills?: string[] }> }
    const listed = new Set(marketplace.plugins.flatMap((p) => (p.skills ?? []).map((s) => s.replace(/^\.\//, ''))))
    expect(new Set(source.packages.map((p) => p.dir))).toEqual(listed)
  })

  // N-F1: a raw SKILL.md / marketplace.json was fetched once and sniffed, then discovery ran and the bytes were dropped.
  it('a raw SKILL.md or marketplace.json is discovered by its path alone: the moving URL itself is never fetched', async () => {
    const routes = anthropicRoutes()
    routes[`${API}/repos/anthropics/skills/git/matching-refs/heads/main`] = json([{ ref: 'refs/heads/main', object: { type: 'commit', sha: ANTHROPIC_SHA } }])
    routes[`${API}/repos/anthropics/skills/git/matching-refs/tags/main`] = json([])
    serve(routes)
    for (const url of [`${RAW}/anthropics/skills/main/skills/pdf/SKILL.md`, `${RAW}/anthropics/skills/main/.claude-plugin/marketplace.json`]) {
      expect(await fetchSkillsCatalog(url)).toMatchObject({ ok: true, discovered: { repository: 'anthropics/skills', sha: ANTHROPIC_SHA } })
      expect(calls().map((c) => c.url)).not.toContain(url)
    }
  })

  it('a Codex marketplace: local members listed, every external member reported, none silently dropped', async () => {
    serve(openaiRoutes())
    const source = await discovered(`https://github.com/openai/plugins/blob/${OPENAI_SHA}/.agents/plugins/marketplace.json`)
    const doc = JSON.parse(read('openai-plugins@d420d13.marketplace.json').toString()) as { plugins: Array<{ name: string; source: { source: string } }> }
    const external = doc.plugins.filter((p) => p.source.source !== 'local').map((p) => p.name)
    expect(external).toHaveLength(3)
    for (const name of external) expect(source.problems.some((p) => p.startsWith(`${name}: lives outside this repository`))).toBe(true)
    expect(source.packages.length).toBeGreaterThan(400)
    expect(source.packages.every((p) => p.dir.startsWith('plugins/'))).toBe(true)
  })

  it('no license anywhere is said, not implied', async () => {
    serve({
      [`${API}/repos/o/r/commits/HEAD`]: sha('a'.repeat(40)),
      [`${API}/repos/o/r/git/trees/${'a'.repeat(40)}?recursive=1`]: json({ truncated: false, tree: [{ path: 's', mode: '040000', type: 'tree', sha: 'b'.repeat(40) }, { path: 's/SKILL.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 10 }] }),
    })
    expect((await discovered('https://github.com/o/r')).problems).toEqual([`No license file found for these packages in o/r at aaaaaaa. Check the repository's terms before installing.`])
  })
})

describe('ref resolution (synthetic answers)', () => {
  const SHA_A = 'a'.repeat(40)
  const SHA_B = 'b'.repeat(40)
  const TAG_OBJ = 'c'.repeat(40)
  const tree = (paths: string[]) => json({ truncated: false, tree: paths.map((path) => ({ path, mode: path.endsWith('SKILL.md') ? '100644' : '040000', type: path.endsWith('SKILL.md') ? 'blob' : 'tree', sha: 'd'.repeat(40), size: 20 })) })

  it('the longest branch whose segments prefix the URL wins (slash refs)', async () => {
    serve({
      [`${API}/repos/o/r/git/matching-refs/heads/feature`]: json([
        { ref: 'refs/heads/feature', object: { type: 'commit', sha: SHA_B } },
        { ref: 'refs/heads/feature/x', object: { type: 'commit', sha: SHA_A } },
        { ref: 'refs/heads/featurex', object: { type: 'commit', sha: SHA_B } },
      ]),
      [`${API}/repos/o/r/git/matching-refs/tags/feature`]: json([]),
      [`${API}/repos/o/r/git/trees/${SHA_A}?recursive=1`]: tree(['skills', 'skills/a', 'skills/a/SKILL.md']),
    })
    const source = await discovered('https://github.com/o/r/tree/feature/x/skills')
    expect(source).toMatchObject({ sha: SHA_A, ref: 'feature/x', scope: 'skills' })
    expect(source.packages.map((p) => p.dir)).toEqual(['skills/a'])
  })

  it('a branch beats a tag of the same name; an annotated tag is peeled to its commit', async () => {
    serve({
      [`${API}/repos/o/r/git/matching-refs/heads/v1`]: json([{ ref: 'refs/heads/v1', object: { type: 'commit', sha: SHA_A } }]),
      [`${API}/repos/o/r/git/matching-refs/tags/v1`]: json([{ ref: 'refs/tags/v1', object: { type: 'tag', sha: TAG_OBJ } }]),
      [`${API}/repos/o/r/git/trees/${SHA_A}?recursive=1`]: tree(['SKILL.md']),
    })
    expect((await discovered('https://github.com/o/r/tree/v1')).sha).toBe(SHA_A)
    guarded.fn.mockReset()
    serve({
      [`${API}/repos/o/r/git/matching-refs/heads/v2`]: json([]),
      [`${API}/repos/o/r/git/matching-refs/tags/v2`]: json([{ ref: 'refs/tags/v2', object: { type: 'tag', sha: TAG_OBJ } }]),
      [`${API}/repos/o/r/git/tags/${TAG_OBJ}`]: json({ object: { type: 'commit', sha: SHA_B } }),
      [`${API}/repos/o/r/git/trees/${SHA_B}?recursive=1`]: tree(['SKILL.md']),
    })
    const tagged = await discovered('https://github.com/o/r/tree/v2')
    expect(tagged).toMatchObject({ sha: SHA_B, ref: 'v2' })
    expect(tagged.packages[0].raw_url).toBe(`${RAW}/o/r/${SHA_B}/SKILL.md`)
  })

  it('an unknown ref, a private or missing repository, and the rate limit are said plainly', async () => {
    serve({ [`${API}/repos/o/r/git/matching-refs/heads/nope`]: json([]), [`${API}/repos/o/r/git/matching-refs/tags/nope`]: json([]) })
    expect(await fetchSkillsCatalog('https://github.com/o/r/tree/nope/x')).toEqual({ ok: false, error: 'o/r has no branch or tag "nope…".' })
    serve({})
    expect((await fetchSkillsCatalog('https://github.com/o/private')) as { error: string }).toMatchObject({ ok: false, error: expect.stringMatching(/not found \(a private repository/) })
    serve({ [`${API}/repos/o/r/commits/HEAD`]: { error: 'HTTP 403 Forbidden', status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 10, 14, 12, 34) / 1000) } } })
    expect(await fetchSkillsCatalog('https://github.com/o/r')).toEqual({ ok: false, error: "GitHub's unauthenticated API limit (60 requests an hour) is used up; it resets at 12:34 UTC. Nothing was listed." })
  })
})

describe('completeness and bounds (synthetic trees)', () => {
  const SHA = 'e'.repeat(40)
  const blob = (path: string, size = 10, mode = '100644') => ({ path, mode, type: 'blob', sha: 'f'.repeat(40), size })
  const dir = (path: string) => ({ path, mode: '040000', type: 'tree', sha: `${path.length}`.padStart(40, '0') })
  const head = { [`${API}/repos/o/r/commits/HEAD`]: sha(SHA) }

  it('a truncated listing is never used: the root is refused; a folder is walked and listed whole', async () => {
    serve({ ...head, [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: json({ truncated: true, tree: [blob('a/SKILL.md')] }) })
    expect(await fetchSkillsCatalog('https://github.com/o/r')).toEqual({ ok: false, error: 'o/r is too large for GitHub to list in one answer; nothing was listed. Paste the URL of the folder that holds the skills.' })
    const skillsTree = '1'.repeat(40)
    serve({
      [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: json({ truncated: true, tree: [] }),
      [`${API}/repos/o/r/git/trees/${SHA}`]: json({ truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: skillsTree }, blob('LICENSE')] }),
      [`${API}/repos/o/r/git/trees/${skillsTree}?recursive=1`]: json({ truncated: false, tree: [dir('a'), blob('a/SKILL.md'), blob('a/ref.md')] }),
    })
    const source = await discovered(`https://github.com/o/r/tree/${SHA}/skills`)
    expect(source.packages.map((p) => [p.dir, p.files.map((f) => f.path)])).toEqual([['skills/a', ['ref.md', 'LICENSES/_root/LICENSE']]])
    serve({
      [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: json({ truncated: true, tree: [] }),
      [`${API}/repos/o/r/git/trees/${SHA}`]: json({ truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: skillsTree }] }),
      [`${API}/repos/o/r/git/trees/${skillsTree}?recursive=1`]: json({ truncated: true, tree: [] }),
    })
    clearGithubTreeCache()
    expect(await fetchSkillsCatalog(`https://github.com/o/r/tree/${SHA}/skills`)).toEqual({ ok: false, error: 'skills is too large for GitHub to list in one answer; nothing was listed. Paste the URL of a smaller folder.' })
  })

  it(`lists exactly ${MAX_DISCOVERED_PACKAGES} packages and refuses one more, never truncating`, async () => {
    const many = (n: number) => json({ truncated: false, tree: Array.from({ length: n }, (_, i) => blob(`p${i}/SKILL.md`)) })
    serve({ ...head, [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: many(MAX_DISCOVERED_PACKAGES) })
    expect((await discovered('https://github.com/o/r')).packages).toHaveLength(MAX_DISCOVERED_PACKAGES)
    clearGithubTreeCache()
    serve({ ...head, [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: many(MAX_DISCOVERED_PACKAGES + 1) })
    expect(await fetchSkillsCatalog('https://github.com/o/r')).toEqual({ ok: false, error: `${MAX_DISCOVERED_PACKAGES + 1} packages found; this browser lists at most ${MAX_DISCOVERED_PACKAGES} from one URL. Paste the URL of a folder that holds fewer.` })
  })

  const MiB = 1024 * 1024
  it('per-package bounds at their exact edges, counting SKILL.md and license files; symlinks, submodules and unusable paths refuse the package', async () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => blob(`full/r${i}.md`))
    serve({
      ...head,
      [`${API}/repos/o/r/git/trees/${SHA}?recursive=1`]: json({
        truncated: false,
        tree: [
          blob('NOTICE'),
          // SKILL.md + 254 resources + the root NOTICE = 256 files: installable.
          blob('full/SKILL.md'), ...files(254),
          // One more resource: 257.
          blob('over/SKILL.md'), ...Array.from({ length: 255 }, (_, i) => blob(`over/r${i}.md`)),
          // No per-file cap: one byte rule, the batch's total (BI-F2/N-F2).
          blob('big/SKILL.md'), blob('big/a.bin', MiB), blob('big/b.bin', 2 * MiB + 1),
          blob('heavy/SKILL.md', 1), ...Array.from({ length: 8 }, (_, i) => blob(`heavy/x${i}.bin`, MiB)),
          blob('link/SKILL.md'), blob('link/to-secret', 10, '120000'),
          blob('sub/SKILL.md'), { path: 'sub/vendor', mode: '160000', type: 'commit', sha: '9'.repeat(40) },
          blob('spaces/SKILL.md'), blob('spaces/my file.md'),
          blob('clash/SKILL.md'), blob('clash/LICENSES/_root/NOTICE'),
          blob('nested/SKILL.md'), blob('nested/inner/SKILL.md'), blob('nested/inner/x.md'),
        ],
      }),
    })
    const source = await discovered('https://github.com/o/r')
    const by = Object.fromEntries(source.packages.map((p) => [p.dir, p]))
    expect(by.full.files).toHaveLength(FILE_BATCH_MAX_FILES - 1)
    expect(by.full.problem).toBeUndefined()
    expect(by.over.problem).toBe(`${FILE_BATCH_MAX_FILES + 1} files (at most ${FILE_BATCH_MAX_FILES}, SKILL.md and license files included)`)
    expect(by.big.problem).toBeUndefined()
    expect(by.heavy.problem).toBe(`${8 * MiB + 1 + 10} bytes in all (at most ${FILE_BATCH_MAX_BYTES})`)
    expect(by.link.problem).toBe('to-secret is a symbolic link')
    expect(by.sub.problem).toBe('vendor is a git submodule')
    expect(by.spaces.problem).toBe('my file.md: path has characters ADF package paths do not allow')
    expect(by.clash.problem).toBe('LICENSES/_root/NOTICE already exists in the package; the license NOTICE would collide')
    // A nested package keeps its files inside its parent, and is listed on its own as well.
    expect(by.nested.files.map((f) => f.path)).toEqual(['inner/SKILL.md', 'inner/x.md', 'LICENSES/_root/NOTICE'])
    expect(by['nested/inner'].files.map((f) => f.path)).toEqual(['x.md', 'LICENSES/_root/NOTICE'])
  })
})

describe('URL safety', () => {
  it('refuses encoded separators, traversal and odd names before any request; other hosts are not GitHub', () => {
    expect(() => parseGithubUrl('https://github.com/o/r/tree/main/a%2Fb')).toThrow(/unusable path segment/)
    expect(() => parseGithubUrl('https://github.com/o/r/tree/main/a%5Cb')).toThrow(/unusable path segment/)
    // Dot segments, encoded or not, are resolved by the URL standard before
    // this parser sees the path (as a browser would); what is left is a plain path.
    expect(parseGithubUrl('https://github.com/o/r/tree/main/%2E%2E/x')).toEqual({ owner: 'o', repo: 'r', kind: 'tree', segments: ['x'] })
    expect(parseGithubUrl('https://github.com/o/r/tree/main/%252E%252E/x')).toEqual({ owner: 'o', repo: 'r', kind: 'tree', segments: ['main', '%2E%2E', 'x'] })
    expect(() => parseGithubUrl('https://github.com/o/r/tree/main/%00')).toThrow(/unusable path segment/)
    expect(() => parseGithubUrl('https://github.com/-o/r')).toThrow(/not a GitHub repository name/)
    expect(() => parseGithubUrl('https://github.com/o/r/issues/1')).toThrow(/Paste a repository/)
    expect(parseGithubUrl('https://github.com.evil.test/o/r')).toBeNull()
    expect(parseGithubUrl('https://user:pw@github.com/o/r')).toBeNull()
    expect(parseGithubUrl('https://github.com:8443/o/r')).toBeNull()
    expect(parseGithubUrl('https://gist.github.com/o/r')).toBeNull()
  })

  it('only https; every GitHub request carries only accept and user-agent', async () => {
    expect(await fetchSkillsCatalog('http://github.com/o/r')).toEqual({ ok: false, error: 'Catalog URL must be https' })
    serve(anthropicRoutes())
    await discovered('https://github.com/anthropics/skills/blob/main/.claude-plugin/marketplace.json'.replace('main', ANTHROPIC_SHA))
    for (const call of calls()) {
      expect(Object.keys(call.opts.headers as object).sort()).toEqual(['accept', 'user-agent'])
    }
  })
})

describe('package reads', () => {
  it('a SKILL.md comes with its import decision; resources come as exact bytes within the batch bound', async () => {
    const docx = read('manifests/anthropics-docx.SKILL.md')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff])
    serve({ 'https://h.test/SKILL.md': { bytes: docx }, 'https://h.test/logo.png': { bytes: png } })
    const manifest = await fetchSkillPackage('https://h.test/SKILL.md')
    expect(manifest).toMatchObject({ ok: true, content: docx.toString('utf8'), import: { ok: true, name: 'docx', changes: [expect.stringMatching(/^description shortened from 835 to \d+ characters/)] } })
    expect(await fetchSkillPackageBytes('https://h.test/logo.png')).toEqual({ ok: true, contentBase64: png.toString('base64'), size: png.length })
    expect(guarded.fn).toHaveBeenLastCalledWith('https://h.test/logo.png', { maxBytes: FILE_BATCH_MAX_BYTES, timeoutMs: 10_000 })
    expect(await fetchSkillPackageBytes('ftp://h.test/x')).toEqual({ ok: false, error: 'Package URL must be https' })
  })
})

describe('raw.githubusercontent.com JSON catalogs keep working whatever their path spells', () => {
  it.each([
    'https://raw.githubusercontent.com/org/repo/feature%2Fx/registry.json',
    'https://raw.githubusercontent.com/org/repo/refs/heads/main/skills/registry.json',
    'https://raw.githubusercontent.com/under_score/repo/main/c.json',
    'https://raw.githubusercontent.com/org/repo/c.json',
  ])('%s: one request, parsed as a catalog, no API call', async (url) => {
    serve({ [url]: json({ skills: [{ name: 'pdf', description: 'PDFs', raw_url: 'https://cat.test/pdf/SKILL.md' }] }) })
    expect(await fetchSkillsCatalog(url)).toMatchObject({ ok: true, entries: [{ name: 'pdf' }] })
    expect(calls().map((c) => c.url)).toEqual([url])
  })
})

describe('github.com URLs that address a file keep the single fetch (no discovery, no API request)', () => {
  const catalog = json({ skills: [{ name: 'pdf', description: 'PDFs', raw_url: 'https://cat.test/pdf/SKILL.md' }] })
  it.each([
    'https://github.com/christianbalevski/adf/raw/main/skills/registry.json',
    'https://github.com/christianbalevski/adf/blob/main/skills/registry.json?raw=true',
    'https://github.com/christianbalevski/adf/blob/main/skills/SKILL.md?raw=1',
  ])('%s is fetched once and read as a catalog', async (url) => {
    serve({ [url]: catalog })
    expect(await fetchSkillsCatalog(url)).toMatchObject({ ok: true, entries: [{ name: 'pdf' }] })
    expect(calls().map((c) => c.url)).toEqual([url])
    expect(calls()[0].opts).toEqual({ maxBytes: MAX_CATALOG_BYTES, timeoutMs: 10_000 })
  })

  it.each([
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/issues/1',
  ])('%s (not a skills page) is fetched once as before and spends no API request', async (url) => {
    serve({ [url]: { bytes: Buffer.from('<!DOCTYPE html>') } })
    expect(await fetchSkillsCatalog(url)).toEqual({ ok: false, error: 'Catalog is not valid JSON' })
    expect(calls().map((c) => c.url)).toEqual([url])
  })
})

describe('the default branch is resolved as a bare SHA, never the commit document', () => {
  it('asks for application/vnd.github.sha with a small cap, and refuses an answer that is not a SHA', async () => {
    serve(anthropicRoutes())
    await discovered('https://github.com/anthropics/skills')
    const head = calls().find((c) => c.url.endsWith('/commits/HEAD'))!
    expect(head.opts.headers).toEqual({ accept: 'application/vnd.github.sha', 'user-agent': 'ADF-Studio' })
    expect(head.opts.maxBytes).toBe(256)
    clearGithubTreeCache()
    // A JSON commit document (what the default media type answers, up to megabytes) is not a SHA.
    serve({ ...anthropicRoutes(), [`${API}/repos/anthropics/skills/commits/HEAD`]: json({ sha: ANTHROPIC_SHA, files: [] }) })
    expect(await fetchSkillsCatalog('https://github.com/anthropics/skills')).toEqual({ ok: false, error: 'anthropics/skills: GitHub did not answer a commit for its default branch.' })
  })
})
