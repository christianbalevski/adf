import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentRegistryService, AGENT_REGISTRY_INDEX_URL, sha256Hex } from '../../../src/main/services/agent-registry.service'
import { parseAgentRegistryIndex, compareAppVersions } from '../../../src/shared/schemas/agent-registry.schema'
import type { GuardedFetchResult } from '../../../src/main/utils/guarded-fetch'

function entry(id: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  return {
    id,
    file: `${id}.adf`,
    name: id,
    blurb: `${id} blurb`,
    tags: [],
    sha256: sha256Hex(bytes),
    size: bytes.length,
    version: 1,
    ...extra,
  }
}

describe('agent-registry schema', () => {
  it('drops malformed and duplicate entries, keeps the rest', () => {
    const good = entry('a', Buffer.from('aaa'))
    const parsed = parseAgentRegistryIndex({
      version: 1,
      updated_at: '2026-09-17',
      agents: [good, { id: 'Bad Id', file: 'x.adf' }, { ...good }],
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.index.agents.map((a) => a.id)).toEqual(['a'])
    expect(parsed!.dropped).toBe(2)
  })

  it('rejects a document that is not an index', () => {
    expect(parseAgentRegistryIndex(null)).toBeNull()
    expect(parseAgentRegistryIndex({ version: 2, updated_at: 'x', agents: [] })).toBeNull()
    expect(parseAgentRegistryIndex({ version: 1, updated_at: 'x' })).toBeNull()
  })

  it('drops a path-traversing file name and a non-slug id', () => {
    const bytes = Buffer.from('aaa')
    const parsed = parseAgentRegistryIndex({
      version: 1,
      updated_at: '2026-09-17',
      agents: [
        entry('evil', bytes, { file: '../evil.adf' }),
        entry('Bad Id', bytes, { id: 'Bad Id' }),
        entry('nested', bytes, { file: 'sub/nested.adf' }),
        entry('fine', bytes),
      ],
    })
    expect(parsed!.index.agents.map((a) => a.id)).toEqual(['fine'])
    expect(parsed!.dropped).toBe(3)
  })

  it('compares dotted versions numerically', () => {
    expect(compareAppVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareAppVersions('0.6.3', '0.6.3')).toBe(0)
    expect(compareAppVersions('0.6', '0.6.1')).toBeLessThan(0)
  })

  it('compares the edges the way the gating code assumes', () => {
    // A missing segment is zero, so '1.0' and '1.0.0' are the same build.
    expect(compareAppVersions('1.0', '1.0.0')).toBe(0)
    // Pre-release suffixes are not understood: a beta counts as the release
    // it is a beta of, which is the permissive direction (it can open the
    // file) rather than locking a tester out of their own build.
    expect(compareAppVersions('0.6.3-beta.1', '0.6.3')).toBe(0)
    // An empty/unknown app version is older than anything.
    expect(compareAppVersions('', '0.0.1')).toBeLessThan(0)
  })
})

describe('AgentRegistryService', () => {
  let root: string
  let bundledDir: string
  let userDataDir: string
  const bundledBytes = Buffer.from('bundled-agent-bytes')
  const remoteBytes = Buffer.from('remote-agent-bytes-longer')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adf-registry-'))
    bundledDir = join(root, 'registry')
    userDataDir = join(root, 'userData')
    mkdirSync(bundledDir, { recursive: true })
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(bundledDir, 'hello.adf'), bundledBytes)
    writeFileSync(join(bundledDir, 'index.json'), JSON.stringify({
      version: 1,
      updated_at: '2026-09-01',
      agents: [entry('hello', bundledBytes), entry('ghost', Buffer.from('missing'))],
    }))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function service(
    fetchFn: (url: string) => Promise<GuardedFetchResult>,
    appVersion = '0.6.3',
    extra: { now?: () => number; expectBundled?: boolean } = {}
  ) {
    return new AgentRegistryService({
      bundledDir,
      userDataDir,
      appVersion,
      fetchFn: (url) => fetchFn(url),
      ...extra,
    })
  }

  function indexBody(agents: unknown[], updatedAt = '2026-09-17'): GuardedFetchResult {
    return {
      bytes: Buffer.from(JSON.stringify({ version: 1, updated_at: updatedAt, agents })),
      contentType: 'application/json',
    }
  }

  it('serves the bundled gallery when the network is down, hiding entries whose file is not shipped', async () => {
    const svc = service(async () => ({ error: 'offline' }))
    const result = await svc.getRegistry()
    expect(result.indexSource).toBe('bundled')
    expect(result.remoteError).toBe('offline')
    expect(result.agents.map((a) => `${a.id}:${a.source}`)).toEqual(['hello:bundled'])
    const resolved = await svc.resolveFile('hello')
    expect(resolved.source).toBe('bundled')
    expect(readFileSync(resolved.path)).toEqual(bundledBytes)
  })

  it('layers the live index over the bundled one and downloads a verified remote file', async () => {
    const calls: string[] = []
    const svc = service(async (url) => {
      calls.push(url)
      if (url === AGENT_REGISTRY_INDEX_URL) {
        return {
          bytes: Buffer.from(JSON.stringify({
            version: 1,
            updated_at: '2026-09-17',
            agents: [entry('hello', bundledBytes), entry('newer', remoteBytes)],
          })),
          contentType: 'application/json',
        }
      }
      if (url.endsWith('/newer.adf')) return { bytes: remoteBytes, contentType: 'application/octet-stream' }
      return { error: `unexpected ${url}` }
    })
    const result = await svc.getRegistry()
    expect(result.indexSource).toBe('remote')
    expect(result.updatedAt).toBe('2026-09-17')
    expect(result.agents.map((a) => `${a.id}:${a.source}`)).toEqual(['hello:bundled', 'newer:remote'])

    const resolved = await svc.resolveFile('newer')
    expect(resolved.source).toBe('remote')
    expect(readFileSync(resolved.path)).toEqual(remoteBytes)
    expect(resolved.path.startsWith(join(userDataDir, AgentRegistryService.FILES_DIR_NAME))).toBe(true)
    // Second resolve is served from the verified download, not the network.
    await svc.resolveFile('newer')
    expect(calls.filter((u) => u.endsWith('/newer.adf'))).toHaveLength(1)
    // The live index was cached for the next offline launch.
    expect(existsSync(join(userDataDir, AgentRegistryService.CACHE_FILE_NAME))).toBe(true)
  })

  it('refuses a download whose bytes do not match the index', async () => {
    const svc = service(async (url) => {
      if (url === AGENT_REGISTRY_INDEX_URL) {
        return {
          bytes: Buffer.from(JSON.stringify({
            version: 1,
            updated_at: '2026-09-17',
            agents: [entry('tampered', remoteBytes)],
          })),
          contentType: 'application/json',
        }
      }
      return { bytes: Buffer.from('x'.repeat(remoteBytes.length)), contentType: 'application/octet-stream' }
    })
    await svc.getRegistry()
    await expect(svc.resolveFile('tampered')).rejects.toThrow(/does not match the index hash/)
    expect(existsSync(join(userDataDir, AgentRegistryService.FILES_DIR_NAME, `tampered-${sha256Hex(remoteBytes).slice(0, 16)}.adf`))).toBe(false)
  })

  it('a strictly newer live version supersedes the bundled copy; an equal one does not', async () => {
    const svc = service(async (url) => {
      if (url === AGENT_REGISTRY_INDEX_URL) {
        return {
          bytes: Buffer.from(JSON.stringify({
            version: 1,
            updated_at: '2026-09-17',
            agents: [entry('hello', remoteBytes, { version: 2 })],
          })),
          contentType: 'application/json',
        }
      }
      return { bytes: remoteBytes, contentType: 'application/octet-stream' }
    })
    const result = await svc.getRegistry()
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].source).toBe('remote')
    expect(result.agents[0].version).toBe(2)
  })

  it('serves the cached live index when a later fetch fails', async () => {
    let online = true
    const fetchFn = async (url: string): Promise<GuardedFetchResult> => {
      if (!online) return { error: 'offline' }
      if (url === AGENT_REGISTRY_INDEX_URL) {
        return {
          bytes: Buffer.from(JSON.stringify({ version: 1, updated_at: '2026-09-17', agents: [entry('cached-only', remoteBytes)] })),
          contentType: 'application/json',
        }
      }
      return { error: 'nope' }
    }
    await service(fetchFn).getRegistry()
    online = false
    const second = await service(fetchFn).getRegistry()
    expect(second.indexSource).toBe('cache')
    expect(second.remoteError).toBe('offline')
    expect(second.agents.map((a) => a.id)).toEqual(['hello', 'cached-only'])
  })

  it('marks an entry unsupported and refuses to resolve it when min_app_version is newer', async () => {
    writeFileSync(join(bundledDir, 'index.json'), JSON.stringify({
      version: 1,
      updated_at: '2026-09-01',
      agents: [entry('hello', bundledBytes, { min_app_version: '0.9.0' })],
    }))
    const svc = service(async () => ({ error: 'offline' }), '0.6.3')
    const result = await svc.getRegistry()
    expect(result.agents[0].supported).toBe(false)
    await expect(svc.resolveFile('hello')).rejects.toThrow(/needs ADF Studio 0\.9\.0/)
  })

  it('retries a failed first fetch once the backoff has elapsed, and stops fetching after it succeeds', async () => {
    // An offline first launch must not latch the session into bundled-only:
    // the gallery has to pick the live index up when the network returns.
    let nowMs = 1_700_000_000_000
    let online = false
    let calls = 0
    const svc = service(
      async () => {
        calls++
        return online ? indexBody([entry('later', remoteBytes)]) : { error: 'offline' }
      },
      '0.6.3',
      { now: () => nowMs }
    )

    expect((await svc.getRegistry()).remoteError).toBe('offline')
    expect(calls).toBe(1)

    // Inside the backoff window: no second attempt.
    nowMs += 59_000
    expect((await svc.getRegistry()).indexSource).toBe('bundled')
    expect(calls).toBe(1)

    nowMs += 1_000
    online = true
    const recovered = await svc.getRegistry()
    expect(calls).toBe(2)
    expect(recovered.indexSource).toBe('remote')
    expect(recovered.agents.map((a) => a.id)).toEqual(['hello', 'later'])

    // A successful attempt is not retried at all.
    nowMs += 10 * 60_000
    await svc.getRegistry()
    expect(calls).toBe(2)
  })

  it('an explicit refresh() during an in-flight fetch performs a second fetch', async () => {
    // The in-flight fetch started before the user pressed Refresh, so it
    // cannot answer the press — a fresh one is chained behind it.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const svc = service(async () => {
      calls++
      if (calls === 1) await gate
      return indexBody([entry(`round-${calls}`, remoteBytes)])
    })

    const first = svc.getRegistry()
    const pressed = svc.refresh()
    expect(calls).toBe(1)
    release()
    await first
    await pressed
    expect(calls).toBe(2)
    expect((await svc.getRegistry()).agents.map((a) => a.id)).toEqual(['hello', 'round-2'])
  })

  it('three concurrent getRegistry() calls share one index fetch', async () => {
    let calls = 0
    const svc = service(async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return indexBody([entry('shared', remoteBytes)])
    })
    const results = await Promise.all([svc.getRegistry(), svc.getRegistry(), svc.getRegistry()])
    expect(calls).toBe(1)
    for (const result of results) expect(result.indexSource).toBe('remote')
  })

  it('a newer remote entry this build cannot open leaves the bundled copy in place', async () => {
    const svc = service(async () =>
      indexBody([
        entry('hello', remoteBytes, { version: 9, min_app_version: '9.9.9' }),
        entry('future', remoteBytes, { min_app_version: '9.9.9' }),
      ]),
      '0.6.3'
    )
    const result = await svc.getRegistry()
    const hello = result.agents.find((a) => a.id === 'hello')!
    expect(hello.source).toBe('bundled')
    expect(hello.version).toBe(1)
    expect(hello.supported).toBe(true)
    // The bundled file still resolves — no network needed.
    expect((await svc.resolveFile('hello')).source).toBe('bundled')
    // A remote-only entry this build cannot open is still listed, honestly.
    const future = result.agents.find((a) => a.id === 'future')!
    expect(future.source).toBe('remote')
    expect(future.supported).toBe(false)
  })

  it('warns once about a bundled file that is listed but not shipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svc = service(async () => ({ error: 'offline' }))
      await svc.getRegistry()
      await svc.getRegistry()
      await svc.getRegistry()
      const ghostWarnings = warn.mock.calls.filter((args) => args.some((a) => typeof a === 'string' && a.includes('ghost.adf')))
      expect(ghostWarnings).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['truncated JSON', '{'],
    ['a document that is not an index', '{"version":2}'],
  ])('treats a bundled index that is %s as an empty registry, reporting why', async (_label, contents) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(join(bundledDir, 'index.json'), contents)
      const svc = service(async () => ({ error: 'offline' }))
      const result = await svc.getRegistry()
      expect(result.agents).toEqual([])
      expect(result.indexSource).toBe('bundled')
      expect(result.remoteError).toMatch(/unreadable|not a registry index/)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a missing bundled registry when the build was supposed to ship one', async () => {
    rmSync(join(bundledDir, 'index.json'), { force: true })
    const silent = await service(async () => ({ error: 'offline' })).getRegistry()
    expect(silent.remoteError).toBe('offline') // dev tree: nothing to report

    const packaged = await service(async () => ({ error: 'offline' }), '0.6.3', { expectBundled: true }).getRegistry()
    expect(packaged.agents).toEqual([])
    expect(packaged.remoteError).toBe(`Bundled registry missing at ${bundledDir}`)
  })

  it('refuses an entry larger than the download ceiling without touching the network', async () => {
    const urls: string[] = []
    const svc = service(async (url) => {
      urls.push(url)
      if (url === AGENT_REGISTRY_INDEX_URL) return indexBody([entry('huge', remoteBytes, { size: 64 * 1024 * 1024 + 1 })])
      return { bytes: remoteBytes, contentType: 'application/octet-stream' }
    })
    await svc.getRegistry()
    await expect(svc.resolveFile('huge')).rejects.toThrow(/larger than the 64 MB download limit/)
    expect(urls.filter((u) => u.endsWith('/huge.adf'))).toEqual([])
  })

  it('refuses a download that is shorter than the index says', async () => {
    const svc = service(async (url) => {
      if (url === AGENT_REGISTRY_INDEX_URL) return indexBody([entry('short', remoteBytes)])
      return { bytes: remoteBytes.subarray(0, 5), contentType: 'application/octet-stream' }
    })
    await svc.getRegistry()
    await expect(svc.resolveFile('short')).rejects.toThrow(/is 5 bytes, the index says 25/)
    expect(existsSync(join(userDataDir, AgentRegistryService.FILES_DIR_NAME, `short-${sha256Hex(remoteBytes).slice(0, 16)}.adf`))).toBe(false)
  })

  it('survives an unwritable cache directory', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // chmod is not a write barrier here
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(userDataDir, 0o500)
    try {
      const result = await service(async () => indexBody([entry('live-only', remoteBytes)])).getRegistry()
      expect(result.indexSource).toBe('remote')
      expect(result.agents.map((a) => a.id)).toEqual(['hello', 'live-only'])
      expect(existsSync(join(userDataDir, AgentRegistryService.CACHE_FILE_NAME))).toBe(false)
    } finally {
      chmodSync(userDataDir, 0o700)
      warn.mockRestore()
    }
  })
})
