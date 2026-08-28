import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// The egress guard resolves DNS; unit tests must not. Its own behavior is
// covered by tests/unit/tools/sys-fetch-ssrf.test.ts.
vi.mock('../../../src/main/utils/ssrf-guard', () => ({
  checkFetchTarget: vi.fn(async () => null),
}))

import { checkFetchTarget } from '../../../src/main/utils/ssrf-guard'
import { SkillInstallTool } from '../../../src/main/tools/built-in/skill-install.tool'
import { DEFAULT_DAEMON_PORT } from '../../../src/main/utils/guarded-fetch'
import { ADF_SKILLS_REGISTRY_URL } from '../../../src/shared/constants/adf-defaults'

const guard = vi.mocked(checkFetchTarget)

const CATALOG = ADF_SKILLS_REGISTRY_URL
const RAW = 'https://raw.githubusercontent.com/x/adf/main/skills/alpha/SKILL.md'

const MANIFEST = '---\nname: alpha\ndescription: Does alpha things.\n---\n\n# Alpha\n'

/**
 * Stand-in for a fetch Response. The body is a REAL ReadableStream so the
 * shared guard's streaming size cap is what runs here, as in production.
 */
function res(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => init.headers?.[key.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (body) controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
  }
}

function routeFetch(routes: Record<string, ReturnType<typeof res>>) {
  return vi.fn(async (url: string) => routes[url] ?? res('not found', { status: 404 }))
}

function catalogJson(entry: Record<string, unknown>) {
  return JSON.stringify({ schema: 1, skills: [entry] })
}

function makeWorkspace(config: Record<string, unknown>) {
  const files = new Map<string, { content: string; protection: string }>()
  const writes: string[] = []
  const workspace = {
    files,
    writes,
    setAgentConfig: vi.fn(),
    getAgentConfig: () => config as never,
    readFile: (path: string) => files.get(path)?.content ?? null,
    listFiles: () => [...files.entries()].map(([path, value]) => ({
      path, size: value.content.length, protection: value.protection, authorized: false,
    })),
    writeFile: (path: string, content: string, protection?: string) => {
      files.set(path, { content, protection: protection ?? 'none' })
      writes.push(path)
    },
    writeFileBuffer: (path: string, content: Buffer) => {
      files.set(path, { content: content.toString('utf-8'), protection: 'none' })
      writes.push(path)
    },
    getFileProtection: (path: string) => files.get(path)?.protection ?? null,
  }
  return workspace
}

const baseConfig = () => ({
  skills: { enabled: true },
  tools: [
    { name: 'fs_read', enabled: true, visible: true },
    { name: 'fs_write', enabled: true, visible: true },
    { name: 'compute_exec', enabled: false, visible: false },
  ],
})

