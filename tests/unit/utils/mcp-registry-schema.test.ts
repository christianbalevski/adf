import { describe, expect, it } from 'vitest'
import bundledRegistryDocument from '../../../mcp-registry.json'
import { parseMcpRegistryDocument } from '../../../src/shared/schemas/mcp-registry.schema'

/** A minimal valid entry to build documents around. */
const validEntry = {
  name: 'filesystem',
  displayName: 'Filesystem',
  npmPackage: '@modelcontextprotocol/server-filesystem',
  description: 'Read, write, and manage local files and directories',
  category: 'tools',
  requiredEnvKeys: [],
  verified: true
}

function doc(entries: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, updatedAt: '2026-08-24', entries, ...overrides }
}

describe('parseMcpRegistryDocument', () => {
  it('parses the real bundled document with zero drops (JSON validity CI)', () => {
    const result = parseMcpRegistryDocument(bundledRegistryDocument)
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.entries.length).toBe(bundledRegistryDocument.entries.length)
    expect(result!.entries.length).toBeGreaterThan(0)
    expect(result!.updatedAt).toBe(bundledRegistryDocument.updatedAt)
  })

  it('drops a malformed entry but keeps the valid ones around it', () => {
    const malformed = { name: 'broken', displayName: 'Broken' } // missing required fields
    const other = { ...validEntry, name: 'memory', npmPackage: '@modelcontextprotocol/server-memory' }
    const result = parseMcpRegistryDocument(doc([validEntry, malformed, other]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(1)
    expect(result!.entries.map((e) => e.name)).toEqual(['filesystem', 'memory'])
  })

  it('returns null for a future schemaVersion this build cannot trust', () => {
    expect(parseMcpRegistryDocument(doc([validEntry], { schemaVersion: 2 }))).toBeNull()
  })

  it('returns null when schemaVersion is missing or not a number', () => {
    expect(parseMcpRegistryDocument({ updatedAt: '2026-08-24', entries: [validEntry] })).toBeNull()
    expect(parseMcpRegistryDocument(doc([validEntry], { schemaVersion: '1' }))).toBeNull()
  })

  it('returns null for non-object documents', () => {
    expect(parseMcpRegistryDocument(null)).toBeNull()
    expect(parseMcpRegistryDocument('registry')).toBeNull()
    expect(parseMcpRegistryDocument([validEntry])).toBeNull()
  })

  it('returns null when entries is missing or not an array', () => {
    expect(parseMcpRegistryDocument({ schemaVersion: 1 })).toBeNull()
    expect(parseMcpRegistryDocument(doc([], { entries: 'nope' }))).toBeNull()
  })

  it('drops an entry with none of npmPackage / pypiPackage / url', () => {
    const packageless = { ...validEntry, name: 'nowhere', npmPackage: undefined }
    delete (packageless as Record<string, unknown>).npmPackage
    const result = parseMcpRegistryDocument(doc([packageless]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(1)
    expect(result!.entries).toEqual([])
  })

  it('strips unknown extra fields but keeps the entry', () => {
    const withExtra = { ...validEntry, futureField: 'from a newer registry' }
    const result = parseMcpRegistryDocument(doc([withExtra]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0]).not.toHaveProperty('futureField')
    expect(result!.entries[0].name).toBe('filesystem')
  })

  it('round-trips oauth / oauthClientId / oauthScopes on a url entry', () => {
    const remote = {
      ...validEntry,
      name: 'remote-oauth',
      npmPackage: undefined,
      url: 'https://mcp.example.com/mcp',
      oauth: true,
      oauthClientId: 'client-123',
      oauthScopes: ['read', 'write'],
    }
    delete (remote as Record<string, unknown>).npmPackage
    const result = parseMcpRegistryDocument(doc([remote]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.entries[0].oauth).toBe(true)
    expect(result!.entries[0].oauthClientId).toBe('client-123')
    expect(result!.entries[0].oauthScopes).toEqual(['read', 'write'])
  })

  it('does not reject oauth on a non-url entry (schema keeps the field; only url entries act on it)', () => {
    // The schema stays simple — it does not require url for oauth. The stdio
    // entry validates and keeps oauth; registrationFromRegistryEntry ignores it.
    const stdioWithOauth = { ...validEntry, name: 'stdio-oauth', oauth: true }
    const result = parseMcpRegistryDocument(doc([stdioWithOauth]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.entries[0].oauth).toBe(true)
  })

  it('round-trips deprecated and advisory fields', () => {
    const flagged = {
      ...validEntry,
      deprecated: 'Upstream repo archived — prefer the official server',
      advisory: 'Reads your entire home directory'
    }
    const result = parseMcpRegistryDocument(doc([flagged]))
    expect(result).not.toBeNull()
    expect(result!.dropped).toBe(0)
    expect(result!.entries[0].deprecated).toBe('Upstream repo archived — prefer the official server')
    expect(result!.entries[0].advisory).toBe('Reads your entire home directory')
  })
})
