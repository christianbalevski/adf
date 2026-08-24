import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpRegistryFetchService, MCP_REGISTRY_URL } from '../../../src/main/services/mcp-registry-fetch.service'
import { MCP_REGISTRY, BUNDLED_REGISTRY_UPDATED_AT } from '../../../src/shared/constants/mcp-registry'

/** A minimal valid remote document, distinguishable from the bundled registry. */
const REMOTE_DOC = {
  schemaVersion: 1,
  updatedAt: '2027-01-01',
  entries: [
    {
      name: 'remote-only',
      displayName: 'Remote Only',
      npmPackage: '@remote/mcp',
      description: 'served from GitHub raw',
      category: 'tools',
      requiredEnvKeys: [],
      verified: true
    }
  ]
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.etag ? { etag: init.etag } : {})
    }
  })
}

describe('McpRegistryFetchService', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>

  const cachePath = () => join(dir, McpRegistryFetchService.CACHE_FILE_NAME)
  const service = () =>
    new McpRegistryFetchService({ userDataDir: dir, fetchFn: fetchMock as unknown as typeof fetch })
  const seedCache = (fetchedAt: number, etag?: string, document: unknown = REMOTE_DOC) =>
    writeFileSync(cachePath(), JSON.stringify({ etag, fetchedAt, document }), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-mcp-registry-'))
    fetchMock = vi.fn()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('valid 200 response: source remote, entries parsed, cache file persisted with the ETag', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(REMOTE_DOC, { etag: 'W/"v1"' }))

    const result = await service().getRegistry()

    expect(result.source).toBe('remote')
    expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
    expect(result.updatedAt).toBe('2027-01-01')
    expect(result.fetchedAt).toBeTypeOf('number')

    const cached = JSON.parse(readFileSync(cachePath(), 'utf-8'))
    expect(cached.etag).toBe('W/"v1"')
    expect(cached.document).toEqual(REMOTE_DOC)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(MCP_REGISTRY_URL)
  })

  it('sends If-None-Match with the stored ETag on the next fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REMOTE_DOC, { etag: 'W/"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))

    const svc = service()
    await svc.refresh()
    await svc.refresh()

    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(firstHeaders['If-None-Match']).toBeUndefined()
    expect(secondHeaders['If-None-Match']).toBe('W/"v1"')
  })

  it('304 serves the cached document as source remote with the prior fetchedAt', async () => {
    seedCache(1_111, 'W/"v1"')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }))

    const result = await service().getRegistry()

    expect(result.source).toBe('remote')
    expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
    expect(result.fetchedAt).toBe(1_111)
  })

  it('network error with a warm cache: source cache', async () => {
    seedCache(2_222)
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    const result = await service().getRegistry()

    expect(result.source).toBe('cache')
    expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
    expect(result.updatedAt).toBe('2027-01-01')
    expect(result.fetchedAt).toBe(2_222)
  })

  it('network error with no cache: source bundled', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
    expect(result.entries).toEqual(MCP_REGISTRY)
    expect(result.updatedAt).toBe(BUNDLED_REGISTRY_UPDATED_AT)
    expect(result.fetchedAt).toBeUndefined()
  })

  it('non-OK response falls back to bundled without caching anything', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
    expect(existsSync(cachePath())).toBe(false)
  })

  it('remote document with an unsupported schemaVersion falls back (bundled when no cache)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...REMOTE_DOC, schemaVersion: 99 }))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
    expect(result.entries).toEqual(MCP_REGISTRY)
    expect(existsSync(cachePath())).toBe(false)
  })

  it('remote document with an unsupported schemaVersion falls back to a warm cache', async () => {
    seedCache(3_333)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...REMOTE_DOC, schemaVersion: 99 }))

    const result = await service().getRegistry()

    expect(result.source).toBe('cache')
    expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
  })

  it('a document with some invalid entries is still served — bad rows dropped with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        ...REMOTE_DOC,
        entries: [...REMOTE_DOC.entries, { name: 'broken' }]
      }))

      const result = await service().getRegistry()

      expect(result.source).toBe('remote')
      expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('1 invalid entry'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('a remote document where EVERY entry fails the schema falls back to the warm cache without overwriting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      seedCache(4_444, 'W/"good"')
      const cacheBefore = readFileSync(cachePath(), 'utf-8')
      fetchMock.mockResolvedValueOnce(jsonResponse({
        ...REMOTE_DOC,
        entries: [{ name: 'broken-1' }, { name: 'broken-2' }]
      }))

      const result = await service().getRegistry()

      // A mass-invalid upstream edit must never blank the registry…
      expect(result.source).toBe('cache')
      expect(result.entries.map((e) => e.name)).toEqual(['remote-only'])
      // …nor clobber the previously good cache with the empty document.
      expect(readFileSync(cachePath(), 'utf-8')).toBe(cacheBefore)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no valid entries'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('a remote document where every entry fails the schema falls back to bundled when there is no cache', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...REMOTE_DOC,
      entries: [{ name: 'broken-1' }]
    }))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
    expect(result.entries).toEqual(MCP_REGISTRY)
    expect(existsSync(cachePath())).toBe(false)
  })

  it('a literally empty entries list is treated as invalid too (the registry is never intentionally empty)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...REMOTE_DOC, entries: [] }))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
    expect(result.entries).toEqual(MCP_REGISTRY)
    expect(existsSync(cachePath())).toBe(false)
  })

  it('getRegistry memoizes: only the first call fetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse(REMOTE_DOC))

    const svc = service()
    await svc.getRegistry()
    await svc.getRegistry()
    await svc.getRegistry()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a corrupt cache file is treated as a miss, not an error', async () => {
    writeFileSync(cachePath(), '{ not json', 'utf-8')
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    const result = await service().getRegistry()

    expect(result.source).toBe('bundled')
  })
})