describe('SkillInstallTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', routeFetch({}))
    guard.mockClear()
    guard.mockResolvedValue(null)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  // Every fetch this tool makes goes through the shared guard, and the guard's
  // daemon tier is inert without the port — loopback is default-open, so
  // without it a catalog could redirect an install straight into the local
  // control API.
  it('passes daemonPort to the egress guard on every hop', async () => {
    const hop = 'https://cdn.example.test/alpha/SKILL.md'
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res('', { status: 302, headers: { location: hop } }),
      [hop]: res(MANIFEST),
    }))

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, makeWorkspace(baseConfig()) as never)

    expect(JSON.parse(result.content).installed).toEqual(['skills/alpha/SKILL.md'])
    // Catalog, the manifest URL, and the redirect target.
    expect(guard.mock.calls.map((call) => call[0])).toEqual([CATALOG, RAW, hop])
    for (const call of guard.mock.calls) {
      expect(call[1]).toEqual({ allowLocal: false, daemonPort: DEFAULT_DAEMON_PORT })
    }
  })

  it('refuses a redirect that downgrades to http instead of following it', async () => {
    const metadata = 'http://169.254.169.254/latest/meta-data/iam/'
    const fetchMock = routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res('', { status: 302, headers: { location: metadata } }),
      [metadata]: res(MANIFEST),
    })
    vi.stubGlobal('fetch', fetchMock)
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/only https URLs may be fetched \(got "http:"\)/)
    // The downgraded hop is never requested at all.
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([CATALOG, RAW])
    expect(workspace.writes).toEqual([])
  })

  it('stops a chunked manifest at the cap instead of buffering it whole', async () => {
    const oversized = {
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { get: () => null }, // no content-length: chunked
      arrayBuffer: async () => new ArrayBuffer(0),
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024))) },
      }),
    }
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: oversized as never,
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/exceeds 262144 bytes/)
    expect(workspace.writes).toEqual([])
  })

  it('installs a package from the default catalog at protection none', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', description: 'Does alpha things.', path: 'skills/alpha/SKILL.md', raw_url: RAW })),
      [RAW]: res(MANIFEST, { headers: { 'content-type': 'text/markdown' } }),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(content).toEqual(expect.objectContaining({
      success: true,
      name: 'alpha',
      catalog: CATALOG,
      installed: ['skills/alpha/SKILL.md'],
      rejected: [],
    }))
    expect(content.requires_unmet).toBeUndefined()
    expect(workspace.files.get('skills/alpha/SKILL.md')).toEqual({ content: MANIFEST, protection: 'none' })
    // Never touches config, tools, or approvals.
    expect(workspace.setAgentConfig).not.toHaveBeenCalled()
  })

  it('writes resource files first and SKILL.md last so a half-install never indexes', async () => {
    const script = 'https://raw.githubusercontent.com/x/adf/main/skills/alpha/scripts/run.js'
    const reference = 'https://raw.githubusercontent.com/x/adf/main/skills/alpha/references/notes.md'
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({
        name: 'alpha', raw_url: RAW,
        files: [
          { path: 'scripts/run.js', raw_url: script },
          { path: 'skills/alpha/references/notes.md', raw_url: reference },
        ],
      })),
      [RAW]: res(MANIFEST),
      [script]: res('export const run = () => {}\n'),
      [reference]: res('# Notes\n'),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.installed).toEqual([
      'skills/alpha/scripts/run.js',
      'skills/alpha/references/notes.md',
      'skills/alpha/SKILL.md',
    ])
    // The manifest is the path the indexer keys on — it must be the final write.
    expect(workspace.writes.at(-1)).toBe('skills/alpha/SKILL.md')
  })

  it('rejects a resource path that escapes the package directory, and installs the rest', async () => {
    const escape = 'https://raw.githubusercontent.com/x/adf/main/evil.js'
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({
        name: 'alpha', raw_url: RAW,
        files: [
          { path: '../../mind.md', raw_url: escape },
          { path: '/etc/passwd', raw_url: escape },
          { path: 'SKILL.md', raw_url: escape },
        ],
      })),
      [RAW]: res(MANIFEST),
      [escape]: res('pwned'),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.rejected).toHaveLength(3)
    expect(content.rejected.map((r: { path: string }) => r.path)).toEqual(['../../mind.md', '/etc/passwd', 'SKILL.md'])
    expect(content.installed).toEqual(['skills/alpha/SKILL.md'])
    expect(workspace.files.has('mind.md')).toBe(false)
  })

  it('refuses a frontmatter name that does not match the requested name, writing nothing', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res('---\nname: beta\ndescription: Impostor.\n---\n'),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/does not match the requested name/)
    expect(workspace.writes).toEqual([])
  })

  it('refuses a manifest with no usable frontmatter', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res('# Alpha\n\nno frontmatter here\n'),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/missing YAML frontmatter/)
    expect(workspace.writes).toEqual([])
  })

  it('reports an already-installed skill and fetches nothing, unless overwrite is set', async () => {
    const fetchMock = routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res(MANIFEST),
    })
    vi.stubGlobal('fetch', fetchMock)
    const workspace = makeWorkspace(baseConfig())
    workspace.files.set('skills/alpha/SKILL.md', { content: 'old', protection: 'none' })
    workspace.writes.length = 0

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(content).toEqual(expect.objectContaining({ success: true, already_installed: true }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(workspace.writes).toEqual([])

    const overwritten = await new SkillInstallTool().execute({ name: 'alpha', overwrite: true }, workspace as never)
    expect(JSON.parse(overwritten.content).installed).toEqual(['skills/alpha/SKILL.md'])
    expect(workspace.files.get('skills/alpha/SKILL.md')!.content).toBe(MANIFEST)
  })

  it('names files a reinstall left behind instead of silently mixing versions', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res(MANIFEST),
    }))
    const workspace = makeWorkspace(baseConfig())
    workspace.files.set('skills/alpha/SKILL.md', { content: 'old', protection: 'none' })
    workspace.files.set('skills/alpha/scripts/legacy.js', { content: 'old', protection: 'none' })

    const result = await new SkillInstallTool().execute({ name: 'alpha', overwrite: true }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.stale_files).toEqual(['skills/alpha/scripts/legacy.js'])
    expect(content.message).toMatch(/Left over from a previous install/)
    // Reported, not deleted — removal is skill_remove's job.
    expect(workspace.files.has('skills/alpha/scripts/legacy.js')).toBe(true)
  })

  it('refuses a catalog URL that is not in the configured allowlist', async () => {
    const fetchMock = routeFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const config = { ...baseConfig(), skills: { enabled: true, catalogs: ['https://catalogs.example.com/skills.json'] } }
    const workspace = makeWorkspace(config)

    const result = await new SkillInstallTool().execute(
      { name: 'alpha', catalog_url: 'https://evil.example.com/skills.json' },
      workspace as never,
    )
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/not configured for this agent/)
    expect(content.allowed_catalogs).toEqual(['https://catalogs.example.com/skills.json'])
    expect(fetchMock).not.toHaveBeenCalled()
    // A configured catalog is not the default one — the default is not a back door.
    expect(content.error).not.toContain(ADF_SKILLS_REGISTRY_URL)
  })

  it('accepts a catalog URL that IS in the allowlist and searches only that one', async () => {
    const custom = 'https://catalogs.example.com/skills.json'
    const fetchMock = routeFetch({
      [custom]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res(MANIFEST),
    })
    vi.stubGlobal('fetch', fetchMock)
    const workspace = makeWorkspace({ ...baseConfig(), skills: { enabled: true, catalogs: [custom, CATALOG] } })

    const result = await new SkillInstallTool().execute({ name: 'alpha', catalog_url: custom }, workspace as never)

    expect(JSON.parse(result.content).catalog).toBe(custom)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([custom, RAW])
  })

  it('reports unmet requires without enabling anything', async () => {
    const manifest =
      '---\nname: alpha\ndescription: Needs things.\nadf: ">=0.2"\nrequires:\n' +
      '  tools: [fs_read, compute_exec, nonexistent_tool]\n  config: [compute.enabled]\n---\n\n# Alpha\n'
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res(manifest),
    }))
    const config = baseConfig()
    const workspace = makeWorkspace(config)

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(content.requires_unmet).toEqual([
      'tool compute_exec is disabled',
      'tool nonexistent_tool is not available in this runtime',
      'config compute.enabled is not set',
    ])
    expect(content.message).toMatch(/Nothing was enabled or changed to satisfy them/)
    // The checklist is reported, never acted on.
    expect(workspace.setAgentConfig).not.toHaveBeenCalled()
    expect(config.tools.find((t) => t.name === 'compute_exec')!.enabled).toBe(false)
    expect(content.installed).toEqual(['skills/alpha/SKILL.md'])
  })

  it('errors with an enablement route when skills.enabled is false', async () => {
    const fetchMock = routeFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const workspace = makeWorkspace({ ...baseConfig(), skills: { enabled: false } })

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/skills\.enabled is false/)
    expect(content.error).toMatch(/sys_update_config/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not write over a read-only manifest', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res(MANIFEST),
    }))
    const workspace = makeWorkspace(baseConfig())
    workspace.files.set('skills/alpha/SKILL.md', { content: 'protected', protection: 'read_only' })
    workspace.writes.length = 0

    const result = await new SkillInstallTool().execute({ name: 'alpha', overwrite: true }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/read-only/)
    expect(workspace.writes).toEqual([])
  })

  it('reports a missing catalog entry instead of inventing one', async () => {
    vi.stubGlobal('fetch', routeFetch({ [CATALOG]: res(catalogJson({ name: 'beta', raw_url: RAW })) }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/No skill named "alpha"/)
    expect(workspace.writes).toEqual([])
  })

  it('rejects a non-https raw_url rather than fetching it', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: 'http://internal.example/SKILL.md' })),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/only https URLs/)
    expect(workspace.writes).toEqual([])
  })

  it('rejects a manifest larger than the indexer would ever accept', async () => {
    vi.stubGlobal('fetch', routeFetch({
      [CATALOG]: res(catalogJson({ name: 'alpha', raw_url: RAW })),
      [RAW]: res('x'.repeat(256 * 1024 + 1)),
    }))
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/exceeds 262144 bytes/)
    expect(workspace.writes).toEqual([])
  })

  it('refuses a name that could never index', async () => {
    const fetchMock = routeFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const workspace = makeWorkspace(baseConfig())

    const result = await new SkillInstallTool().execute({ name: '../escape' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/not a usable skill name/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
